-- Blind Bloom (additive). Sealed-strategy sandbox rounds. Secrets (round seed, submission salts, manifests,
-- base policies, owners, leases) are never column-granted to anon/authenticated; their public reveal columns
-- are filled only by bloom_claim_eval after the server-time commit deadline. All writes are service-role RPCs.

-- Server clock used by every deadline check. Production: now(). Isolated test databases may redefine it.
create or replace function public.bloom_now() returns timestamptz language sql stable as $$ select now() $$;

create table if not exists public.bloom_rounds (
  id uuid primary key default gen_random_uuid(),
  seq int not null unique,
  slug text not null unique,
  title text not null,
  rules jsonb not null,
  rules_hash text not null check (rules_hash ~ '^[0-9a-f]{64}$'),
  market jsonb not null,
  market_hash text not null check (market_hash ~ '^[0-9a-f]{64}$'),
  seed_hex text not null check (seed_hex ~ '^[0-9a-f]{64}$'),
  seed_commit text not null check (seed_commit ~ '^[0-9a-f]{64}$'),
  seed_reveal text,
  commit_closes_at timestamptz not null,
  status text not null default 'open' check (status in ('open','evaluating','scored','failed')),
  revealed_at timestamptz,
  attempts int not null default 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  output jsonb,
  output_hash text,
  content_hash text,
  error text,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
comment on column public.bloom_rounds.seed_hex is 'Private hidden seed. Never column-granted; copied to seed_reveal only after the commit deadline.';

create table if not exists public.bloom_entries (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  round_id uuid not null references public.bloom_rounds(id),
  owner_id uuid not null,
  request_id uuid not null,
  agent_id text not null,
  base_policy_hash text not null check (base_policy_hash ~ '^[0-9a-f]{64}$'),
  body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
  commit text not null check (commit ~ '^[0-9a-f]{64}$'),
  salt text not null check (salt ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null,
  base_policy jsonb not null,
  status text not null default 'sealed' check (status in ('sealed','revealed')),
  salt_reveal text,
  manifest_reveal jsonb,
  base_policy_reveal jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, request_id),
  unique (round_id, agent_id, base_policy_hash)
);
create index if not exists bloom_entries_round_idx on public.bloom_entries(round_id, seq);
create index if not exists bloom_entries_owner_idx on public.bloom_entries(owner_id, created_at);

create table if not exists public.bloom_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  proposal_id uuid not null references public.launch_proposals(id),
  entry_id uuid not null references public.bloom_entries(id),
  round_id uuid not null references public.bloom_rounds(id),
  agent_id text not null,
  policy_hash text not null,
  content_hash text not null,
  attached_at timestamptz not null default now(),
  unique (proposal_id, entry_id)
);

-- Grants: public columns only. Private columns stay unreadable to the Data API.
revoke all on public.bloom_rounds, public.bloom_entries, public.bloom_evidence from anon, authenticated;
grant select (id,seq,slug,title,rules,rules_hash,market,market_hash,seed_commit,seed_reveal,commit_closes_at,status,revealed_at,attempts,output,output_hash,content_hash,error,finished_at,created_at) on public.bloom_rounds to anon, authenticated;
grant select (id,seq,round_id,agent_id,base_policy_hash,commit,status,salt_reveal,manifest_reveal,base_policy_reveal,created_at) on public.bloom_entries to anon, authenticated;
grant select (id,proposal_id,entry_id,round_id,agent_id,policy_hash,content_hash,attached_at) on public.bloom_evidence to authenticated;
grant all on public.bloom_rounds, public.bloom_entries, public.bloom_evidence to service_role;
alter table public.bloom_rounds enable row level security;
alter table public.bloom_entries enable row level security;
alter table public.bloom_evidence enable row level security;
create policy "bloom rounds are public" on public.bloom_rounds for select to anon, authenticated using (true);
create policy "bloom commitments are public" on public.bloom_entries for select to anon, authenticated using (true);
create policy "own bloom evidence" on public.bloom_evidence for select to authenticated using (owner_id = auth.uid());

-- Ensure exactly one open round exists. The seed comes from the database CSPRNG (gen_random_uuid uses
-- pg_strong_random) and only its commitment is ever returned.
create or replace function public.bloom_ensure_round(_title text, _rules jsonb, _rules_hash text, _market jsonb, _market_hash text, _commit_secs int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.bloom_rounds; s text; n int;
begin
  if _title is null or _rules is null or _market is null or _commit_secs is null or _commit_secs < 600 or _commit_secs > 1209600 then raise exception 'bloom: invalid round'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bloom-rounds', 0));
  select * into r from public.bloom_rounds where status='open' and commit_closes_at > public.bloom_now() order by seq desc limit 1;
  if r.id is not null then return jsonb_build_object('id',r.id,'created',false); end if;
  select coalesce(max(seq),0)+1 into n from public.bloom_rounds;
  s := replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
  insert into public.bloom_rounds(seq,slug,title,rules,rules_hash,market,market_hash,seed_hex,seed_commit,commit_closes_at)
    values(n, 'round-' || n, left(_title,80), _rules, _rules_hash, _market, _market_hash, s,
      encode(sha256(convert_to('fleuri.bloom.seed.v1' || chr(10) || s,'UTF8')),'hex'), public.bloom_now() + make_interval(secs=>_commit_secs))
    returning * into r;
  return jsonb_build_object('id',r.id,'created',true);
end $$;

-- Seal one entry. Atomic deadline/status check on server time, owner-owned agent, immutable retry bodies,
-- one entry per round/agent/policy version, per-owner and per-round limits.
create or replace function public.bloom_submit(_owner uuid, _round uuid, _request uuid, _agent text, _base_policy jsonb, _base_policy_hash text,
  _manifest jsonb, _body_hash text, _salt text, _commit text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.bloom_rounds; e public.bloom_entries; n int;
begin
  if _owner is null or _round is null or _request is null or _agent is null or _manifest is null or _base_policy is null then raise exception 'bloom: missing fields'; end if;
  if _body_hash !~ '^[0-9a-f]{64}$' or _salt !~ '^[0-9a-f]{64}$' or _commit !~ '^[0-9a-f]{64}$' or _base_policy_hash !~ '^[0-9a-f]{64}$' then raise exception 'bloom: invalid hashes'; end if;
  perform pg_advisory_xact_lock(hashtextextended('bloom-owner:' || _owner::text, 0));
  select * into e from public.bloom_entries where owner_id=_owner and request_id=_request;
  if e.id is not null then
    if e.body_hash is distinct from _body_hash or e.round_id <> _round or e.agent_id <> _agent then raise exception 'bloom_conflict: this request id was already used with a different strategy'; end if;
    return jsonb_build_object('id',e.id,'commit',e.commit,'created',false);
  end if;
  select * into r from public.bloom_rounds where id=_round for update;
  if r.id is null then raise exception 'bloom: unknown round'; end if;
  if r.status <> 'open' or public.bloom_now() >= r.commit_closes_at then raise exception 'bloom_closed: the commit phase for this round has ended'; end if;
  if not exists (select 1 from public.agents where id=_agent and owner_id=_owner::text and status <> 'archived') then raise exception 'bloom_owner: you can only enter your own active agents'; end if;
  if (_manifest->>'agentId') is distinct from _agent or (_manifest->>'basePolicyHash') is distinct from _base_policy_hash or (_base_policy->>'policyHash') is distinct from _base_policy_hash then raise exception 'bloom: manifest does not match the agent policy'; end if;
  if exists (select 1 from public.bloom_entries where round_id=_round and agent_id=_agent and base_policy_hash=_base_policy_hash) then raise exception 'bloom_duplicate: this agent version is already entered in this round'; end if;
  select count(*) into n from public.bloom_entries where round_id=_round and owner_id=_owner;
  if n >= 3 then raise exception 'bloom_limit: at most 3 entries per owner per round'; end if;
  select count(*) into n from public.bloom_entries where owner_id=_owner and created_at > public.bloom_now() - interval '1 day';
  if n >= 10 then raise exception 'bloom_limit: at most 10 entries per day'; end if;
  select count(*) into n from public.bloom_entries where round_id=_round;
  if n >= coalesce((r.rules->>'maxEntries')::int, 16) then raise exception 'bloom_full: this round is full'; end if;
  insert into public.bloom_entries(round_id,owner_id,request_id,agent_id,base_policy_hash,body_hash,commit,salt,manifest,base_policy,created_at)
    values(_round,_owner,_request,_agent,_base_policy_hash,_body_hash,_commit,_salt,_manifest,_base_policy,public.bloom_now()) returning * into e;
  return jsonb_build_object('id',e.id,'commit',e.commit,'created',true);
end $$;

-- After the deadline: reveal seed + every preimage (once), then hand a fenced lease to one evaluator.
-- Recompute always uses the stored frozen rules/market/preimages. Three expired attempts make it terminal.
create or replace function public.bloom_claim_eval(_round uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.bloom_rounds; tok uuid;
begin
  select * into r from public.bloom_rounds where id=_round for update;
  if r.id is null then raise exception 'bloom: unknown round'; end if;
  if r.status = 'open' and public.bloom_now() < r.commit_closes_at then return jsonb_build_object('state','open'); end if;
  if r.status in ('scored','failed') then return jsonb_build_object('state',r.status); end if;
  if r.status = 'evaluating' and r.lease_expires_at > public.bloom_now() then return jsonb_build_object('state','busy'); end if;
  if r.status = 'evaluating' and r.attempts >= 3 then
    update public.bloom_rounds set status='failed', error='Evaluation gave up after 3 attempts', finished_at=public.bloom_now(), lease_token=null, lease_expires_at=null where id=r.id;
    return jsonb_build_object('state','failed');
  end if;
  if r.status = 'open' then
    update public.bloom_entries set status='revealed', salt_reveal=salt, manifest_reveal=manifest, base_policy_reveal=base_policy where round_id=r.id;
  end if;
  tok := gen_random_uuid();
  update public.bloom_rounds set status='evaluating', seed_reveal=seed_hex, revealed_at=coalesce(revealed_at, public.bloom_now()), attempts=attempts+1,
    lease_token=tok, lease_expires_at=public.bloom_now() + interval '2 minutes' where id=r.id returning * into r;
  return jsonb_build_object('state','acquired','lease',tok,'attempts',r.attempts,'round',jsonb_build_object('id',r.id,'rules',r.rules,'rules_hash',r.rules_hash,'market',r.market,'market_hash',r.market_hash,'seed_commit',r.seed_commit),
    'seed',r.seed_hex,
    'entries',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'seq',e.seq,'agent_id',e.agent_id,'commit',e.commit,'created_at',e.created_at,'salt',e.salt,'manifest',e.manifest,'base_policy',e.base_policy) order by e.seq) from public.bloom_entries e where e.round_id=r.id),'[]'::jsonb));
end $$;

create or replace function public.bloom_finalize(_round uuid, _lease uuid, _output jsonb, _output_hash text, _content_hash text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.bloom_rounds;
begin
  select * into r from public.bloom_rounds where id=_round for update;
  if r.id is null then raise exception 'bloom: unknown round'; end if;
  if r.status = 'scored' then
    if r.output_hash is distinct from _output_hash or r.content_hash is distinct from _content_hash then raise exception 'bloom: a different result is already recorded'; end if;
    return jsonb_build_object('applied',false,'status',r.status);
  end if;
  if r.status <> 'evaluating' or r.lease_token is distinct from _lease or r.lease_expires_at <= public.bloom_now() then raise exception 'bloom_stale: this evaluation lease is no longer current'; end if;
  update public.bloom_rounds set status='scored', output=_output, output_hash=_output_hash, content_hash=_content_hash, finished_at=public.bloom_now(), lease_token=null, lease_expires_at=null where id=_round;
  return jsonb_build_object('applied',true,'status','scored');
end $$;

create or replace function public.bloom_fail(_round uuid, _lease uuid, _reason text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.bloom_rounds;
begin
  select * into r from public.bloom_rounds where id=_round for update;
  if r.id is null or r.status <> 'evaluating' or r.lease_token is distinct from _lease then return jsonb_build_object('applied',false); end if;
  update public.bloom_rounds set status='failed', error=left(coalesce(_reason,'failed'),240), finished_at=public.bloom_now(), lease_token=null, lease_expires_at=null where id=_round;
  return jsonb_build_object('applied',true);
end $$;

-- Link evidence to a launch proposal: owner's own revealed entry in a scored round, proposal drafted by the
-- same agent with the same base policy. Advisory only: never changes proposal status (human review stays).
create or replace function public.bloom_attach_evidence(_owner uuid, _proposal uuid, _entry uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare e public.bloom_entries; r public.bloom_rounds; p public.launch_proposals; ag text;
begin
  select * into e from public.bloom_entries where id=_entry and owner_id=_owner;
  if e.id is null then raise exception 'bloom: only your own entries can be linked'; end if;
  select * into r from public.bloom_rounds where id=e.round_id;
  if r.status <> 'scored' then raise exception 'bloom: only scored rounds can be linked'; end if;
  select * into p from public.launch_proposals where id=_proposal;
  if p.id is null then raise exception 'bloom: unknown proposal'; end if;
  ag := coalesce(p.origin_agent_id, (select a.id from public.agents a where a.handle=p.agent_handle));
  if ag is distinct from e.agent_id or not exists (select 1 from public.agents where id=ag and owner_id=_owner::text) then raise exception 'bloom: the proposal was not drafted by this agent of yours'; end if;
  if p.origin_policy_hash is distinct from e.base_policy_hash then raise exception 'bloom: the proposal policy does not match the entered policy version'; end if;
  insert into public.bloom_evidence(owner_id,proposal_id,entry_id,round_id,agent_id,policy_hash,content_hash)
    values(_owner,_proposal,_entry,e.round_id,e.agent_id,e.base_policy_hash,r.content_hash) on conflict (proposal_id,entry_id) do nothing;
  return jsonb_build_object('ok',true);
end $$;

revoke all on function public.bloom_ensure_round(text,jsonb,text,jsonb,text,int) from public, anon, authenticated;
revoke all on function public.bloom_submit(uuid,uuid,uuid,text,jsonb,text,jsonb,text,text,text) from public, anon, authenticated;
revoke all on function public.bloom_claim_eval(uuid) from public, anon, authenticated;
revoke all on function public.bloom_finalize(uuid,uuid,jsonb,text,text) from public, anon, authenticated;
revoke all on function public.bloom_fail(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.bloom_attach_evidence(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.bloom_ensure_round(text,jsonb,text,jsonb,text,int) to service_role;
grant execute on function public.bloom_submit(uuid,uuid,uuid,text,jsonb,text,jsonb,text,text,text) to service_role;
grant execute on function public.bloom_claim_eval(uuid) to service_role;
grant execute on function public.bloom_finalize(uuid,uuid,jsonb,text,text) to service_role;
grant execute on function public.bloom_fail(uuid,uuid,text) to service_role;
grant execute on function public.bloom_attach_evidence(uuid,uuid,uuid) to service_role;

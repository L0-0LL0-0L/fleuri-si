-- Greenhouse Trials: additive only. Private-by-default trial runs, explicit publication,
-- per-reviewer proposal evidence and immutable proposal origin metadata.
alter table public.launch_proposals add column if not exists origin_agent_id text;
alter table public.launch_proposals add column if not exists origin_policy_hash text;
alter table public.launch_proposals add column if not exists origin_mode text;

create table if not exists public.greenhouse_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid not null,
  status text not null default 'running' check (status in ('running','done','failed')),
  engine_version text not null,
  agent_ids text[] not null,
  input jsonb not null,
  input_hash text not null,
  output jsonb,
  output_hash text,
  content_hash text,
  published boolean not null default false,
  published_at timestamptz,
  attempts integer not null default 1,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_id, request_id)
);
create index if not exists greenhouse_runs_owner_idx on public.greenhouse_runs(owner_id, created_at desc);

create table if not exists public.greenhouse_evidence (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  proposal_id uuid not null references public.launch_proposals(id),
  run_id uuid not null references public.greenhouse_runs(id),
  origin_agent_id text not null,
  run_policy_hash text not null,
  proposal_policy_hash text,
  engine_version text not null,
  content_hash text not null,
  repetitions integer not null,
  scenarios text[] not null,
  attached_at timestamptz not null default now(),
  unique (owner_id, proposal_id, run_id)
);

revoke all on public.greenhouse_runs, public.greenhouse_evidence from anon, authenticated;
grant select on public.greenhouse_runs to anon, authenticated;
grant select on public.greenhouse_evidence to authenticated;
grant all on public.greenhouse_runs, public.greenhouse_evidence to service_role;
alter table public.greenhouse_runs enable row level security;
alter table public.greenhouse_evidence enable row level security;
create policy "owners read own trial runs" on public.greenhouse_runs for select to authenticated using (auth.uid() = owner_id);
create policy "published trial reports are public" on public.greenhouse_runs for select to anon, authenticated using (published and status = 'done');
create policy "reviewers read own evidence" on public.greenhouse_evidence for select to authenticated using (auth.uid() = owner_id);

-- Claim (or recover) a run. Idempotent per (owner, request_id); bounded work per owner.
create or replace function public.greenhouse_claim_run(_owner uuid, _request uuid, _engine text, _agents text[], _input jsonb, _input_hash text)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs; n int;
begin
  select * into r from public.greenhouse_runs where owner_id=_owner and request_id=_request for update;
  if r.id is not null then
    if r.status='running' and r.claimed_at < now() - interval '2 minutes' then
      if r.attempts >= 3 then
        update public.greenhouse_runs set status='failed', error='Gave up after 3 attempts', finished_at=now() where id=r.id returning * into r;
      else
        update public.greenhouse_runs set attempts=attempts+1, claimed_at=now() where id=r.id returning * into r;
      end if;
    end if;
    return r; -- frozen inputs are always the originally stored ones
  end if;
  select count(*) into n from public.greenhouse_runs where owner_id=_owner and created_at > now() - interval '1 hour';
  if n >= 30 then raise exception 'Trial limit reached (30 per hour). Try again later.'; end if;
  select count(*) into n from public.greenhouse_runs where owner_id=_owner and status='running' and claimed_at > now() - interval '2 minutes';
  if n >= 2 then raise exception 'Two trials are already running. Wait for them to finish.'; end if;
  insert into public.greenhouse_runs(owner_id,request_id,engine_version,agent_ids,input,input_hash)
    values(_owner,_request,_engine,_agents,_input,_input_hash) returning * into r;
  return r;
end $$;

create or replace function public.greenhouse_finalize_run(_id uuid, _owner uuid, _input_hash text, _output jsonb, _output_hash text, _content_hash text)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs;
begin
  select * into r from public.greenhouse_runs where id=_id and owner_id=_owner for update;
  if r.id is null then raise exception 'Unknown run'; end if;
  if r.input_hash <> _input_hash then raise exception 'Output was computed from different inputs'; end if;
  if r.status='done' then
    if r.output_hash is distinct from _output_hash then raise exception 'A different result is already recorded'; end if;
    return r;
  end if;
  update public.greenhouse_runs set status='done', output=_output, output_hash=_output_hash, content_hash=_content_hash, error=null, finished_at=now()
    where id=_id returning * into r;
  return r;
end $$;

create or replace function public.greenhouse_fail_run(_id uuid, _owner uuid, _reason text)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs;
begin
  update public.greenhouse_runs set status='failed', error=left(_reason,300), finished_at=now()
    where id=_id and owner_id=_owner and status='running' returning * into r;
  if r.id is null then select * into r from public.greenhouse_runs where id=_id and owner_id=_owner; end if;
  return r;
end $$;

create or replace function public.greenhouse_set_published(_id uuid, _owner uuid, _published boolean)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs;
begin
  update public.greenhouse_runs set published=_published, published_at=case when _published then now() else null end
    where id=_id and owner_id=_owner and status='done' returning * into r;
  if r.id is null then raise exception 'Only your own completed trials can be published'; end if;
  return r;
end $$;

-- Advisory evidence: only the run's owner, only completed runs that include the proposal's origin agent.
create or replace function public.greenhouse_attach_evidence(_owner uuid, _proposal uuid, _run uuid)
returns public.greenhouse_evidence language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs; p public.launch_proposals; e public.greenhouse_evidence; agent text; pol jsonb;
begin
  select * into r from public.greenhouse_runs where id=_run and owner_id=_owner;
  if r.id is null or r.status <> 'done' then raise exception 'Only your own completed trials can be attached'; end if;
  select * into p from public.launch_proposals where id=_proposal;
  if p.id is null then raise exception 'Unknown proposal'; end if;
  agent := p.origin_agent_id;
  if agent is null then
    select a.id into agent from public.agents a where a.handle = p.agent_handle;
  end if;
  if agent is null or not (agent = any(r.agent_ids)) then raise exception 'This trial does not include the agent that drafted the proposal'; end if;
  select x into pol from jsonb_array_elements(r.input->'policies') x where x->>'agentId' = agent;
  insert into public.greenhouse_evidence(owner_id,proposal_id,run_id,origin_agent_id,run_policy_hash,proposal_policy_hash,engine_version,content_hash,repetitions,scenarios)
    values(_owner,_proposal,_run,agent,pol->>'policyHash',p.origin_policy_hash,r.engine_version,r.content_hash,
      (r.input->'config'->>'repetitions')::int, array(select jsonb_array_elements_text(r.input->'config'->'scenarios')))
    on conflict (owner_id,proposal_id,run_id) do nothing;
  select * into e from public.greenhouse_evidence where owner_id=_owner and proposal_id=_proposal and run_id=_run;
  return e;
end $$;

revoke execute on function public.greenhouse_claim_run(uuid,uuid,text,text[],jsonb,text) from public, anon, authenticated;
revoke execute on function public.greenhouse_finalize_run(uuid,uuid,text,jsonb,text,text) from public, anon, authenticated;
revoke execute on function public.greenhouse_fail_run(uuid,uuid,text) from public, anon, authenticated;
revoke execute on function public.greenhouse_set_published(uuid,uuid,boolean) from public, anon, authenticated;
revoke execute on function public.greenhouse_attach_evidence(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.greenhouse_claim_run(uuid,uuid,text,text[],jsonb,text) to service_role;
grant execute on function public.greenhouse_finalize_run(uuid,uuid,text,jsonb,text,text) to service_role;
grant execute on function public.greenhouse_fail_run(uuid,uuid,text) to service_role;
grant execute on function public.greenhouse_set_published(uuid,uuid,boolean) to service_role;
grant execute on function public.greenhouse_attach_evidence(uuid,uuid,uuid) to service_role;

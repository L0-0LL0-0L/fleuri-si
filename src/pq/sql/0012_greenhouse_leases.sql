-- Greenhouse Trials hardening: additive only. Per-owner serialized claims, private execution
-- leases with fencing tokens, terminal failures, settings-conflict detection, and retirement of
-- the token-less mutation RPCs from 0011.
alter table public.greenhouse_runs add column if not exists lease_token uuid;
alter table public.greenhouse_runs add column if not exists lease_expires_at timestamptz;
comment on column public.greenhouse_runs.lease_token is 'Private execution lease (fencing token). Never exposed through the Data API.';

-- Re-assert column-scoped reads: new private columns (lease_*) and owner/request stay unreadable.
revoke all on public.greenhouse_runs, public.greenhouse_evidence from anon, authenticated;
grant select (id,status,engine_version,agent_ids,input,input_hash,output,output_hash,content_hash,published,published_at,attempts,error,created_at,claimed_at,finished_at) on public.greenhouse_runs to anon, authenticated;
grant select (id,proposal_id,run_id,origin_agent_id,run_policy_hash,proposal_policy_hash,engine_version,content_hash,repetitions,scenarios,attached_at) on public.greenhouse_evidence to authenticated;
grant all on public.greenhouse_runs, public.greenhouse_evidence to service_role;

-- Claim (or recover) a run under a per-owner advisory lock. Returns acquired=true and a fresh
-- lease token only to the one caller allowed to compute; everyone else gets the current status.
create or replace function public.greenhouse_claim_lease(_owner uuid, _request uuid, _engine text, _agents text[], _input jsonb, _input_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs; n int; tok uuid; acq boolean := false;
begin
  if _owner is null or _request is null or _input is null or _input_hash is null then raise exception 'Owner, request and inputs are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('greenhouse:' || _owner::text, 0));
  select * into r from public.greenhouse_runs where owner_id=_owner and request_id=_request for update;
  if r.id is not null then
    if (r.input->'config') is distinct from (_input->'config') then
      raise exception 'This request id was already used with different trial settings.';
    end if;
    if r.status='running' and coalesce(r.lease_expires_at, r.claimed_at + interval '2 minutes') <= now() then
      if r.attempts >= 3 then
        update public.greenhouse_runs set status='failed', error='Gave up after 3 attempts', finished_at=now(), lease_token=null, lease_expires_at=null where id=r.id returning * into r;
      else
        tok := gen_random_uuid(); acq := true;
        update public.greenhouse_runs set attempts=attempts+1, claimed_at=now(), lease_token=tok, lease_expires_at=now()+interval '2 minutes' where id=r.id returning * into r;
      end if;
    end if;
  else
    select count(*) into n from public.greenhouse_runs where owner_id=_owner and created_at > now() - interval '1 hour';
    if n >= 30 then raise exception 'Trial limit reached (30 per hour). Try again later.'; end if;
    select count(*) into n from public.greenhouse_runs where owner_id=_owner and status='running' and coalesce(lease_expires_at, claimed_at + interval '2 minutes') > now();
    if n >= 2 then raise exception 'Two trials are already running. Wait for them to finish.'; end if;
    tok := gen_random_uuid(); acq := true;
    insert into public.greenhouse_runs(owner_id,request_id,engine_version,agent_ids,input,input_hash,lease_token,lease_expires_at)
      values(_owner,_request,_engine,_agents,_input,_input_hash,tok,now()+interval '2 minutes') returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'acquired',acq,'lease',case when acq then tok end,'attempts',r.attempts,
    'engine_version',r.engine_version,'input',r.input,'input_hash',r.input_hash,'error',r.error);
end $$;

-- Only the current lease holder may finalize. Identical completed results are idempotent;
-- different results and late writes after a terminal failure are refused.
create or replace function public.greenhouse_finalize_lease(_id uuid, _owner uuid, _lease uuid, _input_hash text, _output jsonb, _output_hash text, _content_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs;
begin
  select * into r from public.greenhouse_runs where id=_id and owner_id=_owner for update;
  if r.id is null then raise exception 'Unknown run'; end if;
  if r.input_hash <> _input_hash then raise exception 'Output was computed from different inputs'; end if;
  if r.status='done' then
    if r.output_hash is distinct from _output_hash or r.content_hash is distinct from _content_hash then raise exception 'A different result is already recorded'; end if;
    return jsonb_build_object('id',r.id,'status',r.status,'applied',false);
  end if;
  if r.status='failed' then raise exception 'This trial already failed; a late result cannot replace a terminal failure.'; end if;
  if _lease is null or r.lease_token is distinct from _lease then raise exception 'Stale worker: this trial lease belongs to another attempt.'; end if;
  update public.greenhouse_runs set status='done', output=_output, output_hash=_output_hash, content_hash=_content_hash, error=null, finished_at=now(), lease_token=null, lease_expires_at=null
    where id=_id returning * into r;
  return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
end $$;

create or replace function public.greenhouse_fail_lease(_id uuid, _owner uuid, _lease uuid, _reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs; ok boolean := false;
begin
  update public.greenhouse_runs set status='failed', error=left(coalesce(_reason,'failed'),300), finished_at=now(), lease_token=null, lease_expires_at=null
    where id=_id and owner_id=_owner and status='running' and _lease is not null and lease_token=_lease returning * into r;
  if r.id is not null then ok := true; else select * into r from public.greenhouse_runs where id=_id and owner_id=_owner; end if;
  return jsonb_build_object('id',r.id,'status',r.status,'applied',ok);
end $$;

-- Retire the token-less 0011 mutations: they could bypass fencing.
create or replace function public.greenhouse_claim_run(_owner uuid, _request uuid, _engine text, _agents text[], _input jsonb, _input_hash text)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
begin raise exception 'Obsolete: use greenhouse_claim_lease'; end $$;
create or replace function public.greenhouse_finalize_run(_id uuid, _owner uuid, _input_hash text, _output jsonb, _output_hash text, _content_hash text)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
begin raise exception 'Obsolete: use greenhouse_finalize_lease'; end $$;
create or replace function public.greenhouse_fail_run(_id uuid, _owner uuid, _reason text)
returns public.greenhouse_runs language plpgsql security definer set search_path = public as $$
begin raise exception 'Obsolete: use greenhouse_fail_lease'; end $$;
comment on function public.greenhouse_claim_run(uuid,uuid,text,text[],jsonb,text) is 'DEPRECATED: replaced by greenhouse_claim_lease';
comment on function public.greenhouse_finalize_run(uuid,uuid,text,jsonb,text,text) is 'DEPRECATED: replaced by greenhouse_finalize_lease';
comment on function public.greenhouse_fail_run(uuid,uuid,text) is 'DEPRECATED: replaced by greenhouse_fail_lease';
revoke execute on function public.greenhouse_claim_run(uuid,uuid,text,text[],jsonb,text) from public, anon, authenticated, service_role;
revoke execute on function public.greenhouse_finalize_run(uuid,uuid,text,jsonb,text,text) from public, anon, authenticated, service_role;
revoke execute on function public.greenhouse_fail_run(uuid,uuid,text) from public, anon, authenticated, service_role;

revoke execute on function public.greenhouse_claim_lease(uuid,uuid,text,text[],jsonb,text) from public, anon, authenticated;
revoke execute on function public.greenhouse_finalize_lease(uuid,uuid,uuid,text,jsonb,text,text) from public, anon, authenticated;
revoke execute on function public.greenhouse_fail_lease(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.greenhouse_claim_lease(uuid,uuid,text,text[],jsonb,text) to service_role;
grant execute on function public.greenhouse_finalize_lease(uuid,uuid,uuid,text,jsonb,text,text) to service_role;
grant execute on function public.greenhouse_fail_lease(uuid,uuid,uuid,text) to service_role;

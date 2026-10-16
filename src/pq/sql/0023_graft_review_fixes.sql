-- Graft review fixes (additive over 0022). v2 RPCs bind the server code version and fresh evidence, take
-- locks in one order (mandate -> proposal/job -> agent), capture replayable gate snapshots on incidents, and
-- invalidate approved purchase proposals whenever a mandate stops being active. v1 write RPCs are retired.

alter table public.graft_mandates add column if not exists approval_proof jsonb;
alter table public.graft_mandates add column if not exists approval_proof_hash text;
alter table public.graft_incidents add column if not exists gate_case jsonb;
alter table public.graft_jobs add column if not exists agent_version_hash text;
comment on column public.graft_incidents.gate_case is 'Sanitized typed gate input captured at denial; null for SQL-side denials that have no gate snapshot.';

-- Any exit from active invalidates open and approved purchase proposals.
create or replace function public.graft_on_mandate_exit() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    update public.graft_proposals set status = 'expired', decided_at = public.graft_now() where mandate_id = new.id and status in ('proposed','approved_awaiting_wallet_payment');
  end if;
  return new;
end $$;
drop trigger if exists graft_mandate_exit on public.graft_mandates;
create trigger graft_mandate_exit after update of status on public.graft_mandates for each row execute function public.graft_on_mandate_exit();
-- Allow proposals to move approved -> expired (status constraint already permits 'expired').

create or replace function public.graft_deny2(_m public.graft_mandates, _job uuid, _code text, _detail text, _case jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into public.graft_incidents(owner_id, mandate_id, job_id, code, detail, gate_case, at) values (_m.owner_id, _m.id, _job, _code, left(_detail, 240), _case, public.graft_now());
  if _code = 'expired_mandate' and _m.status = 'active' then
    update public.graft_mandates set status = 'expired', updated_at = public.graft_now() where id = _m.id;
    perform public.graft_log(_m.id, _m.owner_id, 'expired', 'active', 'expired', '{}'::jsonb);
  elsif _code = 'changed_config' and _m.status = 'active' then
    update public.graft_mandates set status = 'suspended', updated_at = public.graft_now() where id = _m.id;
    perform public.graft_log(_m.id, _m.owner_id, 'config_changed', 'active', 'suspended', '{}'::jsonb);
  end if;
  return jsonb_build_object('denied', _code);
end $$;

-- True when the agent row still matches the frozen DB digest and the caller's server-computed full version hash.
create or replace function public.graft_version_ok(_m public.graft_mandates, _owner uuid, _agent_version_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare a public.agents;
begin
  select * into a from public.agents where id = _m.agent_id for share;
  return found and a.owner_id = _owner::text and a.status <> 'archived' and public.graft_agent_db_digest(a) = (_m.agent_version->'db') and _agent_version_hash = _m.agent_version_hash;
end $$;

create or replace function public.graft_approve_v2(_owner uuid, _id uuid, _draft_hash text, _agent_version_hash text, _expires timestamptz, _agent_version jsonb, _proof jsonb, _proof_hash text, _proof_fetched_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; ttl int;
begin
  select * into m from public.graft_mandates where id = _id and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  if m.status = 'active' and m.approved_hash = _draft_hash then return jsonb_build_object('status','active','applied',false); end if;
  if m.status <> 'review' then raise exception 'not_active: only a mandate in review can be approved (now %)', m.status; end if;
  if m.draft_hash <> _draft_hash or m.agent_version_hash <> _agent_version_hash or m.expires_at <> _expires then raise exception 'request_mismatch: approval does not match the reviewed draft'; end if;
  if m.expires_at <= public.graft_now() then
    perform public.graft_transition_internal(m, 'expired');
    return jsonb_build_object('status','expired','applied',false,'denied','expired_mandate');
  end if;
  if not public.graft_version_ok(m, _owner, _agent_version_hash) or _agent_version is distinct from m.agent_version then
    perform public.graft_transition_internal(m, 'suspended');
    return jsonb_build_object('status','suspended','applied',false,'denied','changed_config');
  end if;
  ttl := (m.draft->>'evidenceTtlSecs')::int;
  if _proof is null or _proof_hash !~ '^[0-9a-f]{64}$' or (_proof->>'draftHash') is distinct from m.draft_hash
     or _proof_fetched_at < public.graft_now() - make_interval(secs => ttl) or _proof_fetched_at > public.graft_now() + interval '30 seconds' then
    raise exception 'stale_proof: approval needs fresh qualified pool evidence fetched by the server within the evidence TTL';
  end if;
  update public.graft_mandates set status = 'active', approved_at = public.graft_now(), approved_hash = _draft_hash, approval_proof = _proof, approval_proof_hash = _proof_hash, updated_at = public.graft_now() where id = _id;
  perform public.graft_log(_id, _owner, 'approved', 'review', 'active', jsonb_build_object('draftHash', _draft_hash, 'agentVersionHash', _agent_version_hash, 'expiresAt', _expires, 'proofHash', _proof_hash));
  return jsonb_build_object('status','active','applied',true);
end $$;

create or replace function public.graft_transition_internal(_m public.graft_mandates, _to text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.graft_mandates set status = _to, updated_at = public.graft_now() where id = _m.id;
  perform public.graft_log(_m.id, _m.owner_id, case when _to = 'suspended' then 'config_changed' else _to end, _m.status, _to, '{}'::jsonb);
end $$;

-- Lock order everywhere: mandate, then job.
create or replace function public.graft_commit_report_v2(_owner uuid, _job uuid, _lease uuid, _report jsonb, _report_hash text, _agent_version_hash text, _observed_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.graft_jobs; m public.graft_mandates; mid uuid; rid uuid; age int;
begin
  select mandate_id into mid from public.graft_jobs where id = _job and owner_id = _owner;
  if not found then raise exception 'not_owner: job not found'; end if;
  select * into m from public.graft_mandates where id = mid for update;
  select * into j from public.graft_jobs where id = _job for update;
  if j.status = 'done' then return jsonb_build_object('status','done','applied',false); end if;
  if j.status <> 'running' or j.lease_token is distinct from _lease or j.lease_expires_at <= public.graft_now() then
    raise exception 'lease_lost: this worker no longer holds the job lease';
  end if;
  if (_report->>'mandateId') is distinct from m.id::text or (_report->>'draftHash') is distinct from m.draft_hash or (_report->>'agentVersionHash') is distinct from m.agent_version_hash or (_report->>'inputHash') is distinct from j.input_hash then
    raise exception 'request_mismatch: report is not bound to this mandate and job';
  end if;
  update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job and false; -- placeholder no-op keeps lock
  if m.status <> 'active' or m.expires_at <= public.graft_now() then
    update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
    return public.graft_deny2(m, _job, case when m.status = 'active' then 'expired_mandate' else 'not_active' end, 'The mandate stopped being active before the report was saved; no report was stored.', null);
  end if;
  if not public.graft_version_ok(m, _owner, _agent_version_hash) or j.agent_version_hash is distinct from _agent_version_hash then
    update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
    return public.graft_deny2(m, _job, 'changed_config', 'The agent or server code version changed during the run; no report was stored.', null);
  end if;
  age := (m.draft->'requirements'->>'maxObservationAgeSecs')::int;
  if _observed_at is null or _observed_at < public.graft_now() - make_interval(secs => age) or _observed_at > public.graft_now() + interval '30 seconds' then
    update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
    return public.graft_deny2(m, _job, 'stale_proof', 'The observation was too old when the report was committed; no report was stored.', null);
  end if;
  insert into public.graft_reports(owner_id, mandate_id, job_id, report, report_hash, created_at) values (_owner, m.id, _job, _report, _report_hash, public.graft_now()) returning id into rid;
  update public.graft_jobs set status = 'done', finished_at = public.graft_now(), lease_token = null where id = _job;
  perform public.graft_log(m.id, _owner, 'report', 'active', 'active', jsonb_build_object('job', _job, 'reportHash', _report_hash));
  return jsonb_build_object('status','done','applied',true,'report', rid);
end $$;

create or replace function public.graft_fail_job_v2(_owner uuid, _job uuid, _lease uuid, _code text, _detail text, _case jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.graft_jobs; m public.graft_mandates; mid uuid;
begin
  select mandate_id into mid from public.graft_jobs where id = _job and owner_id = _owner;
  if not found then raise exception 'not_owner: job not found'; end if;
  select * into m from public.graft_mandates where id = mid for update;
  select * into j from public.graft_jobs where id = _job for update;
  if j.status <> 'running' or j.lease_token is distinct from _lease or j.lease_expires_at <= public.graft_now() then raise exception 'lease_lost: this worker no longer holds the job lease'; end if;
  if _case is not null and octet_length(_case::text) > 16000 then raise exception 'gate snapshot too large'; end if;
  update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
  return public.graft_deny2(m, _job, _code, _detail, _case);
end $$;

-- Claim v2: records the server code version the job runs under (frozen per job).
create or replace function public.graft_claim_job_v2(_owner uuid, _mandate uuid, _request uuid, _input jsonb, _input_hash text, _agent_version_hash text, _owner_limit int, _max_inflight int, _lease_secs int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  if _owner_limit > 6 or _max_inflight > 2 or _lease_secs > 120 then raise exception 'quota_exceeded: budgets are fixed server limits'; end if;
  r := public.graft_claim_job(_owner, _mandate, _request, _input, _input_hash, _agent_version_hash, _owner_limit, _max_inflight, _lease_secs);
  if r->>'status' = 'claimed' then update public.graft_jobs set agent_version_hash = _agent_version_hash where id = (r->>'job')::uuid; end if;
  return r;
end $$;

create or replace function public.graft_propose_v2(_owner uuid, _mandate uuid, _request uuid, _proposal jsonb, _hash text, _expires timestamptz, _agent_version_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; p public.graft_proposals; ttl int;
begin
  select * into m from public.graft_mandates where id = _mandate and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  select * into p from public.graft_proposals where owner_id = _owner and request_id = _request;
  if found then
    if p.proposal_hash <> _hash then raise exception 'request_mismatch: request id used for a different proposal'; end if;
    return jsonb_build_object('id', p.id, 'created', false, 'status', p.status);
  end if;
  if m.status = 'active' and m.expires_at <= public.graft_now() then perform public.graft_transition_internal(m, 'expired'); return jsonb_build_object('denied','expired_mandate'); end if;
  if m.status <> 'active' then raise exception 'not_active: proposals need an active, unexpired mandate (now %)', m.status; end if;
  if not public.graft_version_ok(m, _owner, _agent_version_hash) then perform public.graft_transition_internal(m, 'suspended'); return jsonb_build_object('denied','changed_config'); end if;
  if (_proposal->>'agentVersionHash') is distinct from m.agent_version_hash then raise exception 'request_mismatch: proposal names another agent version'; end if;
  ttl := (m.draft->>'evidenceTtlSecs')::int;
  if not exists (select 1 from public.graft_reports where mandate_id = m.id and created_at >= public.graft_now() - make_interval(secs => ttl)) then
    raise exception 'stale_proof: run the steward first; proposals need a report within the evidence TTL';
  end if;
  return public.graft_propose(_owner, _mandate, _request, _proposal, _hash, _expires);
end $$;

create or replace function public.graft_decide_v2(_owner uuid, _id uuid, _hash text, _approve boolean, _agent_version_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.graft_proposals; m public.graft_mandates; mid uuid;
begin
  select mandate_id into mid from public.graft_proposals where id = _id and owner_id = _owner;
  if not found then raise exception 'not_owner: proposal not found'; end if;
  select * into m from public.graft_mandates where id = mid for update;
  if m.status = 'active' and not public.graft_version_ok(m, _owner, _agent_version_hash) then
    perform public.graft_transition_internal(m, 'suspended'); -- exit trigger expires the proposals
    return jsonb_build_object('status','expired','applied',true,'denied','changed_config');
  end if;
  return public.graft_decide_proposal(_owner, _id, _hash, _approve);
end $$;

do $$ declare f text; begin
  foreach f in array array['graft_on_mandate_exit()','graft_deny2(public.graft_mandates,uuid,text,text,jsonb)','graft_version_ok(public.graft_mandates,uuid,text)',
    'graft_approve_v2(uuid,uuid,text,text,timestamptz,jsonb,jsonb,text,timestamptz)','graft_transition_internal(public.graft_mandates,text)',
    'graft_commit_report_v2(uuid,uuid,uuid,jsonb,text,text,timestamptz)','graft_fail_job_v2(uuid,uuid,uuid,text,text,jsonb)',
    'graft_claim_job_v2(uuid,uuid,uuid,jsonb,text,text,int,int,int)','graft_propose_v2(uuid,uuid,uuid,jsonb,text,timestamptz,text)','graft_decide_v2(uuid,uuid,text,boolean,text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- Retire v1 entry points that lacked version/evidence binding (still callable internally by definer functions).
  foreach f in array array['graft_approve(uuid,uuid,text,text,timestamptz,jsonb)','graft_commit_report(uuid,uuid,uuid,jsonb,text)','graft_fail_job(uuid,uuid,uuid,text,text)',
    'graft_propose(uuid,uuid,uuid,jsonb,text,timestamptz)','graft_decide_proposal(uuid,uuid,text,boolean)','graft_claim_job(uuid,uuid,uuid,jsonb,text,text,int,int,int)']
  loop
    execute format('revoke execute on function public.%s from service_role', f);
  end loop;
end $$;

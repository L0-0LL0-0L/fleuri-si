-- Fleuri Graft v1 Research Steward (additive). Owner-reviewed, read-only research mandates for one agent
-- version. All writes are service-role-only SECURITY DEFINER RPCs; owners read their own rows through RLS.
-- Nothing here moves funds: purchase proposals never become "paid" in this schema.

create or replace function public.graft_now() returns timestamptz language sql stable as $$ select now() $$;

create table if not exists public.graft_mandates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  request_id uuid not null,
  agent_id text not null,
  status text not null default 'draft' check (status in ('draft','review','active','expired','suspended','revoked','completed')),
  draft jsonb not null,
  draft_hash text not null check (draft_hash ~ '^[0-9a-f]{64}$'),
  agent_version jsonb not null,
  agent_version_hash text not null check (agent_version_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  approved_at timestamptz,
  approved_hash text,
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, request_id)
);
create index if not exists graft_mandates_agent on public.graft_mandates(agent_id, status);

create table if not exists public.graft_events (
  id bigserial primary key,
  mandate_id uuid not null references public.graft_mandates(id),
  owner_id uuid not null,
  kind text not null,
  from_status text,
  to_status text,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create table if not exists public.graft_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  mandate_id uuid not null references public.graft_mandates(id),
  request_id uuid not null,
  day date not null,
  status text not null default 'running' check (status in ('running','done','failed')),
  input jsonb not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  generation int not null default 1,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_id, request_id)
);
create index if not exists graft_jobs_owner_day on public.graft_jobs(owner_id, day);

create table if not exists public.graft_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  mandate_id uuid not null references public.graft_mandates(id),
  job_id uuid not null unique references public.graft_jobs(id),
  report jsonb not null,
  report_hash text not null check (report_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.graft_incidents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  mandate_id uuid not null references public.graft_mandates(id),
  job_id uuid references public.graft_jobs(id),
  code text not null check (code in ('expired_mandate','stale_proof','changed_config','service_unavailable','request_mismatch','unsupported_pool','quota_exceeded','lease_lost','not_active')),
  detail text not null check (length(detail) <= 240),
  at timestamptz not null default now()
);

create table if not exists public.graft_proposals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  mandate_id uuid not null references public.graft_mandates(id),
  request_id uuid not null,
  proposal jsonb not null,
  proposal_hash text not null check (proposal_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed','approved_awaiting_wallet_payment','rejected','expired')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, request_id)
);

grant select on public.graft_mandates, public.graft_events, public.graft_jobs, public.graft_reports, public.graft_incidents, public.graft_proposals to authenticated;
grant all on public.graft_mandates, public.graft_events, public.graft_jobs, public.graft_reports, public.graft_incidents, public.graft_proposals to service_role;
grant usage, select on sequence public.graft_events_id_seq to service_role;
revoke insert, update, delete, truncate on public.graft_mandates, public.graft_events, public.graft_jobs, public.graft_reports, public.graft_incidents, public.graft_proposals from anon, authenticated;

alter table public.graft_mandates enable row level security;
alter table public.graft_events enable row level security;
alter table public.graft_jobs enable row level security;
alter table public.graft_reports enable row level security;
alter table public.graft_incidents enable row level security;
alter table public.graft_proposals enable row level security;
create policy "graft mandates owner read" on public.graft_mandates for select to authenticated using (owner_id = auth.uid());
create policy "graft events owner read" on public.graft_events for select to authenticated using (owner_id = auth.uid());
create policy "graft jobs owner read" on public.graft_jobs for select to authenticated using (owner_id = auth.uid());
create policy "graft reports owner read" on public.graft_reports for select to authenticated using (owner_id = auth.uid());
create policy "graft incidents owner read" on public.graft_incidents for select to authenticated using (owner_id = auth.uid());
create policy "graft proposals owner read" on public.graft_proposals for select to authenticated using (owner_id = auth.uid());

-- Append-only history tables.
create or replace function public.graft_append_only() returns trigger language plpgsql as $$
begin raise exception 'graft history is append-only'; end $$;
create trigger graft_events_append_only before update or delete on public.graft_events for each row execute function public.graft_append_only();
create trigger graft_reports_append_only before update or delete on public.graft_reports for each row execute function public.graft_append_only();
create trigger graft_incidents_append_only before update or delete on public.graft_incidents for each row execute function public.graft_append_only();

-- Frozen draft: once created, the draft/agent binding never changes.
create or replace function public.graft_freeze_draft() returns trigger language plpgsql as $$
begin
  if new.draft is distinct from old.draft or new.draft_hash is distinct from old.draft_hash or new.agent_version is distinct from old.agent_version
     or new.agent_version_hash is distinct from old.agent_version_hash or new.expires_at is distinct from old.expires_at
     or new.owner_id is distinct from old.owner_id or new.agent_id is distinct from old.agent_id or new.request_id is distinct from old.request_id then
    raise exception 'graft mandate terms are immutable';
  end if;
  return new;
end $$;
create trigger graft_mandates_freeze before update on public.graft_mandates for each row execute function public.graft_freeze_draft();
create trigger graft_mandates_no_delete before delete on public.graft_mandates for each row execute function public.graft_append_only();

-- Digest of the agent's DB-held configuration; must equal agent_version->'db' recorded at draft time.
create or replace function public.graft_agent_db_digest(a public.agents) returns jsonb language sql immutable as $$
  select jsonb_build_object('archetype', a.archetype, 'risk', a.risk, 'handle', a.handle,
    'personaDigest', encode(sha256(convert_to(a.persona, 'UTF8')), 'hex'),
    'strategyDigest', encode(sha256(convert_to(a.strategy, 'UTF8')), 'hex'))
$$;

create or replace function public.graft_log(_m uuid, _owner uuid, _kind text, _from text, _to text, _detail jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.graft_events(mandate_id, owner_id, kind, from_status, to_status, detail, at) values (_m, _owner, _kind, _from, _to, coalesce(_detail,'{}'::jsonb), public.graft_now());
$$;

-- Atomically invalidate review/active approvals when relevant agent configuration changes.
create or replace function public.graft_on_agent_change() returns trigger language plpgsql security definer set search_path = public as $$
declare m record;
begin
  for m in select id, owner_id, status from public.graft_mandates where agent_id = new.id and status in ('draft','review','active') for update loop
    update public.graft_mandates set status = 'suspended', updated_at = public.graft_now() where id = m.id;
    perform public.graft_log(m.id, m.owner_id, 'config_changed', m.status, 'suspended', jsonb_build_object('reason','agent configuration, owner or status changed'));
  end loop;
  return new;
end $$;
create trigger graft_agent_change after update on public.agents for each row
  when (old.archetype is distinct from new.archetype or old.risk is distinct from new.risk or old.persona is distinct from new.persona
        or old.strategy is distinct from new.strategy or old.owner_id is distinct from new.owner_id or old.handle is distinct from new.handle
        or (old.status is distinct from new.status and new.status = 'archived'))
  execute function public.graft_on_agent_change();

create or replace function public.graft_create_draft(_owner uuid, _request uuid, _agent text, _draft jsonb, _draft_hash text, _agent_version jsonb, _agent_version_hash text, _expires timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.agents; m public.graft_mandates;
begin
  select * into m from public.graft_mandates where owner_id = _owner and request_id = _request;
  if found then
    if m.draft_hash <> _draft_hash then raise exception 'request_mismatch: this request id was used for a different draft'; end if;
    return jsonb_build_object('id', m.id, 'created', false);
  end if;
  select * into a from public.agents where id = _agent for share;
  if not found or a.owner_id <> _owner::text then raise exception 'not_owner: choose one of your own agents'; end if;
  if a.status = 'archived' then raise exception 'not_active: archived agents cannot receive mandates'; end if;
  if (_agent_version->'db') is distinct from public.graft_agent_db_digest(a) then raise exception 'changed_config: agent configuration changed while drafting'; end if;
  if _expires <= public.graft_now() then raise exception 'expired_mandate: expiry must be in the future'; end if;
  if _expires > public.graft_now() + interval '30 days' then raise exception 'expiry is limited to 30 days'; end if;
  if (select count(*) from public.graft_mandates where owner_id = _owner and status in ('draft','review','active')) >= 10 then raise exception 'quota_exceeded: at most 10 open mandates'; end if;
  insert into public.graft_mandates(owner_id, request_id, agent_id, draft, draft_hash, agent_version, agent_version_hash, expires_at, created_at, updated_at)
    values (_owner, _request, _agent, _draft, _draft_hash, _agent_version, _agent_version_hash, _expires, public.graft_now(), public.graft_now()) returning * into m;
  perform public.graft_log(m.id, _owner, 'created', null, 'draft', jsonb_build_object('draftHash', _draft_hash, 'agentVersionHash', _agent_version_hash));
  return jsonb_build_object('id', m.id, 'created', true);
end $$;

-- Owner transitions other than approval. Allowed: draft->review, draft|review|active|suspended->revoked, active->completed.
create or replace function public.graft_transition(_owner uuid, _id uuid, _to text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates;
begin
  select * into m from public.graft_mandates where id = _id and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  if m.status = _to then return jsonb_build_object('status', m.status, 'applied', false); end if;
  if not ((m.status = 'draft' and _to = 'review') or (m.status in ('draft','review','active','suspended') and _to = 'revoked') or (m.status = 'active' and _to = 'completed')) then
    raise exception 'not_active: cannot move a % mandate to %', m.status, _to;
  end if;
  update public.graft_mandates set status = _to, updated_at = public.graft_now() where id = _id;
  perform public.graft_log(_id, _owner, _to, m.status, _to, '{}'::jsonb);
  if _to = 'revoked' then update public.graft_proposals set status = 'expired', decided_at = public.graft_now() where mandate_id = _id and status = 'proposed'; end if;
  return jsonb_build_object('status', _to, 'applied', true);
end $$;

-- Approval binds the exact draft hash, agent version hash and expiry; ownership and the current agent configuration
-- are rechecked under row locks in this same write.
create or replace function public.graft_approve(_owner uuid, _id uuid, _draft_hash text, _agent_version_hash text, _expires timestamptz, _agent_version jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; a public.agents;
begin
  select * into m from public.graft_mandates where id = _id and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  if m.status = 'active' and m.approved_hash = _draft_hash then return jsonb_build_object('status','active','applied',false); end if;
  if m.status <> 'review' then raise exception 'not_active: only a mandate in review can be approved (now %)', m.status; end if;
  if m.draft_hash <> _draft_hash or m.agent_version_hash <> _agent_version_hash or m.expires_at <> _expires then raise exception 'request_mismatch: approval does not match the reviewed draft'; end if;
  if m.expires_at <= public.graft_now() then
    update public.graft_mandates set status = 'expired', updated_at = public.graft_now() where id = _id;
    perform public.graft_log(_id, _owner, 'expired', m.status, 'expired', '{}'::jsonb);
    return jsonb_build_object('status','expired','applied',false,'denied','expired_mandate');
  end if;
  select * into a from public.agents where id = m.agent_id for share;
  if not found or a.owner_id <> _owner::text or a.status = 'archived' then raise exception 'not_owner: agent is no longer yours or active'; end if;
  if public.graft_agent_db_digest(a) is distinct from (m.agent_version->'db') or _agent_version is distinct from m.agent_version then
    update public.graft_mandates set status = 'suspended', updated_at = public.graft_now() where id = _id;
    perform public.graft_log(_id, _owner, 'config_changed', m.status, 'suspended', '{}'::jsonb);
    return jsonb_build_object('status','suspended','applied',false,'denied','changed_config');
  end if;
  update public.graft_mandates set status = 'active', approved_at = public.graft_now(), approved_hash = _draft_hash, updated_at = public.graft_now() where id = _id;
  perform public.graft_log(_id, _owner, 'approved', 'review', 'active', jsonb_build_object('draftHash', _draft_hash, 'agentVersionHash', _agent_version_hash, 'expiresAt', _expires));
  return jsonb_build_object('status','active','applied',true);
end $$;

-- Internal: deny a job with a sanitized incident (and state change when relevant).
create or replace function public.graft_deny(_m public.graft_mandates, _job uuid, _code text, _detail text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into public.graft_incidents(owner_id, mandate_id, job_id, code, detail, at) values (_m.owner_id, _m.id, _job, _code, left(_detail, 240), public.graft_now());
  if _code = 'expired_mandate' and _m.status = 'active' then
    update public.graft_mandates set status = 'expired', updated_at = public.graft_now() where id = _m.id;
    perform public.graft_log(_m.id, _m.owner_id, 'expired', 'active', 'expired', '{}'::jsonb);
  elsif _code = 'changed_config' and _m.status = 'active' then
    update public.graft_mandates set status = 'suspended', updated_at = public.graft_now() where id = _m.id;
    perform public.graft_log(_m.id, _m.owner_id, 'config_changed', 'active', 'suspended', '{}'::jsonb);
  end if;
  return jsonb_build_object('denied', _code);
end $$;

-- Claim (or re-claim after lease expiry) one bounded research job. Per-owner serialized; daily owner and mandate
-- quotas count every created job (failures consume compute); at most _max_inflight live leases per owner.
create or replace function public.graft_claim_job(_owner uuid, _mandate uuid, _request uuid, _input jsonb, _input_hash text, _agent_version_hash text, _owner_limit int, _max_inflight int, _lease_secs int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; a public.agents; j public.graft_jobs; d date; tok uuid; r public.graft_reports; per int;
begin
  perform pg_advisory_xact_lock(hashtext('graft:' || _owner::text));
  select * into m from public.graft_mandates where id = _mandate and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  select * into j from public.graft_jobs where owner_id = _owner and request_id = _request for update;
  if found then
    if j.mandate_id <> _mandate or j.input_hash <> _input_hash then return public.graft_deny(m, j.id, 'request_mismatch', 'This request id was already used with different inputs; start a new request.'); end if;
    if j.status = 'done' then select * into r from public.graft_reports where job_id = j.id; return jsonb_build_object('status','done','job', j.id, 'reportHash', r.report_hash); end if;
    if j.status = 'failed' then return jsonb_build_object('status','failed','job', j.id); end if;
    if j.lease_expires_at > public.graft_now() then return jsonb_build_object('status','busy','job', j.id); end if;
  end if;
  if m.status <> 'active' then return public.graft_deny(m, j.id, 'not_active', 'The mandate is ' || m.status || '; nothing was run.'); end if;
  if m.expires_at <= public.graft_now() then return public.graft_deny(m, j.id, 'expired_mandate', 'The mandate expired; nothing was run.'); end if;
  select * into a from public.agents where id = m.agent_id for share;
  if not found or a.owner_id <> _owner::text or a.status = 'archived' or public.graft_agent_db_digest(a) is distinct from (m.agent_version->'db') or _agent_version_hash <> m.agent_version_hash then
    return public.graft_deny(m, j.id, 'changed_config', 'The agent configuration no longer matches the approved version; approval suspended.');
  end if;
  if (select count(*) from public.graft_jobs where owner_id = _owner and status = 'running' and lease_expires_at > public.graft_now()) >= _max_inflight then
    return public.graft_deny(m, j.id, 'quota_exceeded', 'Too many research jobs are already running.');
  end if;
  tok := gen_random_uuid();
  if j.id is not null then
    update public.graft_jobs set lease_token = tok, lease_expires_at = public.graft_now() + make_interval(secs => _lease_secs), generation = generation + 1 where id = j.id returning * into j;
    return jsonb_build_object('status','claimed','job', j.id, 'lease', tok, 'generation', j.generation, 'input', j.input, 'resumed', true);
  end if;
  d := (public.graft_now() at time zone 'utc')::date;
  per := coalesce((m.draft->'budgets'->>'runsPerDay')::int, 0);
  if (select count(*) from public.graft_jobs where owner_id = _owner and day = d) >= _owner_limit then return public.graft_deny(m, null, 'quota_exceeded', 'Daily research compute for your workspace is used up (UTC day).'); end if;
  if (select count(*) from public.graft_jobs where mandate_id = _mandate and day = d) >= per then return public.graft_deny(m, null, 'quota_exceeded', 'This mandate''s daily run budget is used up (UTC day).'); end if;
  insert into public.graft_jobs(owner_id, mandate_id, request_id, day, input, input_hash, lease_token, lease_expires_at, created_at)
    values (_owner, _mandate, _request, d, _input, _input_hash, tok, public.graft_now() + make_interval(secs => _lease_secs), public.graft_now()) returning * into j;
  return jsonb_build_object('status','claimed','job', j.id, 'lease', tok, 'generation', 1, 'input', j.input, 'resumed', false);
end $$;

-- Commit the frozen report. Requires the current unexpired lease and a still-active, unexpired, unchanged mandate.
create or replace function public.graft_commit_report(_owner uuid, _job uuid, _lease uuid, _report jsonb, _report_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.graft_jobs; m public.graft_mandates; a public.agents; rid uuid;
begin
  select * into j from public.graft_jobs where id = _job and owner_id = _owner for update;
  if not found then raise exception 'not_owner: job not found'; end if;
  if j.status = 'done' then return jsonb_build_object('status','done','applied',false); end if;
  if j.status <> 'running' or j.lease_token is distinct from _lease or j.lease_expires_at <= public.graft_now() then
    raise exception 'lease_lost: this worker no longer holds the job lease';
  end if;
  select * into m from public.graft_mandates where id = j.mandate_id for update;
  if (_report->>'mandateId') is distinct from m.id::text or (_report->>'draftHash') is distinct from m.draft_hash or (_report->>'agentVersionHash') is distinct from m.agent_version_hash or (_report->>'inputHash') is distinct from j.input_hash then
    raise exception 'request_mismatch: report is not bound to this mandate and job';
  end if;
  if m.status <> 'active' or m.expires_at <= public.graft_now() then
    update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
    return public.graft_deny(m, _job, case when m.status = 'active' then 'expired_mandate' else 'not_active' end, 'The mandate stopped being active before the report was saved; no report was stored.');
  end if;
  select * into a from public.agents where id = m.agent_id for share;
  if not found or a.owner_id <> _owner::text or public.graft_agent_db_digest(a) is distinct from (m.agent_version->'db') then
    update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
    return public.graft_deny(m, _job, 'changed_config', 'The agent configuration changed during the run; no report was stored.');
  end if;
  insert into public.graft_reports(owner_id, mandate_id, job_id, report, report_hash, created_at) values (_owner, m.id, _job, _report, _report_hash, public.graft_now()) returning id into rid;
  update public.graft_jobs set status = 'done', finished_at = public.graft_now(), lease_token = null where id = _job;
  perform public.graft_log(m.id, _owner, 'report', 'active', 'active', jsonb_build_object('job', _job, 'reportHash', _report_hash));
  return jsonb_build_object('status','done','applied',true,'report', rid);
end $$;

create or replace function public.graft_fail_job(_owner uuid, _job uuid, _lease uuid, _code text, _detail text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j public.graft_jobs; m public.graft_mandates;
begin
  select * into j from public.graft_jobs where id = _job and owner_id = _owner for update;
  if not found then raise exception 'not_owner: job not found'; end if;
  if j.status <> 'running' or j.lease_token is distinct from _lease or j.lease_expires_at <= public.graft_now() then raise exception 'lease_lost: this worker no longer holds the job lease'; end if;
  select * into m from public.graft_mandates where id = j.mandate_id for update;
  update public.graft_jobs set status = 'failed', finished_at = public.graft_now(), lease_token = null where id = _job;
  return public.graft_deny(m, _job, _code, _detail);
end $$;

-- Purchase PROPOSALS only: no payment authority. Approval records consent to this exact proposal.
create or replace function public.graft_propose(_owner uuid, _mandate uuid, _request uuid, _proposal jsonb, _hash text, _expires timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; p public.graft_proposals; allowed jsonb; mx numeric;
begin
  select * into p from public.graft_proposals where owner_id = _owner and request_id = _request;
  if found then
    if p.proposal_hash <> _hash then raise exception 'request_mismatch: request id used for a different proposal'; end if;
    return jsonb_build_object('id', p.id, 'created', false);
  end if;
  select * into m from public.graft_mandates where id = _mandate and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  if m.status <> 'active' or m.expires_at <= public.graft_now() then raise exception 'not_active: proposals need an active, unexpired mandate'; end if;
  allowed := m.draft->'purchases'->'services';
  if allowed is null or not (allowed ? (_proposal->>'service')) then raise exception 'unsupported: service is not allowlisted by this mandate'; end if;
  mx := (m.draft->'purchases'->>'maxAtomic')::numeric;
  if (_proposal->>'maxAtomic')::numeric > mx or (_proposal->>'maxAtomic')::numeric <= 0 then raise exception 'unsupported: amount exceeds the mandate cap'; end if;
  if (_proposal->>'currency') is distinct from (m.draft->'purchases'->>'currency') then raise exception 'unsupported: currency differs from the mandate'; end if;
  if (_proposal->>'mandateDraftHash') is distinct from m.draft_hash then raise exception 'request_mismatch: proposal is bound to another mandate version'; end if;
  if _expires <= public.graft_now() or _expires > m.expires_at then raise exception 'expired_mandate: proposal must expire before the mandate'; end if;
  if (select count(*) from public.graft_proposals where mandate_id = _mandate and status = 'proposed') >= 5 then raise exception 'quota_exceeded: at most 5 open proposals'; end if;
  insert into public.graft_proposals(owner_id, mandate_id, request_id, proposal, proposal_hash, expires_at, created_at) values (_owner, _mandate, _request, _proposal, _hash, _expires, public.graft_now()) returning * into p;
  perform public.graft_log(_mandate, _owner, 'purchase_proposed', m.status, m.status, jsonb_build_object('proposal', p.id, 'hash', _hash));
  return jsonb_build_object('id', p.id, 'created', true);
end $$;

create or replace function public.graft_decide_proposal(_owner uuid, _id uuid, _hash text, _approve boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.graft_proposals; m public.graft_mandates; st text;
begin
  select * into p from public.graft_proposals where id = _id and owner_id = _owner for update;
  if not found then raise exception 'not_owner: proposal not found'; end if;
  if p.proposal_hash <> _hash then raise exception 'request_mismatch: decision does not match the proposal'; end if;
  if p.status <> 'proposed' then return jsonb_build_object('status', p.status, 'applied', false); end if;
  select * into m from public.graft_mandates where id = p.mandate_id for update;
  if p.expires_at <= public.graft_now() or m.status <> 'active' or m.expires_at <= public.graft_now() then
    update public.graft_proposals set status = 'expired', decided_at = public.graft_now() where id = _id;
    return jsonb_build_object('status','expired','applied',true);
  end if;
  st := case when _approve then 'approved_awaiting_wallet_payment' else 'rejected' end;
  update public.graft_proposals set status = st, decided_at = public.graft_now() where id = _id;
  perform public.graft_log(p.mandate_id, _owner, 'purchase_' || case when _approve then 'approved' else 'rejected' end, m.status, m.status, jsonb_build_object('proposal', _id, 'hash', _hash));
  return jsonb_build_object('status', st, 'applied', true);
end $$;

create or replace function public.graft_set_shared(_owner uuid, _id uuid, _shared boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates;
begin
  select * into m from public.graft_mandates where id = _id and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  if m.shared = _shared then return jsonb_build_object('shared', _shared, 'applied', false); end if;
  update public.graft_mandates set shared = _shared, updated_at = public.graft_now() where id = _id;
  perform public.graft_log(_id, _owner, case when _shared then 'shared' else 'unshared' end, m.status, m.status, '{}'::jsonb);
  return jsonb_build_object('shared', _shared, 'applied', true);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'graft_log(uuid,uuid,text,text,text,jsonb)','graft_create_draft(uuid,uuid,text,jsonb,text,jsonb,text,timestamptz)','graft_transition(uuid,uuid,text)',
    'graft_approve(uuid,uuid,text,text,timestamptz,jsonb)','graft_deny(public.graft_mandates,uuid,text,text)',
    'graft_claim_job(uuid,uuid,uuid,jsonb,text,text,int,int,int)','graft_commit_report(uuid,uuid,uuid,jsonb,text)','graft_fail_job(uuid,uuid,uuid,text,text)',
    'graft_propose(uuid,uuid,uuid,jsonb,text,timestamptz)','graft_decide_proposal(uuid,uuid,text,boolean)','graft_set_shared(uuid,uuid,boolean)','graft_on_agent_change()']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- Graft fixes (additive over 0022/0023):
--  * request-body hashes make draft/proposal retries clock-independent and race-safe (advisory lock per owner+request);
--  * evidence age is anchored to the OLDEST observation fetchedAt inside the latest report, never report created_at;
--  * proposal approval rechecks that evidence TTL at decision time;
--  * owner-only supporting-evidence links (Blind Bloom entries, research receipts) are append-only, allowed only
--    while the mandate is a draft, and approval binds their manifest hash;
--  * internal helpers are no longer directly executable by service_role (definer wrappers owned by postgres call them).

alter table public.graft_mandates add column if not exists request_body_hash text;
alter table public.graft_mandates add column if not exists evidence_manifest_hash text;
alter table public.graft_proposals add column if not exists request_body_hash text;
comment on column public.graft_mandates.request_body_hash is 'Hash of the normalized original draft request (terms only, no clock); set once.';
comment on column public.graft_mandates.evidence_manifest_hash is 'Hash of the attached supporting-evidence manifest frozen at approval; set once.';
comment on column public.graft_proposals.request_body_hash is 'Hash of the normalized original proposal request including minutes; set once.';

create or replace function public.graft_set_once() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'graft_mandates' then
    if (old.request_body_hash is not null and new.request_body_hash is distinct from old.request_body_hash)
       or (old.evidence_manifest_hash is not null and new.evidence_manifest_hash is distinct from old.evidence_manifest_hash) then
      raise exception 'graft request/evidence hashes are set once';
    end if;
  elsif old.request_body_hash is not null and new.request_body_hash is distinct from old.request_body_hash then
    raise exception 'graft request hashes are set once';
  end if;
  return new;
end $$;
drop trigger if exists graft_mandates_set_once on public.graft_mandates;
create trigger graft_mandates_set_once before update on public.graft_mandates for each row execute function public.graft_set_once();
drop trigger if exists graft_proposals_set_once on public.graft_proposals;
create trigger graft_proposals_set_once before update on public.graft_proposals for each row execute function public.graft_set_once();

-- Supporting evidence (never a permission): append-only, owner-scoped.
create table if not exists public.graft_evidence_links (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  mandate_id uuid not null references public.graft_mandates(id),
  kind text not null check (kind in ('bloom_entry','research_receipt')),
  ref_id uuid not null,
  agent_id text not null,
  policy_hash text not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null,
  manifest_hash text not null check (manifest_hash ~ '^[0-9a-f]{64}$'),
  attached_at timestamptz not null default now(),
  unique (mandate_id, kind, ref_id)
);
grant select on public.graft_evidence_links to authenticated;
grant all on public.graft_evidence_links to service_role;
alter table public.graft_evidence_links enable row level security;
create policy "graft evidence owner read" on public.graft_evidence_links for select to authenticated using (owner_id = auth.uid());
create trigger graft_evidence_append_only before update or delete on public.graft_evidence_links for each row execute function public.graft_append_only();

-- Evidence time of the latest report = its OLDEST observation fetchedAt (a late commit cannot extend the TTL).
create or replace function public.graft_evidence_at(_mandate uuid) returns timestamptz language sql stable security definer set search_path = public as $$
  select max(o) from (
    select (select min((x->>'fetchedAt')::timestamptz) from jsonb_array_elements(r.report->'observations') x) o
    from public.graft_reports r where r.mandate_id = _mandate
  ) s
$$;

create or replace function public.graft_create_draft_v2(_owner uuid, _request uuid, _agent text, _draft jsonb, _draft_hash text, _agent_version jsonb, _agent_version_hash text, _expires timestamptz, _body_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; r jsonb;
begin
  if _body_hash !~ '^[0-9a-f]{64}$' then raise exception 'request_mismatch: bad request hash'; end if;
  perform pg_advisory_xact_lock(hashtextextended('graft.draft:' || _owner::text || ':' || _request::text, 0));
  select * into m from public.graft_mandates where owner_id = _owner and request_id = _request;
  if found then
    if coalesce(m.request_body_hash, '') <> _body_hash then raise exception 'request_mismatch: this request id was used for a different draft'; end if;
    return jsonb_build_object('id', m.id, 'created', false, 'draftHash', m.draft_hash);
  end if;
  r := public.graft_create_draft(_owner, _request, _agent, _draft, _draft_hash, _agent_version, _agent_version_hash, _expires);
  update public.graft_mandates set request_body_hash = _body_hash where id = (r->>'id')::uuid and request_body_hash is null;
  return r || jsonb_build_object('draftHash', _draft_hash);
end $$;

create or replace function public.graft_attach_evidence(_owner uuid, _mandate uuid, _kind text, _ref uuid, _policy_hash text, _manifest jsonb, _manifest_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; l public.graft_evidence_links; ok boolean;
begin
  select * into m from public.graft_mandates where id = _mandate and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  select * into l from public.graft_evidence_links where mandate_id = _mandate and kind = _kind and ref_id = _ref;
  if found then
    if l.manifest_hash <> _manifest_hash then raise exception 'request_mismatch: this evidence was attached with a different manifest'; end if;
    return jsonb_build_object('id', l.id, 'created', false);
  end if;
  if m.status <> 'draft' then raise exception 'not_active: evidence can only be attached to a draft; start a new draft to change evidence'; end if;
  if octet_length(_manifest::text) > 8000 then raise exception 'evidence manifest too large'; end if;
  if (select count(*) from public.graft_evidence_links where mandate_id = _mandate) >= 6 then raise exception 'quota_exceeded: at most 6 evidence links'; end if;
  if (_manifest->>'agentId') is distinct from m.agent_id or (_manifest->>'policyHash') is distinct from _policy_hash or (_manifest->>'refId') is distinct from _ref::text or (_manifest->>'kind') is distinct from _kind then
    raise exception 'request_mismatch: evidence manifest does not bind this mandate agent';
  end if;
  -- The server derives _policy_hash from the live agent (whose DB digest must still match the frozen version);
  -- SQL additionally requires every link on one mandate to name the same policy.
  if exists (select 1 from public.graft_evidence_links where mandate_id = _mandate and policy_hash <> _policy_hash) then
    raise exception 'request_mismatch: all evidence on a mandate must cover the same agent policy';
  end if;
  if not public.graft_version_ok(m, _owner, m.agent_version_hash) then raise exception 'changed_config: the agent changed since this draft; start a new draft'; end if;
  if _kind = 'bloom_entry' then
    select exists(select 1 from public.bloom_entries e join public.bloom_rounds r on r.id = e.round_id
      where e.id = _ref and e.owner_id = _owner and e.agent_id = m.agent_id and e.base_policy_hash = _policy_hash and r.status = 'scored') into ok;
  else
    select exists(select 1 from public.research_receipts x where x.id = _ref and x.owner_id = _owner and x.status = 'signed') into ok;
  end if;
  if not ok then raise exception 'not_owner: evidence must be your own scored entry or signed receipt for this agent and policy'; end if;
  insert into public.graft_evidence_links(owner_id, mandate_id, kind, ref_id, agent_id, policy_hash, manifest, manifest_hash, attached_at)
    values (_owner, _mandate, _kind, _ref, m.agent_id, _policy_hash, _manifest, _manifest_hash, public.graft_now()) returning * into l;
  perform public.graft_log(_mandate, _owner, 'evidence_attached', m.status, m.status, jsonb_build_object('kind', _kind, 'ref', _ref, 'manifestHash', _manifest_hash));
  return jsonb_build_object('id', l.id, 'created', true);
end $$;

-- Approval v3: binds the supporting-evidence manifest (count + hash inside the hashed approval proof).
create or replace function public.graft_approve_v3(_owner uuid, _id uuid, _draft_hash text, _agent_version_hash text, _expires timestamptz, _agent_version jsonb, _proof jsonb, _proof_hash text, _proof_fetched_at timestamptz, _evidence_hash text, _evidence_count int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; r jsonb;
begin
  select * into m from public.graft_mandates where id = _id and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  if m.status = 'review' then
    if _evidence_hash !~ '^[0-9a-f]{64}$' or (_proof->>'evidenceManifestHash') is distinct from _evidence_hash
       or _evidence_count <> (select count(*) from public.graft_evidence_links where mandate_id = _id) then
      raise exception 'request_mismatch: approval evidence manifest does not match the attached evidence';
    end if;
  end if;
  r := public.graft_approve_v2(_owner, _id, _draft_hash, _agent_version_hash, _expires, _agent_version, _proof, _proof_hash, _proof_fetched_at);
  if (r->>'applied')::boolean then update public.graft_mandates set evidence_manifest_hash = _evidence_hash where id = _id and evidence_manifest_hash is null; end if;
  return r;
end $$;

create or replace function public.graft_propose_v3(_owner uuid, _mandate uuid, _request uuid, _proposal jsonb, _hash text, _expires timestamptz, _agent_version_hash text, _body_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.graft_mandates; p public.graft_proposals; ttl int; ev timestamptz; r jsonb;
begin
  if _body_hash !~ '^[0-9a-f]{64}$' then raise exception 'request_mismatch: bad request hash'; end if;
  perform pg_advisory_xact_lock(hashtextextended('graft.proposal:' || _owner::text || ':' || _request::text, 0));
  select * into m from public.graft_mandates where id = _mandate and owner_id = _owner for update;
  if not found then raise exception 'not_owner: mandate not found'; end if;
  select * into p from public.graft_proposals where owner_id = _owner and request_id = _request;
  if found then
    if coalesce(p.request_body_hash, '') <> _body_hash then raise exception 'request_mismatch: request id used for a different proposal'; end if;
    return jsonb_build_object('id', p.id, 'created', false, 'status', p.status);
  end if;
  if m.status = 'active' and m.expires_at <= public.graft_now() then perform public.graft_transition_internal(m, 'expired'); return jsonb_build_object('denied','expired_mandate'); end if;
  if m.status <> 'active' then raise exception 'not_active: proposals need an active, unexpired mandate (now %)', m.status; end if;
  if not public.graft_version_ok(m, _owner, _agent_version_hash) then perform public.graft_transition_internal(m, 'suspended'); return jsonb_build_object('denied','changed_config'); end if;
  if (_proposal->>'agentVersionHash') is distinct from m.agent_version_hash then raise exception 'request_mismatch: proposal names another agent version'; end if;
  ttl := (m.draft->>'evidenceTtlSecs')::int;
  ev := public.graft_evidence_at(m.id);
  if ev is null or ev < public.graft_now() - make_interval(secs => ttl) then
    raise exception 'stale_proof: run the steward first; proposals need observations fetched within the evidence TTL';
  end if;
  r := public.graft_propose(_owner, _mandate, _request, _proposal, _hash, _expires);
  update public.graft_proposals set request_body_hash = _body_hash where id = (r->>'id')::uuid and request_body_hash is null;
  return r;
end $$;

create or replace function public.graft_decide_v3(_owner uuid, _id uuid, _hash text, _approve boolean, _agent_version_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.graft_proposals; m public.graft_mandates; mid uuid; ttl int; ev timestamptz;
begin
  select mandate_id into mid from public.graft_proposals where id = _id and owner_id = _owner;
  if not found then raise exception 'not_owner: proposal not found'; end if;
  select * into m from public.graft_mandates where id = mid for update;
  select * into p from public.graft_proposals where id = _id for update;
  if p.proposal_hash <> _hash then raise exception 'request_mismatch: decision does not match the proposal'; end if;
  if p.status <> 'proposed' then return jsonb_build_object('status', p.status, 'applied', false); end if;
  if m.status = 'active' and not public.graft_version_ok(m, _owner, _agent_version_hash) then
    perform public.graft_transition_internal(m, 'suspended'); -- exit trigger expires the proposals
    return jsonb_build_object('status','expired','applied',true,'denied','changed_config');
  end if;
  if _approve then
    ttl := (m.draft->>'evidenceTtlSecs')::int;
    ev := public.graft_evidence_at(m.id);
    if m.status = 'active' and m.expires_at > public.graft_now() and p.expires_at > public.graft_now()
       and (ev is null or ev < public.graft_now() - make_interval(secs => ttl)) then
      return jsonb_build_object('status','proposed','applied',false,'denied','stale_proof');
    end if;
  end if;
  return public.graft_decide_proposal(_owner, _id, _hash, _approve);
end $$;

do $$ declare f text; begin
  foreach f in array array['graft_set_once()','graft_evidence_at(uuid)',
    'graft_create_draft_v2(uuid,uuid,text,jsonb,text,jsonb,text,timestamptz,text)','graft_attach_evidence(uuid,uuid,text,uuid,text,jsonb,text)',
    'graft_approve_v3(uuid,uuid,text,text,timestamptz,jsonb,jsonb,text,timestamptz,text,int)','graft_propose_v3(uuid,uuid,uuid,jsonb,text,timestamptz,text,text)',
    'graft_decide_v3(uuid,uuid,text,boolean,text)']
  loop execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop;
  foreach f in array array['graft_create_draft_v2(uuid,uuid,text,jsonb,text,jsonb,text,timestamptz,text)','graft_attach_evidence(uuid,uuid,text,uuid,text,jsonb,text)',
    'graft_approve_v3(uuid,uuid,text,text,timestamptz,jsonb,jsonb,text,timestamptz,text,int)','graft_propose_v3(uuid,uuid,uuid,jsonb,text,timestamptz,text,text)',
    'graft_decide_v3(uuid,uuid,text,boolean,text)']
  loop execute format('grant execute on function public.%s to service_role', f); end loop;
  -- Retired or internal: callable only by the postgres-owned definer wrappers.
  foreach f in array array['graft_create_draft(uuid,uuid,text,jsonb,text,jsonb,text,timestamptz)','graft_approve_v2(uuid,uuid,text,text,timestamptz,jsonb,jsonb,text,timestamptz)',
    'graft_propose_v2(uuid,uuid,uuid,jsonb,text,timestamptz,text)','graft_decide_v2(uuid,uuid,text,boolean,text)',
    'graft_deny(public.graft_mandates,uuid,text,text)','graft_deny2(public.graft_mandates,uuid,text,text,jsonb)','graft_version_ok(public.graft_mandates,uuid,text)',
    'graft_transition_internal(public.graft_mandates,text)','graft_log(uuid,uuid,text,text,text,jsonb)','graft_on_agent_change()','graft_on_mandate_exit()']
  loop execute format('revoke execute on function public.%s from public, anon, authenticated, service_role', f); end loop;
end $$;

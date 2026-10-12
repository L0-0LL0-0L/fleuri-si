-- Pollen Access v2.1 (additive, after 0017): deep-trial credits bind durably at the Greenhouse claim, in the same
-- transaction that creates the frozen run, so once a deep run exists its credit counts across lease expiry and
-- across every workspace on the wallet. A worker without a current lease can never create a deep run.
-- Bonus-cycle commits also verify the agent belongs to the owner and matches the reserved input hash.

-- Bind any reserved deep credit whose frozen run already exists (and didn't fail) to that run. Used by acquire
-- (wallet-serialized, before quota counting) to reconcile rows created before this migration.
create or replace function public.access_bind_deep_runs(_wallet text)
returns int language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  update public.access_reservations a set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null,
      result=jsonb_build_object('run_id',g.id,'lease',a.lease_token)
    from public.greenhouse_runs g
    where a.wallet=_wallet and a.action='deep_trial' and a.status='reserved'
      and g.owner_id=a.owner_id and g.request_id::text=a.request_key and g.status <> 'failed';
  get diagnostics n = row_count;
  return n;
end $$;

-- Same as 0017's access_acquire, plus: reconcile durable deep runs before counting the wallet's quota.
create or replace function public.access_acquire(_owner uuid, _action text, _key text, _input_hash text, _wallet text, _eligible boolean,
  _limit int, _evidence jsonb, _lease_secs int default 120, _max_inflight int default 2)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; d date := (now() at time zone 'utc')::date; n int; tok uuid; g public.greenhouse_runs;
begin
  if _owner is null or _action is null or _key is null or _input_hash is null or _eligible is null then raise exception 'access: owner, action, key, input and eligibility are required'; end if;
  if _action not in ('owner_cycle','deep_trial','research_report') then raise exception 'access: unknown action'; end if;
  if length(_key) not between 8 and 128 or _input_hash !~ '^[0-9a-f]{64}$' then raise exception 'access: invalid key or input hash'; end if;
  if _limit is null or _limit < 0 or _limit > 1000 or _lease_secs < 10 or _lease_secs > 900 or _max_inflight < 1 or _max_inflight > 10 then raise exception 'access: invalid limits'; end if;
  perform pg_advisory_xact_lock(hashtextextended('access-owner:' || _owner::text, 0));
  select * into r from public.access_reservations where owner_id=_owner and action=_action and request_key=_key for update;
  if r.id is not null then
    if r.input_hash is distinct from _input_hash then raise exception 'access_conflict: this request id was already used with different input'; end if;
    if r.status = 'consumed' then return jsonb_build_object('id',r.id,'state','done','result',r.result); end if;
    if r.status = 'reserved' and r.lease_expires_at > now() then raise exception 'access_inflight: this request is already running'; end if;
    if r.status = 'reserved' and _action = 'deep_trial' then
      select * into g from public.greenhouse_runs where owner_id=_owner and request_id::text=_key;
      if g.id is not null and g.status <> 'failed' then
        update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null,
          result=jsonb_build_object('run_id',g.id,'lease',r.lease_token) where id=r.id returning * into r;
        return jsonb_build_object('id',r.id,'state','done','result',r.result);
      end if;
    end if;
  end if;
  if not _eligible or _wallet is null then raise exception 'access_locked: no verified Pollen Access for this workspace'; end if;
  perform pg_advisory_xact_lock(hashtextextended('access-wallet:' || _wallet, 0));
  perform public.access_bind_deep_runs(_wallet);
  select count(*) into n from public.access_reservations where wallet=_wallet and status='reserved' and lease_expires_at > now() and id is distinct from r.id;
  if n >= _max_inflight then raise exception 'access_busy: % Pollen Access actions are already running for this wallet', n; end if;
  select count(*) into n from public.access_reservations where wallet=_wallet and action=_action and day=d and (status='consumed' or (status='reserved' and lease_expires_at > now())) and id is distinct from r.id;
  if n >= _limit then raise exception 'access_exhausted: today''s Pollen Access allowance for this wallet is used up'; end if;
  tok := gen_random_uuid();
  if r.id is not null then
    update public.access_reservations set status='reserved', tier='extra', day=d, wallet=_wallet, evidence=_evidence, lease_token=tok,
      lease_expires_at=now()+make_interval(secs=>_lease_secs), generation=generation+1, finished_at=null, result=null where id=r.id returning * into r;
  else
    insert into public.access_reservations(owner_id,action,request_key,day,tier,status,wallet,input_hash,evidence,lease_token,lease_expires_at,generation)
      values(_owner,_action,_key,d,'extra','reserved',_wallet,_input_hash,_evidence,tok,now()+make_interval(secs=>_lease_secs),1) returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'state','acquired','lease',tok,'generation',r.generation);
end $$;

-- The ONLY way a deep-profile trial is claimed. With a current lease it creates/claims the frozen run and binds the
-- credit in one transaction; with an already-bound credit it only recovers the existing run (never creates one).
create or replace function public.access_claim_deep_trial(_owner uuid, _id uuid, _lease uuid, _request uuid, _engine text, _agents text[], _input jsonb, _input_hash text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; g public.greenhouse_runs; res jsonb;
begin
  if _owner is null or _id is null or _request is null or _input is null then raise exception 'access: claim fields are required'; end if;
  if (_input->'config'->>'profile') is distinct from 'deep-1' then raise exception 'access: only deep-profile trials use this claim'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner and action='deep_trial' for update;
  if r.id is null or r.request_key is distinct from _request::text then raise exception 'access: reservation does not match this request'; end if;
  perform pg_advisory_xact_lock(hashtextextended('access-wallet:' || coalesce(r.wallet,''), 0));
  select * into g from public.greenhouse_runs where owner_id=_owner and request_id=_request;
  if r.status = 'consumed' then
    if g.id is null or (r.result->>'run_id') is distinct from g.id::text then raise exception 'access_stale: no bound trial to recover'; end if;
    return public.greenhouse_claim_lease(_owner,_request,_engine,_agents,_input,_input_hash);
  end if;
  if r.status <> 'reserved' or _lease is null or r.lease_token is distinct from _lease or r.lease_expires_at <= now() then
    raise exception 'access_stale: this reservation lease is no longer current';
  end if;
  res := public.greenhouse_claim_lease(_owner,_request,_engine,_agents,_input,_input_hash);
  select * into g from public.greenhouse_runs where owner_id=_owner and request_id=_request;
  if g.id is not null and g.status <> 'failed' then
    update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null,
      result=jsonb_build_object('run_id',g.id,'lease',_lease) where id=_id;
  end if;
  return res;
end $$;

-- Settle after the trial attempt. Reserved with a current lease and no run -> refund. Bound credit whose run then
-- failed terminally -> refund (only the claiming lease may do this). Otherwise unchanged.
create or replace function public.access_settle_trial(_owner uuid, _id uuid, _lease uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; g public.greenhouse_runs;
begin
  if _owner is null or _id is null or _lease is null then raise exception 'access: settle fields are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner and action='deep_trial' for update;
  if r.id is null then raise exception 'access: reservation not found'; end if;
  select * into g from public.greenhouse_runs where owner_id=_owner and request_id::text=r.request_key;
  if r.status = 'consumed' then
    if (r.result->>'lease') = _lease::text and g.id is not null and g.status = 'failed' then
      update public.access_reservations set status='refunded', finished_at=now() where id=_id returning * into r;
      return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
    end if;
    return jsonb_build_object('id',r.id,'status',r.status,'applied',false);
  end if;
  if r.status <> 'reserved' or r.lease_token is distinct from _lease then raise exception 'access_stale: this reservation lease is no longer current'; end if;
  if g.id is not null and g.status <> 'failed' then
    update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null, result=jsonb_build_object('run_id',g.id,'lease',_lease) where id=_id returning * into r;
  else
    update public.access_reservations set status='refunded', finished_at=now(), lease_token=null, lease_expires_at=null where id=_id returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
end $$;

-- Bonus cycle commit: current lease, unique bucket, and the cycle's agent must be the owner's and match the reservation.
create or replace function public.access_commit_cycle(_owner uuid, _id uuid, _lease uuid, p jsonb, _result jsonb)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; v bigint; ag text;
begin
  if _owner is null or _id is null or _lease is null or p is null then raise exception 'access: commit fields are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner and action='owner_cycle' for update;
  if r.id is null or r.status <> 'reserved' or r.lease_token is distinct from _lease or r.lease_expires_at <= now() then raise exception 'access_stale: this reservation lease is no longer current'; end if;
  if jsonb_array_length(coalesce(p->'cycles','[]'::jsonb)) <> 1 or (p->'cycles'->0->>'bucket') is distinct from ('access:' || _id::text) then
    raise exception 'access: the cycle is not bound to this reservation';
  end if;
  ag := p->'cycles'->0->>'agent_id';
  if ag is null or not exists (select 1 from public.agents where id=ag and owner_id=_owner::text) then raise exception 'access: the cycle agent is not yours'; end if;
  if r.input_hash not in (encode(sha256(convert_to('bonus|' || ag || '|0','UTF8')),'hex'), encode(sha256(convert_to('bonus|' || ag || '|1','UTF8')),'hex')) then
    raise exception 'access: the cycle agent does not match the reserved request';
  end if;
  v := public.garden_commit(p);
  update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null, result=_result where id=_id;
  return v;
end $$;

revoke all on function public.access_bind_deep_runs(text) from public, anon, authenticated;
revoke all on function public.access_claim_deep_trial(uuid,uuid,uuid,uuid,text,text[],jsonb,text) from public, anon, authenticated;
revoke all on function public.access_acquire(uuid,text,text,text,text,boolean,int,jsonb,int,int) from public, anon, authenticated;
revoke all on function public.access_settle_trial(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.access_commit_cycle(uuid,uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.access_bind_deep_runs(text) to service_role;
grant execute on function public.access_claim_deep_trial(uuid,uuid,uuid,uuid,text,text[],jsonb,text) to service_role;
grant execute on function public.access_acquire(uuid,text,text,text,text,boolean,int,jsonb,int,int) to service_role;
grant execute on function public.access_settle_trial(uuid,uuid,uuid) to service_role;
grant execute on function public.access_commit_cycle(uuid,uuid,uuid,jsonb,jsonb) to service_role;

-- Backfill: bind deep credits from 0017 whose frozen run already exists, so usage counts them immediately.
select public.access_bind_deep_runs(w.wallet) from (select distinct wallet from public.access_reservations where action='deep_trial' and status='reserved' and wallet is not null) w;

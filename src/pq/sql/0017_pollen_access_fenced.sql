-- Pollen Access v2: dedicated extra actions only (free cycles/trials are no longer metered at all),
-- a shared WALLET + UTC-day budget, lease-fenced reservations with an immutable input hash, and
-- effect-bound completion (cycle commit + debit in one transaction; trials bound to their frozen run).
-- Additive: new columns/functions; v1 functions are retired in place.
alter table public.access_reservations add column if not exists wallet text;
alter table public.access_reservations add column if not exists input_hash text;
alter table public.access_reservations add column if not exists lease_token uuid;
alter table public.access_reservations add column if not exists lease_expires_at timestamptz;
alter table public.access_reservations add column if not exists generation int not null default 0;
alter table public.access_reservations add column if not exists result jsonb;
create index if not exists access_reservations_wallet_day on public.access_reservations (wallet, action, day, status);
comment on column public.access_reservations.tier is 'DEPRECATED: v2 has no free tier; every v2 reservation is extra';

-- Quota = consumed + live leases for the wallet/action/UTC day. An expired lease no longer counts and can no
-- longer commit (cycles/reports), so a stale worker can never push a wallet over its budget.
-- Acquire (or recover) the lease for one extra action. Returns state done | acquired.
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
      -- A crashed deep-trial worker: if its frozen run exists, the credit is bound to it, never re-spent or refunded.
      select * into g from public.greenhouse_runs where owner_id=_owner and request_id=_key::uuid;
      if g.id is not null and g.status <> 'failed' then
        update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null,
          result=jsonb_build_object('run_id',g.id) where id=r.id returning * into r;
        return jsonb_build_object('id',r.id,'state','done','result',r.result);
      end if;
    end if;
  end if;
  if not _eligible or _wallet is null then raise exception 'access_locked: no verified Pollen Access for this workspace'; end if;
  perform pg_advisory_xact_lock(hashtextextended('access-wallet:' || _wallet, 0));
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

-- Refund a failed attempt. Only the current lease holder can refund, and a deep trial whose run exists is consumed instead.
create or replace function public.access_release(_owner uuid, _id uuid, _lease uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; g public.greenhouse_runs;
begin
  if _owner is null or _id is null or _lease is null then raise exception 'access: owner, reservation and lease are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner for update;
  if r.id is null then raise exception 'access: reservation not found'; end if;
  if r.status <> 'reserved' or r.lease_token is distinct from _lease then return jsonb_build_object('id',r.id,'status',r.status,'applied',false); end if;
  if r.action = 'deep_trial' then
    select * into g from public.greenhouse_runs where owner_id=_owner and request_id=r.request_key::uuid;
    if g.id is not null and g.status <> 'failed' then
      update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null, result=jsonb_build_object('run_id',g.id) where id=_id returning * into r;
      return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
    end if;
  end if;
  update public.access_reservations set status='refunded', finished_at=now(), lease_token=null, lease_expires_at=null where id=_id returning * into r;
  return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
end $$;

-- Extra cycle: the garden effect and the debit commit in ONE transaction, fenced by the lease and bound to the
-- reservation's unique cycle bucket. A stale lease cannot commit; a committed effect can never be refunded.
create or replace function public.access_commit_cycle(_owner uuid, _id uuid, _lease uuid, p jsonb, _result jsonb)
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; v bigint;
begin
  if _owner is null or _id is null or _lease is null or p is null then raise exception 'access: commit fields are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner and action='owner_cycle' for update;
  if r.id is null or r.status <> 'reserved' or r.lease_token is distinct from _lease or r.lease_expires_at <= now() then raise exception 'access_stale: this reservation lease is no longer current'; end if;
  if jsonb_array_length(coalesce(p->'cycles','[]'::jsonb)) <> 1 or (p->'cycles'->0->>'bucket') is distinct from ('access:' || _id::text) then
    raise exception 'access: the cycle is not bound to this reservation';
  end if;
  v := public.garden_commit(p);
  update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null, result=_result where id=_id;
  return v;
end $$;

-- Deep trial: settle after the fenced Greenhouse start. Consumed iff the frozen run for this request exists and didn't fail.
create or replace function public.access_settle_trial(_owner uuid, _id uuid, _lease uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; g public.greenhouse_runs;
begin
  if _owner is null or _id is null or _lease is null then raise exception 'access: settle fields are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner and action='deep_trial' for update;
  if r.id is null then raise exception 'access: reservation not found'; end if;
  if r.status = 'consumed' then return jsonb_build_object('id',r.id,'status',r.status,'applied',false); end if;
  if r.status <> 'reserved' or r.lease_token is distinct from _lease then raise exception 'access_stale: this reservation lease is no longer current'; end if;
  select * into g from public.greenhouse_runs where owner_id=_owner and request_id=r.request_key::uuid;
  if g.id is not null and g.status <> 'failed' then
    update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null, result=jsonb_build_object('run_id',g.id) where id=_id returning * into r;
  else
    update public.access_reservations set status='refunded', finished_at=now(), lease_token=null, lease_expires_at=null where id=_id returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
end $$;

-- Research credit: store the report and consume in one transaction, fenced by lease and bound to the frozen mint.
create or replace function public.access_store_report(_owner uuid, _id uuid, _lease uuid, _mint text, _report jsonb, _digest text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; x public.access_reports;
begin
  if _owner is null or _id is null or _lease is null or _mint is null or _report is null or _digest is null then raise exception 'access: report fields are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner and action='research_report' for update;
  if r.id is null or r.status <> 'reserved' or r.lease_token is distinct from _lease or r.lease_expires_at <= now() then raise exception 'access_stale: this reservation lease is no longer current'; end if;
  if r.input_hash is distinct from encode(sha256(convert_to('report|' || _mint, 'UTF8')), 'hex') then raise exception 'access: report mint does not match the reserved request'; end if;
  insert into public.access_reports(owner_id,reservation_id,mint,report,digest) values(_owner,_id,_mint,_report,_digest) returning * into x;
  update public.access_reservations set status='consumed', finished_at=now(), lease_token=null, lease_expires_at=null, result=jsonb_build_object('report_id',x.id) where id=_id;
  return jsonb_build_object('id',x.id,'created',true);
end $$;

-- Retire v1 entry points (per-owner base allowance, unfenced finish/save).
create or replace function public.access_reserve(_owner uuid, _action text, _key text, _base int, _extra int, _eligible boolean, _evidence jsonb, _max_inflight int default 2)
returns jsonb language plpgsql security definer set search_path to 'public' as $$ begin raise exception 'Obsolete: use access_acquire'; end $$;
create or replace function public.access_finish(_owner uuid, _id uuid, _ok boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$ begin raise exception 'Obsolete: use access_release / access_commit_cycle / access_settle_trial / access_store_report'; end $$;
create or replace function public.access_save_report(_owner uuid, _reservation uuid, _mint text, _report jsonb, _digest text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$ begin raise exception 'Obsolete: use access_store_report'; end $$;

revoke all on function public.access_acquire(uuid,text,text,text,text,boolean,int,jsonb,int,int) from public, anon, authenticated;
revoke all on function public.access_release(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.access_commit_cycle(uuid,uuid,uuid,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.access_settle_trial(uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.access_store_report(uuid,uuid,uuid,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.access_acquire(uuid,text,text,text,text,boolean,int,jsonb,int,int) to service_role;
grant execute on function public.access_release(uuid,uuid,uuid) to service_role;
grant execute on function public.access_commit_cycle(uuid,uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.access_settle_trial(uuid,uuid,uuid) to service_role;
grant execute on function public.access_store_report(uuid,uuid,uuid,text,jsonb,text) to service_role;

-- Pollen Access v1: metered owner actions with atomic reserve -> consume/refund.
-- Additive only. Owners can read their own rows; every write goes through service-role-only functions.
create table if not exists public.access_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  action text not null check (action in ('owner_cycle','deep_trial','research_report')),
  request_key text not null check (length(request_key) between 8 and 128),
  day date not null,
  tier text not null check (tier in ('base','extra')),
  status text not null default 'reserved' check (status in ('reserved','consumed','refunded')),
  evidence jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_id, action, request_key)
);
create index if not exists access_reservations_quota on public.access_reservations (owner_id, action, day, tier, status);

create table if not exists public.access_eligibility (
  owner_id uuid primary key,
  wallet text,
  eligible boolean not null default false,
  active_stake text,
  slot bigint,
  cluster text,
  blockers jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now()
);

create table if not exists public.access_reports (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  reservation_id uuid not null unique references public.access_reservations(id),
  mint text not null check (length(mint) between 32 and 44),
  report jsonb not null,
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index if not exists access_reports_owner on public.access_reports (owner_id, created_at desc);

revoke all on public.access_reservations, public.access_eligibility, public.access_reports from public, anon, authenticated;
grant select on public.access_reservations, public.access_eligibility, public.access_reports to authenticated;
grant all on public.access_reservations, public.access_eligibility, public.access_reports to service_role;
alter table public.access_reservations enable row level security;
alter table public.access_eligibility enable row level security;
alter table public.access_reports enable row level security;
drop policy if exists "own access reservations" on public.access_reservations;
create policy "own access reservations" on public.access_reservations for select to authenticated using (owner_id = auth.uid());
drop policy if exists "own access eligibility" on public.access_eligibility;
create policy "own access eligibility" on public.access_eligibility for select to authenticated using (owner_id = auth.uid());
drop policy if exists "own access reports" on public.access_reports;
create policy "own access reports" on public.access_reports for select to authenticated using (owner_id = auth.uid());

-- Reserve one unit of an action for an owner, idempotent per (owner, action, request_key).
-- Base (free) units are used first; extra units need _eligible. Stale reservations (>10 min) are refunded.
create or replace function public.access_reserve(_owner uuid, _action text, _key text, _base int, _extra int, _eligible boolean, _evidence jsonb, _max_inflight int default 2)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; d date := (now() at time zone 'utc')::date; nb int; ne int; nf int; t text;
begin
  if _owner is null or _action is null or _key is null or _eligible is null then raise exception 'access: owner, action, key and eligibility are required'; end if;
  if _base is null or _extra is null or _base < 0 or _extra < 0 or _base > 1000 or _extra > 1000 or _max_inflight < 1 or _max_inflight > 10 then raise exception 'access: invalid limits'; end if;
  perform pg_advisory_xact_lock(hashtextextended('access:' || _owner::text, 0));
  update public.access_reservations set status='refunded', finished_at=now()
    where owner_id=_owner and status='reserved' and created_at < now() - interval '10 minutes';
  select * into r from public.access_reservations where owner_id=_owner and action=_action and request_key=_key for update;
  if r.id is not null and r.status <> 'refunded' then
    return jsonb_build_object('id',r.id,'status',r.status,'tier',r.tier,'replay',true);
  end if;
  select count(*) into nf from public.access_reservations where owner_id=_owner and action=_action and status='reserved';
  if nf >= _max_inflight then raise exception 'access_busy: % actions of this kind are already in progress', nf; end if;
  select count(*) filter (where tier='base'), count(*) filter (where tier='extra') into nb, ne
    from public.access_reservations where owner_id=_owner and action=_action and day=d and status in ('reserved','consumed');
  if nb < _base then t := 'base';
  elsif not _eligible then raise exception 'access_locked: free daily allowance used and no verified Pollen Access';
  elsif ne < _extra then t := 'extra';
  else raise exception 'access_exhausted: today''s Pollen Access allowance for this action is used up';
  end if;
  if r.id is not null then
    update public.access_reservations set status='reserved', tier=t, day=d, evidence=_evidence, created_at=now(), finished_at=null where id=r.id returning * into r;
  else
    insert into public.access_reservations(owner_id,action,request_key,day,tier,evidence) values(_owner,_action,_key,d,t,_evidence) returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'tier',r.tier,'replay',false);
end $$;

-- Finish a reservation: consume on success, refund on failure. Consumed is final.
create or replace function public.access_finish(_owner uuid, _id uuid, _ok boolean)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations;
begin
  if _owner is null or _id is null or _ok is null then raise exception 'access: owner, reservation and result are required'; end if;
  select * into r from public.access_reservations where id=_id and owner_id=_owner for update;
  if r.id is null then raise exception 'access: reservation not found'; end if;
  if r.status = 'consumed' then return jsonb_build_object('id',r.id,'status',r.status,'applied',false); end if;
  if not _ok and r.status = 'refunded' then return jsonb_build_object('id',r.id,'status',r.status,'applied',false); end if;
  -- A late success after a stale refund is still counted, so completed work is never free.
  update public.access_reservations set status=case when _ok then 'consumed' else 'refunded' end, finished_at=now() where id=_id returning * into r;
  return jsonb_build_object('id',r.id,'status',r.status,'applied',true);
end $$;

-- Store a research report and consume its reservation in one transaction (idempotent per reservation).
create or replace function public.access_save_report(_owner uuid, _reservation uuid, _mint text, _report jsonb, _digest text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.access_reservations; x public.access_reports;
begin
  if _owner is null or _reservation is null or _mint is null or _report is null or _digest is null then raise exception 'access: report fields are required'; end if;
  select * into r from public.access_reservations where id=_reservation and owner_id=_owner and action='research_report' for update;
  if r.id is null then raise exception 'access: reservation not found'; end if;
  select * into x from public.access_reports where reservation_id=_reservation;
  if x.id is not null then return jsonb_build_object('id',x.id,'created',false); end if;
  if r.status = 'refunded' and r.finished_at is not null and r.created_at < now() - interval '10 minutes' then null; end if;
  insert into public.access_reports(owner_id,reservation_id,mint,report,digest) values(_owner,_reservation,_mint,_report,_digest) returning * into x;
  update public.access_reservations set status='consumed', finished_at=now() where id=_reservation;
  return jsonb_build_object('id',x.id,'created',true);
end $$;

create or replace function public.access_set_eligibility(_owner uuid, _wallet text, _eligible boolean, _active text, _slot bigint, _cluster text, _blockers jsonb)
returns void language sql security definer set search_path to 'public' as $$
  insert into public.access_eligibility(owner_id,wallet,eligible,active_stake,slot,cluster,blockers,checked_at)
  values(_owner,_wallet,coalesce(_eligible,false),_active,_slot,_cluster,coalesce(_blockers,'[]'::jsonb),now())
  on conflict (owner_id) do update set wallet=excluded.wallet, eligible=excluded.eligible, active_stake=excluded.active_stake,
    slot=excluded.slot, cluster=excluded.cluster, blockers=excluded.blockers, checked_at=excluded.checked_at;
$$;

revoke all on function public.access_reserve(uuid,text,text,int,int,boolean,jsonb,int) from public, anon, authenticated;
revoke all on function public.access_finish(uuid,uuid,boolean) from public, anon, authenticated;
revoke all on function public.access_save_report(uuid,uuid,text,jsonb,text) from public, anon, authenticated;
revoke all on function public.access_set_eligibility(uuid,text,boolean,text,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.access_reserve(uuid,text,text,int,int,boolean,jsonb,int) to service_role;
grant execute on function public.access_finish(uuid,uuid,boolean) to service_role;
grant execute on function public.access_save_report(uuid,uuid,text,jsonb,text) to service_role;
grant execute on function public.access_set_eligibility(uuid,text,boolean,text,bigint,text,jsonb) to service_role;

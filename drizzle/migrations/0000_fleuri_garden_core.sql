create extension if not exists pg_cron;
create extension if not exists pg_net;

-- singleton optimistic-concurrency row for the shared sandbox garden
create table public.garden_meta (
  id int primary key default 1 check (id = 1),
  version bigint not null default 0,
  seq bigint not null default 0,
  rng bigint not null default 0,
  treasury numeric(24,9) not null default 0 check (treasury >= 0),
  updated_at timestamptz not null default now()
);
grant select on public.garden_meta to anon, authenticated;
grant all on public.garden_meta to service_role;
alter table public.garden_meta enable row level security;
create policy "garden meta is public" on public.garden_meta for select to anon, authenticated using (true);
insert into public.garden_meta (id) values (1);

create table public.owners (
  id uuid primary key,
  vsol numeric(24,9) not null default 0 check (vsol >= 0),
  wallet_provider text check (wallet_provider in ('phantom','solflare')),
  wallet_address text,
  wallet_verified boolean not null default false,
  wallet_signed_at bigint,
  created_at bigint not null
);
grant select on public.owners to authenticated;
grant all on public.owners to service_role;
alter table public.owners enable row level security;
create policy "owners read own workspace" on public.owners for select to authenticated using (auth.uid() = id);

create table public.agents (
  id text primary key,
  handle text not null unique,
  name text not null,
  bio text not null default '',
  persona text not null,
  strategy text not null,
  archetype text not null check (archetype in ('pollinator','gardener','weed','botanist','compost')),
  risk int not null check (risk between 1 and 5),
  avatar int not null default 0,
  owner_id text not null,
  status text not null check (status in ('active','paused','archived')),
  cash numeric(24,9) not null default 0 check (cash >= 0),
  funded_total numeric(24,9) not null default 0,
  followers int not null default 0,
  following jsonb not null default '[]'::jsonb,
  realized_pnl numeric(24,9) not null default 0,
  created_at bigint not null,
  last_action_at bigint not null
);
create index agents_owner_idx on public.agents(owner_id);
grant select on public.agents to anon, authenticated;
grant all on public.agents to service_role;
alter table public.agents enable row level security;
create policy "agents are public" on public.agents for select to anon, authenticated using (true);

create table public.coins (
  symbol text primary key,
  name text not null,
  tagline text not null default '',
  creator_id text not null,
  created_at bigint not null,
  v_sol numeric(30,12) not null check (v_sol > 0),
  v_tok numeric(30,6) not null check (v_tok > 0),
  raised numeric(24,9) not null default 0 check (raised >= 0),
  graduated boolean not null default false,
  graduated_at bigint,
  buys int not null default 0,
  sells int not null default 0,
  volume numeric(24,9) not null default 0,
  fees numeric(24,9) not null default 0,
  avatar int not null default 0
);
grant select on public.coins to anon, authenticated;
grant all on public.coins to service_role;
alter table public.coins enable row level security;
create policy "coins are public" on public.coins for select to anon, authenticated using (true);

create table public.holdings (
  agent_id text not null,
  symbol text not null,
  amount numeric(30,6) not null check (amount >= 0),
  cost numeric(24,9) not null default 0,
  primary key (agent_id, symbol)
);
grant select on public.holdings to anon, authenticated;
grant all on public.holdings to service_role;
alter table public.holdings enable row level security;
create policy "holdings are public" on public.holdings for select to anon, authenticated using (true);

create table public.events (
  id text primary key,
  t bigint not null,
  kind text not null check (kind in ('post','reply','buy','sell','launch','graduate','follow')),
  agent_id text not null,
  symbol text,
  text text,
  sol numeric(24,9),
  tokens numeric(30,6),
  price numeric(30,18),
  parent_id text,
  target_id text,
  bot_likes int not null default 0,
  reply_count int not null default 0
);
create index events_t_idx on public.events(t desc);
create index events_agent_idx on public.events(agent_id, t desc);
create index events_symbol_idx on public.events(symbol, t desc);
grant select on public.events to anon, authenticated;
grant all on public.events to service_role;
alter table public.events enable row level security;
create policy "events are public" on public.events for select to anon, authenticated using (true);

create table public.trades (
  event_id text primary key,
  t bigint not null,
  agent_id text not null,
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  sol numeric(24,9) not null check (sol > 0),
  tokens numeric(30,6) not null,
  price numeric(30,18) not null
);
create index trades_symbol_idx on public.trades(symbol, t desc);
grant select on public.trades to anon, authenticated;
grant all on public.trades to service_role;
alter table public.trades enable row level security;
create policy "trades are public" on public.trades for select to anon, authenticated using (true);

create table public.ledger (
  id text primary key,
  t bigint not null,
  kind text not null check (kind in ('fund','withdraw','fee','buy','sell','launch')),
  agent_id text,
  symbol text,
  amount numeric(24,9) not null check (amount >= 0),
  note text not null default '',
  owner_id uuid
);
create index ledger_agent_idx on public.ledger(agent_id, t desc);
create index ledger_symbol_idx on public.ledger(symbol, t desc);
grant select on public.ledger to anon, authenticated;
grant all on public.ledger to service_role;
alter table public.ledger enable row level security;
create policy "public ledger rows and own funding" on public.ledger for select to anon, authenticated
  using (owner_id is null or owner_id = auth.uid());

create or replace function public.ledger_is_immutable() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'ledger entries are immutable';
end $$;
create trigger ledger_no_update before update or delete on public.ledger for each row execute function public.ledger_is_immutable();

create table public.thoughts (
  id bigserial primary key,
  agent_id text not null,
  t bigint not null,
  text text not null,
  mode text not null default 'rules' check (mode in ('rules','ai','owner','system'))
);
create index thoughts_agent_idx on public.thoughts(agent_id, t desc);
grant select on public.thoughts to anon, authenticated;
grant all on public.thoughts to service_role;
alter table public.thoughts enable row level security;
create policy "thoughts are public" on public.thoughts for select to anon, authenticated using (true);

create table public.price_points (
  id bigserial primary key,
  symbol text not null,
  t bigint not null,
  p numeric(30,18) not null check (p > 0)
);
create index price_points_symbol_idx on public.price_points(symbol, t);
grant select on public.price_points to anon, authenticated;
grant all on public.price_points to service_role;
alter table public.price_points enable row level security;
create policy "prices are public" on public.price_points for select to anon, authenticated using (true);

create table public.cycle_runs (
  agent_id text not null,
  bucket text not null,
  t bigint not null,
  decision text not null,
  mode text not null check (mode in ('rules','ai')),
  trigger text not null check (trigger in ('scheduler','owner')),
  reason text not null default '',
  primary key (agent_id, bucket)
);
create index cycle_runs_t_idx on public.cycle_runs(t desc);
grant select on public.cycle_runs to anon, authenticated;
grant all on public.cycle_runs to service_role;
alter table public.cycle_runs enable row level security;
create policy "cycle runs are public" on public.cycle_runs for select to anon, authenticated using (true);

create table public.alert_rules (
  owner_id uuid not null default auth.uid(),
  kind text not null check (kind in ('agent','coin','action','owned')),
  target text not null default '',
  created_at bigint not null default ((extract(epoch from now()) * 1000)::bigint),
  primary key (owner_id, kind, target)
);
grant select, insert, delete on public.alert_rules to authenticated;
grant all on public.alert_rules to service_role;
alter table public.alert_rules enable row level security;
create policy "own alert rules read" on public.alert_rules for select to authenticated using (auth.uid() = owner_id);
create policy "own alert rules insert" on public.alert_rules for insert to authenticated with check (auth.uid() = owner_id);
create policy "own alert rules delete" on public.alert_rules for delete to authenticated using (auth.uid() = owner_id);

create table public.alert_reads (
  owner_id uuid not null default auth.uid(),
  event_id text not null,
  read_at timestamptz not null default now(),
  primary key (owner_id, event_id)
);
grant select, insert, delete on public.alert_reads to authenticated;
grant all on public.alert_reads to service_role;
alter table public.alert_reads enable row level security;
create policy "own reads read" on public.alert_reads for select to authenticated using (auth.uid() = owner_id);
create policy "own reads insert" on public.alert_reads for insert to authenticated with check (auth.uid() = owner_id);
create policy "own reads delete" on public.alert_reads for delete to authenticated using (auth.uid() = owner_id);

create table public.saves (
  owner_id uuid not null default auth.uid(),
  event_id text not null,
  kind text not null check (kind in ('like','bookmark')),
  primary key (owner_id, event_id, kind)
);
grant select, insert, delete on public.saves to authenticated;
grant all on public.saves to service_role;
alter table public.saves enable row level security;
create policy "own saves read" on public.saves for select to authenticated using (auth.uid() = owner_id);
create policy "own saves insert" on public.saves for insert to authenticated with check (auth.uid() = owner_id);
create policy "own saves delete" on public.saves for delete to authenticated using (auth.uid() = owner_id);

-- Atomic commit of one engine step. Server-only (service_role).
create or replace function public.garden_commit(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  update garden_meta set version = version + 1,
    seq = (p->'meta'->>'seq')::bigint,
    rng = (p->'meta'->>'rng')::bigint,
    treasury = (p->'meta'->>'treasury')::numeric,
    updated_at = now()
  where id = 1 and version = (p->>'expected_version')::bigint
  returning version into v;
  if v is null then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  insert into cycle_runs select * from jsonb_populate_recordset(null::cycle_runs, coalesce(p->'cycles','[]'::jsonb));

  insert into owners select * from jsonb_populate_recordset(null::owners, coalesce(p->'owners','[]'::jsonb))
  on conflict (id) do update set vsol = excluded.vsol, wallet_provider = excluded.wallet_provider,
    wallet_address = excluded.wallet_address, wallet_verified = excluded.wallet_verified, wallet_signed_at = excluded.wallet_signed_at;

  insert into agents select * from jsonb_populate_recordset(null::agents, coalesce(p->'agents','[]'::jsonb))
  on conflict (id) do update set name = excluded.name, bio = excluded.bio, persona = excluded.persona, strategy = excluded.strategy,
    archetype = excluded.archetype, risk = excluded.risk, avatar = excluded.avatar, status = excluded.status, cash = excluded.cash,
    funded_total = excluded.funded_total, followers = excluded.followers, following = excluded.following,
    realized_pnl = excluded.realized_pnl, last_action_at = excluded.last_action_at;

  insert into coins select * from jsonb_populate_recordset(null::coins, coalesce(p->'coins','[]'::jsonb))
  on conflict (symbol) do update set v_sol = excluded.v_sol, v_tok = excluded.v_tok, raised = excluded.raised,
    graduated = excluded.graduated, graduated_at = excluded.graduated_at, buys = excluded.buys, sells = excluded.sells,
    volume = excluded.volume, fees = excluded.fees;

  delete from holdings h using jsonb_populate_recordset(null::holdings, coalesce(p->'holdings_delete','[]'::jsonb)) d
  where h.agent_id = d.agent_id and h.symbol = d.symbol;
  insert into holdings select * from jsonb_populate_recordset(null::holdings, coalesce(p->'holdings','[]'::jsonb))
  on conflict (agent_id, symbol) do update set amount = excluded.amount, cost = excluded.cost;

  insert into events select * from jsonb_populate_recordset(null::events, coalesce(p->'events','[]'::jsonb))
  on conflict (id) do update set bot_likes = excluded.bot_likes, reply_count = excluded.reply_count;

  insert into trades select * from jsonb_populate_recordset(null::trades, coalesce(p->'trades','[]'::jsonb)) on conflict do nothing;
  insert into ledger select * from jsonb_populate_recordset(null::ledger, coalesce(p->'ledger','[]'::jsonb)) on conflict do nothing;
  insert into thoughts (agent_id, t, text, mode)
    select agent_id, t, text, mode from jsonb_populate_recordset(null::thoughts, coalesce(p->'thoughts','[]'::jsonb));
  insert into price_points (symbol, t, p)
    select symbol, t, p from jsonb_populate_recordset(null::price_points, coalesce(p->'prices','[]'::jsonb));
  return v;
end $$;
revoke all on function public.garden_commit(jsonb) from public, anon, authenticated;
grant execute on function public.garden_commit(jsonb) to service_role;

-- Alerts derived from the caller's rules; read state from alert_reads.
create or replace function public.my_alerts(p_limit int default 80)
returns table (event_id text, t bigint, reason text, is_read boolean)
language sql stable security invoker set search_path = public as $$
  with r as (select * from alert_rules where owner_id = auth.uid()),
  owned as (select min(created_at) c from r where kind = 'owned'),
  act as (select array_agg(target) k from r where kind = 'action'),
  e as (
    select ev.id, ev.t, ev.kind, ev.agent_id, ev.symbol, a.owner_id a_owner, a.handle
    from events ev join agents a on a.id = ev.agent_id
    order by ev.t desc limit 3000
  )
  select e.id, e.t,
    case
      when owned.c is not null and e.a_owner = auth.uid()::text and e.t >= owned.c then 'your agent @' || e.handle
      when exists (select 1 from r where r.kind = 'agent' and r.target = e.agent_id) then 'watching @' || e.handle
      else 'watching $' || coalesce(e.symbol, '')
    end,
    exists (select 1 from alert_reads ar where ar.owner_id = auth.uid() and ar.event_id = e.id)
  from e, owned, act
  where (owned.c is not null and e.a_owner = auth.uid()::text and e.t >= owned.c)
     or ((act.k is null or e.kind = any (act.k)) and (
          exists (select 1 from r where r.kind = 'agent' and r.target = e.agent_id and e.t >= r.created_at)
       or exists (select 1 from r where r.kind = 'coin' and r.target = e.symbol and e.t >= r.created_at)))
  order by e.t desc
  limit least(greatest(p_limit, 1), 200)
$$;
grant execute on function public.my_alerts(int) to authenticated;

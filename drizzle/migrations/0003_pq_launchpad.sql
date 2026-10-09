-- Fleuri PQ launchpad. Private keys are never stored. All writes are service-role only.
create table public.pq_challenges (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  wallet text not null check (length(wallet) between 32 and 44),
  pq_key_hash text not null check (length(pq_key_hash) = 64),
  cluster text not null,
  genesis_hash text not null,
  nonce text not null unique,
  statement text not null check (length(statement) <= 16384),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
grant select on public.pq_challenges to authenticated;
grant all on public.pq_challenges to service_role;
alter table public.pq_challenges enable row level security;
create policy "owners read own challenges" on public.pq_challenges for select to authenticated using (auth.uid() = owner_id);

create table public.pq_identities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  wallet text not null,
  cluster text not null,
  genesis_hash text not null,
  alg text not null default 'ML-DSA-65',
  public_key text not null check (length(public_key) <= 4096),
  key_hash text not null unique check (length(key_hash) = 64),
  statement text not null,
  registration_hash text not null unique check (length(registration_hash) = 64),
  wallet_signature text not null,
  pq_signature text not null,
  status text not null default 'unanchored' check (status in ('unanchored','anchored','revoked')),
  anchor_signature text unique,
  anchor_slot bigint,
  anchored_at timestamptz,
  created_at timestamptz not null default now()
);
grant select on public.pq_identities to anon, authenticated;
grant all on public.pq_identities to service_role;
alter table public.pq_identities enable row level security;
create policy "identities are public" on public.pq_identities for select to anon, authenticated using (true);

create table public.chain_preparations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  kind text not null check (kind in ('anchor','launch','migrate')),
  wallet text not null,
  cluster text not null,
  message_hash text not null check (length(message_hash) = 64),
  message_b64 text not null,
  subject text not null,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  submitted_at timestamptz,
  signature text unique,
  created_at timestamptz not null default now()
);
grant select on public.chain_preparations to authenticated;
grant all on public.chain_preparations to service_role;
alter table public.chain_preparations enable row level security;
create policy "owners read own preparations" on public.chain_preparations for select to authenticated using (auth.uid() = owner_id);

create table public.launch_nonces (
  nonce text primary key check (length(nonce) = 32),
  owner_id uuid not null,
  identity_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
grant select on public.launch_nonces to authenticated;
grant all on public.launch_nonces to service_role;
alter table public.launch_nonces enable row level security;
create policy "owners read own nonces" on public.launch_nonces for select to authenticated using (auth.uid() = owner_id);

create table public.passports (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.pq_identities(id),
  manifest jsonb not null,
  manifest_hash text not null unique check (length(manifest_hash) = 64),
  signature text not null,
  metadata_uri text,
  metadata_hash text,
  base_mint text not null,
  pool text not null,
  cluster text not null,
  created_at timestamptz not null default now()
);
grant select on public.passports to anon, authenticated;
grant all on public.passports to service_role;
alter table public.passports enable row level security;
create policy "confirmed passports are public" on public.passports for select to anon, authenticated using (true);

create table public.launches (
  id uuid primary key default gen_random_uuid(),
  passport_id uuid not null unique references public.passports(id),
  owner_id uuid not null,
  creator_wallet text not null,
  cluster text not null,
  base_mint text not null unique,
  pool text not null unique,
  config text not null,
  signature text not null unique,
  slot bigint not null,
  lifecycle text not null default 'curve_active' check (lifecycle in ('curve_active','curve_completed','migration_pending','damm_v2_live')),
  damm_v2_pool text,
  migration_signature text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
grant select on public.launches to anon, authenticated;
grant all on public.launches to service_role;
alter table public.launches enable row level security;
create policy "confirmed launches are public" on public.launches for select to anon, authenticated using (true);

-- Atomic single-use consumption helpers (service role only).
create or replace function public.consume_pq_challenge(_id uuid, _owner uuid) returns public.pq_challenges
language sql security definer set search_path = public as $$
  update public.pq_challenges set used_at = now()
  where id = _id and owner_id = _owner and used_at is null and expires_at > now()
  returning *;
$$;
create or replace function public.consume_preparation(_id uuid, _owner uuid, _hash text) returns public.chain_preparations
language sql security definer set search_path = public as $$
  update public.chain_preparations set submitted_at = now()
  where id = _id and owner_id = _owner and message_hash = _hash and submitted_at is null and expires_at > now()
  returning *;
$$;
create or replace function public.consume_launch_nonce(_nonce text, _owner uuid, _identity uuid) returns public.launch_nonces
language sql security definer set search_path = public as $$
  update public.launch_nonces set used_at = now()
  where nonce = _nonce and owner_id = _owner and identity_id = _identity and used_at is null and expires_at > now()
  returning *;
$$;
revoke all on function public.consume_pq_challenge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.consume_preparation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.consume_launch_nonce(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.consume_pq_challenge(uuid, uuid) to service_role;
grant execute on function public.consume_preparation(uuid, uuid, text) to service_role;
grant execute on function public.consume_launch_nonce(text, uuid, uuid) to service_role;
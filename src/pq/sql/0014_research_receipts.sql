-- Agent Research Receipts: additive. Owner-signed receipts over saved Greenhouse trials, private by
-- default, explicit publication, and optional wallet-signed Memo anchors via chain_preparations.
alter table public.chain_preparations drop constraint if exists chain_preparations_kind_check;
alter table public.chain_preparations add constraint chain_preparations_kind_check check (kind = any (array['anchor','launch','migrate','config','pollen_create','pollen_fund','pollen_claim','pollen_route','staking_stake','staking_request_unstake','staking_cancel_unstake','staking_withdraw','staking_claim','staking_harvest','receipt_anchor']));

create table if not exists public.research_receipts (
  id uuid primary key,
  owner_id uuid not null,
  request_id uuid not null,
  run_id uuid not null references public.greenhouse_runs(id),
  identity_id uuid not null references public.pq_identities(id),
  status text not null default 'draft' check (status in ('draft','signed')),
  manifest jsonb not null,
  manifest_hash text not null unique check (manifest_hash ~ '^[0-9a-f]{64}$'),
  experiment jsonb not null,
  public_key text,
  signature text,
  identity_proof jsonb,
  signed_at timestamptz,
  published boolean not null default false,
  published_at timestamptz,
  anchor_status text not null default 'none' check (anchor_status in ('none','pending','confirmed','failed')),
  anchor_preparation_id uuid references public.chain_preparations(id),
  anchor_signature text,
  anchor_slot bigint,
  anchored_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, request_id)
);
create index if not exists research_receipts_owner_idx on public.research_receipts(owner_id, created_at desc);
create index if not exists research_receipts_run_idx on public.research_receipts(run_id);

revoke all on public.research_receipts from anon, authenticated;
grant select (id,status,manifest,manifest_hash,experiment,public_key,signature,identity_proof,signed_at,published,published_at,anchor_status,anchor_signature,anchor_slot,anchored_at,created_at) on public.research_receipts to anon, authenticated;
grant all on public.research_receipts to service_role;
alter table public.research_receipts enable row level security;
create policy "owners read own receipts" on public.research_receipts for select to authenticated using (auth.uid() = owner_id);
create policy "published signed receipts are public" on public.research_receipts for select to anon, authenticated using (published and status = 'signed');

-- Signed evidence is immutable: only publication and anchor metadata may change after signing.
create or replace function public.research_receipts_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if old.status = 'signed' and (new.manifest is distinct from old.manifest or new.manifest_hash is distinct from old.manifest_hash or new.experiment is distinct from old.experiment
     or new.signature is distinct from old.signature or new.public_key is distinct from old.public_key or new.identity_proof is distinct from old.identity_proof
     or new.status is distinct from old.status or new.owner_id is distinct from old.owner_id or new.run_id is distinct from old.run_id or new.identity_id is distinct from old.identity_id or new.signed_at is distinct from old.signed_at) then
    raise exception 'Signed research receipts are immutable';
  end if;
  if old.status = 'draft' and (new.manifest is distinct from old.manifest or new.manifest_hash is distinct from old.manifest_hash or new.experiment is distinct from old.experiment or new.owner_id is distinct from old.owner_id) then
    raise exception 'Receipt drafts are frozen';
  end if;
  if old.anchor_status in ('confirmed') and (new.anchor_status is distinct from old.anchor_status or new.anchor_signature is distinct from old.anchor_signature) then
    raise exception 'A confirmed anchor is final';
  end if;
  return new;
end $$;
drop trigger if exists research_receipts_guard on public.research_receipts;
create trigger research_receipts_guard before update on public.research_receipts for each row execute function public.research_receipts_guard();

-- Frozen draft, idempotent per (owner, request). Same request with another run/identity is a conflict.
create or replace function public.research_create_draft(_owner uuid, _request uuid, _r jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts; g public.greenhouse_runs; i public.pq_identities; n int;
begin
  if _owner is null or _request is null or _r is null then raise exception 'Owner, request and draft are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || _owner::text, 0));
  select * into x from public.research_receipts where owner_id=_owner and request_id=_request;
  if x.id is not null then
    if x.run_id::text <> _r->>'run_id' or x.identity_id::text <> _r->>'identity_id' then raise exception 'This request id was already used for a different trial or identity.'; end if;
    return jsonb_build_object('id',x.id,'status',x.status,'manifest',x.manifest,'manifest_hash',x.manifest_hash,'created',false);
  end if;
  select * into g from public.greenhouse_runs where id=(_r->>'run_id')::uuid and owner_id=_owner;
  if g.id is null or g.status <> 'done' then raise exception 'Only your own completed trials can be attested'; end if;
  select * into i from public.pq_identities where id=(_r->>'identity_id')::uuid and owner_id=_owner;
  if i.id is null or i.status = 'revoked' then raise exception 'Identity not found in your workspace'; end if;
  if g.input_hash <> _r#>>'{manifest,source,inputHash}' or g.output_hash is distinct from _r#>>'{manifest,source,outputHash}' or g.content_hash is distinct from _r#>>'{manifest,source,contentHash}' then raise exception 'Draft does not match the stored trial checksums'; end if;
  if i.key_hash <> _r#>>'{manifest,issuer,keyHash}' or i.wallet <> _r#>>'{manifest,issuer,wallet}' then raise exception 'Draft issuer does not match the identity'; end if;
  select count(*) into n from public.research_receipts where owner_id=_owner and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'Receipt limit reached (20 per hour). Try again later.'; end if;
  insert into public.research_receipts(id,owner_id,request_id,run_id,identity_id,manifest,manifest_hash,experiment)
    values((_r->>'id')::uuid,_owner,_request,g.id,i.id,_r->'manifest',_r->>'manifest_hash',_r->'experiment') returning * into x;
  return jsonb_build_object('id',x.id,'status',x.status,'manifest',x.manifest,'manifest_hash',x.manifest_hash,'created',true);
end $$;

-- Records a signature the server already verified. Retries with the same key are idempotent and
-- keep the ORIGINAL signature bytes; a different key is refused.
create or replace function public.research_sign(_owner uuid, _id uuid, _hash text, _public_key text, _signature text, _proof jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts;
begin
  select * into x from public.research_receipts where id=_id and owner_id=_owner for update;
  if x.id is null then raise exception 'Receipt not found'; end if;
  if x.manifest_hash <> _hash then raise exception 'Signature is for a different document'; end if;
  if x.status = 'signed' then
    if x.public_key is distinct from _public_key then raise exception 'Already signed by a different key'; end if;
    return jsonb_build_object('id',x.id,'status',x.status,'applied',false);
  end if;
  update public.research_receipts set status='signed', public_key=_public_key, signature=_signature, identity_proof=_proof, signed_at=now() where id=_id returning * into x;
  return jsonb_build_object('id',x.id,'status',x.status,'applied',true);
end $$;

create or replace function public.research_set_published(_owner uuid, _id uuid, _published boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts;
begin
  update public.research_receipts set published=_published, published_at=case when _published then now() else null end
    where id=_id and owner_id=_owner and status='signed' returning * into x;
  if x.id is null then raise exception 'Only your own signed receipts can be published'; end if;
  return jsonb_build_object('id',x.id,'published',x.published);
end $$;

-- Atomically creates the Memo preparation and links it. One active anchor attempt per receipt.
create or replace function public.research_create_anchor_preparation(_owner uuid, _id uuid, _row jsonb)
returns public.chain_preparations language plpgsql security definer set search_path = public as $$
declare x public.research_receipts; p public.chain_preparations;
begin
  select * into x from public.research_receipts where id=_id and owner_id=_owner for update;
  if x.id is null or x.status <> 'signed' then raise exception 'Only your own signed receipts can be anchored'; end if;
  if x.anchor_status = 'confirmed' then raise exception 'This receipt is already anchored'; end if;
  if x.anchor_status = 'pending' then
    select * into p from public.chain_preparations where id=x.anchor_preparation_id;
    if p.submitted_at is not null and p.confirmed_at is null then raise exception 'An anchor transaction for this receipt is already submitted. Check its confirmation.'; end if;
    if p.submitted_at is null and p.expires_at > now() then return p; end if;
  end if;
  if _row->>'wallet' <> x.manifest#>>'{issuer,wallet}' or _row->>'subject' <> _id::text or _row->>'cluster' <> x.manifest->>'cluster' or _row#>>'{payload,memo}' <> 'fleuri:receipt:v1:' || x.manifest_hash then raise exception 'Anchor preparation does not match this receipt'; end if;
  insert into public.chain_preparations(owner_id,kind,wallet,cluster,subject,message_hash,message_b64,transaction_b64,payload,expires_at)
    values(_owner,'receipt_anchor',_row->>'wallet',_row->>'cluster',_row->>'subject',_row->>'message_hash',_row->>'message_b64',_row->>'transaction_b64',_row->'payload',(_row->>'expires_at')::timestamptz) returning * into p;
  update public.research_receipts set anchor_status='pending', anchor_preparation_id=p.id, anchor_signature=null, anchor_slot=null, anchored_at=null where id=_id;
  return p;
end $$;

-- Called only after the server re-read the confirmed transaction. Confirms once; failure is terminal for that attempt.
create or replace function public.research_record_anchor(_owner uuid, _id uuid, _prep uuid, _ok boolean, _signature text, _slot bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts;
begin
  select * into x from public.research_receipts where id=_id and owner_id=_owner for update;
  if x.id is null then raise exception 'Receipt not found'; end if;
  if x.anchor_preparation_id is distinct from _prep then raise exception 'This preparation is not the receipt''s current anchor'; end if;
  if x.anchor_status = 'confirmed' then
    if x.anchor_signature is distinct from _signature then raise exception 'A different anchor is already confirmed'; end if;
    return jsonb_build_object('id',x.id,'anchor_status',x.anchor_status,'applied',false);
  end if;
  if x.anchor_status <> 'pending' then return jsonb_build_object('id',x.id,'anchor_status',x.anchor_status,'applied',false); end if;
  update public.research_receipts set anchor_status=case when _ok then 'confirmed' else 'failed' end, anchor_signature=_signature, anchor_slot=_slot, anchored_at=case when _ok then now() else null end where id=_id returning * into x;
  update public.chain_preparations set confirmed_at=coalesce(confirmed_at, now()) where id=_prep and owner_id=_owner;
  return jsonb_build_object('id',x.id,'anchor_status',x.anchor_status,'applied',true);
end $$;

revoke execute on function public.research_create_draft(uuid,uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.research_sign(uuid,uuid,text,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.research_set_published(uuid,uuid,boolean) from public, anon, authenticated;
revoke execute on function public.research_create_anchor_preparation(uuid,uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.research_record_anchor(uuid,uuid,uuid,boolean,text,bigint) from public, anon, authenticated;
revoke execute on function public.research_receipts_guard() from public, anon, authenticated;
grant execute on function public.research_create_draft(uuid,uuid,jsonb) to service_role;
grant execute on function public.research_sign(uuid,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.research_set_published(uuid,uuid,boolean) to service_role;
grant execute on function public.research_create_anchor_preparation(uuid,uuid,jsonb) to service_role;
grant execute on function public.research_record_anchor(uuid,uuid,uuid,boolean,text,bigint) to service_role;

-- Copy of the already-applied live migration 0004 (drizzle/migrations is tool-managed and read-only here).
-- Used by src/pq/database.test.ts. Apply after 0003. Deny TRUNCATE and all client writes as well as enforcing RLS.
revoke all on public.pq_challenges, public.pq_identities, public.chain_preparations,
  public.launch_nonces, public.passports, public.launches from anon, authenticated;
grant select on public.pq_identities, public.passports, public.launches to anon, authenticated;
grant select on public.pq_challenges, public.chain_preparations, public.launch_nonces to authenticated;

alter table public.chain_preparations add column if not exists transaction_b64 text;
alter table public.chain_preparations add column if not exists signed_transaction_b64 text;
alter table public.chain_preparations add column if not exists confirmed_at timestamptz;
alter table public.launch_nonces add column if not exists preparation_id uuid references public.chain_preparations(id);
alter table public.launch_nonces add column if not exists manifest_hash text;

create or replace function public.register_pq_identity(_challenge uuid, _owner uuid, _proof jsonb)
returns public.pq_identities language plpgsql security definer set search_path=public as $$
declare c public.pq_challenges; i public.pq_identities;
begin
  select * into c from public.pq_challenges where id=_challenge and owner_id=_owner for update;
  if c.id is null then raise exception 'Unknown challenge or wrong owner'; end if;
  if c.used_at is not null then
    select * into i from public.pq_identities where registration_hash=_proof->>'registrationHash'
      and owner_id=_owner and statement=c.statement and public_key=_proof->>'publicKey';
    if i.id is null then raise exception 'Challenge already used'; end if;
    return i;
  end if;
  if c.expires_at<=now() then raise exception 'Challenge expired'; end if;
  insert into public.pq_identities(owner_id,wallet,cluster,genesis_hash,public_key,key_hash,statement,
    registration_hash,wallet_signature,pq_signature)
  values(_owner,c.wallet,c.cluster,c.genesis_hash,_proof->>'publicKey',c.pq_key_hash,c.statement,
    _proof->>'registrationHash',_proof->>'walletSignature',_proof->>'pqSignature') returning * into i;
  update public.pq_challenges set used_at=now() where id=c.id;
  return i;
end $$;

create or replace function public.create_launch_preparation(_owner uuid, _nonce text, _identity uuid, _row jsonb)
returns public.chain_preparations language plpgsql security definer set search_path=public as $$
declare n public.launch_nonces; p public.chain_preparations; w text;
begin
  select * into n from public.launch_nonces where nonce=_nonce and owner_id=_owner
    and identity_id=_identity for update;
  if n.nonce is null then raise exception 'Unknown launch nonce or wrong owner'; end if;
  if n.used_at is not null then
    select * into p from public.chain_preparations where id=n.preparation_id and owner_id=_owner;
    if p.id is null or p.payload->'passport' is distinct from _row->'payload'->'passport' then
      raise exception 'Launch nonce was used for different terms';
    end if;
    if p.submitted_at is null and p.expires_at<=now() then raise exception 'Preparation expired; start again'; end if;
    return p;
  end if;
  if n.expires_at<=now() then raise exception 'Launch nonce expired'; end if;
  select wallet into w from public.pq_identities where id=_identity and owner_id=_owner and status='anchored';
  if w is null or w is distinct from _row->>'wallet' then raise exception 'Identity is not anchored for this owner'; end if;
  insert into public.chain_preparations(owner_id,kind,wallet,cluster,subject,message_hash,message_b64,
    transaction_b64,payload,expires_at)
  values(_owner,'launch',w,_row->>'cluster',_row->>'subject',_row->>'message_hash',_row->>'message_b64',
    _row->>'transaction_b64',_row->'payload',(_row->>'expires_at')::timestamptz) returning * into p;
  update public.launch_nonces set used_at=now(),preparation_id=p.id,
    manifest_hash=_row->'payload'->'passport'->>'manifestHash' where nonce=_nonce;
  return p;
end $$;

create or replace function public.claim_chain_submission(_id uuid, _owner uuid, _hash text, _signature text, _transaction text)
returns public.chain_preparations language plpgsql security definer set search_path=public as $$
declare p public.chain_preparations;
begin
  select * into p from public.chain_preparations where id=_id and owner_id=_owner for update;
  if p.id is null or p.message_hash is distinct from _hash then raise exception 'Preparation or message mismatch'; end if;
  if p.submitted_at is not null then
    if p.signature is distinct from _signature or p.signed_transaction_b64 is distinct from _transaction then
      raise exception 'Different signed transaction already submitted';
    end if;
    return p;
  end if;
  if p.expires_at<=now() then raise exception 'Preparation expired'; end if;
  update public.chain_preparations set submitted_at=now(),signature=_signature,signed_transaction_b64=_transaction
    where id=p.id returning * into p;
  return p;
end $$;

create or replace function public.record_launch_confirmation(_id uuid, _owner uuid, _slot bigint, _lifecycle text)
returns uuid language plpgsql security definer set search_path=public as $$
declare p public.chain_preparations; doc public.passports; l public.launches; v jsonb;
begin
  select * into p from public.chain_preparations where id=_id and owner_id=_owner and kind='launch' for update;
  if p.id is null or p.signature is null then raise exception 'Launch was not submitted by this owner'; end if;
  v=p.payload;
  insert into public.passports(identity_id,manifest,manifest_hash,signature,metadata_uri,metadata_hash,base_mint,pool,cluster)
  values((v->>'identityId')::uuid,v->'passport'->'manifest',v->'passport'->>'manifestHash',v->'passport'->>'signature',
    v->>'metadataUri',v->>'metadataHash',v->>'baseMint',v->>'pool',p.cluster)
  on conflict(manifest_hash) do nothing;
  select * into doc from public.passports where manifest_hash=v->'passport'->>'manifestHash';
  if doc.manifest is distinct from v->'passport'->'manifest' or doc.signature is distinct from v->'passport'->>'signature'
    or doc.metadata_uri is distinct from v->>'metadataUri' or doc.metadata_hash is distinct from v->>'metadataHash'
    or doc.identity_id is distinct from (v->>'identityId')::uuid then raise exception 'Immutable passport conflict'; end if;
  insert into public.launches(passport_id,owner_id,creator_wallet,cluster,base_mint,pool,config,signature,slot,lifecycle)
  values(doc.id,_owner,p.wallet,p.cluster,v->>'baseMint',v->>'pool',v->>'config',p.signature,_slot,_lifecycle)
  on conflict(signature) do nothing;
  select * into l from public.launches where signature=p.signature;
  if l.passport_id is distinct from doc.id or l.owner_id is distinct from _owner
    or l.base_mint is distinct from v->>'baseMint' or l.pool is distinct from v->>'pool' then
    raise exception 'Launch confirmation conflict';
  end if;
  update public.chain_preparations set confirmed_at=coalesce(confirmed_at,now()) where id=p.id;
  return doc.id;
end $$;

revoke all on function public.register_pq_identity(uuid,uuid,jsonb),
  public.create_launch_preparation(uuid,text,uuid,jsonb), public.claim_chain_submission(uuid,uuid,text,text,text),
  public.record_launch_confirmation(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.register_pq_identity(uuid,uuid,jsonb),
  public.create_launch_preparation(uuid,text,uuid,jsonb), public.claim_chain_submission(uuid,uuid,text,text,text),
  public.record_launch_confirmation(uuid,uuid,bigint,text) to service_role;

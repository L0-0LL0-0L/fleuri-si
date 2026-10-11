-- Research receipts: additive null/binding hardening of the service-role RPCs from 0014.
-- SQL comparisons with NULL are not "true", so every required argument and bound field is checked
-- explicitly and compared with IS DISTINCT FROM. Grants are unchanged (service_role only).
create or replace function public.research_create_draft(_owner uuid, _request uuid, _r jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts; g public.greenhouse_runs; i public.pq_identities; n int;
begin
  if _owner is null or _request is null or _r is null or jsonb_typeof(_r) <> 'object' then raise exception 'Owner, request and draft are required'; end if;
  if _r->>'id' is null or _r->>'run_id' is null or _r->>'identity_id' is null or _r->'manifest' is null or _r->'experiment' is null
     or coalesce(_r->>'manifest_hash','') !~ '^[0-9a-f]{64}$' then raise exception 'Draft is missing required fields'; end if;
  perform pg_advisory_xact_lock(hashtextextended('receipt:' || _owner::text, 0));
  select * into x from public.research_receipts where owner_id=_owner and request_id=_request;
  if x.id is not null then
    if x.run_id::text is distinct from _r->>'run_id' or x.identity_id::text is distinct from _r->>'identity_id' then raise exception 'This request id was already used for a different trial or identity.'; end if;
    return jsonb_build_object('id',x.id,'status',x.status,'manifest',x.manifest,'manifest_hash',x.manifest_hash,'created',false);
  end if;
  select * into g from public.greenhouse_runs where id=(_r->>'run_id')::uuid and owner_id=_owner;
  if g.id is null or g.status is distinct from 'done' or g.output_hash is null or g.content_hash is null then raise exception 'Only your own completed trials can be attested'; end if;
  select * into i from public.pq_identities where id=(_r->>'identity_id')::uuid and owner_id=_owner;
  if i.id is null or i.status = 'revoked' then raise exception 'Identity not found in your workspace'; end if;
  if g.id::text is distinct from _r#>>'{manifest,source,runId}' or _r#>>'{manifest,receiptId}' is distinct from _r->>'id' then raise exception 'Draft is not bound to this trial'; end if;
  if g.input_hash is distinct from _r#>>'{manifest,source,inputHash}' or g.output_hash is distinct from _r#>>'{manifest,source,outputHash}' or g.content_hash is distinct from _r#>>'{manifest,source,contentHash}' then raise exception 'Draft does not match the stored trial checksums'; end if;
  if i.key_hash is distinct from _r#>>'{manifest,issuer,keyHash}' or i.wallet is distinct from _r#>>'{manifest,issuer,wallet}' or i.registration_hash is distinct from _r#>>'{manifest,issuer,registrationHash}' then raise exception 'Draft issuer does not match the identity'; end if;
  if _r->'manifest' ? 'requestId' and _r#>>'{manifest,schema}' is distinct from 'fleuri.research-receipt/v1' then raise exception 'New receipts must not include the private request id'; end if;
  select count(*) into n from public.research_receipts where owner_id=_owner and created_at > now() - interval '1 hour';
  if n >= 20 then raise exception 'Receipt limit reached (20 per hour). Try again later.'; end if;
  insert into public.research_receipts(id,owner_id,request_id,run_id,identity_id,manifest,manifest_hash,experiment)
    values((_r->>'id')::uuid,_owner,_request,g.id,i.id,_r->'manifest',_r->>'manifest_hash',_r->'experiment') returning * into x;
  return jsonb_build_object('id',x.id,'status',x.status,'manifest',x.manifest,'manifest_hash',x.manifest_hash,'created',true);
end $$;

create or replace function public.research_sign(_owner uuid, _id uuid, _hash text, _public_key text, _signature text, _proof jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts;
begin
  if _owner is null or _id is null or _hash is null or _public_key is null or _signature is null or _proof is null then raise exception 'Signature fields are required'; end if;
  select * into x from public.research_receipts where id=_id and owner_id=_owner for update;
  if x.id is null then raise exception 'Receipt not found'; end if;
  if x.manifest_hash is distinct from _hash then raise exception 'Signature is for a different document'; end if;
  if _proof->>'key_hash' is distinct from x.manifest#>>'{issuer,keyHash}' or _proof->>'wallet' is distinct from x.manifest#>>'{issuer,wallet}' then raise exception 'Signer proof does not match the draft issuer'; end if;
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
  if _owner is null or _id is null or _published is null then raise exception 'Owner, receipt and visibility are required'; end if;
  update public.research_receipts set published=_published, published_at=case when _published then now() else null end
    where id=_id and owner_id=_owner and status='signed' returning * into x;
  if x.id is null then raise exception 'Only your own signed receipts can be published'; end if;
  return jsonb_build_object('id',x.id,'published',x.published);
end $$;

create or replace function public.research_create_anchor_preparation(_owner uuid, _id uuid, _row jsonb)
returns public.chain_preparations language plpgsql security definer set search_path = public as $$
declare x public.research_receipts; p public.chain_preparations;
begin
  if _owner is null or _id is null or _row is null or jsonb_typeof(_row) <> 'object' then raise exception 'Owner, receipt and preparation are required'; end if;
  select * into x from public.research_receipts where id=_id and owner_id=_owner for update;
  if x.id is null or x.status <> 'signed' then raise exception 'Only your own signed receipts can be anchored'; end if;
  if x.anchor_status = 'confirmed' then raise exception 'This receipt is already anchored'; end if;
  if x.anchor_status = 'pending' then
    select * into p from public.chain_preparations where id=x.anchor_preparation_id and owner_id=_owner;
    if p.id is not null and p.submitted_at is not null and p.confirmed_at is null then raise exception 'An anchor transaction for this receipt is already submitted. Check its confirmation.'; end if;
    if p.id is not null and p.submitted_at is null and p.expires_at > now() then return p; end if;
  end if;
  if _row->>'wallet' is distinct from x.manifest#>>'{issuer,wallet}' or _row->>'subject' is distinct from _id::text or _row->>'cluster' is distinct from x.manifest->>'cluster'
     or _row#>>'{payload,memo}' is distinct from 'fleuri:receipt:v1:' || x.manifest_hash then raise exception 'Anchor preparation does not match this receipt'; end if;
  if _row->>'message_hash' is null or _row->>'message_b64' is null or _row->>'transaction_b64' is null or _row->>'expires_at' is null then raise exception 'Anchor preparation is incomplete'; end if;
  insert into public.chain_preparations(owner_id,kind,wallet,cluster,subject,message_hash,message_b64,transaction_b64,payload,expires_at)
    values(_owner,'receipt_anchor',_row->>'wallet',_row->>'cluster',_row->>'subject',_row->>'message_hash',_row->>'message_b64',_row->>'transaction_b64',_row->'payload',(_row->>'expires_at')::timestamptz) returning * into p;
  update public.research_receipts set anchor_status='pending', anchor_preparation_id=p.id, anchor_signature=null, anchor_slot=null, anchored_at=null where id=_id;
  return p;
end $$;

create or replace function public.research_record_anchor(_owner uuid, _id uuid, _prep uuid, _ok boolean, _signature text, _slot bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x public.research_receipts; p public.chain_preparations;
begin
  if _owner is null or _id is null or _prep is null or _ok is null or _signature is null then raise exception 'Anchor result fields are required'; end if;
  if _ok and _slot is null then raise exception 'A confirmed anchor needs its slot'; end if;
  select * into x from public.research_receipts where id=_id and owner_id=_owner for update;
  if x.id is null then raise exception 'Receipt not found'; end if;
  if x.anchor_preparation_id is distinct from _prep then raise exception 'This preparation is not the receipt''s current anchor'; end if;
  select * into p from public.chain_preparations where id=_prep and owner_id=_owner and kind='receipt_anchor' and subject=_id::text;
  if p.id is null or p.signature is distinct from _signature then raise exception 'Anchor signature does not match the stored submission'; end if;
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
grant execute on function public.research_create_draft(uuid,uuid,jsonb) to service_role;
grant execute on function public.research_sign(uuid,uuid,text,text,text,jsonb) to service_role;
grant execute on function public.research_set_published(uuid,uuid,boolean) to service_role;
grant execute on function public.research_create_anchor_preparation(uuid,uuid,jsonb) to service_role;
grant execute on function public.research_record_anchor(uuid,uuid,uuid,boolean,text,bigint) to service_role;

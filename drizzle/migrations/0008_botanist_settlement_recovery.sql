-- Botanist settlement recovery: durable facilitator candidate signature + frozen facilitator terms.
ALTER TABLE public.botanist_jobs ADD COLUMN IF NOT EXISTS candidate_signature text;
ALTER TABLE public.botanist_jobs ADD COLUMN IF NOT EXISTS facilitator text;
ALTER TABLE public.botanist_jobs DROP CONSTRAINT IF EXISTS botanist_jobs_status_check;
ALTER TABLE public.botanist_jobs ADD CONSTRAINT botanist_jobs_status_check CHECK (status IN ('quoted','payment_submitted','settlement_pending','settled','report_ready','failed'));
CREATE UNIQUE INDEX IF NOT EXISTS botanist_jobs_candidate_signature_key ON public.botanist_jobs (candidate_signature) WHERE candidate_signature IS NOT NULL;

CREATE OR REPLACE FUNCTION public.botanist_freeze_terms() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
begin
  if new.request_hash<>old.request_hash or new.capability_hash<>old.capability_hash or new.mint<>old.mint or new.network<>old.network
     or new.asset<>old.asset or new.amount<>old.amount or new.pay_to<>old.pay_to or new.memo<>old.memo or new.quote_expires_at<>old.quote_expires_at
     or (old.fee_payer is not null and new.fee_payer is distinct from old.fee_payer)
     or (old.resource is not null and new.resource is distinct from old.resource)
     or (old.facilitator is not null and new.facilitator is distinct from old.facilitator)
     or (old.payment_tx_b64 is not null and new.payment_tx_b64 is distinct from old.payment_tx_b64)
     or (old.payment_hash is not null and new.payment_hash is distinct from old.payment_hash)
     or (old.payer is not null and new.payer is distinct from old.payer)
     or (old.candidate_signature is not null and new.candidate_signature is distinct from old.candidate_signature)
     or (old.settle_signature is not null and new.settle_signature is distinct from old.settle_signature)
     or (old.settled_slot is not null and new.settled_slot is distinct from old.settled_slot)
     or (old.report is not null and new.report is distinct from old.report)
     or (old.report_digest is not null and new.report_digest is distinct from old.report_digest) then
    raise exception 'Botanist job terms, signed payment bytes, signatures and reports are immutable';
  end if;
  if old.status in ('settled','report_ready') and new.status not in ('settled','report_ready') then
    raise exception 'Settled Botanist jobs cannot regress';
  end if;
  return new;
end $$;
REVOKE EXECUTE ON FUNCTION public.botanist_freeze_terms() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.botanist_record_candidate(_id uuid, _sig text)
 RETURNS public.botanist_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare j public.botanist_jobs;
begin
  select * into j from public.botanist_jobs where id=_id for update;
  if j.id is null or j.payment_hash is null then raise exception 'No submitted payment'; end if;
  if j.candidate_signature is not null then
    if j.candidate_signature is distinct from _sig then raise exception 'Different settlement candidate already recorded'; end if;
    return j;
  end if;
  update public.botanist_jobs set candidate_signature=_sig,
    status=case when status='payment_submitted' then 'settlement_pending' else status end, updated_at=now()
    where id=_id returning * into j;
  return j;
end $$;

CREATE OR REPLACE FUNCTION public.botanist_mark_settled(_id uuid, _sig text, _slot bigint)
 RETURNS public.botanist_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare j public.botanist_jobs;
begin
  select * into j from public.botanist_jobs where id=_id for update;
  if j.id is null or j.payment_hash is null then raise exception 'No submitted payment'; end if;
  if j.settle_signature is not null then
    if j.settle_signature is distinct from _sig then raise exception 'Different settlement already recorded'; end if;
    return j;
  end if;
  if j.candidate_signature is not null and j.candidate_signature is distinct from _sig then raise exception 'Settlement differs from the recorded candidate'; end if;
  if j.status not in ('payment_submitted','settlement_pending') then raise exception 'Job is not awaiting settlement'; end if;
  update public.botanist_jobs set status='settled', candidate_signature=coalesce(candidate_signature,_sig), settle_signature=_sig, settled_slot=_slot, settled_at=now(), error=null, updated_at=now()
    where id=_id returning * into j;
  return j;
end $$;

CREATE OR REPLACE FUNCTION public.botanist_mark_failed(_id uuid, _reason text)
 RETURNS public.botanist_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare j public.botanist_jobs;
begin
  select * into j from public.botanist_jobs where id=_id for update;
  if j.id is null then raise exception 'Unknown job'; end if;
  if j.settle_signature is not null then raise exception 'Settled jobs cannot fail'; end if;
  update public.botanist_jobs set status='failed', error=left(_reason,300), updated_at=now() where id=_id returning * into j;
  return j;
end $$;

REVOKE ALL ON FUNCTION public.botanist_record_candidate(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.botanist_mark_settled(uuid,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.botanist_mark_failed(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.botanist_record_candidate(uuid,text), public.botanist_mark_settled(uuid,text,bigint), public.botanist_mark_failed(uuid,text) TO service_role;
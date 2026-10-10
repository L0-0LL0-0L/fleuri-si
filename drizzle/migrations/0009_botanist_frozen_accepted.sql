ALTER TABLE public.botanist_jobs ADD COLUMN IF NOT EXISTS accepted jsonb;
ALTER TABLE public.botanist_jobs ADD COLUMN IF NOT EXISTS resource_info jsonb;
CREATE OR REPLACE FUNCTION public.botanist_freeze_terms() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
begin
  if new.request_hash<>old.request_hash or new.capability_hash<>old.capability_hash or new.mint<>old.mint or new.network<>old.network
     or new.asset<>old.asset or new.amount<>old.amount or new.pay_to<>old.pay_to or new.memo<>old.memo or new.quote_expires_at<>old.quote_expires_at
     or (old.fee_payer is not null and new.fee_payer is distinct from old.fee_payer)
     or (old.resource is not null and new.resource is distinct from old.resource)
     or (old.facilitator is not null and new.facilitator is distinct from old.facilitator)
     or (old.accepted is not null and new.accepted is distinct from old.accepted)
     or (old.resource_info is not null and new.resource_info is distinct from old.resource_info)
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
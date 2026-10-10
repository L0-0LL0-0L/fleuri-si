REVOKE ALL ON public.passport_observations, public.pollen_vaults, public.pollen_associations, public.botanist_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.passport_observations, public.pollen_vaults, public.pollen_associations TO anon, authenticated;
GRANT ALL ON public.passport_observations, public.pollen_vaults, public.pollen_associations, public.botanist_jobs TO service_role;
-- Frozen quotes: requirement fields cannot change after a job is created.
CREATE OR REPLACE FUNCTION public.botanist_freeze_terms() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
begin
  if new.request_hash<>old.request_hash or new.capability_hash<>old.capability_hash or new.mint<>old.mint or new.network<>old.network
     or new.asset<>old.asset or new.amount<>old.amount or new.pay_to<>old.pay_to or new.memo<>old.memo or new.quote_expires_at<>old.quote_expires_at
     or (old.payment_tx_b64 is not null and new.payment_tx_b64 is distinct from old.payment_tx_b64)
     or (old.payment_hash is not null and new.payment_hash is distinct from old.payment_hash)
     or (old.report is not null and new.report is distinct from old.report) then
    raise exception 'Botanist job terms, signed payment bytes and reports are immutable';
  end if;
  return new;
end $$;
DROP TRIGGER IF EXISTS botanist_freeze_terms ON public.botanist_jobs;
CREATE TRIGGER botanist_freeze_terms BEFORE UPDATE ON public.botanist_jobs FOR EACH ROW EXECUTE FUNCTION public.botanist_freeze_terms();
ALTER TABLE public.botanist_jobs ADD COLUMN IF NOT EXISTS fee_payer text;
ALTER TABLE public.botanist_jobs ADD COLUMN IF NOT EXISTS resource text;
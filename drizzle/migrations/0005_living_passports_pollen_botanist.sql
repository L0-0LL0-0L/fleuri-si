ALTER TABLE public.chain_preparations DROP CONSTRAINT chain_preparations_kind_check;
ALTER TABLE public.chain_preparations ADD CONSTRAINT chain_preparations_kind_check CHECK (kind = ANY (ARRAY['anchor','launch','migrate','config','pollen_create','pollen_fund','pollen_claim','pollen_route']));

-- Living passports: append-only, deduplicated confirmed observations.
CREATE TABLE public.passport_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  launch_id uuid NOT NULL REFERENCES public.launches(id),
  kind text NOT NULL CHECK (kind IN ('snapshot','creator_changed','graduated','damm_v2_confirmed','authority_changed','metadata_changed')),
  observed_slot bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  digest text NOT NULL CHECK (length(digest)=64),
  facts jsonb NOT NULL,
  UNIQUE (launch_id, kind, digest)
);
GRANT SELECT ON public.passport_observations TO anon, authenticated;
GRANT ALL ON public.passport_observations TO service_role;
ALTER TABLE public.passport_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "observations are public" ON public.passport_observations FOR SELECT TO anon, authenticated USING (true);
CREATE OR REPLACE FUNCTION public.observations_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $$
begin raise exception 'passport observations are append-only'; end $$;
CREATE TRIGGER passport_observations_immutable BEFORE UPDATE OR DELETE ON public.passport_observations FOR EACH ROW EXECUTE FUNCTION public.observations_append_only();

-- Pollen: confirmed on-chain Meteora Dynamic Fee Sharing vaults known to fleuri.
CREATE TABLE public.pollen_vaults (
  address text PRIMARY KEY,
  cluster text NOT NULL,
  mint text NOT NULL,
  owner_wallet text NOT NULL,
  base text,
  created_signature text UNIQUE,
  recorded_by uuid,
  recipients jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.pollen_vaults TO anon, authenticated;
GRANT ALL ON public.pollen_vaults TO service_role;
ALTER TABLE public.pollen_vaults ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pollen vaults are public" ON public.pollen_vaults FOR SELECT TO anon, authenticated USING (true);

CREATE TABLE public.pollen_associations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault text NOT NULL REFERENCES public.pollen_vaults(address),
  launch_id uuid NOT NULL REFERENCES public.launches(id),
  owner_id uuid NOT NULL,
  wallet text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault, launch_id)
);
GRANT SELECT ON public.pollen_associations TO anon, authenticated;
GRANT ALL ON public.pollen_associations TO service_role;
ALTER TABLE public.pollen_associations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pollen associations are public" ON public.pollen_associations FOR SELECT TO anon, authenticated USING (true);

-- Botanist: private paid jobs. No client policies: service role only.
CREATE TABLE public.botanist_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_hash text NOT NULL UNIQUE CHECK (length(request_hash)=64),
  capability_hash text NOT NULL CHECK (length(capability_hash)=64),
  client_hash text NOT NULL,
  mint text NOT NULL,
  status text NOT NULL DEFAULT 'quoted' CHECK (status IN ('quoted','payment_submitted','settled','report_ready','failed')),
  network text NOT NULL,
  asset text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  pay_to text NOT NULL,
  memo text NOT NULL UNIQUE,
  quote_expires_at timestamptz NOT NULL,
  payment_hash text UNIQUE,
  payment_tx_b64 text,
  payer text,
  settle_signature text UNIQUE,
  settled_slot bigint,
  settled_at timestamptz,
  report jsonb,
  report_digest text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX botanist_jobs_client_created ON public.botanist_jobs (client_hash, created_at);
GRANT ALL ON public.botanist_jobs TO service_role;
ALTER TABLE public.botanist_jobs ENABLE ROW LEVEL SECURITY;

-- Atomic claim: one payment per job, one job per payment. Same payload retry returns the row.
CREATE OR REPLACE FUNCTION public.botanist_claim_payment(_id uuid, _cap text, _payment_hash text, _tx text, _payer text)
RETURNS public.botanist_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare j public.botanist_jobs;
begin
  select * into j from public.botanist_jobs where id=_id and capability_hash=_cap for update;
  if j.id is null then raise exception 'Unknown job'; end if;
  if j.payment_hash is not null then
    if j.payment_hash is distinct from _payment_hash then raise exception 'This job already has a different payment'; end if;
    return j;
  end if;
  if j.status <> 'quoted' then raise exception 'Job is not awaiting payment'; end if;
  if j.quote_expires_at <= now() then raise exception 'Quote expired'; end if;
  update public.botanist_jobs set status='payment_submitted', payment_hash=_payment_hash, payment_tx_b64=_tx, payer=_payer, updated_at=now()
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
  update public.botanist_jobs set status='settled', settle_signature=_sig, settled_slot=_slot, settled_at=now(), error=null, updated_at=now()
    where id=_id returning * into j;
  return j;
end $$;

CREATE OR REPLACE FUNCTION public.botanist_store_report(_id uuid, _report jsonb, _digest text)
RETURNS public.botanist_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare j public.botanist_jobs;
begin
  select * into j from public.botanist_jobs where id=_id for update;
  if j.settle_signature is null then raise exception 'Payment not settled'; end if;
  if j.report is not null then return j; end if;
  update public.botanist_jobs set status='report_ready', report=_report, report_digest=_digest, error=null, updated_at=now()
    where id=_id returning * into j;
  return j;
end $$;

REVOKE ALL ON FUNCTION public.botanist_claim_payment(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.botanist_mark_settled(uuid,text,bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.botanist_store_report(uuid,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.botanist_claim_payment(uuid,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.botanist_mark_settled(uuid,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.botanist_store_report(uuid,jsonb,text) TO service_role;
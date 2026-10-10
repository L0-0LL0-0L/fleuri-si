REVOKE ALL ON public.botanist_jobs FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.passport_observations, public.pollen_vaults, public.pollen_associations FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.observations_append_only() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.botanist_freeze_terms() FROM PUBLIC;
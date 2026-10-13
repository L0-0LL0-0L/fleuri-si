-- Blind Bloom: bloom_fail is fenced by an unexpired lease (a worker whose lease lapsed cannot fail the round).
create or replace function public.bloom_fail(_round uuid, _lease uuid, _reason text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare r public.bloom_rounds;
begin
  select * into r from public.bloom_rounds where id=_round for update;
  if r.id is null or r.status <> 'evaluating' or r.lease_token is distinct from _lease or r.lease_expires_at <= public.bloom_now() then return jsonb_build_object('applied',false); end if;
  update public.bloom_rounds set status='failed', error=left(coalesce(_reason,'failed'),240), finished_at=public.bloom_now(), lease_token=null, lease_expires_at=null where id=_round;
  return jsonb_build_object('applied',true);
end $$;
revoke all on function public.bloom_fail(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.bloom_fail(uuid,uuid,text) to service_role;

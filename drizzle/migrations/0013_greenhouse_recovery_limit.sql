-- Greenhouse Trials: expired-lease recovery must respect the 2-active-trials limit.
-- Additive: replaces only greenhouse_claim_lease (same signature); 0012 data/grants preserved.
create or replace function public.greenhouse_claim_lease(_owner uuid, _request uuid, _engine text, _agents text[], _input jsonb, _input_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.greenhouse_runs; n int; tok uuid; acq boolean := false;
begin
  if _owner is null or _request is null or _input is null or _input_hash is null then raise exception 'Owner, request and inputs are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('greenhouse:' || _owner::text, 0));
  select * into r from public.greenhouse_runs where owner_id=_owner and request_id=_request for update;
  if r.id is not null then
    if (r.input->'config') is distinct from (_input->'config') then
      raise exception 'This request id was already used with different trial settings.';
    end if;
    if r.status='running' and coalesce(r.lease_expires_at, r.claimed_at + interval '2 minutes') <= now() then
      if r.attempts >= 3 then
        update public.greenhouse_runs set status='failed', error='Gave up after 3 attempts', finished_at=now(), lease_token=null, lease_expires_at=null where id=r.id returning * into r;
      else
        -- Recovery takes a slot too: refuse (without touching attempts/lease) while two others are active.
        select count(*) into n from public.greenhouse_runs where owner_id=_owner and id<>r.id and status='running' and coalesce(lease_expires_at, claimed_at + interval '2 minutes') > now();
        if n >= 2 then raise exception 'Two trials are already running. Wait for them to finish before recovering this one.'; end if;
        tok := gen_random_uuid(); acq := true;
        update public.greenhouse_runs set attempts=attempts+1, claimed_at=now(), lease_token=tok, lease_expires_at=now()+interval '2 minutes' where id=r.id returning * into r;
      end if;
    end if;
  else
    select count(*) into n from public.greenhouse_runs where owner_id=_owner and created_at > now() - interval '1 hour';
    if n >= 30 then raise exception 'Trial limit reached (30 per hour). Try again later.'; end if;
    select count(*) into n from public.greenhouse_runs where owner_id=_owner and status='running' and coalesce(lease_expires_at, claimed_at + interval '2 minutes') > now();
    if n >= 2 then raise exception 'Two trials are already running. Wait for them to finish.'; end if;
    tok := gen_random_uuid(); acq := true;
    insert into public.greenhouse_runs(owner_id,request_id,engine_version,agent_ids,input,input_hash,lease_token,lease_expires_at)
      values(_owner,_request,_engine,_agents,_input,_input_hash,tok,now()+interval '2 minutes') returning * into r;
  end if;
  return jsonb_build_object('id',r.id,'status',r.status,'acquired',acq,'lease',case when acq then tok end,'attempts',r.attempts,
    'engine_version',r.engine_version,'input',r.input,'input_hash',r.input_hash,'error',r.error);
end $$;

revoke execute on function public.greenhouse_claim_lease(uuid,uuid,text,text[],jsonb,text) from public, anon, authenticated;
grant execute on function public.greenhouse_claim_lease(uuid,uuid,text,text[],jsonb,text) to service_role;

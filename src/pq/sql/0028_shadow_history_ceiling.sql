-- Bound actual append operations, including no-op saves/shares, while preserving privacy revocation.
create or replace function public.shadow_log(_id uuid,_kind text,_body jsonb) returns void
language plpgsql set search_path=public as $$
declare n integer;p text;e jsonb;last_share boolean;
begin
 select coalesce(max(seq),0)+1 into n from public.shadow_events where season_id=_id;
 if _kind='edited' and _body->>'inputHash'=(select event->'body'->>'inputHash' from public.shadow_events where season_id=_id and event->>'kind' in ('created','edited') order by seq desc limit 1) then return;end if;
 if _kind='shared' then
  select (event->'body'->>'shared')::boolean into last_share from public.shadow_events where season_id=_id and event->>'kind'='shared' order by seq desc limit 1;
  if coalesce(last_share,false)=(_body->>'shared')::boolean then return;end if;
 end if;
 if (_kind='edited' and n>100) or (_kind in ('shared','annotation') and n>150 and not (_kind='shared' and _body->>'shared'='false')) or (_kind='evaluating' and n>180) or n>200 then raise exception 'history_quota';end if;
 select event->>'hash' into p from public.shadow_events where season_id=_id order by seq desc limit 1;
 e:=jsonb_build_object('seq',n,'kind',_kind,'at',to_char(public.shadow_now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'body',_body,'previous',coalesce(p,repeat('0',64)));
 insert into public.shadow_events values(_id,n,e||jsonb_build_object('hash',public.shadow_hash('shadow.event/1',e)));
end $$;
revoke all on function public.shadow_log(uuid,text,jsonb) from public,anon,authenticated,service_role;
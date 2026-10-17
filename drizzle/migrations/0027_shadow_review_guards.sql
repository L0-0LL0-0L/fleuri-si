-- Tighten coordinator inputs and ensure bounded history remains exportable.
create function public.shadow_write_v2(_owner uuid,_request uuid,_action text,_id uuid,_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
 if _action in ('edit','commit') and coalesce(_payload->>'reviewedHash','') !~ '^[0-9a-f]{64}$' then raise exception 'draft_conflict'; end if;
 if _action in ('create','edit') and coalesce(_payload->>'saveBodyHash','') !~ '^[0-9a-f]{64}$' then raise exception 'request_mismatch'; end if;
 return public.shadow_write(_owner,_request,_action,_id,_payload);
end $$;
revoke all on function public.shadow_write(uuid,uuid,text,uuid,jsonb),public.shadow_write_v2(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.shadow_write_v2(uuid,uuid,text,uuid,jsonb) to service_role;
create function public.shadow_history_bound() returns trigger language plpgsql set search_path=public as $$
declare n integer;
begin
 select count(*) into n from public.shadow_events where season_id=old.id;
 if old.status='draft' and new.frozen is distinct from old.frozen and n>=100 then raise exception 'history_quota'; end if;
 if not old.shared and new.shared and n>=150 then raise exception 'history_quota'; end if;
 if new.generation>old.generation and n>=180 then raise exception 'history_quota'; end if;
 return new;
end $$;
create trigger shadow_history_bound before update on public.shadow_seasons for each row execute function public.shadow_history_bound();
revoke all on function public.shadow_history_bound() from public,anon,authenticated,service_role;

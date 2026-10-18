DO $$ DECLARE definition text; BEGIN
 SELECT pg_get_functiondef('public.forward_write(uuid,uuid,text,uuid,jsonb)'::regprocedure) INTO definition;
 definition:=replace(definition,'if n>=240 and _action not in(''end'',''share'',''finish'',''fail'') then raise exception ''history_quota'';end if;','if n>=240 and (_action not in(''end'',''share'',''finish'',''fail'') or (_action=''share'' and coalesce((_payload->>''shared'')::boolean,false))) then raise exception ''history_quota'';end if;');
 EXECUTE definition;
END $$;
CREATE OR REPLACE FUNCTION public.forward_log(_id uuid,_kind text,_body jsonb,_at text) RETURNS void LANGUAGE plpgsql SET search_path=public AS $$
DECLARE n integer;p text;e jsonb;
BEGIN
 SELECT coalesce(max(seq),0)+1 INTO n FROM public.forward_events WHERE watch_id=_id;
 IF n>256 THEN
  -- Legacy full histories must never prevent owner privacy revocation.
  IF _kind='shared' AND _body=jsonb_build_object('shared',false) THEN RETURN; END IF;
  RAISE EXCEPTION 'history_quota';
 END IF;
 SELECT event->>'hash' INTO p FROM public.forward_events WHERE watch_id=_id ORDER BY seq DESC LIMIT 1;
 e:=jsonb_build_object('seq',n,'kind',_kind,'at',_at,'body',_body,'previous',coalesce(p,repeat('0',64)));
 INSERT INTO public.forward_events VALUES(_id,n,e||jsonb_build_object('hash',public.forward_hash('forward.event/1',e)));
END $$;
REVOKE ALL ON FUNCTION public.forward_log(uuid,text,jsonb,text),public.forward_write(uuid,uuid,text,uuid,jsonb) FROM public,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.forward_write(uuid,uuid,text,uuid,jsonb) TO service_role;
create table public.forward_watches(id uuid primary key default gen_random_uuid(),owner_id uuid not null,agent_id text not null,status text not null default 'draft' check(status in('draft','watching','complete','partial','ended','expired','incomplete')),frozen jsonb not null,draft_hash text not null,committed_at text,commitment text,observations jsonb not null default '[]',proposals jsonb not null default '[]',shared boolean not null default false,lease_token uuid,lease_until timestamptz,generation integer not null default 0,request_started text,created_at timestamptz not null default clock_timestamp());
grant select(id,owner_id,agent_id,status,frozen,draft_hash,committed_at,commitment,observations,proposals,shared,generation,created_at) on public.forward_watches to anon,authenticated;
grant all on public.forward_watches to service_role;
alter table public.forward_watches enable row level security;
create policy forward_read on public.forward_watches for select to anon,authenticated using(owner_id=auth.uid() or shared);
create index forward_owner_created on public.forward_watches(owner_id,created_at desc);
create table public.forward_events(watch_id uuid not null references public.forward_watches(id),seq integer not null,event jsonb not null,primary key(watch_id,seq));
grant select on public.forward_events to anon,authenticated;grant all on public.forward_events to service_role;
alter table public.forward_events enable row level security;
create policy forward_event_read on public.forward_events for select to anon,authenticated using(exists(select 1 from public.forward_watches w where w.id=watch_id and(w.owner_id=auth.uid() or w.shared)));
create table public.forward_requests(owner_id uuid not null,request_id uuid not null,body_hash text not null,response jsonb not null,created_at timestamptz not null default clock_timestamp(),primary key(owner_id,request_id));
grant all on public.forward_requests to service_role;alter table public.forward_requests enable row level security;
create function public.forward_now() returns timestamptz language sql volatile as $$ select clock_timestamp() $$;
create function public.forward_stamp() returns text language sql volatile as $$ select to_char(public.forward_now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
create function public.forward_log(_id uuid,_kind text,_body jsonb,_at text) returns void language plpgsql set search_path=public as $$
declare n integer;p text;e jsonb;
begin select coalesce(max(seq),0)+1 into n from public.forward_events where watch_id=_id;if n>256 then raise exception 'history_quota';end if;select event->>'hash' into p from public.forward_events where watch_id=_id order by seq desc limit 1;e:=jsonb_build_object('seq',n,'kind',_kind,'at',_at,'body',_body,'previous',coalesce(p,repeat('0',64)));insert into public.forward_events values(_id,n,e||jsonb_build_object('hash',public.shadow_hash('forward.event/1',e)));end $$;
create function public.forward_guard() returns trigger language plpgsql as $$
begin if tg_op='DELETE' then raise exception 'append_only';end if;if new.owner_id<>old.owner_id or new.agent_id<>old.agent_id then raise exception 'immutable_owner';end if;if old.committed_at is not null and(new.frozen is distinct from old.frozen or new.draft_hash is distinct from old.draft_hash or new.committed_at is distinct from old.committed_at) then raise exception 'frozen';end if;if old.commitment is not null and new.commitment is distinct from old.commitment then raise exception 'frozen';end if;if jsonb_array_length(new.observations)<jsonb_array_length(old.observations) or jsonb_array_length(new.proposals)<jsonb_array_length(old.proposals) or (select coalesce(jsonb_agg(v order by ord),'[]') from jsonb_array_elements(new.observations) with ordinality x(v,ord) where ord<=jsonb_array_length(old.observations))<>old.observations or (select coalesce(jsonb_agg(v order by ord),'[]') from jsonb_array_elements(new.proposals) with ordinality x(v,ord) where ord<=jsonb_array_length(old.proposals))<>old.proposals then raise exception 'append_only';end if;return new;end $$;
create trigger forward_guard before update or delete on public.forward_watches for each row execute function public.forward_guard();
create trigger forward_events_immutable before update or delete on public.forward_events for each row execute function public.shadow_immutable();
create function public.forward_write(_owner uuid,_request uuid,_action text,_id uuid,_payload jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare w public.forward_watches;a public.agents;prior public.forward_requests;bh text;r jsonb;f jsonb;expected jsonb;stamp text;n integer;obs jsonb;prop jsonb;lastobs jsonb;lastprop jsonb;initial boolean;nowtime timestamptz;
begin
if _owner is null or _request is null or octet_length(_payload::text)>50000 then raise exception 'invalid_request';end if;
perform pg_advisory_xact_lock(hashtextextended('forward:'||_owner::text,0));nowtime:=public.forward_now();stamp:=public.forward_stamp();
bh:=_payload->>'bodyHash';if coalesce(bh,'')!~'^[a-f0-9]{64}$' then raise exception 'request_mismatch';end if;
select * into prior from public.forward_requests where owner_id=_owner and request_id=_request;
if found and prior.body_hash<>bh then raise exception 'request_mismatch';end if;
if found and _action not in('finish','fail','reserve') then return prior.response;end if;
if found and _action='reserve' and prior.response->>'status'<>'reserved' then return prior.response;end if;
if _action not in('create','edit','reserve','finish','fail','share','annotate','end') then raise exception 'unsupported_action';end if;
if _action<>'create' then select * into w from public.forward_watches where id=_id for update;if not found or w.owner_id<>_owner then raise exception 'not_owner';end if;end if;
if _action in('create','edit') or (_action='reserve' and w.committed_at is null) then
 f:=case when _action='reserve' then w.frozen else _payload->'frozen' end;
 select * into a from public.agents where id=f->'terms'->>'agentId' for update;if not found or a.owner_id<>_owner::text or a.status='archived' then raise exception 'not_owner';end if;
 expected:=jsonb_build_object('handle',a.handle,'archetype',a.archetype,'risk',a.risk,'personaDigest',public.shadow_hash('shadow.persona/1',to_jsonb(a.persona)),'strategyDigest',public.shadow_hash('shadow.strategy/1',to_jsonb(a.strategy)));
 if f->'version'->'db'<>expected or f->'version'->>'agentId'<>a.id or f->'version'->>'policyHash'<>public.shadow_hash('shadow.policy/1',expected) or f->>'versionHash'<>public.shadow_hash('forward.version/1',f->'version') or _payload->>'versionHash'<>f->>'versionHash' then raise exception 'changed_version';end if;
 if f->>'engine'<>'forward-inventory/1' or (f->'terms'->>'cadenceSeconds')::int<60 or (f->'terms'->>'maxSteps')::int not between 2 and 48 or (f->'terms'->>'expirySeconds')::int>604800 then raise exception 'invalid_terms';end if;
end if;
select count(*) into n from public.forward_events where watch_id=w.id;
if n>=240 and _action not in('end','share','finish','fail') then raise exception 'history_quota';end if;
if _action='create' then
 if (select count(*) from public.forward_watches where owner_id=_owner and created_at>=date_trunc('day',nowtime at time zone 'UTC') at time zone 'UTC')>=6 then raise exception 'daily_quota';end if;
 insert into public.forward_watches(owner_id,agent_id,frozen,draft_hash,created_at) values(_owner,a.id,f,public.shadow_hash('forward.draft/1',f),nowtime) returning * into w;
 perform public.forward_log(w.id,'created',jsonb_build_object('draftHash',w.draft_hash),stamp);r:=jsonb_build_object('id',w.id,'status',w.status);
elsif _action='edit' then
 if w.status<>'draft' or w.lease_until>nowtime then raise exception 'frozen';end if;if w.draft_hash<>_payload->>'reviewedHash' then raise exception 'draft_conflict';end if;
 if f->'terms'->>'agentId'<>w.agent_id then raise exception 'immutable_agent';end if;
 update public.forward_watches set frozen=f,draft_hash=public.shadow_hash('forward.draft/1',f) where id=w.id returning * into w;
 perform public.forward_log(w.id,'edited',jsonb_build_object('draftHash',w.draft_hash),stamp);r:=jsonb_build_object('id',w.id,'status',w.status);
elsif _action='reserve' then
 if w.status not in('draft','watching') then raise exception 'ended';end if;if w.lease_until>nowtime then raise exception 'busy';end if;
 if (select count(*) from public.forward_watches where owner_id=_owner and lease_until>nowtime)>=2 then raise exception 'inflight_quota';end if;
 if (select count(*) from public.forward_events e join public.forward_watches s on s.id=e.watch_id where s.owner_id=_owner and e.event->>'kind'='reserved' and (e.event->>'at')::timestamptz>=date_trunc('day',nowtime at time zone 'UTC') at time zone 'UTC')>=96 then raise exception 'daily_capture_quota';end if;
 if w.committed_at is null and w.draft_hash<>_payload->>'reviewedHash' then raise exception 'draft_conflict';end if;
 if w.committed_at is not null and nowtime>w.committed_at::timestamptz+(w.frozen->'terms'->>'expirySeconds')::int*interval '1 second' then update public.forward_watches set status='expired' where id=w.id;perform public.forward_log(w.id,'ended',jsonb_build_object('reason','expired'),stamp);return jsonb_build_object('id',w.id,'status','expired');end if;
 lastobs:=w.observations->(jsonb_array_length(w.observations)-1);lastprop:=w.proposals->(jsonb_array_length(w.proposals)-1);
 if lastobs is not null and (nowtime<=(lastprop->>'decisionAt')::timestamptz or nowtime<(lastobs->>'requestedAt')::timestamptz+(w.frozen->'terms'->>'cadenceSeconds')::int*interval '1 second') then raise exception 'minimum_spacing';end if;
 if w.request_started is not null and nowtime<w.request_started::timestamptz+interval '60 seconds' then raise exception 'minimum_spacing';end if;
 update public.forward_watches set lease_token=gen_random_uuid(),lease_until=nowtime+interval '60 seconds',generation=generation+1,request_started=stamp,committed_at=coalesce(committed_at,stamp),status='watching' where id=w.id returning * into w;
 perform public.forward_log(w.id,'reserved',jsonb_build_object('generation',w.generation,'prefixHash',public.shadow_hash('forward.prefix/1',(select coalesce(jsonb_agg(public.shadow_hash('forward.evidence/1',v) order by ord),'[]') from jsonb_array_elements(w.observations) with ordinality x(v,ord)))),stamp);
 r:=jsonb_build_object('id',w.id,'status','reserved','token',w.lease_token,'generation',w.generation,'requestedAt',stamp,'committedAt',w.committed_at,'frozen',w.frozen,'observations',w.observations,'proposals',w.proposals);
elsif _action in('finish','fail') then
 if w.lease_token::text is distinct from _payload->>'token' or w.generation<>(_payload->>'generation')::int or w.lease_until<=nowtime or w.status<>'watching' then raise exception 'lease_lost';end if;
 initial:=jsonb_array_length(w.observations)=0;
 if initial and _action='finish' then select * into a from public.agents where id=w.agent_id for update;expected:=jsonb_build_object('handle',a.handle,'archetype',a.archetype,'risk',a.risk,'personaDigest',public.shadow_hash('shadow.persona/1',to_jsonb(a.persona)),'strategyDigest',public.shadow_hash('shadow.strategy/1',to_jsonb(a.strategy)));if a.owner_id<>_owner::text or a.status='archived' or w.frozen->'version'->'db'<>expected then raise exception 'changed_version';end if;end if;
 if _action='fail' then
  update public.forward_watches set lease_token=null,lease_until=null,status=case when _payload->>'reason'='source_changed' or initial then 'incomplete' else 'watching' end where id=w.id;
  perform public.forward_log(w.id,'failure',jsonb_build_object('reason',case when _payload->>'reason' in('source_changed','stale_source','source_unavailable') then _payload->>'reason' else 'source_unavailable' end,'requestedAt',w.request_started,'generation',w.generation),stamp);r:=jsonb_build_object('id',w.id,'status','failed');
 else
  obs:=_payload->'evidence';prop:=_payload->'proposal';lastobs:=w.observations->(jsonb_array_length(w.observations)-1);lastprop:=w.proposals->(jsonb_array_length(w.proposals)-1);
  if obs->>'requestedAt'<>w.request_started or (obs->>'fetchedAt')::timestamptz<(obs->>'requestedAt')::timestamptz or (obs->>'fetchedAt')::timestamptz>nowtime or nowtime-(obs->>'fetchedAt')::timestamptz>interval '60 seconds' or nowtime-to_timestamp((obs->>'blockTime')::bigint)>(w.frozen->'terms'->>'maxStalenessSeconds')::int*interval '1 second' or obs->>'pool'<>w.frozen->'terms'->>'pool' or obs->>'adapter'<>w.frozen->'terms'->>'adapter' or obs->>'orientation'<>w.frozen->'terms'->>'orientation' or obs->>'commitment'<>'finalized' then raise exception 'invalid_capture';end if;
  if lastobs is not null and ((obs->>'slot')::bigint<=(lastobs->>'slot')::bigint or (obs->>'blockTime')::bigint<=(lastobs->>'blockTime')::bigint or (obs->>'requestedAt')::timestamptz<=(lastprop->>'decisionAt')::timestamptz) then raise exception 'stale_source';end if;
  prop:=jsonb_set(prop,'{decisionAt}',to_jsonb(stamp));
  if (prop->>'index')::int<>jsonb_array_length(w.observations) or prop->>'prefixHash'<>public.shadow_hash('forward.prefix/1',(select jsonb_agg(public.shadow_hash('forward.evidence/1',v) order by ord) from jsonb_array_elements(w.observations||jsonb_build_array(obs)) with ordinality x(v,ord))) then raise exception 'prefix_mismatch';end if;
  update public.forward_watches set observations=observations||jsonb_build_array(obs),proposals=proposals||jsonb_build_array(prop),commitment=case when initial then public.shadow_hash('forward.commit/1',jsonb_build_object('draftHash',w.draft_hash,'committedAt',w.committed_at,'initialHash',public.shadow_hash('forward.evidence/1',obs))) else commitment end,lease_token=null,lease_until=null,status=case when jsonb_array_length(observations)+1=(frozen->'terms'->>'maxSteps')::int then case when _payload->>'complete'='true' then 'complete' else 'partial' end else 'watching' end where id=w.id returning * into w;
  perform public.forward_log(w.id,case when initial then 'committed' else 'capture' end,jsonb_build_object('evidenceHash',public.shadow_hash('forward.evidence/1',obs),'proposalHash',public.shadow_hash('forward.proposal/1',prop),'commitment',w.commitment),stamp);r:=jsonb_build_object('id',w.id,'status',w.status);
 end if;
elsif _action='share' then
 if (_payload->>'shared')::boolean and w.commitment is null then raise exception 'capture_before_sharing';end if;
 if w.shared is distinct from (_payload->>'shared')::boolean then update public.forward_watches set shared=(_payload->>'shared')::boolean where id=w.id;perform public.forward_log(w.id,'shared',jsonb_build_object('shared',(_payload->>'shared')::boolean),stamp);end if;r:=jsonb_build_object('id',w.id,'status',w.status);
elsif _action='annotate' then
 if length(_payload->>'text') not between 1 and 500 then raise exception 'invalid_note';end if;perform public.forward_log(w.id,'annotation',jsonb_build_object('text',_payload->>'text'),stamp);r:=jsonb_build_object('id',w.id,'status',w.status);
elsif _action='end' then
 if w.status in('draft','watching') then update public.forward_watches set status='ended',lease_token=null,lease_until=null where id=w.id;perform public.forward_log(w.id,'ended',jsonb_build_object('reason','owner ended'),stamp);end if;r:=jsonb_build_object('id',w.id,'status','ended');
end if;
insert into public.forward_requests(owner_id,request_id,body_hash,response,created_at) values(_owner,_request,bh,r,nowtime) on conflict(owner_id,request_id) do update set response=excluded.response;return r;
end $$;
revoke all on function public.forward_now(),public.forward_stamp(),public.forward_log(uuid,text,jsonb,text),public.forward_guard(),public.forward_write(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.forward_write(uuid,uuid,text,uuid,jsonb) to service_role;
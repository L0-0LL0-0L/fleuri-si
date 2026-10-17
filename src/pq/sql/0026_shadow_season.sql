-- Shadow Season: private frozen synthetic experiments; no financial authority.
create table public.shadow_seasons (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null, agent_id text not null,
 status text not null default 'draft' check(status in ('draft','committed','evaluating','completed')),
 frozen jsonb not null, input_hash text not null, seed_hex text not null, seed_commit text not null,
 committed_at timestamptz, commitment text, result jsonb, result_hash text, tape jsonb,
 shared boolean not null default false, generation integer not null default 0,
 lease_token uuid, lease_expires_at timestamptz, created_at timestamptz not null default clock_timestamp()
);
grant select(id,owner_id,agent_id,status,frozen,input_hash,seed_commit,committed_at,commitment,result,result_hash,tape,shared,generation,created_at) on public.shadow_seasons to authenticated,anon;
grant all on public.shadow_seasons to service_role;
alter table public.shadow_seasons enable row level security;
create policy shadow_read on public.shadow_seasons for select to authenticated,anon using(owner_id=auth.uid() or shared);
create index shadow_owner_created on public.shadow_seasons(owner_id,created_at desc);
create table public.shadow_events (
 season_id uuid not null references public.shadow_seasons(id), seq integer not null,
 event jsonb not null, primary key(season_id,seq)
);
grant select on public.shadow_events to authenticated,anon;
grant all on public.shadow_events to service_role;
alter table public.shadow_events enable row level security;
create policy shadow_event_read on public.shadow_events for select to authenticated,anon using(exists(select 1 from public.shadow_seasons s where s.id=season_id and(s.owner_id=auth.uid() or s.shared)));
create table public.shadow_requests (
 owner_id uuid not null, request_id uuid not null, body_hash text not null, response jsonb not null,
 created_at timestamptz not null default clock_timestamp(), primary key(owner_id,request_id)
);
grant all on public.shadow_requests to service_role;
alter table public.shadow_requests enable row level security;

create function public.shadow_now() returns timestamptz language sql volatile as $$ select clock_timestamp() $$;
create function public.shadow_canonical(v jsonb) returns text language plpgsql immutable set search_path=public as $$
declare r text;
begin
 case jsonb_typeof(v)
 when 'object' then select '{'||coalesce(string_agg(to_jsonb(key)::text||':'||public.shadow_canonical(value),',' order by key),'')||'}' into r from jsonb_each(v);
 when 'array' then select '['||coalesce(string_agg(public.shadow_canonical(value),',' order by ord),'')||']' into r from jsonb_array_elements(v) with ordinality x(value,ord);
 else r:=v::text; end case; return r;
end $$;
create function public.shadow_hash(d text,v jsonb) returns text language sql immutable set search_path=public as $$ select encode(sha256(convert_to(d||E'\n'||public.shadow_canonical(v),'UTF8')),'hex') $$;
create function public.shadow_log(_id uuid,_kind text,_body jsonb) returns void language plpgsql set search_path=public as $$
declare n integer; p text; e jsonb;
begin
 select coalesce(max(seq),0)+1 into n from public.shadow_events where season_id=_id;
 select event->>'hash' into p from public.shadow_events where season_id=_id order by seq desc limit 1;
 e:=jsonb_build_object('seq',n,'kind',_kind,'at',to_char(public.shadow_now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'body',_body,'previous',coalesce(p,repeat('0',64)));
 insert into public.shadow_events values(_id,n,e||jsonb_build_object('hash',public.shadow_hash('shadow.event/1',e)));
end $$;
create function public.shadow_immutable() returns trigger language plpgsql as $$ begin raise exception 'append_only'; end $$;
create trigger shadow_events_immutable before update or delete on public.shadow_events for each row execute function public.shadow_immutable();
create trigger shadow_requests_immutable before update or delete on public.shadow_requests for each row execute function public.shadow_immutable();
create function public.shadow_frozen_guard() returns trigger language plpgsql as $$
begin
 if old.status<>'draft' and (new.frozen is distinct from old.frozen or new.input_hash is distinct from old.input_hash or new.seed_hex is distinct from old.seed_hex or new.seed_commit is distinct from old.seed_commit or new.committed_at is distinct from old.committed_at or new.commitment is distinct from old.commitment) then raise exception 'frozen'; end if;
 if old.result is not null and(new.result is distinct from old.result or new.result_hash is distinct from old.result_hash or new.tape is distinct from old.tape or new.status is distinct from old.status) then raise exception 'immutable_result'; end if;
 if new.owner_id<>old.owner_id or new.agent_id<>old.agent_id then raise exception 'immutable_owner'; end if;
 return new;
end $$;
create trigger shadow_frozen_guard before update on public.shadow_seasons for each row execute function public.shadow_frozen_guard();

-- Single coordinator: owner advisory lock -> season row -> agent. No inverse lock path.
create function public.shadow_write(_owner uuid,_request uuid,_action text,_id uuid,_payload jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare s public.shadow_seasons; a public.agents; prior public.shadow_requests; bh text; r jsonb; f jsonb; seed text; vh text; stamp timestamptz; stamptext text; expected jsonb; n integer;
begin
 if _owner is null or _request is null or octet_length(_payload::text)>500000 then raise exception 'invalid_request'; end if;
 perform pg_advisory_xact_lock(hashtextextended('shadow:'||_owner::text,0));
 bh:=public.shadow_hash('shadow.request/1',jsonb_build_object('action',_action,'id',_id,'payload',_payload));
 select * into prior from public.shadow_requests where owner_id=_owner and request_id=_request;
 if found then if prior.body_hash<>bh then raise exception 'request_mismatch'; end if; return prior.response; end if;
 if _action not in ('create','edit','commit','claim','finish','share','annotate') then raise exception 'unsupported_action'; end if;
 if _action<>'create' then
  select * into s from public.shadow_seasons where id=_id for update;
  if not found or s.owner_id<>_owner then raise exception 'not_owner'; end if;
 end if;
 if _action in ('create','edit','commit') then
  f:=case when _action='commit' then s.frozen else _payload->'frozen' end;
  select * into a from public.agents where id=f->'terms'->>'agentId' for update;
  if not found or a.owner_id<>_owner::text or a.status='archived' then raise exception 'not_owner'; end if;
  expected:=jsonb_build_object('handle',a.handle,'archetype',a.archetype,'risk',a.risk,'personaDigest',public.shadow_hash('shadow.persona/1',to_jsonb(a.persona)),'strategyDigest',public.shadow_hash('shadow.strategy/1',to_jsonb(a.strategy)));
  if f->'version'->'db'<>expected or f->'version'->>'agentId'<>a.id then raise exception 'changed_version'; end if;
  vh:=public.shadow_hash('shadow.version/1',f->'version');
  if _payload->>'versionHash'<>vh then raise exception 'changed_version'; end if;
 end if;
 if _action='create' then
  select count(*) into n from public.shadow_seasons where owner_id=_owner and created_at>=(date_trunc('day',public.shadow_now() at time zone 'UTC') at time zone 'UTC');
  if n>=6 then raise exception 'daily_quota'; end if;
  seed:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  f:=jsonb_set(f,'{seedCommit}',to_jsonb(public.shadow_hash('shadow.seed/1',to_jsonb(seed))));
  insert into public.shadow_seasons(owner_id,agent_id,frozen,input_hash,seed_hex,seed_commit) values(_owner,a.id,f,public.shadow_hash('shadow.input/1',f),seed,f->>'seedCommit') returning * into s;
  perform public.shadow_log(s.id,'created',jsonb_build_object('inputHash',s.input_hash));
  r:=jsonb_build_object('id',s.id,'status',s.status);
 elsif _action='edit' then
  if s.status<>'draft' then raise exception 'frozen'; end if;
  if s.input_hash<>_payload->>'reviewedHash' then raise exception 'draft_conflict'; end if;
  if f->'terms'->>'agentId'<>s.agent_id then raise exception 'immutable_agent'; end if;
  f:=jsonb_set(f,'{seedCommit}',to_jsonb(s.seed_commit));
  update public.shadow_seasons set frozen=f,input_hash=public.shadow_hash('shadow.input/1',f) where id=s.id returning * into s;
  perform public.shadow_log(s.id,'edited',jsonb_build_object('inputHash',s.input_hash));
  r:=jsonb_build_object('id',s.id,'status',s.status);
 elsif _action='commit' then
  if s.status<>'draft' then raise exception 'already_committed'; end if;
  if s.input_hash<>_payload->>'reviewedHash' then raise exception 'draft_conflict'; end if;
  stamp:=public.shadow_now(); stamptext:=to_char(stamp at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- Persist millisecond precision so exported commitment and event time are identical.
  update public.shadow_seasons set status='committed',committed_at=stamptext::timestamptz,commitment=public.shadow_hash('shadow.commit/1',jsonb_build_object('inputHash',s.input_hash,'committedAt',stamptext)) where id=s.id returning * into s;
  -- Use stored timestamp rather than a later clock read for the commit event.
  select coalesce(max(seq),0)+1 into n from public.shadow_events where season_id=s.id;
  expected:=jsonb_build_object('seq',n,'kind','committed','at',stamptext,'body',jsonb_build_object('inputHash',s.input_hash,'commitment',s.commitment),'previous',(select event->>'hash' from public.shadow_events where season_id=s.id order by seq desc limit 1));
  insert into public.shadow_events values(s.id,n,expected||jsonb_build_object('hash',public.shadow_hash('shadow.event/1',expected)));
  r:=jsonb_build_object('id',s.id,'status',s.status);
 elsif _action='claim' then
  if s.status='completed' then return jsonb_build_object('id',s.id,'status','completed'); end if;
  if s.status='draft' then raise exception 'not_committed'; end if;
  if s.lease_expires_at>public.shadow_now() then return jsonb_build_object('id',s.id,'status','busy'); end if;
  select count(*) into n from public.shadow_seasons where owner_id=_owner and lease_expires_at>public.shadow_now();
  if n>=2 then raise exception 'inflight_quota'; end if;
  update public.shadow_seasons set status='evaluating',generation=generation+1,lease_token=gen_random_uuid(),lease_expires_at=public.shadow_now()+interval '60 seconds' where id=s.id returning * into s;
  perform public.shadow_log(s.id,'evaluating',jsonb_build_object('generation',s.generation));
  r:=jsonb_build_object('id',s.id,'status','claimed','token',s.lease_token,'generation',s.generation,'seed',s.seed_hex,'frozen',s.frozen);
 elsif _action='finish' then
  if s.status<>'evaluating' or s.lease_token::text<>_payload->>'token' or s.generation<>(_payload->>'generation')::integer or s.lease_expires_at<=public.shadow_now() then raise exception 'lease_lost'; end if;
  if s.input_hash<>_payload->>'inputHash' or public.shadow_hash('shadow.result/1',_payload->'result')<>_payload->>'resultHash' then raise exception 'result_mismatch'; end if;
  update public.shadow_seasons set status='completed',result=_payload->'result',result_hash=_payload->>'resultHash',tape=_payload->'tape',lease_expires_at=null,lease_token=null where id=s.id returning * into s;
  perform public.shadow_log(s.id,'completed',jsonb_build_object('resultHash',s.result_hash));
  r:=jsonb_build_object('id',s.id,'status','completed');
 elsif _action='share' then
  if jsonb_typeof(_payload->'shared')<>'boolean' then raise exception 'invalid_share'; end if;
  if s.status<>'completed' then raise exception 'complete_before_sharing'; end if;
  update public.shadow_seasons set shared=(_payload->>'shared')::boolean where id=s.id;
  perform public.shadow_log(s.id,'shared',jsonb_build_object('shared',(_payload->>'shared')::boolean));
  r:=jsonb_build_object('id',s.id,'shared',(_payload->>'shared')::boolean);
 else
  if s.status<>'completed' or length(_payload->>'text') not between 1 and 500 then raise exception 'invalid_annotation'; end if;
  select count(*) into n from public.shadow_events where season_id=s.id;
  if n>=150 then raise exception 'annotation_quota'; end if;
  perform public.shadow_log(s.id,'annotation',jsonb_build_object('text',_payload->>'text','requestId',_request));
  r:=jsonb_build_object('id',s.id,'annotated',true);
 end if;
 insert into public.shadow_requests(owner_id,request_id,body_hash,response) values(_owner,_request,bh,r);
 return r;
end $$;
revoke all on function public.shadow_now(),public.shadow_canonical(jsonb),public.shadow_hash(text,jsonb),public.shadow_log(uuid,text,jsonb),public.shadow_immutable(),public.shadow_frozen_guard(),public.shadow_write(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.shadow_write(uuid,uuid,text,uuid,jsonb) to service_role;

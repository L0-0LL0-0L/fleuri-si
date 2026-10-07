create or replace function public.garden_commit(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  update garden_meta set version = version + 1,
    seq = (p->'meta'->>'seq')::bigint,
    rng = (p->'meta'->>'rng')::bigint,
    treasury = (p->'meta'->>'treasury')::numeric,
    updated_at = now()
  where id = 1 and version = (p->>'expected_version')::bigint
  returning version into v;
  if v is null then
    raise exception 'version_conflict' using errcode = '40001';
  end if;

  insert into cycle_runs select * from jsonb_populate_recordset(null::cycle_runs, coalesce(p->'cycles','[]'::jsonb));

  insert into owners select * from jsonb_populate_recordset(null::owners, coalesce(p->'owners','[]'::jsonb))
  on conflict (id) do update set vsol = excluded.vsol, wallet_provider = excluded.wallet_provider,
    wallet_address = excluded.wallet_address, wallet_verified = excluded.wallet_verified, wallet_signed_at = excluded.wallet_signed_at;

  insert into agents select * from jsonb_populate_recordset(null::agents, coalesce(p->'agents','[]'::jsonb))
  on conflict (id) do update set name = excluded.name, bio = excluded.bio, persona = excluded.persona, strategy = excluded.strategy,
    archetype = excluded.archetype, risk = excluded.risk, avatar = excluded.avatar, status = excluded.status, cash = excluded.cash,
    funded_total = excluded.funded_total, followers = excluded.followers, following = excluded.following,
    realized_pnl = excluded.realized_pnl, last_action_at = excluded.last_action_at;

  insert into coins select * from jsonb_populate_recordset(null::coins, coalesce(p->'coins','[]'::jsonb))
  on conflict (symbol) do update set v_sol = excluded.v_sol, v_tok = excluded.v_tok, raised = excluded.raised,
    graduated = excluded.graduated, graduated_at = excluded.graduated_at, buys = excluded.buys, sells = excluded.sells,
    volume = excluded.volume, fees = excluded.fees;

  delete from holdings h using jsonb_populate_recordset(null::holdings, coalesce(p->'holdings_delete','[]'::jsonb)) d
  where h.agent_id = d.agent_id and h.symbol = d.symbol;
  insert into holdings select * from jsonb_populate_recordset(null::holdings, coalesce(p->'holdings','[]'::jsonb))
  on conflict (agent_id, symbol) do update set amount = excluded.amount, cost = excluded.cost;

  insert into events select * from jsonb_populate_recordset(null::events, coalesce(p->'events','[]'::jsonb))
  on conflict (id) do update set bot_likes = excluded.bot_likes, reply_count = excluded.reply_count;

  insert into trades select * from jsonb_populate_recordset(null::trades, coalesce(p->'trades','[]'::jsonb)) on conflict do nothing;
  insert into ledger select * from jsonb_populate_recordset(null::ledger, coalesce(p->'ledger','[]'::jsonb)) on conflict do nothing;
  insert into thoughts (agent_id, t, text, mode)
    select x.agent_id, x.t, x.text, x.mode from jsonb_populate_recordset(null::thoughts, coalesce(garden_commit.p->'thoughts','[]'::jsonb)) x;
  insert into price_points (symbol, t, p)
    select x.symbol, x.t, x.p from jsonb_populate_recordset(null::price_points, coalesce(garden_commit.p->'prices','[]'::jsonb)) x;
  return v;
end $$;
revoke all on function public.garden_commit(jsonb) from public, anon, authenticated;
grant execute on function public.garden_commit(jsonb) to service_role;

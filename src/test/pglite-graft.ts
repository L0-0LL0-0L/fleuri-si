// Test helper: PGlite with the REAL Graft SQL (0022), a minimal agents table, a controllable graft_now()
// clock (isolated test DB only) and a small Supabase-like client.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export async function graftDb() {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  await pg.exec(`create table public.agents(id text primary key, handle text not null, name text not null default 'n', archetype text not null, risk int not null, strategy text not null default '', persona text not null default '', owner_id text not null, status text not null default 'active', cash numeric not null default 0);
    grant select on public.agents to anon, authenticated;
    create table public.bloom_rounds(id uuid primary key, title text not null default 'r', status text not null);
    create table public.bloom_entries(id uuid primary key, round_id uuid not null, owner_id uuid not null, agent_id text not null, base_policy_hash text not null, status text not null default 'revealed', created_at timestamptz not null default now());
    create table public.research_receipts(id uuid primary key, owner_id uuid not null, run_id uuid, status text not null, manifest jsonb, anchor_status text not null default 'none', created_at timestamptz not null default now());`);
  for (const f of ["0022_graft.sql", "0023_graft_review_fixes.sql", "0025_graft_evidence_and_retries.sql"]) await pg.exec(await readFile(new URL(`../pq/sql/${f}`, import.meta.url), "utf8"));
  await pg.exec(`create table public.test_clock(t timestamptz); insert into public.test_clock values (now());
    create or replace function public.graft_now() returns timestamptz language sql stable as $$ select t from public.test_clock $$;`);
  const lit = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : v);
  const norm = (x: any) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v]));
  const client = {
    pg,
    now: async () => (await pg.query<any>("select t from public.test_clock")).rows[0].t as Date,
    advance: (secs: number) => pg.query(`update public.test_clock set t = t + make_interval(secs => $1)`, [secs]),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      try {
        const r = await pg.query<any>(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(",")}) as j`, names.map((n) => lit(args[n])));
        return { data: r.rows[0]?.j ?? null, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    from: (table: string) => {
      const where: string[] = []; const params: unknown[] = []; let cols = "*"; let order = "";
      const b: any = {
        select: (c: string) => { cols = c; return b; },
        eq: (c: string, v: unknown) => { params.push(v == null ? null : String(v)); where.push(`${c}::text = $${params.length}`); return b; },
        in: (c: string, vs: unknown[]) => { params.push(vs.map(String)); where.push(`${c}::text = any($${params.length})`); return b; },
        order: (c: string, o?: { ascending?: boolean }) => { order = ` order by ${c} ${o?.ascending === false ? "desc" : "asc"}`; return b; },
        limit: () => b,
        run: async () => { try { const r = await pg.query<any>(`select ${cols} from public.${table}${where.length ? " where " + where.join(" and ") : ""}${order}`, params); return { data: r.rows.map(norm), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
        maybeSingle: async () => { const r = await b.run(); return r.error ? r : { data: r.data[0] ?? null, error: null }; },
        then: (res: any, rej: any) => b.run().then(res, rej),
      };
      return b;
    },
  };
  return client;
}

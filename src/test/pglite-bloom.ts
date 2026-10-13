// Test helper: PGlite with the REAL Blind Bloom SQL (0020), minimal agents/launch_proposals, a controllable
// bloom_now() clock (isolated test DB only) and a Supabase-like client (from().select().eq().maybeSingle(), rpc()).
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export async function bloomDb() {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  await pg.exec(`create table public.agents(id text primary key, handle text not null, name text not null, archetype text not null, risk int not null, strategy text not null default '', persona text not null default '', owner_id text not null, status text not null default 'active');
    create table public.launch_proposals(id uuid primary key default gen_random_uuid(), agent_handle text not null, origin_agent_id text, origin_policy_hash text, status text not null default 'proposed', name text not null default 'x', symbol text not null default 'XX', created_at timestamptz not null default now());
    grant select on public.agents, public.launch_proposals to anon, authenticated;`);
  for (const f of ["0020_blind_bloom.sql", "0021_blind_bloom_fail_fence.sql"]) await pg.exec(await readFile(new URL(`../pq/sql/${f}`, import.meta.url), "utf8"));
  // Controllable clock: replace bloom_now() in this isolated database only.
  await pg.exec(`create table public.test_clock(t timestamptz); insert into public.test_clock values (now());
    create or replace function public.bloom_now() returns timestamptz language sql stable as $$ select t from public.test_clock $$;`);
  const lit = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : v);
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const client = {
    pg,
    advance: (secs: number) => pg.query(`update public.test_clock set t = t + make_interval(secs => $1)`, [secs]),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const names = Object.keys(args);
      try {
        const r = await pg.query<any>(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(",")}) as j`, names.map((n) => lit(args[n])));
        return { data: r.rows[0]?.j ?? null, error: null };
      } catch (e) { return { data: null, error: { message: (e as Error).message } }; }
    },
    from: (table: string) => {
      const where: string[] = []; const params: unknown[] = []; let cols = "*";
      const b: any = {
        select: (c: string) => { cols = c; return b; },
        eq: (c: string, v: unknown) => { params.push(str(v)); where.push(`${c}::text = $${params.length}`); return b; },
        run: async () => { try { const r = await pg.query<any>(`select ${cols} from public.${table}${where.length ? " where " + where.join(" and ") : ""}`, params); return { data: r.rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : typeof v === "bigint" ? Number(v) : v]))), error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
        maybeSingle: async () => { const r = await b.run(); return r.error ? r : { data: r.data[0] ?? null, error: null }; },
        then: (res: any, rej: any) => b.run().then(res, rej),
      };
      return b;
    },
  };
  return client;
}

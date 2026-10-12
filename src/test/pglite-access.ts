// Test helper: a PGlite database with the real 0016 Pollen Access SQL and a tiny Supabase-like client
// (from().select().eq().in().maybeSingle() and rpc()) so server code runs against the actual functions.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export async function accessDb() {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  await pg.exec("create table public.owners(id uuid primary key, wallet_address text, wallet_verified boolean not null default false);");
  await pg.exec(await readFile(new URL("../pq/sql/0016_pollen_access.sql", import.meta.url), "utf8"));
  const lit = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v));
  const client = {
    pg,
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
        eq: (c: string, v: unknown) => { params.push(lit(v)); where.push(`${c}::text = $${params.length}`); return b; },
        in: (c: string, vs: unknown[]) => { params.push(vs.map(lit)); where.push(`${c}::text = any($${params.length}::text[])`); return b; },
        run: async () => { try { const r = await pg.query<any>(`select ${cols} from public.${table}${where.length ? " where " + where.join(" and ") : ""}`, params); return { data: r.rows, error: null }; } catch (e) { return { data: null, error: { message: (e as Error).message } }; } },
        maybeSingle: async () => { const r = await b.run(); return r.error ? r : { data: r.data[0] ?? null, error: null }; },
        then: (res: any, rej: any) => b.run().then(res, rej),
      };
      return b;
    },
  };
  return client;
}

export const readyChecks = (over: Record<string, boolean> = {}) =>
  ["cluster", "rpc", "configured", "program", "code", "upgrade", "mint", "mintAuth", "freezeAuth", "pool", "vaults", "source"].map((id) => ({ id, label: id, ok: over[id] ?? true, detail: `${id} detail` }));

// Test helper: a PGlite database with the real 0016 + 0017 Pollen Access SQL (plus minimal greenhouse_runs and a
// garden_commit stand-in that records effects and can fail on request) and a tiny Supabase-like client
// (from().select().eq().in().maybeSingle() and rpc()) so server code runs against the actual functions.
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export async function accessDb() {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;");
  await pg.exec("create table public.owners(id uuid primary key, wallet_address text, wallet_verified boolean not null default false);");
  await pg.exec(`create table public.greenhouse_runs(id uuid primary key default gen_random_uuid(), owner_id uuid not null, request_id uuid not null, status text not null);
    create table public.agents(id text primary key, owner_id text not null);
    create function public.greenhouse_claim_lease(_owner uuid,_request uuid,_engine text,_agents text[],_input jsonb,_input_hash text) returns jsonb language plpgsql as $$
      declare g public.greenhouse_runs; begin
      select * into g from public.greenhouse_runs where owner_id=_owner and request_id=_request;
      if g.id is null then insert into public.greenhouse_runs(owner_id,request_id,status) values(_owner,_request,'running') returning * into g;
        return jsonb_build_object('id',g.id,'status',g.status,'acquired',true,'lease',gen_random_uuid(),'attempts',1); end if;
      return jsonb_build_object('id',g.id,'status',g.status,'acquired',false,'lease',null,'attempts',2); end $$;
    create table public.garden_effects(bucket text primary key, p jsonb not null);
    create function public.garden_commit(p jsonb) returns bigint language plpgsql as $$ begin
      insert into public.garden_effects values (p->'cycles'->0->>'bucket', p);
      if p->>'fail' = '1' then raise exception 'version_conflict' using errcode = '40001'; end if;
      return 1; end $$;`);
  await pg.exec(await readFile(new URL("../pq/sql/0016_pollen_access.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../pq/sql/0017_pollen_access_fenced.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../pq/sql/0018_pollen_access_deep_binding.sql", import.meta.url), "utf8"));
  const lit = (v: unknown) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : v);
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
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
        eq: (c: string, v: unknown) => { params.push(str(v)); where.push(`${c}::text = $${params.length}`); return b; },
        in: (c: string, vs: unknown[]) => { params.push(vs.map(str)); where.push(`${c}::text = any($${params.length}::text[])`); return b; },
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

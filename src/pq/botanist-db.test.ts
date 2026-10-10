// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
let db: PGlite;
const sql = (f: string) => readFile(new URL(f, import.meta.url), "utf8");
const cap = "c".repeat(64);
beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to anon,authenticated,service_role;");
  await db.exec(await sql("../../drizzle/migrations/0003_pq_launchpad.sql"));
  await db.exec(await sql("./sql/0004_pq_atomic_and_permissions.sql"));
  await db.exec(await sql("../../drizzle/migrations/0005_living_passports_pollen_botanist.sql"));
  // Supabase-style broad default grants, so the hardening migration is actually exercised.
  await db.exec("grant all on all tables in schema public to anon,authenticated;");
  await db.exec(await sql("../../drizzle/migrations/0006_harden_new_table_permissions.sql"));
  await db.exec(await sql("../../drizzle/migrations/0007_persist_owner_permission_restrictions.sql"));
  await db.exec(await sql("../../drizzle/migrations/0008_botanist_settlement_recovery.sql"));
}, 30_000);
afterAll(async () => { await db?.close(); });
const job = async (memo: string, expires = "now()+interval '10 minutes'") => (await db.query<any>(`insert into botanist_jobs(request_hash,capability_hash,client_hash,mint,network,asset,amount,pay_to,memo,quote_expires_at) values(md5($1)||md5($1),$2,'c','mint','solana:x','usdc',500000,'pay',$1,${expires}) returning id`, [memo, cap])).rows[0].id;
const claim = (id: string, h: string) => db.query<any>("select (botanist_claim_payment($1,$2,$3,'tx-bytes','payer')).*", [id, cap, h]);

describe("botanist job state machine", () => {
  it("denies anon/authenticated reads, writes and TRUNCATE on private jobs and public tables", async () => {
    for (const r of ["anon", "authenticated"]) {
      await db.exec(`set role ${r}`);
      await expect(db.query("select * from botanist_jobs")).rejects.toThrow(/permission/);
      for (const t of ["botanist_jobs", "passport_observations", "pollen_vaults", "pollen_associations"]) await expect(db.exec(`truncate ${t} cascade`)).rejects.toThrow(/permission/);
      await expect(db.exec("insert into pollen_vaults(address) values('x')")).rejects.toThrow(/permission/);
      for (const t of ["passport_observations", "pollen_vaults", "pollen_associations"]) {
        await expect(db.query(`select count(*) from ${t}`)).resolves.toBeTruthy(); // public SELECT retained
        await expect(db.exec(`delete from ${t}`)).rejects.toThrow(/permission/);
        await expect(db.exec(`update ${t} set created_at=created_at`)).rejects.toThrow(/permission|column/);
      }
      await expect(db.query("select public.observations_append_only()")).rejects.toThrow(/permission|trigger/);
      await expect(db.query("select botanist_claim_payment(gen_random_uuid(),'a','b','c','d')")).rejects.toThrow(/permission/);
      await db.exec("reset role");
    }
  });
  it("binds one payment to one job, returns the same row on retry and rejects replay on another job", async () => {
    const a = await job("m-a"), b = await job("m-b"); const h = "1".repeat(64);
    expect((await claim(a, h)).rows[0].status).toBe("payment_submitted");
    expect((await claim(a, h)).rows[0].payment_tx_b64).toBe("tx-bytes");
    await expect(claim(a, "2".repeat(64))).rejects.toThrow(/different payment/);
    await expect(claim(b, h)).rejects.toThrow(/duplicate|unique/);
  });
  it("refuses payment on expired quotes, report before settlement and edits to frozen terms", async () => {
    const e = await job("m-exp", "now()-interval '1 second'");
    await expect(claim(e, "3".repeat(64))).rejects.toThrow(/expired/);
    const j = await job("m-c"); await claim(j, "4".repeat(64));
    await expect(db.query("select botanist_store_report($1,'{}'::jsonb,'d')", [j])).rejects.toThrow(/not settled/);
    await expect(db.query("update botanist_jobs set amount=1 where id=$1", [j])).rejects.toThrow(/immutable/);
    await expect(db.query("update botanist_jobs set payment_tx_b64='other' where id=$1", [j])).rejects.toThrow(/immutable/);
    await db.query("select botanist_mark_settled($1,'sig-c',10)", [j]);
    await expect(db.query("select botanist_mark_settled($1,'sig-other',10)", [j])).rejects.toThrow(/Different settlement/);
    const r1 = (await db.query<any>("select (botanist_store_report($1,'{\"a\":1}'::jsonb,'d1')).*", [j])).rows[0];
    const r2 = (await db.query<any>("select (botanist_store_report($1,'{\"a\":2}'::jsonb,'d2')).*", [j])).rows[0];
    expect(r2.report_digest).toBe(r1.report_digest); // repeat delivery returns stored report, never regenerates
  });
  it("records the facilitator candidate durably, settles only that signature and freezes recovery fields", async () => {
    const j = await job("m-cand"); await claim(j, "5".repeat(64));
    await db.query("update botanist_jobs set fee_payer='fp', resource='r', facilitator='f' where id=$1", [j]);
    for (const col of ["fee_payer", "resource", "facilitator"]) await expect(db.query(`update botanist_jobs set ${col}='other' where id=$1`, [j])).rejects.toThrow(/immutable/);
    const c = (await db.query<any>("select (botanist_record_candidate($1,'cand-1')).*", [j])).rows[0];
    expect(c.status).toBe("settlement_pending"); expect(c.settle_signature).toBeNull();
    await expect(db.query("select botanist_record_candidate($1,'cand-2')", [j])).rejects.toThrow(/Different settlement candidate/);
    await expect(db.query("update botanist_jobs set candidate_signature='x' where id=$1", [j])).rejects.toThrow(/immutable/);
    await expect(db.query("select botanist_mark_settled($1,'cand-2',9)", [j])).rejects.toThrow(/candidate/);
    expect((await db.query<any>("select (botanist_mark_settled($1,'cand-1',9)).*", [j])).rows[0].status).toBe("settled");
    await expect(db.query("select botanist_mark_failed($1,'late')", [j])).rejects.toThrow(/cannot fail/);
    await expect(db.query("update botanist_jobs set status='quoted' where id=$1", [j])).rejects.toThrow(/regress/);
    for (const r of ["anon", "authenticated"]) { await db.exec(`set role ${r}`); for (const f of ["botanist_record_candidate(gen_random_uuid(),'s')", "botanist_mark_failed(gen_random_uuid(),'s')", "botanist_mark_settled(gen_random_uuid(),'s',1)"]) await expect(db.query(`select ${f}`)).rejects.toThrow(/permission/); await db.exec("reset role"); }
  });
});

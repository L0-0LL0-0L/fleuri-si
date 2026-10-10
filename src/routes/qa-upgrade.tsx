// TEMPORARY local-only QA harness; removed before commit.
import { createFileRoute } from "@tanstack/react-router";
import { FieldReport } from "@/components/pq/FieldReport";
const AUTH = "9gMUCqxZ1wQ4bH3sV7yP2kLmN8rT5uE6cA1dF4gHnqRp";
const ok = (immutable: unknown, authority: unknown) => ({ status: "ok", immutable, authority, slot: 5 });
const mk = (id: string, tp: any, dbc: any) => ({ jobId: id, receipt: { outputDigest: "e".repeat(64), notice: "", payment: { transaction: "5".repeat(88), slot: 1, amount: "500000" } },
  report: { mint: AUTH, cluster: "mainnet-beta", observedSlot: 1, observedAt: "2026-10-10T00:00:00.000Z", disclaimer: "", unavailable: { protocol: "Not a fleuri launch.", tokenProgram: "Loader X is not decoded here." },
    facts: { mint: { program: "spl-token", decimals: 6, supply: "1", mintAuthorityRevoked: true, freezeAuthorityRevoked: true }, metadata: null, holders: null, ...(tp ? { tokenProgram: tp } : {}) } } });
export const Route = createFileRoute("/qa-upgrade")({ component: () => <div>{[mk("a", ok(false, AUTH), null), mk("b", ok(true, null), null), mk("c", ok(undefined, AUTH), null), mk("d", null, null)].map((r) => <FieldReport key={r.jobId} result={r as any} />)}</div> });

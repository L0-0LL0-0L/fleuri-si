import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FrozenEvidence, freezeReview, type EvidenceRow } from "./ProposalEvidence";
import { policyHash } from "@/domain/greenhouse";
afterEach(cleanup);

const agent: any = { id: "a_1", archetype: "weed", risk: 3, strategy: "buy small", persona: "a thorny little flower" };
const h = policyHash(agent);
const row: EvidenceRow = { id: "e1", proposal_id: "p1", run_id: "r1", origin_agent_id: "a_1", run_policy_hash: h, proposal_policy_hash: h, engine_version: "greenhouse-rules-2", content_hash: "c".repeat(64), repetitions: 3, scenarios: ["control"], attached_at: "2026-10-11T00:00:00Z" };
const prop = { id: "p1", name: "Rose", symbol: "ROSE", agent_handle: "rose", origin_policy_hash: h, origin_mode: "rules" };

describe("frozen launch review evidence", () => {
  it("does not change when the agent is edited or more evidence is attached later", () => {
    const agents: any = { a_1: { ...agent } };
    const rows = [row];
    const review = freezeReview(prop, rows, agents, new Date("2026-10-11T12:00:00Z"));
    agents.a_1.strategy = "edited later"; rows.push({ ...row, id: "e2" }); rows[0].content_hash = "d".repeat(64);
    render(<FrozenEvidence review={review} />);
    expect(screen.getByText("agent unchanged at freeze")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByTestId("frozen-evidence")).toHaveTextContent("cccccccc…");
    expect(screen.getByTestId("frozen-evidence")).toHaveTextContent("2026-10-11 12:00:00 UTC");
  });
  it("records stale status at freeze time and states when no evidence existed", () => {
    const stale = freezeReview(prop, [row], { a_1: { ...agent, risk: 5 } } as any, new Date());
    expect(stale.items[0].status.currency).toBe("stale");
    render(<FrozenEvidence review={freezeReview(prop, [], {}, new Date())} />);
    expect(screen.getByText(/No greenhouse evidence was attached/)).toBeInTheDocument();
  });
});

describe("frozen review with signed receipts", () => {
  it("freezes receipt status; later anchor/publication changes do not alter the review", () => {
    const rc: any = { id: "rc1", run_id: "r1", manifest_hash: "a".repeat(64), anchor_status: "none", published: false, signed_at: "2026-10-11T00:00:00Z", issuer_key: "b".repeat(64), engine_version: "greenhouse-rules-2", policies: [{ agentId: "a_1", policyHash: h }] };
    const live = [{ ...row, receipts: [rc] }];
    const review = freezeReview(prop, live, { a_1: agent } as any, new Date());
    rc.anchor_status = "confirmed"; rc.policies[0].policyHash = "z".repeat(64); live[0].receipts.push({ ...rc, id: "rc2" });
    render(<FrozenEvidence review={review} />);
    expect(screen.getAllByTestId("frozen-receipt")).toHaveLength(1);
    expect(screen.getByText("anchor none at freeze")).toBeInTheDocument();
    expect(screen.getByText("receipt policy matches")).toBeInTheDocument();
  });
  it("flags a receipt for a different policy or legacy engine", () => {
    const rc: any = { id: "rc1", run_id: "r1", manifest_hash: "a".repeat(64), anchor_status: "none", published: false, signed_at: "x", issuer_key: "b".repeat(64), engine_version: "greenhouse-rules-1", policies: [{ agentId: "a_1", policyHash: "y".repeat(64) }] };
    render(<FrozenEvidence review={freezeReview(prop, [{ ...row, receipts: [rc] }], {}, new Date())} />);
    expect(screen.getByText("receipt policy differs")).toBeInTheDocument();
    expect(screen.getByText("unsupported greenhouse-rules-1")).toBeInTheDocument();
  });
});

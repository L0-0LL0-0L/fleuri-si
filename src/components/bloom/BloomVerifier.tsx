import { useRef, useState } from "react";
import { verifyBloomBundle, type BloomVerify } from "@/domain/bloom";

/** Local verifier: everything is recomputed in this browser; nothing is sent anywhere. */
export function BloomVerifier() {
  const [res, setRes] = useState<BloomVerify | null>(null);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const run = (t: string) => { setErr(""); try { setRes(verifyBloomBundle(t)); } catch (e) { setRes(null); setErr((e as Error).message); } };
  return (
    <div className="space-y-3">
      <p className="text-sm">Load a Blind Bloom bundle to recompute the seed commitment, every sealed commitment, all scenarios, paired comparisons and Brier scores in your browser.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-paper" onClick={() => input.current?.click()}>Choose bundle file</button>
        <input ref={input} type="file" accept="application/json,.json" className="sr-only" aria-label="Bundle file" onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = "";
          if (!f) return;
          if (f.size > 3_000_000) { setRes(null); setErr("File is larger than the 3 MB bundle limit."); return; }
          try { run(await f.text()); } catch { setErr("The file could not be read."); }
        }} />
        <button type="button" className="btn btn-ink" disabled={!text.trim()} onClick={() => run(text)}>Verify pasted JSON</button>
      </div>
      <label className="block text-xs font-bold" htmlFor="bloom-paste">Or paste bundle JSON</label>
      <textarea id="bloom-paste" className="hair num h-24 w-full bg-paper-light p-2 text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      {res && (
        <div role="status" data-bloom-result className="hair bg-paper-light p-3 text-sm">
          <p className="font-bold">{({ verified: "Verified", pending: "Pending — not revealed yet", partial: "Partly checked — no scores", mismatch: "Does not match", unsupported: "Unsupported version", invalid: "Invalid bundle" } as const)[res.status]} — {res.detail}</p>
          <ul className="mt-2 space-y-1">
            {res.checks.map((c) => <li key={c.id} className="flex gap-2"><span className="chip">{c.ok ? "pass" : "fail"}</span><span>{c.detail}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

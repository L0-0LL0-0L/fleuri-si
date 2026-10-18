// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { captureDeadline, FORWARD_READ_MS, FORWARD_TOTAL_MS } from './forward-deadline';
afterEach(() => vi.useRealTimers());
it('aborts one read at 10 seconds with sanitized failure', async () => {
 vi.useFakeTimers(); let signal: AbortSignal | undefined;
 const d = captureDeadline(new Date().toISOString(), async (_, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); });
 const p = expect(d.fetch('https://rpc.invalid')).rejects.toThrow('source_unavailable');
 await vi.advanceTimersByTimeAsync(FORWARD_READ_MS); await p; expect(signal?.aborted).toBe(true); d.dispose();
});
it('bounds all sequential reads to 40 seconds, below 45 seconds and lease', async () => {
 vi.useFakeTimers(); const d = captureDeadline(new Date().toISOString(), async () => { await new Promise(r => setTimeout(r, 9000)); return new Response('{}'); });
 for (let i = 0; i < 4; i++) { const p = d.fetch('https://rpc.invalid'); await vi.advanceTimersByTimeAsync(9000); await p; }
 const p = expect(d.fetch('https://rpc.invalid')).rejects.toThrow('source_unavailable');
 await vi.advanceTimersByTimeAsync(4000); await p; expect(FORWARD_TOTAL_MS).toBe(40000); d.dispose();
});
it('includes stalled response bodies in the per-read deadline', async () => {
 vi.useFakeTimers(); const d = captureDeadline(new Date().toISOString(), async () => new Response(new ReadableStream({ start() {} })));
 const p = expect(d.fetch('https://rpc.invalid')).rejects.toThrow('source_unavailable');
 await vi.advanceTimersByTimeAsync(10000); await p; d.dispose();
});
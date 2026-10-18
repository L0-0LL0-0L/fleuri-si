// Capture-local deadlines; fully consume RPC bodies before releasing each timer.
export const FORWARD_READ_MS = 10_000;
export const FORWARD_TOTAL_MS = 40_000;
export function captureDeadline(requestedAt: string, transport: typeof fetch = fetch) {
 const remaining = Math.max(0, FORWARD_TOTAL_MS - Math.max(0, Date.now() - Date.parse(requestedAt)));
 const total = new AbortController();
 const timer = setTimeout(() => total.abort(), remaining);
 const boundedFetch: typeof fetch = async (input, init) => {
  if (total.signal.aborted || remaining === 0) throw new Error('source_unavailable');
  const read = new AbortController();
  const abort = () => read.abort();
  total.signal.addEventListener('abort', abort, { once: true });
  const perRead = setTimeout(abort, FORWARD_READ_MS);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new Error('source_unavailable')); read.signal.addEventListener('abort', rejectAbort, { once: true }); });
  try {
   return await Promise.race([aborted, (async () => {
    const response = await transport(input, { ...init, signal: read.signal });
    const bytes = await response.arrayBuffer();
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
   })()]);
  } catch { throw new Error('source_unavailable'); }
  finally { clearTimeout(perRead); total.signal.removeEventListener('abort', abort); if (rejectAbort) read.signal.removeEventListener('abort', rejectAbort); }
 };
 return { fetch: boundedFetch, dispose: () => clearTimeout(timer) };
}
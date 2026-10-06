export function ago(t: number, now: number) {
  const d = Math.max(0, now - t) / 1000;
  if (d < 45) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}
export function sol(n: number, d = 2) {
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(d);
}
export function pct(n: number, d = 1) {
  return `${(n * 100).toFixed(d)}%`;
}
export function signedPct(n: number) {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
}
export function tokens(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}
export function priceFmt(p: number) {
  return (p * 1e6).toFixed(3) + "µ";
}
export function clock(t: number) {
  const d = new Date(t);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

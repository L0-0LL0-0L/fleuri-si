// Strict, bounded JSON reader. JSON.parse silently keeps the LAST of duplicate keys, so a file can
// show one value to a human reader and another to a verifier. This parser rejects duplicate keys at
// every depth after decoding escapes ("seed" and "\u0073eed" are the same key), bounds UTF-8 size
// before any work, and never builds prototype-bearing properties.

export class StrictJsonError extends Error { constructor(m: string) { super(m); this.name = "StrictJsonError"; } }

/** UTF-8 byte length without allocating an encoded copy. Lone surrogates count as U+FFFD (3 bytes). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Byte size of an in-memory value as JSON. Callers must bound structure first (boundedJson). */
export function jsonByteLength(v: unknown): number {
  const s = JSON.stringify(v);
  return s === undefined ? 0 : utf8Length(s);
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUM = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

export function parseStrictJson(text: string, opts: { maxBytes: number; maxDepth?: number }): unknown {
  if (utf8Length(text) > opts.maxBytes) throw new StrictJsonError(`larger than the ${opts.maxBytes} byte limit`);
  const maxDepth = opts.maxDepth ?? 64;
  let i = 0;
  const err = (m: string): never => { throw new StrictJsonError(`${m} at position ${i}`); };
  const ws = () => { while (i < text.length && WS.has(text.charCodeAt(i))) i++; };
  const str = (): string => {
    const start = i; i++; // opening quote
    for (;;) {
      if (i >= text.length) err("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; break; }
      if (c < 0x20) err("control character in string");
      if (c === 0x5c) { i++; const e = text[i]; if (e === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) err("bad unicode escape"); i += 5; } else if ('"\\/bfnrt'.includes(e ?? "x")) i++; else err("bad escape"); }
      else i++;
    }
    return JSON.parse(text.slice(start, i)) as string; // decodes escapes of an already-validated literal
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) err("nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++; const o: Record<string, unknown> = {}; const seen = new Set<string>();
      ws(); if (text[i] === "}") { i++; return o; }
      for (;;) {
        ws(); if (text[i] !== '"') err("expected a key");
        const k = str();
        if (seen.has(k)) err(`duplicate key ${JSON.stringify(k.slice(0, 40))}`);
        seen.add(k);
        ws(); if (text[i] !== ":") err("expected ':'"); i++;
        const v = value(depth + 1);
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "}") { i++; return o; }
        err("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++; const a: unknown[] = [];
      ws(); if (text[i] === "]") { i++; return a; }
      for (;;) {
        a.push(value(depth + 1));
        ws(); if (text[i] === ",") { i++; continue; } if (text[i] === "]") { i++; return a; }
        err("expected ',' or ']'");
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    NUM.lastIndex = i; const m = NUM.exec(text);
    if (!m) err("unexpected token");
    i += m![0].length;
    const n = Number(m![0]); if (!Number.isFinite(n)) err("non-finite number");
    return n;
  };
  const v = value(0); ws();
  if (i !== text.length) err("trailing data");
  return v;
}

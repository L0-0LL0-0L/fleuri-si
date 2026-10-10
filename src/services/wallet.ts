// Real browser-wallet connection for Phantom / Solflare injected providers.
// We never request or store seed phrases or private keys. A session is linked
// only after the wallet signs a message and the ed25519 signature verifies.
export type WalletKind = "phantom" | "solflare";

interface InjectedProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toString(): string; toBytes?(): Uint8Array } | null;
  connect(): Promise<{ publicKey: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  signMessage(msg: Uint8Array, display?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

export function getProvider(kind: WalletKind): InjectedProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, any>;
  if (kind === "phantom") {
    const p = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : null);
    return p ?? null;
  }
  // Solflare injects window.solflare, but some versions only set window.solana.
  if (w.solflare?.isSolflare) return w.solflare;
  if (w.solana?.isSolflare) return w.solana;
  return null;
}

export const WALLET_URLS: Record<WalletKind, string> = {
  phantom: "https://phantom.com/download",
  solflare: "https://solflare.com/download",
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("invalid base58");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

export async function verifyEd25519(address: string, message: Uint8Array, signature: Uint8Array) {
  try {
    const key = await crypto.subtle.importKey("raw", base58Decode(address) as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

/** Reads the public key after connect(); some wallets populate it a beat later. */
async function readPublicKey(p: InjectedProvider): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const pk = p.publicKey?.toString();
    if (pk) return pk;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("The wallet did not share a public key. Unlock it and try again.");
}

export async function connectAndSign(kind: WalletKind, ownerId: string) {
  const p = getProvider(kind);
  if (!p) throw new Error(`${kind === "phantom" ? "Phantom" : "Solflare"} is not installed in this browser.`);
  const res = await p.connect();
  const pk = (res && "publicKey" in res ? res.publicKey?.toString() : undefined) ?? (await readPublicKey(p));
  const text = `Fleuri sandbox sign-in\nworkspace: ${ownerId}\nnonce: ${crypto.randomUUID()}\nThis signature links your wallet to a sandbox session. It costs nothing and moves no funds.`;
  const msg = new TextEncoder().encode(text);
  const out = await p.signMessage(msg, "utf8");
  const sig = out instanceof Uint8Array ? out : out.signature;
  // Server re-verifies this ed25519 signature before linking the wallet.
  return { provider: kind, address: pk, message: text, signature: Array.from(sig) };
}

export async function disconnectWallet(kind: WalletKind) {
  try {
    await getProvider(kind)?.disconnect?.();
  } catch {
    /* ignore */
  }
}

/** Connects and returns the wallet's base58 address (no signature yet). */
export async function connectWallet(kind: WalletKind) {
  const p = getProvider(kind);
  if (!p) throw new Error(`${kind === "phantom" ? "Phantom" : "Solflare"} is not installed in this browser.`);
  const res = await p.connect();
  const pk = (res && "publicKey" in res ? res.publicKey : p.publicKey)?.toString();
  if (!pk) throw new Error("The wallet did not share a public key.");
  return pk;
}

/** Asks the wallet to sign exact message bytes (Ed25519). */
export async function walletSignMessage(kind: WalletKind, msg: Uint8Array) {
  const p = getProvider(kind);
  if (!p) throw new Error("Wallet not available.");
  const out = await p.signMessage(msg, "utf8");
  return out instanceof Uint8Array ? out : out.signature;
}

/** Asks the wallet to sign a legacy transaction prepared by the server. */
export async function walletSignTransaction<T>(kind: WalletKind, tx: T): Promise<T> {
  const p = getProvider(kind) as unknown as { signTransaction?: (t: T) => Promise<T> } | null;
  if (!p?.signTransaction) throw new Error("This wallet cannot sign transactions.");
  return p.signTransaction(tx);
}

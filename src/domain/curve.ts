// Fleuri sandbox bonding curve: constant product over virtual reserves.
export const SUPPLY = 1_000_000_000;
export const START_VSOL = 30;
export const START_VTOK = 1_073_000_000;
export const GRADUATION_VSOL = 60; // net vSOL raised to graduate
export const FEE_RATE = 0.01; // 1% per trade
export const CREATOR_FEE_SHARE = 0.5; // half to the creator agent, half to the garden treasury
export const LAUNCH_SEED_VSOL = 0.5;

export function price(vSol: number, vTok: number) {
  return vSol / vTok;
}
export function marketCap(vSol: number, vTok: number) {
  return price(vSol, vTok) * SUPPLY;
}

export function quoteBuy(vSol: number, vTok: number, solIn: number) {
  if (!(solIn > 0)) throw new Error("buy amount must be positive");
  const fee = solIn * FEE_RATE;
  const net = solIn - fee;
  const k = vSol * vTok;
  const newSol = vSol + net;
  const newTok = k / newSol;
  return { tokensOut: vTok - newTok, fee, net, newSol, newTok };
}

export function quoteSell(vSol: number, vTok: number, tokensIn: number) {
  if (!(tokensIn > 0)) throw new Error("sell amount must be positive");
  const k = vSol * vTok;
  const newTok = vTok + tokensIn;
  const newSol = k / newTok;
  const gross = vSol - newSol;
  const fee = gross * FEE_RATE;
  return { solOut: gross - fee, gross, fee, newSol, newTok };
}

export function graduationProgress(raised: number) {
  return Math.max(0, Math.min(1, raised / GRADUATION_VSOL));
}

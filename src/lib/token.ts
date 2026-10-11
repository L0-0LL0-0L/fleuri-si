/**
 * $FLEURI token address (Solana mainnet).
 *
 * Verified on chain, 11 October 2026 (~14:00 UTC): the mint exists with supply
 * 999,999,999.999908 (6 decimals), mint authority revoked, freeze authority still
 * set. It trades on a Meteora DBC bonding curve — pool `Doz2NHbYq3suCN2bHTqEUYPVZdpobVgfqqhZEWR3AWnK`
 * (launch tx `549h8cejoCkTeTjFuHBTnHpPU3ndHabbGyFBS5L8hjg1q2uy7WDMft7JKZ9gKpAjvDNjo8rZTDKmbzc87J8dQGRB`).
 * The pool uses Meteora config `BLFWLUXLc5Ba6ihWBRcEb3xdMXx2YUJtZJHqRsK3MMqu`, so this
 * launch is NOT recorded through fleuri's own launchpad (its config is `GCUPDN6mau1Y2wAUGLtFBiTaiddZwB8592qAG4mKY8Ta`)
 * and has no passport. Never present it as a fleuri-launched token; state figures
 * from live chain reads only.
 */
export const FLEURI_MINT = "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri";

/** The verified Meteora DBC bonding-curve pool for $FLEURI (mainnet). */
export const FLEURI_POOL = "Doz2NHbYq3suCN2bHTqEUYPVZdpobVgfqqhZEWR3AWnK";

/** The confirmed transaction that created the mint and the curve. */
export const FLEURI_LAUNCH_TX =
  "549h8cejoCkTeTjFuHBTnHpPU3ndHabbGyFBS5L8hjg1q2uy7WDMft7JKZ9gKpAjvDNjo8rZTDKmbzc87J8dQGRB";

/** Short honest status line shown next to the address wherever it is displayed. */
export const FLEURI_MINT_NOTE =
  "Live — minted and trading on a Meteora bonding curve (Solana mainnet) since 11 October 2026. Not yet migrated to a DAMM v2 pool. Only send funds if the address and launch are independently verified on Meteora.";

/** One-word status chip for UI badges. Keep it derived from the note above. */
export const FLEURI_STATUS = "live";

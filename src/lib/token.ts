/**
 * $FLEURI token address (Solana mainnet).
 *
 * Re-checked 2026-10-11 against the public mainnet RPC: `getAccountInfo` still
 * returns null, so nothing has been minted at this address yet and there is no
 * supply, price or holder data to show. The token is expected to go live shortly
 * on Meteora (Solana mainnet). Keep the status note honest until that call
 * returns a real account — then the token page picks up live figures by itself.
 */
export const FLEURI_MINT = "25bk5SwR8hyreMuD7pnjZwJUFKR1o869PaDA9fhuAuri";

/** Short honest status line shown next to the address wherever it is displayed. */
export const FLEURI_MINT_NOTE =
  "Not live yet — nothing has been minted at this address. $FLEURI is expected to go live shortly on Meteora (Solana mainnet). Check the address carefully before sending anything.";

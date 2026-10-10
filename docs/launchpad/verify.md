# Verifying a passport

![Verify](../.gitbook/assets/verify.png)

Anyone can verify a launch — no account needed. Open **Verify passport** (`/verify`), paste a passport hash, link or file, and fleuri checks:

* both registration signatures (wallet + PQ key)
* the on-chain Memo anchoring the identity
* every signed term against the actual pool config
* that the launch transaction is confirmed on-chain
* that the decoded Meteora create instruction exactly matches the signed name, ticker, metadata URI, config, mint, pool and original creator, with canonical accounts and required signatures
* that mint and freeze authorities are revoked
* that the pinned metadata is immutable and matches

## Reading the result

* **Verified** — every check passed against live chain data.
* **Signatures valid, chain unavailable** — the cryptography checks out, but on-chain data couldn't be read right now. This is **not** a verified launch.
* **Failed** — a check failed; the reason is shown.

Each passport also has a public page at `/passport/<hash>` showing its terms, links and status.

## Living passports

The original signed passport never changes. Its page can collect dated, append-only observations of chain state, keeping history and evidence separate from the original launch promise. A later creator change is shown as an observation, not used to rewrite the original author. Dates represent when fleuri observed a change, not necessarily the exact time it happened on chain. Missing metadata or unreadable facts remain explicitly unavailable.

## Independent bundle verification

Download the evidence bundle from a passport page. Then verify it in **Verify → Evidence bundle** using any RPC and IPFS gateway you choose, or run `bun scripts/verify-bundle.ts bundle.json --rpc <url> --gateway <url>`. Neither one talks to fleuri's database, and the RPC address you enter is never saved.

Import the bundle, then press **Verify bundle independently** to run the checks. Replacing it with an invalid file clears the old import and result. Changing the RPC or gateway also clears the displayed result: run verification again against the new sources.

The verifier checks all of the following itself:

* **Launch instruction:** it decodes the actual DBC SPL Token create instruction (`initializeVirtualPoolWithSplToken` in the SDK; `initialize_virtual_pool_with_spl_token` in the raw IDL). Name, symbol and URI must match exactly. Config, creator, mint, SOL quote and pool must sit in the expected positions. The vaults, metadata and event-authority accounts must be the ones derived from the mint and pool. The creator, mint and payer must all have signed.
* **Pool account:** it reads the live pool account, checks that DBC owns it and that it links to the signed mint and config. If the pool's creator changed later, that is shown, but the original creator's signature still counts.
* **Program upgrade authority:** this is only called immutable for known loaders. Unknown or unreadable programs show as unavailable.
* **Unreadable data:** unsupported transaction versions and RPC errors show as **unavailable**. They never count as a pass or a fail.

Memo anchoring records a hash on chain. Solana itself does not check ML-DSA signatures.

The site's public verification, launch confirmation and portable verifier share this strict create-instruction check. Original authorship comes from that instruction, not the pool's current creator field; a lawful later creator change does not prevent recovery of the original confirmed launch.

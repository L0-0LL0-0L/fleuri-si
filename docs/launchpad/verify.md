# Verifying a passport

![Verify](../.gitbook/assets/verify.png)

Anyone can verify a launch — no account needed. Open **Verify passport** (`/verify`), paste a passport hash, link or file, and fleuri checks:

* both registration signatures (wallet + PQ key)
* the on-chain Memo anchoring the identity
* every signed term against the actual pool config
* that the launch transaction is confirmed on-chain
* that mint and freeze authorities are revoked
* that the pinned metadata is immutable and matches

## Reading the result

* **Verified** — every check passed against live chain data.
* **Signatures valid, chain unavailable** — the cryptography checks out, but on-chain data couldn't be read right now. This is **not** a verified launch.
* **Failed** — a check failed; the reason is shown.

Each passport also has a public page at `/passport/<hash>` showing its terms, links and status.

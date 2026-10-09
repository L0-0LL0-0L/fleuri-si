# Launchpad setup: what was checked and what's left

## What I checked (nothing changed)

Readiness on the live launchpad right now:

| Check | Result |
| --- | --- |
| Network | PASS: mainnet-beta |
| Helius RPC + genesis | PASS: genesis matches mainnet-beta |
| Meteora DBC program | PASS: deployed |
| Pool config (METEORA_DBC_CONFIG) | FAIL: not set |
| Metadata pinning (PINATA_JWT) | FAIL: not set |
| DAMM v2 graduation | PASS: derived from the signed fee option |

Saved project settings (names only): FLEURI_ORIGIN, SOLANA_CLUSTER, SOLANA_RPC_URL, LOVABLE_API_KEY, LOVABLE_CRON_SECRET. METEORA_DBC_CONFIG and PINATA_JWT are not saved.

Site address: FLEURI_ORIGIN is set to https://fleuri.si, which returns 200 on /launchpad. No new custom domain is needed. The lovable.app address also responds (it redirects).

## Are the two remaining settings necessary?

Yes. Readiness only passes when every check passes, so both are required before any launch.

- **Pool config:** it sets every launch's supply, fees, graduation point, LP split and fee recipient. There is no neutral default. Someone has to create it on chain, and that payment and signature must come from your wallet.
- **Pinata:** the passport proof depends on content-addressed IPFS that can't be changed. The app's own Cloud file storage can be changed, so it can't replace this without weakening the proof. Your workspace has no Pinata or IPFS connector (it has ElevenLabs, Resend, Telegram and Firecrawl). So I can't set up pinning without your own Pinata API key. That means entering it once in the secure form.

## What only you can do

1. **Pinata key:** sign up at pinata.cloud, create an API key (JWT), and paste it into the secure form. I open the form; you type the value. I never see it.
2. **Pool config, signed with your wallet:**
   - Open /launch-config and connect Phantom or Solflare. The wallet needs mainnet SOL for account rent and network fees; the page simulates the exact amount.
   - Choose the terms and enter both recipient addresses yourself.
   - Tick the review box and approve in your wallet.
3. **Save the config address:** after it confirms, the page shows the address. I open the secure form to save it as METEORA_DBC_CONFIG. The address is public, but the setting can only be saved through that form.
4. **Per launch, later:** create, back up and unlock your post-quantum key at /identity. Approve the two wallet signatures that register and anchor it (one costs a small network fee). Then approve each launch and, later, each migration.

## What I'll do after you approve

- Open the secure Pinata form. Once it's saved, recheck readiness so pinning shows PASS.
- Once you've confirmed the config at /launch-config, open the secure form for METEORA_DBC_CONFIG. Then recheck readiness to confirm the config is valid and every check passes.
- Report the final readiness. I won't create a wallet, choose a recipient, spend funds, send a transaction or publish.

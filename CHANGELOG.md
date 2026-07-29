# Changelog

All notable changes to `@cc0company/sdk`. Behaviour is aligned with the production
launchpad reference implementation (`cc0strategy-v2-launch.ts` in the cc0.company
frontend) unless explicitly noted.

## 1.12.0

### Fixed

- **Vault/airdrop admin + dev-buy proceeds no longer derive from `creatorRewards[0]`** —
  they now ALWAYS derive from the launching account (or the new optional
  `proceedsRecipient` param), matching production (`cc0strategy-v2-launch.ts:516`,
  `:546`, `:596`). Previously, an Option B launch (`nftCollection`) set the vault
  admin, airdrop admin and dev-buy recipient to the deployed `Cc0NftFeeDistributor`
  CONTRACT — permanently locking the vault tokens and stranding the dev-buy proceeds
  (the factory accepts that config; nothing on-chain saves the caller). Likewise, a
  multi-slice split ordered `[{platform, 375}, {user, 7125}]` silently handed the
  PLATFORM the vault/airdrop admin and the dev-buy tokens. `CreatorRewardSlice`
  order now matters ONLY for fee routing — never for proceeds.
- **`resolvePairedToken` price lookup is now chain-aware** — the price-API query
  hardcoded `chains=base,base`, so paired-launch auto price resolution could NEVER
  work on Robinhood Chain (the paired token + RH WETH were looked up as Base
  addresses). The instance's chain slug is now used for both lookups; a new optional
  `chainSlug` opt on `resolvePairedToken` (default `'base'`, back-compatible) carries
  it for direct callers.

### Changed

- **`tokenAdmin` now defaults to `address(0)` — born-renounced**, matching every
  production launch (`cc0strategy-v2-launch.ts:609-611`). Token scanners
  (GoPlus, DexScreener) read `admin()=0` as "ownership renounced"; SDK launches were
  previously flagged "NOT renounced" unlike platform launches. A new optional
  `tokenAdmin` param on `LaunchTokenParams` restores the old behaviour for callers
  who genuinely want a metadata admin (scanners will flag it). Fee control is
  unaffected either way — it lives in the locker's `rewardAdmins`.
- **`lpPreset` now defaults to `'degen'`** (was `'classic'`), aligned with the
  production default (`cc0strategy-v2-launch.ts:130-135`). `'classic'` remains fully
  supported. `lp_preset` is now ALWAYS recorded on the registry (previously only
  when caller-passed), so token pages badge the correct profile.

### Added

- **`proceedsRecipient?: Address` on `LaunchTokenParams`** — explicit override for
  the vault admin / airdrop admin / dev-buy recipient trio. Defaults to the
  launching account.
- **Airdrop registry plumbing** — `airdrop.entriesCid` / `airdrop.entriesJson` on
  `LaunchTokenParams` are recorded as `airdrop_entries_cid` / `airdrop_entries_json`,
  and the merkle root as `airdrop_merkle_root`, so the platform claim flow can serve
  proofs for SDK launches. The airdrop extension address the launch actually used is
  recorded as `airdrop_extension_address` and exposed as
  `LaunchTokenResult.airdropExtension` (and on `PreparedLaunchTransaction`). NOTE:
  paired launches register on the PAIRED suite's `AIRDROP_V2`, standard launches on
  the standard suite's — the two DIFFER, which is why the exact address is recorded
  per launch (`cc0strategy-v2-launch.ts:160-164`). `registerLaunch` gains matching
  optional params (`airdropMerkleRoot`, `airdropEntriesCid`, `airdropEntriesJson`,
  `airdropExtension`) for manual `prepareLaunchTransaction` flows.
- **Re-exports**: `guardedPairedStartingTick` and `NFT_FACTORY_ABI` are now exported
  from the package root.

### Documented

- `launchTokenSponsored()` / `sponsorshipStatus()`: the sponsored endpoints are
  same-origin/server-side only today (no CORS headers) — browser third-party
  integrators must use the self-signed `launchToken()` path; sponsored launches
  work from servers, scripts and agents.
- `CreatorRewardSlice`: slices are FEES ONLY; slice order no longer affects
  vault/airdrop admin or dev-buy proceeds.

All public signatures remain backward-compatible (additive params only).

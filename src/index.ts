// ═══════════════════════════════════════════════════════════════════════════════════
// @cc0company/sdk — the official cc0.company SDK.
//
//   • Cc0Launchpad — launch tokens with the on-chain enforced 75/15/10 fee split
//   • Cc0Fees      — read + claim creator trading fees
//   • Cc0Staking   — stake $cc0company, earn WETH from every launch
//
// Built for humans & AI agents. https://cc0.company/docs/launchpad-sdk
// ═══════════════════════════════════════════════════════════════════════════════════

// Launchpad
export {
  Cc0Launchpad,
  FACTORY_ABI,
  parseLaunchReceipt,
  toPreparedTx,
  estimateEip1559Fees,
  assertTxHash,
} from './launchpad';
export type {
  Cc0ClientConfig,
  ExternalSender,
  LaunchTokenParams,
  LaunchTokenResult,
  LaunchImage,
  PreparedTransaction,
  PreparedLaunchTransaction,
  CreatorRewardSlice,
  CreatorFeePreference,
} from './launchpad';

// Creator fees
export { Cc0Fees } from './fees';
export type { ClaimableFees, ClaimFeesResult } from './fees';

// Staking
export { Cc0Staking } from './staking';
export type { StakingPosition } from './staking';

// Addresses + protocol constants + chains (Base 8453 · Ethereum 1 · Robinhood Chain 4663)
export {
  CC0_CONTRACTS,
  CHAIN_IDS,
  DEFAULT_RPCS,
  PROTOCOL_SPLIT,
  robinhoodChain,
  toChainSlug,
  VAULT_MIN_LOCKUP_SECONDS,
  AIRDROP_MIN_LOCKUP_SECONDS,
  VIEM_CHAINS,
} from './addresses';
export type { Cc0Chain, Cc0ChainSlug } from './addresses';

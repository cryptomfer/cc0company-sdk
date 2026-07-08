// ═══════════════════════════════════════════════════════════════════════════════════
// @cc0company/sdk — the official cc0.company SDK.
//
//   • Cc0Launchpad — launch tokens with the on-chain enforced 75/15/10 fee split
//   • Cc0Fees      — read + claim creator trading fees
//   • Cc0Staking   — stake $cc0company, earn WETH from every launch
//   • Cc0Drops     — deploy, manage + mint IPFS NFT drops (CC0Drop 721 / 1155)
//
// Built for humans & AI agents. https://cc0.company/docs/launchpad-sdk
// ═══════════════════════════════════════════════════════════════════════════════════

// Launchpad
export {
  Cc0Launchpad,
  FACTORY_ABI,
  LP_PRESETS,
  parseLaunchReceipt,
  toPreparedTx,
  estimateEip1559Fees,
  assertTxHash,
} from './launchpad';
export type {
  Cc0ClientConfig,
  Cc0LpPreset,
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

// IPFS NFT drops (CC0Drop ERC721-C + CC0Drop1155)
export {
  Cc0Drops,
  CC0_DROP_ABI,
  CC0_DROP_1155_ABI,
  computeAllowlistRoot,
  computeAllowlistProof,
  EMPTY_MERKLE_ROOT,
} from './drops';
export type {
  Cc0DropsConfig,
  AllowlistEntry,
  PhaseInput,
  AllowlistPhaseInput,
  DeployDrop721Params,
  DeployDrop1155Params,
  LaunchDrop721Params,
  LaunchDrop1155Params,
  DeployDropResult,
  EditionInput,
  DropMetadataInput,
  PinDropMetadataResult,
  PinResult,
} from './drops';

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

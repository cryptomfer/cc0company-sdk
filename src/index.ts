// ═══════════════════════════════════════════════════════════════════════════════════
// @cc0company/sdk — the official cc0.company SDK.
//
//   • Cc0Launchpad    — launch tokens with the on-chain enforced 75/15/10 fee split
//                       (or pair with any ERC-20 instead of WETH — 80/20 paired launches)
//   • Cc0B20Launchpad — launch tradeable B20s (Base-native standard), same splits
//   • Cc0Fees         — read + claim creator trading fees
//   • Cc0Staking      — stake $cc0company, earn WETH from every launch
//   • Cc0Drops        — deploy, manage + mint IPFS NFT drops (CC0Drop 721 / 1155)
//
// Built for humans & AI agents. https://cc0.company/docs/launchpad-sdk
// ═══════════════════════════════════════════════════════════════════════════════════

// Launchpad
export {
  Cc0Launchpad,
  FACTORY_ABI,
  LP_PRESETS,
  DEFAULT_SUPPLY_WHOLE,
  startingTickForSupply,
  startingTickForPairedLaunch,
  impliedFdvWethAtTick,
  resolvePairedToken,
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
  SponsoredLaunchParams,
  SponsoredLaunchResult,
  LaunchImage,
  PairedTokenOption,
  PairedTokenParam,
  PreparedTransaction,
  PreparedLaunchTransaction,
  CreatorRewardSlice,
  CreatorFeePreference,
} from './launchpad';

// B20 launchpad (Base-only — tradeable B20s with the same enforced 75/15/10 split)
export {
  Cc0B20Launchpad,
  B20_FACTORY_ABI,
  B20_LAUNCHPAD_CONTRACTS,
  B20_LAUNCHPAD_PAIRED_CONTRACTS,
  B20_LAUNCH_DECIMALS,
  B20_POLICY_REGISTRY_ADDRESS,
  B20_POLICY_TYPE,
  B20_ROLES,
  B20_SCOPES,
  getB20PairedLaunchpad,
  isB20LaunchpadAvailable,
  isB20PairedLaunchpadAvailable,
} from './b20';
export type {
  B20ComplianceMode,
  B20LaunchConfig,
  B20LaunchpadContracts,
  B20PairedLaunchpadContracts,
  B20RoleGrant,
  Cc0B20Config,
  LaunchB20Params,
  LaunchB20Result,
  SponsoredB20LaunchParams,
  SponsoredB20LaunchResult,
} from './b20';

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
  CC0_PAIRED_CONTRACTS,
  CHAIN_IDS,
  DEFAULT_RPCS,
  getCc0PairedContracts,
  isCc0PairedAvailable,
  PAIRED_SPLIT,
  PROTOCOL_SPLIT,
  robinhoodChain,
  toChainSlug,
  VAULT_MIN_LOCKUP_SECONDS,
  AIRDROP_MIN_LOCKUP_SECONDS,
  VIEM_CHAINS,
} from './addresses';
export type { Cc0Chain, Cc0ChainSlug, Cc0PairedContracts } from './addresses';

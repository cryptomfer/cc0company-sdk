import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEther,
  parseEventLogs,
  parseUnits,
  toBytes,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import {
  Cc0Launchpad,
  FACTORY_ABI,
  LP_PRESETS,
  guardedPairedStartingTick,
  resolvePairedToken,
  startingTickForSupply,
  assertTxHash,
  estimateEip1559Fees,
  parseLaunchReceipt,
  toPreparedTx,
  type Cc0LpPreset,
  type ExternalSender,
  type LaunchImage,
  type PairedTokenOption,
  type PairedTokenParam,
  type PreparedTransaction,
} from './launchpad';
import { PAIRED_SPLIT, PROTOCOL_SPLIT } from './addresses';

// ═══════════════════════════════════════════════════════════════════════════════════
// B20 LAUNCHPAD — launch a TRADEABLE B20 (Base's native token standard) through the
// cc0.company B20 launchpad: the same Clanker-fork factory + Uniswap V4 pool + enforced
// 75/15/10 fee split as the ERC-20 launchpad, but the factory mints a B20 via Base's
// precompile instead of an ERC-20. B20 is Base-only (mainnet + Sepolia precompiles).
//
// Two admin models for the minted token itself (independent of the fee split):
//   • 'trustless' (default) — admin-less at birth: fixed supply, can never be minted
//     into, paused, frozen, or reconfigured. Maximum trader trust.
//   • 'managed' — the creator is DEFAULT_ADMIN and can mint/pause/configure later;
//     the optional `b20` config (supply cap, roles, compliance, freeze) is applied
//     right after launch as follow-up transactions.
//
// PAIRED LAUNCHES (custom pair): pass `pairedToken` to pair the pool with an arbitrary
// ERC-20 instead of WETH — the DUAL-MODE factory then enforces an 80/20 creator/treasury
// split (no staking slice; staking rewards are WETH-only) with fees taken in BOTH pool
// tokens. Paired launches use a SEPARATE suite (B20_LAUNCHPAD_PAIRED_CONTRACTS below):
// the standard book stays THE path for every WETH launch, byte-for-byte. Paired is live
// on Base Sepolia (its own dual-mode suite incl. a separate test feeLocker/staking) and
// PRE-STAGED on Base mainnet — until that entry is filled, paired mainnet launches throw.
//
// FAIL-CLOSED availability: the launchpad is live on Base mainnet (8453, default) and
// Base Sepolia (84532). Constructing against a chain whose factory isn't set throws
// immediately.
// ═══════════════════════════════════════════════════════════════════════════════════

/** The launchpad B20 is ASSET / 18 decimals; empty supply = the 100B default. */
export const B20_LAUNCH_DECIMALS = 18;
const B20_DEFAULT_LAUNCH_SUPPLY = 100_000_000_000n * 10n ** BigInt(B20_LAUNCH_DECIMALS);

const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const MAX_TICK_UPPER = 887200;
const TICK_SPACING = 200;
const FEE_IN = { both: 0, paired: 1 } as const;

// Clanker "Dynamic 3%" preset (1% base → 3% max), 1e6 fee units — same as the ERC-20 path.
const DYNAMIC_3_CONFIG = {
  baseFee: 10_000,
  maxLpFee: 30_000,
  referenceTickFilterPeriod: BigInt(30),
  resetPeriod: BigInt(120),
  resetTickFilter: 200,
  feeControlNumerator: BigInt(250_000_000),
  decayFilterBps: 7500,
} as const;

// ── Addresses ────────────────────────────────────────────────────────────────────────

/** One B20-launchpad deployment's address set. */
export interface B20LaunchpadContracts {
  chainId: number;
  factory: Address | '';
  hookStaticFee: Address | '';
  hookDynamicFee: Address | '';
  locker: Address | '';
  feeLocker: Address;
  mevBlockDelay: Address | '';
  mevSniperTax: Address | '';
  vault: Address | '';
  airdropV2: Address | '';
  devBuyV4: Address | '';
  poolManager: Address;
  positionManager: Address;
  universalRouter: Address;
  weth: Address;
}

/**
 * Per-chain B20 launchpad deployments. Base mainnet is PRE-STAGED (empty factory) until
 * the audited mainnet cutover — `isB20LaunchpadAvailable(8453)` stays false and the
 * constructor refuses it, so nothing can silently target a non-existent factory.
 */
export const B20_LAUNCHPAD_CONTRACTS: Record<number, B20LaunchpadContracts> = {
  // Base Sepolia (84532) — live rehearsal deployment (custom launch supply + ZeroLiquidity guard).
  84532: {
    chainId: 84532,
    factory: '0x73a167592D33882270C94f6eecDAA10941a5fa43',
    hookStaticFee: '0x2ceE83A4360B9F29FEe681C1760CCdc64b3dE8cc',
    hookDynamicFee: '0x20CD5FF03117EC19E148987157A1290B4265e8cc',
    locker: '0xFE927b4e9F41010944ba657353E80b0368caeFF9',
    feeLocker: '0xfA48e826716c1A2aB928F9b9ae7b6E47799fe495',
    mevBlockDelay: '0x4D559eB202Cbc5D82B1B6c4C700dD8D08a55b969',
    mevSniperTax: '0xC5Eae0D1B6B0cdFfd6228d30814473d39dACF8d6',
    vault: '0x2a39afD2CbEa603424E8219a4AAc1f133518aacb',
    airdropV2: '0x426718FC1C31Ba2Cc21090076DB192d71331fB46',
    devBuyV4: '0x81DAd01801761Ff11e5bC100bE3f6c0c3a78FE50',
    poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
    positionManager: '0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80',
    universalRouter: '0x492E6456D9528771018DeB9E87ef7750EF184104',
    weth: '0x4200000000000000000000000000000000000006',
  },
  // Base mainnet (8453) — LIVE, deployed + Basescan-verified 2026-07-08 (forge script DeployB20).
  8453: {
    chainId: 8453,
    factory: '0x826a2b79aBD77269fc861a36B88979daabe80C8B',
    hookStaticFee: '0x0ae73DfA41f1AcaCF32ad050924384B295E968cc',
    hookDynamicFee: '0xC8B624Ad72059c41b6e324c7840651E1DFa268Cc',
    locker: '0x3E099Bc47ad5277ab0270160E90Ae7d6f4C0a0FD',
    mevBlockDelay: '0xfC9a94dDca02A00400553898b50FdDB133269BC0',
    mevSniperTax: '0x6Be662Ce74e6823Ebef906ed7A8D1Df50cEA37E6',
    vault: '0x79D6E3f984d698ADf08BBa4139f47ea4137c28D2',
    airdropV2: '0xB9f2D2f12d6e92aFbD599B97859FC21fc2aC08Bc',
    devBuyV4: '0x401D658888739c65C0BFAE0Ce2a8d7aC5dfcBEE6',
    // Reused LIVE cc0strategy-v2 infra (the new locker points at these):
    feeLocker: '0xC04bdF721FA5CEc839819864FA86F3D48B89Fcee',
    poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    positionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
    universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    weth: '0x4200000000000000000000000000000000000006',
  },
};

/** True when the B20 launchpad is deployed + configured on `chainId` (fail-closed). */
export function isB20LaunchpadAvailable(chainId: number): boolean {
  const c = B20_LAUNCHPAD_CONTRACTS[chainId];
  return !!c && /^0x[a-fA-F0-9]{40}$/.test(c.factory);
}

// ═══ PAIRED launchpad — a SEPARATE dual-mode suite, additive to the existing one ═══════
//
// PAIRED launches (pool vs an arbitrary ERC-20, enforced 80/20 creator/treasury,
// FeeIn.Both, no staking slice) require the dual-mode factory (weth ctor immutable +
// _checkCc0PairedSplit). The EXISTING suites above stay THE path for every standard WETH
// launch — never re-pointed, never deprecated; tokens already launched keep resolving on
// them forever. This block only ADDS a second, independent suite used exclusively when a
// paired token is selected; while a chain's entry is unfilled, paired launches there fail
// closed and nothing else changes.

/** A PAIRED (dual-mode) suite's address set — the standard shape + its enforced-staking
 *  recipient and the extra mirrored fields (airdrop v1, devBuyV3) kept for frontend-book
 *  parity. On Sepolia the paired suite is self-contained (its OWN feeLocker/staking); on
 *  mainnet it reuses the shared live feeLocker/staking, pre-filled below. */
export interface B20PairedLaunchpadContracts extends B20LaunchpadContracts {
  staking: Address;
  airdrop: Address | '';
  devBuyV3: Address | '';
}

/**
 * Per-chain PAIRED B20 launchpad deployments — mirrors the cc0.company frontend book.
 *   • Base Sepolia (84532) — dual-mode suite deployed 2026-07-10, e2e-proven incl. a live
 *     paired launch. Self-contained: its OWN feeLocker/staking (fresh test economics), so
 *     paired-launch fee reads on Sepolia must resolve THIS book's feeLocker.
 *   • Base mainnet (8453) — PRE-STAGED (empty factory) until the dual-mode broadcast; the
 *     shared LIVE feeLocker/staking are already filled. Until `factory` is real,
 *     isB20PairedLaunchpadAvailable(8453) is false and paired mainnet launches throw.
 */
export const B20_LAUNCHPAD_PAIRED_CONTRACTS: Record<number, B20PairedLaunchpadContracts> = {
  84532: {
    chainId: 84532,
    factory: '0x0a98D57699915598018E0CAe5A00F8850ec38966',
    hookStaticFee: '0x6da0D206b5a0fFF28b59e0Da3AEa4ff28601a8cC',
    hookDynamicFee: '0xC367F9b46EC29B075c9A98a33C85bAB2Faa5e8CC',
    locker: '0xD502732da601097D41156B6A295cd227F635bbc6',
    feeLocker: '0x1E2384B029c87dA7075C50524ac3Cf53C4f4FDE4',
    staking: '0xb43f7BCEaB355110C63f5a821659d781d2531bAa',
    mevBlockDelay: '0xE6DEb041cA8CE015d9CD6Ae38731d833C38d5f39',
    mevSniperTax: '0x03E4e724Daad11159192A620FA4bb861deE41974',
    vault: '0x2a2A5c4f44eF177f6d2674300355C9b243C5A2ac',
    airdrop: '0x532581badE328f2b64921FAC0E9f294AD2FFB778',
    airdropV2: '0xCAe0754a5fB52db7efa42f482AbC0Be8D63BF05e',
    devBuyV4: '0x0C003114f418a3A4D61C170EDf0357Ce4Acb4F21',
    devBuyV3: '0x3942675b018D975686684227d11E8dC1DdA67Ac3',
    // Same V4 infra + WETH as the standard Sepolia entry:
    poolManager: '0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408',
    positionManager: '0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80',
    universalRouter: '0x492E6456D9528771018DeB9E87ef7750EF184104',
    weth: '0x4200000000000000000000000000000000000006',
  },
  8453: {
    chainId: 8453,
    // LIVE — deployed + Basescan-verified 14/14 on 2026-07-10 (DeployB20 mainnet branch).
    // The standard B20 factory 0x826a… was NOT touched.
    factory: '0x55ee7660b1253bFdeCAfD4f79cA8f9A4addB7979',
    hookStaticFee: '0xa10A6f4b918e963eC8694D37aA22E438706fE8cC',
    hookDynamicFee: '0xc942072fdD8Ab5Eb97abEfcD4bd08e918472a8cC',
    locker: '0xc683151b2a597b0ca7Be0e20AaD4483994fc6F95',
    mevBlockDelay: '0x10cb69067b76642c63F62aF55572c5c496d4EE04',
    mevSniperTax: '0x917d4A2FaD56C97825893cC95614806e8889899A',
    vault: '0xf37d86B07c8D7082A38387E73078490ad30a6Fe0',
    airdrop: '0x7490ECe16552734379E272206d0A0f869500C868',
    airdropV2: '0x5a4169A188C0E5f2Ea27F96B2Bf873602b45720a',
    devBuyV4: '0x01EE852E4A364296C3DeD05F4dD8e44a595A93CD',
    devBuyV3: '0x413Ae94AAF4a26C44C897D4ae256B22f8f904c81',
    // Reused LIVE infra — same shared fee locker + staking as every launch:
    feeLocker: '0xC04bdF721FA5CEc839819864FA86F3D48B89Fcee',
    staking: '0x38cE743b88c54eD1aF84816Ff596E518d16DFF95',
    poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
    positionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
    universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
    weth: '0x4200000000000000000000000000000000000006',
  },
};

/** PAIRED-suite address book for a chain, or null when not deployed/filled there (fail-closed). */
export function getB20PairedLaunchpad(chainId: number): B20PairedLaunchpadContracts | null {
  const c = B20_LAUNCHPAD_PAIRED_CONTRACTS[chainId] ?? null;
  return c && /^0x[a-fA-F0-9]{40}$/.test(c.factory) ? c : null;
}

/** True when paired (80/20) B20 launches are possible on `chainId` (fail-closed). */
export function isB20PairedLaunchpadAvailable(chainId: number): boolean {
  return getB20PairedLaunchpad(chainId) !== null;
}

const B20_RPCS: Record<number, string> = {
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
};
const B20_VIEM_CHAINS = { 8453: base, 84532: baseSepolia } as const;
const B20_EXPLORERS: Record<number, string> = {
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
};

// ── B20-native constants (precompiles — identical on Base mainnet + Sepolia) ─────────

export const B20_POLICY_REGISTRY_ADDRESS =
  '0x8453000000000000000000000000000000000002' as Address;

/** AccessControl roles — bytes32(keccak256(name)); admin role is bytes32(0). */
export const B20_ROLES = {
  DEFAULT_ADMIN_ROLE: `0x${'00'.repeat(32)}` as Hex,
  MINT_ROLE: keccak256(toBytes('MINT_ROLE')),
  BURN_ROLE: keccak256(toBytes('BURN_ROLE')),
  BURN_BLOCKED_ROLE: keccak256(toBytes('BURN_BLOCKED_ROLE')),
  PAUSE_ROLE: keccak256(toBytes('PAUSE_ROLE')),
  UNPAUSE_ROLE: keccak256(toBytes('UNPAUSE_ROLE')),
  METADATA_ROLE: keccak256(toBytes('METADATA_ROLE')),
  OPERATOR_ROLE: keccak256(toBytes('OPERATOR_ROLE')),
} as const;

/** Policy scopes — bytes32(keccak256(name)). */
export const B20_SCOPES = {
  TRANSFER_SENDER_POLICY: keccak256(toBytes('TRANSFER_SENDER_POLICY')),
  TRANSFER_RECEIVER_POLICY: keccak256(toBytes('TRANSFER_RECEIVER_POLICY')),
  TRANSFER_EXECUTOR_POLICY: keccak256(toBytes('TRANSFER_EXECUTOR_POLICY')),
  MINT_RECEIVER_POLICY: keccak256(toBytes('MINT_RECEIVER_POLICY')),
} as const;

/** PolicyRegistry policy types (uint8 on the wire). */
export const B20_POLICY_TYPE = { blocklist: 0, allowlist: 1 } as const;

// Minimal ABI fragments — only what the managed post-launch config touches.
const B20_TOKEN_ABI = [
  { type: 'function', name: 'updateSupplyCap', stateMutability: 'nonpayable', inputs: [{ name: 'newSupplyCap', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'updateContractURI', stateMutability: 'nonpayable', inputs: [{ name: 'newURI', type: 'string' }], outputs: [] },
  { type: 'function', name: 'grantRole', stateMutability: 'nonpayable', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [] },
  { type: 'function', name: 'updatePolicy', stateMutability: 'nonpayable', inputs: [{ name: 'policyScope', type: 'bytes32' }, { name: 'newPolicyId', type: 'uint64' }], outputs: [] },
] as const;

const B20_POLICY_REGISTRY_ABI = [
  { type: 'function', name: 'createPolicyWithAccounts', stateMutability: 'nonpayable', inputs: [{ name: 'admin', type: 'address' }, { name: 'policyType', type: 'uint8' }, { name: 'accounts', type: 'address[]' }], outputs: [{ name: 'newPolicyId', type: 'uint64' }] },
  { type: 'event', name: 'PolicyCreated', inputs: [{ name: 'policyId', type: 'uint64', indexed: true }, { name: 'creator', type: 'address', indexed: true }, { name: 'policyType', type: 'uint8', indexed: false }] },
] as const;

const FACTORY_PROTOCOL_ABI = [
  { type: 'function', name: 'cc0Staking', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'cc0Treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'cc0Admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/**
 * B20 launchpad factory ABI — the shared factory ABI with an EXTRA trailing
 * `uint256 supply` on TokenConfig (caller-chosen launch supply; 0 ⇒ 100B default).
 * Encoding a B20 launch against the 8-field ERC-20 ABI corrupts the calldata, so the
 * clone below is load-bearing. The spreads create new objects — FACTORY_ABI is never
 * mutated.
 */
export const B20_FACTORY_ABI: Abi = (FACTORY_ABI as readonly unknown[]).map((entry) => {
  const e = entry as { type?: string; name?: string; inputs?: unknown[] };
  if (e.type !== 'function' || e.name !== 'deployToken') return entry;
  return {
    ...e,
    inputs: (e.inputs as Array<{ name?: string; components?: unknown[] }>).map((inp) =>
      inp.name === 'deploymentConfig'
        ? {
            ...inp,
            components: (inp.components as Array<{ name?: string; components?: unknown[] }>).map(
              (c) =>
                c.name === 'tokenConfig'
                  ? {
                      ...c,
                      components: [
                        ...(c.components as unknown[]),
                        { name: 'supply', type: 'uint256', internalType: 'uint256' },
                      ],
                    }
                  : c,
            ),
          }
        : inp,
    ),
  };
}) as Abi;

// ── Types ────────────────────────────────────────────────────────────────────────────

export interface Cc0B20Config {
  /** Ready viem WalletClient (signs + submits itself). */
  walletClient?: WalletClient;
  /** Any viem Account — a WalletClient on the configured chain is built internally. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  account?: any;
  /** Provider-agnostic sender (CDP, Bankr, Safe, relayer) — the SDK prepares, you submit. */
  sender?: ExternalSender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient?: any;
  /**
   * 8453 (Base mainnet) or 84532 (Base Sepolia). Defaults to mainnet when the launchpad
   * is live there, else Sepolia. A chain whose factory isn't deployed throws (fail-closed).
   */
  chainId?: number;
  /** cc0.company base URL for image pinning + launch registration. */
  registryUrl?: string;
}

export interface B20RoleGrant {
  role: Hex;
  accounts: Address[];
}

export type B20ComplianceMode = 'none' | 'allowlist' | 'blocklist';

/** B20-native config applied right after a MANAGED launch (trustless tokens are immutable). */
export interface B20LaunchConfig {
  /** Cap on FUTURE minting, whole tokens. Must be ≥ the launch supply. Empty ⇒ uncapped. */
  supplyCap?: string;
  /** ERC-7572 onchain metadata URI. */
  contractURI?: string;
  /** Extra role holders (use B20_ROLES). */
  roleGrants?: B20RoleGrant[];
  /**
   * Transfer-restriction policy. An allowlist auto-includes the creator + the pool/router/
   * locker infra so the token keeps trading; a blocklist never blocks that infra.
   */
  compliance?: { mode: B20ComplianceMode; accounts: Address[] };
  /** Grant the creator BURN_BLOCKED_ROLE so they can freeze + seize a blocked balance. */
  freezeAndSeize?: boolean;
}

export interface LaunchB20Params {
  name: string;
  symbol: string;
  /** ipfs:// URI, remote URL, data: URL, raw bytes or Blob — pinned to IPFS unless already ipfs://. */
  image: LaunchImage;
  /** 'pin' (default): guarantee permanence before building the tx. 'as-is': trust the URL. */
  imagePolicy?: 'pin' | 'as-is';
  description?: string;
  /**
   * Total supply to mint at launch, WHOLE tokens (e.g. "1000000000"). Empty ⇒ the 100B
   * default. The factory seeds the pool with exactly this amount.
   */
  supply?: string;
  /** 'static' (default) uses feeTier on the static hook; 'dynamic' the 1→3% preset hook. */
  feeMode?: 'static' | 'dynamic';
  /** Static LP fee tier: 1 | 2 | 3 | 6.9 (%). Ignored when feeMode === 'dynamic'. */
  feeTier?: 1 | 2 | 3 | 6.9;
  /** Optional Clanker-style sniper tax; if omitted, a 2-block MEV delay is used. */
  sniperTax?: { startingBps: number; endingBps: number; secondsToDecay: number };
  /** Optional creator supply vault (% of supply, lockup ≥ 7 days, optional vesting). */
  vault?: { percentage: number; lockupSeconds: number; vestingSeconds: number };
  /** Optional merkle airdrop (% of supply, lockup ≥ 1 day). */
  airdrop?: { merkleRoot: Hex; percentage: number; lockupSeconds?: number; vestingSeconds?: number };
  /** Optional dev buy: ETH spent buying the token at launch (e.g. "0.05"). */
  devBuyEth?: string;
  /**
   * Liquidity profile — 'classic' (default, ~$36k starting FDV at the 100B default supply)
   * or 'degen' (~$5k: the price needs ~7× less volume to move). A custom `supply` scales
   * the dollar figures proportionally; degen stays ~7× thinner either way.
   */
  lpPreset?: Cc0LpPreset;
  /**
   * PAIRED LAUNCH — pair the pool with this ERC-20 instead of WETH. The fee split
   * becomes 80% you / 20% treasury (no staker slice — staking rewards are WETH-only)
   * and both slices take fees in BOTH pool tokens. symbol/decimals are read on-chain;
   * the WETH price resolves from the cc0.company price API unless `priceWeth` is set
   * (fail-closed: no price, no launch — on Sepolia pass it explicitly). Paired launches
   * deploy through the SEPARATE dual-mode suite (B20_LAUNCHPAD_PAIRED_CONTRACTS) —
   * check `isB20PairedLaunchpadAvailable(chainId)`: live on Base Sepolia (84532),
   * PRE-STAGED on Base mainnet (throws until that suite is broadcast). Dev buy is not
   * available for paired launches. undefined ⇒ standard WETH launch (75/15/10 path
   * on the existing suite).
   */
  pairedToken?: PairedTokenParam;
  socials?: string[];
  /** Wallet receiving the creator's 75% slice + vault/dev-buy proceeds. Defaults to the creator. */
  rewardRecipient?: Address;
  /**
   * Who controls the minted B20 itself (independent of the fee split):
   *   'trustless' (default) — admin-less, fixed supply, immutable. Best for fair launches.
   *   'managed'             — the creator is DEFAULT_ADMIN (mint/pause/configure later).
   */
  adminMode?: 'trustless' | 'managed';
  /** Managed-only B20-native config, applied right after launch. Ignored when trustless. */
  b20?: B20LaunchConfig;
  /** Register on cc0.company (token page, chart, swap). Default true. */
  register?: boolean;
  /** Progress callback for the managed post-launch config steps. */
  onConfigStep?: (msg: string) => void;
}

export interface LaunchB20Result {
  tokenAddress: Address;
  txHash: Hash;
  /** Whether the launch was registered on cc0.company (best-effort). */
  registered: boolean;
  /**
   * Managed config steps that FAILED (the token itself is live + tradeable either way);
   * finish them from the token dashboard. Undefined when everything applied cleanly.
   */
  configWarnings?: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return ('0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

function dedupeAddrs(a: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const x of a) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

// ── The launchpad ────────────────────────────────────────────────────────────────────

/**
 * Launch tradeable B20s through the cc0.company B20 launchpad (Base-only).
 *
 * ```ts
 * import { Cc0B20Launchpad } from '@cc0company/sdk';
 *
 * const b20 = new Cc0B20Launchpad({ walletClient, chainId: 84532 });
 * const { tokenAddress } = await b20.launchB20({
 *   name: 'My B20',
 *   symbol: 'MYB20',
 *   image: 'ipfs://…',
 *   lpPreset: 'degen',
 * });
 * ```
 */
export class Cc0B20Launchpad {
  public readonly walletClient?: WalletClient;
  public readonly sender?: ExternalSender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  public readonly chainId: number;
  public readonly chain: (typeof B20_VIEM_CHAINS)[keyof typeof B20_VIEM_CHAINS];
  public readonly contracts: B20LaunchpadContracts;
  public readonly registryUrl: string;
  /** Internal ERC-20 launchpad instance — reused ONLY for its public image pinning. */
  private readonly pinner: Cc0Launchpad;

  constructor(config: Cc0B20Config = {}) {
    const requested =
      config.chainId ?? (isB20LaunchpadAvailable(8453) ? 8453 : 84532);
    if (requested !== 8453 && requested !== 84532) {
      throw new Error(`B20 is Base-only — chainId must be 8453 or 84532, got ${requested}.`);
    }
    if (!isB20LaunchpadAvailable(requested)) {
      throw new Error(
        `The B20 launchpad is not deployed on chain ${requested} yet` +
          (requested === 8453 ? ' (mainnet cutover pending — use chainId 84532 for Base Sepolia).' : '.'),
      );
    }
    this.chainId = requested;
    this.chain = B20_VIEM_CHAINS[requested as 8453 | 84532];
    this.contracts = B20_LAUNCHPAD_CONTRACTS[requested];
    this.registryUrl = (config.registryUrl ?? 'https://cc0.company').replace(/\/$/, '');

    this.walletClient =
      config.walletClient ??
      (config.account
        ? createWalletClient({
            account: config.account,
            chain: this.chain,
            transport: http(B20_RPCS[requested]),
          })
        : undefined);
    this.sender = config.sender;
    this.publicClient =
      config.publicClient ??
      createPublicClient({ chain: this.chain, transport: http(B20_RPCS[requested]) });
    this.pinner = new Cc0Launchpad({ registryUrl: this.registryUrl });
  }

  /** Read the enforced recipients live from the B20 factory (fail-closed). Paired launches
   *  pass the PAIRED suite's factory via `factoryOverride` — the dual-mode contract whose
   *  cc0Treasury/cc0Admin the 80/20 config must name; omitted ⇒ the standard factory. */
  async getProtocolAddresses(
    factoryOverride?: Address,
  ): Promise<{ staking: Address; treasury: Address; admin: Address }> {
    try {
      const factory = factoryOverride ?? (this.contracts.factory as Address);
      const [staking, treasury, admin] = await Promise.all([
        this.publicClient.readContract({ address: factory, abi: FACTORY_PROTOCOL_ABI, functionName: 'cc0Staking' }),
        this.publicClient.readContract({ address: factory, abi: FACTORY_PROTOCOL_ABI, functionName: 'cc0Treasury' }),
        this.publicClient.readContract({ address: factory, abi: FACTORY_PROTOCOL_ABI, functionName: 'cc0Admin' }),
      ]);
      return { staking, treasury, admin };
    } catch {
      throw new Error(
        'Could not read the enforced protocol addresses from the B20 factory — refusing to build a launch config that would revert.',
      );
    }
  }

  /**
   * Launch end-to-end with whatever you configured (walletClient/account signs via viem;
   * sender lets your infra submit). Image pinned to IPFS, launch registered on cc0.company,
   * managed B20 config applied as follow-up transactions.
   */
  async launchB20(p: LaunchB20Params): Promise<LaunchB20Result> {
    const creator = await this.resolveCreator();
    const { config, totalMsgValue, supplyBaseUnits, paired, factory } =
      await this.buildDeploymentConfig(p, creator);

    const data = encodeFunctionData({
      abi: B20_FACTORY_ABI,
      functionName: 'deployToken',
      args: [config as never],
    });
    // The PAIRED suite's factory for paired launches; the standard one otherwise.
    const txHash = await this.write(factory, data, totalMsgValue);

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 180_000,
    });
    const tokenAddress = parseLaunchReceipt(receipt);
    if (!tokenAddress) {
      throw new Error('Transaction confirmed but the TokenCreated event was not found.');
    }

    // Managed B20 config — the token is already live + tradeable, so each follow-up tx is
    // individually fail-soft: a miss becomes a warning, never a failed launch.
    const configWarnings: string[] = [];
    if ((p.adminMode ?? 'trustless') === 'managed' && p.b20) {
      await this.applyManagedConfig(tokenAddress, creator, p, supplyBaseUnits, configWarnings);
    }

    let registered = false;
    if (p.register !== false) {
      registered = await this.registerLaunch({
        tokenAddress,
        txHash,
        name: p.name,
        symbol: p.symbol,
        description: p.description,
        image: typeof p.image === 'string' && p.image.startsWith('ipfs://') ? p.image : undefined,
        creator,
        hasAirdrop: !!p.airdrop,
        lpPreset: p.lpPreset,
        paired,
      });
    }

    return {
      tokenAddress,
      txHash,
      registered,
      configWarnings: configWarnings.length ? configWarnings : undefined,
    };
  }

  /** Register a B20 launch on cc0.company (protocol `b20strategy`). Best-effort. */
  async registerLaunch(params: {
    tokenAddress: Address;
    txHash: Hash;
    name: string;
    symbol: string;
    description?: string;
    image?: string;
    creator: Address;
    hasAirdrop?: boolean;
    lpPreset?: Cc0LpPreset;
    /** Paired launch: the resolved paired token — recorded so the token page shows the
     *  "Paired with $SYM" badge, the 80/20 split, and the paired claim assets. */
    paired?: { address: Address; symbol: string; decimals: number };
  }): Promise<boolean> {
    try {
      const res = await fetch(`${this.registryUrl}/api/store/token-launches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token_address: params.tokenAddress,
          // The registry records every B20 as chain "base" (Sepolia rehearsals included) —
          // same convention as the cc0.company frontend.
          chain: 'base',
          tx_hash: params.txHash,
          protocol: 'b20strategy',
          protocol_url: `${B20_EXPLORERS[this.chainId]}/token/${params.tokenAddress}`,
          name: params.name,
          symbol: params.symbol,
          description: params.description || undefined,
          image_url: params.image || undefined,
          creator_wallet: params.creator,
          has_airdrop: !!params.hasAirdrop,
          ...(params.lpPreset ? { lp_preset: params.lpPreset } : {}),
          ...(params.paired
            ? {
                paired_token: params.paired.address.toLowerCase(),
                paired_symbol: params.paired.symbol,
                paired_decimals: params.paired.decimals,
                split_type: 'paired',
              }
            : {}),
        }),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────

  private async resolveCreator(): Promise<Address> {
    const acct = this.walletClient?.account;
    if (acct?.address) return acct.address as Address;
    if (this.sender?.address) return this.sender.address as Address;
    throw new Error(
      'No signer configured — pass a walletClient/account, or a sender with an `address`.',
    );
  }

  /** One write path for BOTH signer models: viem walletClient, or prepared-tx sender. */
  private async write(to: Address, data: Hex, value: bigint): Promise<Hash> {
    if (this.walletClient) {
      const txHash = await this.walletClient.sendTransaction({
        account: this.walletClient.account!,
        chain: this.chain,
        to,
        data,
        value,
      });
      return txHash;
    }
    if (this.sender) {
      const prepared = await this.prepareTx(to, data, value);
      const txHash = await this.sender.send(prepared);
      assertTxHash(txHash, 'Your sender.send()');
      return txHash as Hash;
    }
    throw new Error('No signer configured — pass a walletClient/account or a sender.');
  }

  private async prepareTx(to: Address, data: Hex, value: bigint): Promise<PreparedTransaction> {
    const creator = await this.resolveCreator();
    // deployToken is HEAVY (token + pool + locked LP + extensions) — 20% buffer, safe
    // ceiling when the node refuses to estimate (e.g. unfunded creator).
    let gas = BigInt(16_000_000);
    try {
      const estimated = (await this.publicClient.estimateGas({
        account: creator,
        to,
        data,
        value,
      })) as bigint;
      gas = (estimated * BigInt(120)) / BigInt(100);
    } catch {
      /* keep the fallback ceiling */
    }
    const fees = await estimateEip1559Fees(this.publicClient);
    return toPreparedTx(to, data, value, gas, fees, this.chainId);
  }

  private async buildDeploymentConfig(
    p: LaunchB20Params,
    creator: Address,
  ): Promise<{
    config: Record<string, unknown>;
    totalMsgValue: bigint;
    supplyBaseUnits: bigint;
    paired?: PairedTokenOption;
    /** The factory deployToken targets — the PAIRED suite's for paired launches. */
    factory: Address;
  }> {
    const c = this.contracts;

    const lpPreset = p.lpPreset ?? 'classic';
    if (!LP_PRESETS[lpPreset]) {
      throw new Error(
        `Unknown lpPreset "${lpPreset}" — use one of: ${Object.keys(LP_PRESETS).join(', ')}.`,
      );
    }

    // ── Paired launch (custom pair) — validate + resolve BEFORE any side effect ──
    // symbol/decimals read on-chain; priceWeth explicit or resolved live from the
    // cc0.company price API (fail-closed — no price, no launch). Paired launches bind
    // to the SEPARATE dual-mode PAIRED suite (B20_LAUNCHPAD_PAIRED_CONTRACTS) — never
    // the standard book — and fail closed while that suite is unfilled on the chain.
    let paired: PairedTokenOption | undefined;
    const pairedBook = p.pairedToken ? getB20PairedLaunchpad(this.chainId) : null;
    if (p.pairedToken) {
      if (!pairedBook) {
        throw new Error('Paired launches are not available on this chain yet.');
      }
      if (p.devBuyEth && Number(p.devBuyEth) > 0) {
        throw new Error('Dev buy is not available for paired launches yet.');
      }
      paired = await resolvePairedToken(p.pairedToken, {
        publicClient: this.publicClient,
        registryUrl: this.registryUrl,
        weth: c.weth,
      });
    }

    // The suite this launch binds to: the WHOLE config (factory target, hooks, locker,
    // MEV modules, extensions) comes from the PAIRED book for paired launches; standard
    // WETH launches keep the existing book — untouched.
    const suite: B20LaunchpadContracts = pairedBook ?? c;

    // Pin the image FIRST — the URI goes on-chain forever (fail-closed permanence).
    const imageUri = await this.resolveImage(p.image, p.imagePolicy ?? 'pin');

    // Enforced recipients read from the factory the launch actually targets — the PAIRED
    // dual-mode factory for paired launches (its recipients can differ, e.g. Sepolia's
    // self-contained test economics), the standard factory otherwise.
    const enforced = await this.getProtocolAddresses(
      pairedBook ? (pairedBook.factory as Address) : undefined,
    );
    const rewardRecipient = (p.rewardRecipient ?? creator) as Address;

    // Custom launch supply (whole tokens) → base units. parseUnits, never Number()*1e18
    // (1e29 overflows MAX_SAFE_INTEGER).
    const supplyBaseUnits =
      p.supply && p.supply.trim() !== ''
        ? parseUnits(p.supply.trim(), B20_LAUNCH_DECIMALS)
        : B20_DEFAULT_LAUNCH_SUPPLY;
    const supplyWhole = Number(supplyBaseUnits / 10n ** BigInt(B20_LAUNCH_DECIMALS));

    // Starting tick ADJUSTED for the supply so the preset's FDV holds — a fixed tick + a tiny custom
    // supply prices the whole pool at ~$0 and one small buy drains it. Paired pools are priced in
    // the PAIRED token, so their tick is additionally derived from its live WETH price (with the
    // [0.5, 2] implied-FDV guard). Feeds both tickIfToken0IsClanker AND tickLower[0] below.
    const startingTick = paired
      ? guardedPairedStartingTick(lpPreset, supplyWhole, paired)
      : startingTickForSupply(lpPreset, supplyWhole);

    // ── fee hook + feeData ──
    const feeMode = p.feeMode ?? 'static';
    let hook: Address;
    let feeData: Hex;
    if (feeMode === 'dynamic') {
      hook = suite.hookDynamicFee as Address;
      feeData = encodeAbiParameters(
        [
          { name: 'baseFee', type: 'uint24' },
          { name: 'maxLpFee', type: 'uint24' },
          { name: 'referenceTickFilterPeriod', type: 'uint256' },
          { name: 'resetPeriod', type: 'uint256' },
          { name: 'resetTickFilter', type: 'int24' },
          { name: 'feeControlNumerator', type: 'uint256' },
          { name: 'decayFilterBps', type: 'uint24' },
        ],
        [
          DYNAMIC_3_CONFIG.baseFee,
          DYNAMIC_3_CONFIG.maxLpFee,
          DYNAMIC_3_CONFIG.referenceTickFilterPeriod,
          DYNAMIC_3_CONFIG.resetPeriod,
          DYNAMIC_3_CONFIG.resetTickFilter,
          DYNAMIC_3_CONFIG.feeControlNumerator,
          DYNAMIC_3_CONFIG.decayFilterBps,
        ],
      );
    } else {
      hook = suite.hookStaticFee as Address;
      const feeUnits = Math.round((p.feeTier ?? 1) * 10_000);
      feeData = encodeAbiParameters(
        [{ name: 'clankerFee', type: 'uint24' }, { name: 'pairedFee', type: 'uint24' }],
        [feeUnits, feeUnits],
      );
    }

    const poolData = encodeAbiParameters(
      [{
        type: 'tuple',
        components: [
          { name: 'extension', type: 'address' },
          { name: 'extensionData', type: 'bytes' },
          { name: 'feeData', type: 'bytes' },
        ],
      }],
      [{ extension: ZERO, extensionData: '0x', feeData }],
    );
    // Standard: creator → Both (WETH + token); staking + treasury → Paired (WETH only).
    // Paired launch: BOTH slices → Both — neither pool token is assumed WETH-liquid.
    const lockerData = encodeAbiParameters(
      [{ type: 'tuple', components: [{ name: 'feePreference', type: 'uint8[]' }] }],
      [
        {
          feePreference: paired
            ? [FEE_IN.both, FEE_IN.both]
            : [FEE_IN.both, FEE_IN.paired, FEE_IN.paired],
        },
      ],
    );

    // ── MEV protection ──
    let mevModule: Address;
    let mevModuleData: Hex;
    if (p.sniperTax) {
      mevModule = suite.mevSniperTax as Address;
      mevModuleData = encodeAbiParameters(
        [{
          type: 'tuple',
          components: [
            { name: 'startingFee', type: 'uint24' },
            { name: 'endingFee', type: 'uint24' },
            { name: 'secondsToDecay', type: 'uint256' },
          ],
        }],
        [{
          startingFee: p.sniperTax.startingBps,
          endingFee: p.sniperTax.endingBps,
          secondsToDecay: BigInt(p.sniperTax.secondsToDecay),
        }],
      );
    } else {
      mevModule = suite.mevBlockDelay as Address;
      mevModuleData = '0x';
    }

    // ── extensions: vault / airdrop / dev buy ──
    const extensions: { extension: Address; msgValue: bigint; extensionBps: number; extensionData: Hex }[] = [];
    let totalMsgValue = BigInt(0);

    if (p.vault && p.vault.percentage > 0) {
      const lockup = Math.max(p.vault.lockupSeconds, 7 * 86400);
      extensions.push({
        extension: suite.vault as Address,
        msgValue: BigInt(0),
        extensionBps: Math.round(p.vault.percentage * 100),
        extensionData: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'admin', type: 'address' },
              { name: 'lockupDuration', type: 'uint256' },
              { name: 'vestingDuration', type: 'uint256' },
            ],
          }],
          [{
            admin: rewardRecipient,
            lockupDuration: BigInt(lockup),
            vestingDuration: BigInt(Math.max(p.vault.vestingSeconds, 0)),
          }],
        ),
      });
    }
    if (p.airdrop && p.airdrop.percentage > 0) {
      const lockup = Math.max(p.airdrop.lockupSeconds ?? 0, 86400);
      extensions.push({
        extension: suite.airdropV2 as Address,
        msgValue: BigInt(0),
        extensionBps: Math.round(p.airdrop.percentage * 100),
        extensionData: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              { name: 'admin', type: 'address' },
              { name: 'merkleRoot', type: 'bytes32' },
              { name: 'lockupDuration', type: 'uint256' },
              { name: 'vestingDuration', type: 'uint256' },
            ],
          }],
          [{
            admin: rewardRecipient,
            merkleRoot: p.airdrop.merkleRoot,
            lockupDuration: BigInt(lockup),
            vestingDuration: BigInt(Math.max(p.airdrop.vestingSeconds ?? 0, 0)),
          }],
        ),
      });
    }
    if (p.devBuyEth && Number(p.devBuyEth) > 0) {
      const ethValue = parseEther(p.devBuyEth);
      totalMsgValue += ethValue;
      extensions.push({
        extension: suite.devBuyV4 as Address,
        msgValue: ethValue,
        extensionBps: 0, // takes no supply — it BUYS from the fresh pool
        extensionData: encodeAbiParameters(
          [{
            type: 'tuple',
            components: [
              {
                name: 'pairedTokenPoolKey',
                type: 'tuple',
                components: [
                  { name: 'currency0', type: 'address' },
                  { name: 'currency1', type: 'address' },
                  { name: 'fee', type: 'uint24' },
                  { name: 'tickSpacing', type: 'int24' },
                  { name: 'hooks', type: 'address' },
                ],
              },
              { name: 'pairedTokenAmountOutMinimum', type: 'uint128' },
              { name: 'recipient', type: 'address' },
            ],
          }],
          [{
            pairedTokenPoolKey: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
            pairedTokenAmountOutMinimum: BigInt(0),
            recipient: rewardRecipient,
          }],
        ),
      });
    }

    // tokenAdmin selects the minted B20's admin model: trustless → address(0) (admin-less,
    // immutable supply), managed → the creator (DEFAULT_ADMIN). Fee split enforced either way.
    const config = {
      tokenConfig: {
        tokenAdmin: (p.adminMode ?? 'trustless') === 'managed' ? creator : ZERO,
        name: p.name,
        symbol: p.symbol,
        salt: randomSalt(),
        image: imageUri,
        metadata: JSON.stringify({ description: p.description ?? '', socials: p.socials ?? [] }),
        context: 'cc0company-sdk',
        originatingChainId: BigInt(this.chainId),
        supply: supplyBaseUnits, // trailing B20-only field (see B20_FACTORY_ABI)
      },
      poolConfig: {
        hook,
        pairedToken: paired ? paired.address : c.weth,
        tickIfToken0IsClanker: startingTick,
        tickSpacing: TICK_SPACING,
        poolData,
      },
      lockerConfig: {
        locker: suite.locker,
        rewardAdmins: paired
          ? [creator, enforced.admin]
          : [creator, enforced.admin, enforced.admin],
        rewardRecipients: paired
          ? [rewardRecipient, enforced.treasury]
          : [rewardRecipient, enforced.staking, enforced.treasury],
        rewardBps: paired
          ? [PAIRED_SPLIT.CREATOR_BPS, PAIRED_SPLIT.TREASURY_BPS]
          : [PROTOCOL_SPLIT.CREATOR_BPS, PROTOCOL_SPLIT.STAKING_BPS, PROTOCOL_SPLIT.TREASURY_BPS],
        tickLower: [startingTick],
        tickUpper: [MAX_TICK_UPPER],
        positionBps: [10_000],
        lockerData,
      },
      mevModuleConfig: { mevModule, mevModuleData },
      extensionConfigs: extensions,
    };

    return { config, totalMsgValue, supplyBaseUnits, paired, factory: suite.factory as Address };
  }

  /** Apply the managed B20-native config to the live token. Each step is fail-soft. */
  private async applyManagedConfig(
    token: Address,
    creator: Address,
    p: LaunchB20Params,
    supplyBaseUnits: bigint,
    warnings: string[],
  ): Promise<void> {
    const cfg = p.b20!;
    const step = (m: string) => p.onConfigStep?.(m);
    const soft = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        warnings.push(`${label} failed — finish it from the token dashboard on cc0.company.`);
      }
    };
    const writeFn = async (to: Address, abi: Abi | readonly unknown[], functionName: string, args: unknown[]) => {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args } as never);
      const h = await this.write(to, data, BigInt(0));
      await this.publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
      return h;
    };

    if (cfg.supplyCap && cfg.supplyCap.trim() !== '') {
      const cap = parseUnits(cfg.supplyCap.trim(), B20_LAUNCH_DECIMALS);
      if (cap >= supplyBaseUnits) {
        step('Setting the supply cap…');
        try {
          await writeFn(token, B20_TOKEN_ABI, 'updateSupplyCap', [cap]);
        } catch {
          // No retry (the follow-up tx can flake right after the deploy) — tell the creator they
          // can cap the supply from the token dashboard (they're the admin).
          warnings.push('Supply cap not set yet — you can cap the supply anytime from your token dashboard.');
        }
      } else {
        warnings.push('Supply cap below the minted supply — skipped.');
      }
    }
    if (cfg.contractURI && cfg.contractURI.trim() !== '') {
      step('Setting onchain metadata…');
      await soft('Contract URI', () =>
        writeFn(token, B20_TOKEN_ABI, 'updateContractURI', [cfg.contractURI!.trim()]),
      );
    }
    for (const g of cfg.roleGrants ?? []) {
      for (const acct of dedupeAddrs(g.accounts)) {
        step('Granting roles…');
        await soft('Role grant', () => writeFn(token, B20_TOKEN_ABI, 'grantRole', [g.role, acct]));
      }
    }
    if (cfg.freezeAndSeize) {
      step('Enabling freeze & seize…');
      await soft('Freeze & seize role', () =>
        writeFn(token, B20_TOKEN_ABI, 'grantRole', [B20_ROLES.BURN_BLOCKED_ROLE, creator]),
      );
    }

    const mode: B20ComplianceMode = cfg.compliance?.mode ?? 'none';
    if (mode === 'allowlist' || mode === 'blocklist') {
      await soft('Compliance policy', async () => {
        step('Creating the compliance policy…');
        // pool/router/locker/positionManager/feeLocker/WETH must keep moving the token.
        // A PAIRED launch trades through the PAIRED suite's locker/feeLocker — include
        // them too (extra allowlisted infra is harmless; a missing locker bricks trading).
        const c = this.contracts;
        const pairedInfra = p.pairedToken ? getB20PairedLaunchpad(this.chainId) : null;
        const infra = dedupeAddrs(
          [
            c.poolManager,
            c.universalRouter,
            c.positionManager,
            c.locker as Address,
            c.feeLocker,
            c.weth,
            ...(pairedInfra
              ? [pairedInfra.locker as Address, pairedInfra.feeLocker]
              : []),
          ].map((x) => getAddress(x)),
        );
        let policyType: number;
        let accounts: Address[];
        let scopes: Hex[];
        if (mode === 'allowlist') {
          policyType = B20_POLICY_TYPE.allowlist;
          accounts = dedupeAddrs([creator, ...infra, ...((cfg.compliance?.accounts ?? []) as Address[])]);
          scopes = [
            B20_SCOPES.TRANSFER_SENDER_POLICY,
            B20_SCOPES.TRANSFER_RECEIVER_POLICY,
            B20_SCOPES.MINT_RECEIVER_POLICY,
          ];
        } else {
          // blocklist — never seed the infra into it.
          policyType = B20_POLICY_TYPE.blocklist;
          accounts = dedupeAddrs((cfg.compliance?.accounts ?? []) as Address[]);
          scopes = [B20_SCOPES.TRANSFER_SENDER_POLICY, B20_SCOPES.TRANSFER_RECEIVER_POLICY];
        }

        // Read the new policy id from the PolicyCreated event (never a predicted id).
        const data = encodeFunctionData({
          abi: B20_POLICY_REGISTRY_ABI,
          functionName: 'createPolicyWithAccounts',
          args: [creator, policyType, accounts],
        });
        const h = await this.write(B20_POLICY_REGISTRY_ADDRESS, data, BigInt(0));
        const r = await this.publicClient.waitForTransactionReceipt({ hash: h, timeout: 120_000 });
        const evs = parseEventLogs({ abi: B20_POLICY_REGISTRY_ABI, eventName: 'PolicyCreated', logs: r.logs });
        const mine =
          evs.find(
            (e) => ((e.args as { creator?: Address }).creator ?? '').toLowerCase() === creator.toLowerCase(),
          ) ?? evs[0];
        const policyId = (mine?.args as { policyId?: bigint })?.policyId;
        if (policyId === undefined) throw new Error('Could not read the new policy id.');

        step('Binding the compliance policy…');
        for (const scope of scopes) {
          await writeFn(token, B20_TOKEN_ABI, 'updatePolicy', [scope, policyId]);
        }
      });
    }
  }

  /** Resolve any LaunchImage into the on-chain URI, honouring imagePolicy. */
  private async resolveImage(image: LaunchImage, policy: 'pin' | 'as-is'): Promise<string> {
    if (typeof image === 'string' && image.startsWith('ipfs://')) return image;
    if (policy === 'as-is') {
      if (typeof image !== 'string') {
        throw new Error("imagePolicy 'as-is' requires the image to be a URL string.");
      }
      return image;
    }
    return (await this.pinner.pinImage(image)).ipfsUri;
  }
}

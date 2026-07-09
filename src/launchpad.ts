import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseEther,
  parseEventLogs,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';

import {
  AIRDROP_MIN_LOCKUP_SECONDS,
  CC0_CONTRACTS,
  CHAIN_IDS,
  DEFAULT_RPCS,
  getCc0PairedContracts,
  PAIRED_SPLIT,
  PROTOCOL_SPLIT,
  toChainSlug,
  VAULT_MIN_LOCKUP_SECONDS,
  VIEM_CHAINS,
  type Cc0Chain,
  type Cc0ChainSlug,
} from './addresses';

// ═══════════════════════════════════════════════════════════════════════════════════
// LAUNCHPAD — deploy tokens through the cc0.company launchpad (Uniswap V4 on Base)
// from any website, app, or agent.
//
// Fee economics, enforced ON-CHAIN by the factory at launch time:
//   • 75% of every trade's LP fee → the creator (you), splittable across up to 5 wallets
//   • 15% → $cc0company stakers   (pinned by the factory — cannot be altered)
//   • 10% → cc0.company treasury  (pinned by the factory — cannot be altered)
// A config that drops or resizes the protocol slices reverts with Cc0InvalidProtocolSplit.
// The two protocol slice addresses + their admin are read live from the factory, so this
// SDK keeps working if the platform ever rotates them (e.g. a staking v2).
//
// PAIRED LAUNCHES (custom pair): pass `pairedToken` to pair the pool with an arbitrary
// ERC-20 instead of WETH. The dual-mode factory then enforces an 80/20 creator/treasury
// split — no staking slice (staking rewards are WETH-only; a paired-token slice would
// strand in the fee locker) — and BOTH slices take fees in BOTH pool tokens. Paired
// launches use a SEPARATE suite (CC0_PAIRED_CONTRACTS): the standard books above are
// never re-pointed, and paired launches fail closed while a chain's paired suite is
// unfilled (Base pre-staged, pending its broadcast).
// ═══════════════════════════════════════════════════════════════════════════════════

// Pool constants (must mirror the launchpad's canonical pool shape).
const MAX_TICK_UPPER = 887200;
const TICK_SPACING = 200;

/**
 * Liquidity profiles. Both are the SAME single full-range one-sided LP — only the starting
 * tick differs, which sets the starting FDV and therefore the depth (for a full-range LP the
 * virtual WETH depth ≈ FDV at the current price):
 *   • classic — ~9.9 WETH starting FDV (~$36k): deep, steady price. The historical default.
 *   • degen   — ~1.3 WETH starting FDV (~$5k): thin, price ~7× more reactive at launch.
 * Ticks must be multiples of TICK_SPACING and feed BOTH tickIfToken0IsClanker and
 * tickLower[0] — if they diverge the LP mint stops being one-sided and the launch reverts.
 */
export const LP_PRESETS = {
  classic: { startingTick: -230400 },
  degen: { startingTick: -250400 },
} as const;

/** Liquidity profile name ('classic' default | 'degen'). */
export type Cc0LpPreset = keyof typeof LP_PRESETS;

/** Supply the preset ticks are calibrated for (the historical + B20 default), in WHOLE tokens. */
export const DEFAULT_SUPPLY_WHOLE = 100_000_000_000;

/**
 * Starting tick that holds a preset's FDV constant across ANY launch supply. The preset ticks fix
 * the price PER TOKEN, calibrated for the 100B default (FDV = supply × price). A custom supply (B20)
 * at the fixed tick keeps that per-token price, so its FDV collapses proportionally — e.g. 69 tokens
 * price the whole pool at ~$0 and one tiny buy drains it. Shifting the tick by
 * ln(DEFAULT / supply) / ln(1.0001) restores the FDV to the preset's target for any supply; the 100B
 * default returns the base tick unchanged. Result is a multiple of TICK_SPACING, clamped to range.
 */
export function startingTickForSupply(preset: Cc0LpPreset, supplyWhole: number): number {
  const base = LP_PRESETS[preset].startingTick;
  const s = Number.isFinite(supplyWhole) && supplyWhole > 0 ? supplyWhole : DEFAULT_SUPPLY_WHOLE;
  if (s === DEFAULT_SUPPLY_WHOLE) return base;
  const shift = Math.log(DEFAULT_SUPPLY_WHOLE / s) / Math.log(1.0001);
  let tick = Math.round((base + shift) / 200) * 200; // TICK_SPACING = 200
  if (tick > 887000) tick = 887000;
  if (tick < -887200) tick = -887200;
  return tick;
}

/**
 * Starting tick for a PAIRED launch (pool quoted in an arbitrary ERC-20, not WETH).
 * A paired pool prices the new token in the PAIRED token, so the preset's fixed tick
 * (a WETH price) is meaningless — the tick is recomputed at launch time from the paired
 * token's live WETH price + decimals so the preset's FDV target (in WETH) still holds.
 * Identity invariant: pairedPriceWeth=1, pairedDecimals=18, default supply → the
 * preset's base tick exactly. Result is a multiple of TICK_SPACING, clamped to range.
 * Fail-closed: throws when the paired price is missing — NEVER defaults.
 */
export function startingTickForPairedLaunch(opts: {
  preset: Cc0LpPreset;            // 'classic' | 'degen'
  supplyWhole: number;            // launched-token supply in whole tokens
  pairedPriceWeth: number;        // live price of the paired token, in WETH
  pairedDecimals: number;         // paired token decimals (NOT always 18)
}): number {
  const { preset, supplyWhole, pairedPriceWeth, pairedDecimals } = opts;
  if (!Number.isFinite(pairedPriceWeth) || pairedPriceWeth <= 0)
    throw new Error('Paired token price unavailable'); // fail-closed, NEVER default
  const s = Number.isFinite(supplyWhole) && supplyWhole > 0 ? supplyWhole : DEFAULT_SUPPLY_WHOLE;
  // The preset's FDV target in WETH, derived from its own tick (single source of truth):
  const fdvWeth = Math.pow(1.0001, LP_PRESETS[preset].startingTick) * DEFAULT_SUPPLY_WHOLE;
  // classic ≈ 9.9 WETH, degen ≈ 1.3 WETH
  const pricePerTokenInPaired = fdvWeth / pairedPriceWeth / s;      // human units
  const raw = pricePerTokenInPaired * Math.pow(10, pairedDecimals - 18); // raw token1-per-token0
  const spacing = TICK_SPACING; // 200
  let tick = Math.round(Math.log(raw) / Math.log(1.0001) / spacing) * spacing;
  if (tick > 887000) tick = 887000;
  if (tick < -887200) tick = -887200;
  return tick;
}

/** Implied launch FDV (in WETH) at a given tick — the preview + clamp-guard companion
 *  to {startingTickForPairedLaunch}. */
export function impliedFdvWethAtTick(
  tick: number,
  supplyWhole: number,
  pairedPriceWeth: number,
  pairedDecimals: number,
): number {
  const raw = Math.pow(1.0001, tick);
  const pricePerTokenInPaired = raw * Math.pow(10, 18 - pairedDecimals);
  return pricePerTokenInPaired * pairedPriceWeth * supplyWhole;
}

/**
 * Compute the paired-launch starting tick AND enforce the [0.5, 2] implied-FDV guard:
 * tick-range clamping (extreme paired prices/decimals) can silently over- OR under-shoot
 * the preset's FDV target — outside the window the launch throws instead of deploying a
 * broken pool. (Checking |ratio − 1| does NOT work: undershoot caps at 1.)
 * Shared by the ERC-20 + B20 launch builders.
 */
export function guardedPairedStartingTick(
  preset: Cc0LpPreset,
  supplyWhole: number,
  paired: PairedTokenOption,
): number {
  const tick = startingTickForPairedLaunch({
    preset,
    supplyWhole,
    pairedPriceWeth: paired.priceWeth,
    pairedDecimals: paired.decimals,
  });
  const s = Number.isFinite(supplyWhole) && supplyWhole > 0 ? supplyWhole : DEFAULT_SUPPLY_WHOLE;
  const targetFdvWeth = Math.pow(1.0001, LP_PRESETS[preset].startingTick) * DEFAULT_SUPPLY_WHOLE;
  const ratio = impliedFdvWethAtTick(tick, s, paired.priceWeth, paired.decimals) / targetFdvWeth;
  if (!(ratio >= 0.5 && ratio <= 2)) {
    throw new Error(
      `Paired launch blocked: at the computed starting tick the implied FDV lands ${
        ratio < 0.5 ? 'below half' : 'more than double'
      } the '${preset}' preset target — the paired token's price/decimals push the pool ` +
        'outside the supported tick range. Check pairedToken.priceWeth (price of ONE whole ' +
        'paired token in WETH), or pick a different pair.',
    );
  }
  return tick;
}

// Locker FeeIn enum: Both=0, Paired=1, Clanker(token)=2.
const FEE_IN = { both: 0, paired: 1, token: 2 } as const;

/** How a creator slice takes its fees: WETH + token, WETH only, or token only. */
export type CreatorFeePreference = keyof typeof FEE_IN;

// Clanker "Dynamic 3%" preset (1% base → 3% max, volatility-driven), 1e6 fee units.
const DYNAMIC_3_CONFIG = {
  baseFee: 10_000,
  maxLpFee: 30_000,
  referenceTickFilterPeriod: BigInt(30),
  resetPeriod: BigInt(120),
  resetTickFilter: 200,
  feeControlNumerator: BigInt(250_000_000),
  decayFilterBps: 7500,
} as const;

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Paired-launch input: the ERC-20 to pair the pool with instead of WETH.
 * symbol/decimals are always read on-chain from the address; the WETH price
 * resolves live from the cc0.company price API unless `priceWeth` is passed.
 */
export interface PairedTokenParam {
  address: Address;
  /**
   * Price of ONE whole paired token in WETH. Explicit value wins; when omitted the
   * SDK resolves it from the cc0.company price API (paired USD ÷ ETH/USD). The launch
   * THROWS when neither resolves — fail-closed, never a default.
   */
  priceWeth?: number;
}

/** A fully-resolved paired token (symbol/decimals from the chain, price live). */
export interface PairedTokenOption {
  address: Address;
  symbol: string;
  decimals: number;
  /** Live price of ONE whole paired token in WETH. Resolver: form/server/SDK. Fail-closed. */
  priceWeth: number;
}

export interface CreatorRewardSlice {
  /** Wallet receiving this share of the creator fees. */
  recipient: Address;
  /** Share in basis points of TOTAL fees. All creator slices must sum to 7500. */
  bps: number;
  /** Fee denomination for this slice. Default 'both' (WETH + the launched token). */
  feePreference?: CreatorFeePreference;
}

/**
 * The token image. The URI is written ON-CHAIN FOREVER at launch, so the SDK
 * guarantees permanence: anything that isn't already `ipfs://` is pinned to
 * IPFS through cc0.company before launching. Accepts:
 *   • an `ipfs://` URI               → used as-is
 *   • an `https://` URL              → mirrored to IPFS server-side
 *   • a `data:` URL, Blob/File, or Uint8Array → uploaded + pinned
 */
export type LaunchImage = string | Uint8Array | Blob;

export interface LaunchTokenParams {
  name: string;
  symbol: string;
  /** Token image — pinned to IPFS automatically unless already `ipfs://`. */
  image: LaunchImage;
  /**
   * 'pin' (default): guarantee permanence — non-ipfs images are pinned to IPFS
   * via cc0.company before launch (the launch FAILS if pinning fails, rather
   * than writing a rottable URL on-chain). 'as-is': trust the provided URL.
   */
  imagePolicy?: 'pin' | 'as-is';
  /** Description + socials are stored on-chain in the token metadata. */
  description?: string;
  socials?: string[];
  /** 'static' (1/2/3% tier) or 'dynamic' (1%→3% volatility preset). Default 'static'. */
  feeMode?: 'static' | 'dynamic';
  /** Static LP fee tier in percent: 1, 2, 3, or 6.9. Default 1. Ignored when feeMode === 'dynamic'. */
  feeTier?: 1 | 2 | 3 | 6.9;
  /**
   * How to split the creator's 75%. Defaults to a single slice to the deployer.
   * Up to 5 slices; bps must sum to exactly 7500. Overridden by `nftCollection` (Option B).
   */
  creatorRewards?: CreatorRewardSlice[];
  /**
   * Option B — route the FULL 75% creator slice to the holders of this NFT collection. The SDK
   * deploys a per-token Cc0NftFeeDistributor (an extra tx via your signer) and wires it as the sole
   * creator recipient with feePreference 'both' (holders earn WETH + the launched token); the slice
   * is frozen to the distributor. Overrides `creatorRewards`. Requires a walletClient/account or
   * sender — the manual prepareLaunchTransaction() path can't auto-deploy, so there deploy via
   * deployNftDistributor() yourself and pass the address as a creatorRewards recipient.
   */
  nftCollection?: {
    /** ERC-721 collection on Base (sequential ids; exposes totalSupply()). */
    address: Address;
    /** Highest existing tokenId at launch — the eligibility ceiling (excludes post-launch mints). */
    maxEligibleTokenId: bigint | number;
  };
  /** Optional sniper tax (descending fee). Without it, a 2-block MEV delay applies. */
  sniperTax?: { startingBps: number; endingBps: number; secondsToDecay: number };
  /** Optional creator supply vault (% of supply, lockup ≥ 7 days, optional vesting). */
  vault?: { percentage: number; lockupSeconds: number; vestingSeconds: number };
  /** Optional merkle airdrop (% of supply, lockup ≥ 1 day). */
  airdrop?: {
    merkleRoot: Hex;
    percentage: number;
    lockupSeconds?: number;
    vestingSeconds?: number;
  };
  /** Optional dev buy: ETH spent buying the token at launch (e.g. "0.05"). */
  devBuyEth?: string;
  /**
   * Liquidity profile — 'classic' (default, ~$36k starting FDV, deep) or 'degen'
   * (~$5k starting FDV, thin: the price needs ~7× less volume to move). See LP_PRESETS.
   */
  lpPreset?: Cc0LpPreset;
  /**
   * PAIRED LAUNCH — pair the pool with this ERC-20 instead of WETH. The fee split
   * becomes 80% you / 20% treasury (no staker slice — staking rewards are WETH-only)
   * and both slices take fees in BOTH pool tokens. symbol/decimals are read on-chain;
   * the WETH price resolves from the cc0.company price API unless `priceWeth` is set
   * (fail-closed: no price, no launch). Paired launches deploy through a SEPARATE
   * dual-mode suite (CC0_PAIRED_CONTRACTS) — check `isCc0PairedAvailable(chain)`;
   * while a chain's paired suite is unfilled the launch throws (Base pending its
   * broadcast). Dev buy + creatorRewards + nftCollection are not available for
   * paired launches yet. undefined ⇒ standard WETH launch (unchanged 75/15/10 path
   * on the existing suite).
   */
  pairedToken?: PairedTokenParam;
  /** Custom salt; random if omitted. */
  salt?: Hex;
  /**
   * Every launch is registered on cc0.company automatically (token page, chart,
   * swap, fee-claim button, search). Set to false to skip — the token still works
   * fully on-chain, it just won't appear on the platform.
   */
  register?: boolean;
}

export interface LaunchTokenResult {
  tokenAddress: Address;
  txHash: Hash;
  /** Whether the launch was registered on cc0.company (token page, chart, swap,
   *  claim button). Launches are registered automatically; `false` means the
   *  registry was unreachable — the token is still fully live on-chain. */
  registered: boolean;
}

/**
 * An unsigned transaction ready for ANY signer. `json` is the BigInt-free mirror
 * (hex-encoded value/gas) for transports that JSON-serialize (CDP sendTransaction,
 * HTTP relayers, Bankr) — pass it straight through, no serialization gymnastics.
 */
export interface PreparedTransaction {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  /** Estimated gas limit with a 20% buffer (deployToken is heavy: ~10-15M). */
  gas: bigint;
  /** Current EIP-1559 fees from the chain (some transports — CDP — require them). */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** JSON-safe (BigInt-free, hex) mirror of the whole transaction. */
  json: {
    to: Address;
    data: Hex;
    value: Hex;
    chainId: number;
    gas: Hex;
    maxFeePerGas?: Hex;
    maxPriorityFeePerGas?: Hex;
  };
}

/** A prepared launch — also carries the resolved on-chain image URI. */
export interface PreparedLaunchTransaction extends PreparedTransaction {
  /** The ipfs:// URI that was written into the token config (already pinned). */
  imageUri: string;
  /** Paired launches only: the fully-resolved paired token (symbol/decimals/price) —
   *  pass it to registerLaunch so the token page records the pairing. */
  pairedToken?: PairedTokenOption;
}

/**
 * Wallet-provider-agnostic signer: anything that can take an unsigned tx and
 * return its hash — Coinbase CDP `sendTransaction`, Bankr submit, a Safe, a raw
 * JSON-RPC relayer. With a `sender`, EVERY SDK method works without viem wallet
 * plumbing: the SDK prepares, your infra signs + submits, the SDK finishes.
 */
export interface ExternalSender {
  /** The address your infra signs with (= creator / fee payer). */
  address: Address;
  /** Submit the transaction, return its hash. Use `tx.json` for JSON transports. */
  send: (tx: PreparedTransaction) => Promise<Hash>;
  /**
   * OPTIONAL: sign an EIP-191 personal message and return the signature.
   * Enables the agent-auth'd HTTP routes (art pinning, drop records) for
   * signer-only integrations — Bankr smart wallets validate via EIP-1271,
   * so the returned signature does not need to be an EOA recover match.
   * Without it, Cc0Drops falls back to `agentApiKey` (legacy) for those
   * routes; all purely on-chain methods work regardless.
   */
  signMessage?: (message: string) => Promise<Hex>;
}

export interface Cc0ClientConfig {
  /**
   * Chain to operate on: 'base' (default) | 'ethereum' | 'robinhood' — or the
   * chain id (8453 | 1 | 4663). Drives the contract addresses, the default
   * clients' network, the tx `chainId`, and the registry record. Your
   * walletClient/publicClient (if provided) must be on the SAME chain.
   */
  chain?: Cc0Chain;
  /** Viem WalletClient with an account (wagmi compatible), on the configured chain. */
  walletClient?: WalletClient;
  /**
   * Alternative to `walletClient`: any viem Account — a WalletClient on the
   * configured chain is built internally. Works with `privateKeyToAccount(...)`
   * and any provider that exposes a viem-compatible account.
   */
  account?: Account;
  /**
   * Alternative to both: a wallet-provider-agnostic sender (Coinbase CDP, Bankr,
   * Safe, any relayer). The SDK builds + estimates the tx, your `send` submits
   * it, the SDK waits/parses/registers. See ExternalSender.
   */
  sender?: ExternalSender;
  /** Optional viem PublicClient; a default client on the configured chain is created if omitted. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient?: any;
  /** cc0.company base URL for the launch registry. Override for self-hosted setups. */
  registryUrl?: string;
}

// ─── ABIs (minimal fragments) ────────────────────────────────────────────────

const FACTORY_PROTOCOL_ABI = [
  { type: 'function', name: 'cc0Staking', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'cc0Treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'cc0Admin', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export const FACTORY_ABI = [
  {
    type: 'function',
    name: 'deployToken',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'deploymentConfig',
        type: 'tuple',
        components: [
          {
            name: 'tokenConfig',
            type: 'tuple',
            components: [
              { name: 'tokenAdmin', type: 'address' },
              { name: 'name', type: 'string' },
              { name: 'symbol', type: 'string' },
              { name: 'salt', type: 'bytes32' },
              { name: 'image', type: 'string' },
              { name: 'metadata', type: 'string' },
              { name: 'context', type: 'string' },
              { name: 'originatingChainId', type: 'uint256' },
            ],
          },
          {
            name: 'poolConfig',
            type: 'tuple',
            components: [
              { name: 'hook', type: 'address' },
              { name: 'pairedToken', type: 'address' },
              { name: 'tickIfToken0IsClanker', type: 'int24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'poolData', type: 'bytes' },
            ],
          },
          {
            name: 'lockerConfig',
            type: 'tuple',
            components: [
              { name: 'locker', type: 'address' },
              { name: 'rewardAdmins', type: 'address[]' },
              { name: 'rewardRecipients', type: 'address[]' },
              { name: 'rewardBps', type: 'uint16[]' },
              { name: 'tickLower', type: 'int24[]' },
              { name: 'tickUpper', type: 'int24[]' },
              { name: 'positionBps', type: 'uint16[]' },
              { name: 'lockerData', type: 'bytes' },
            ],
          },
          {
            name: 'mevModuleConfig',
            type: 'tuple',
            components: [
              { name: 'mevModule', type: 'address' },
              { name: 'mevModuleData', type: 'bytes' },
            ],
          },
          {
            name: 'extensionConfigs',
            type: 'tuple[]',
            components: [
              { name: 'extension', type: 'address' },
              { name: 'msgValue', type: 'uint256' },
              { name: 'extensionBps', type: 'uint16' },
              { name: 'extensionData', type: 'bytes' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: 'tokenAddress', type: 'address' }],
  },
  {
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { name: 'msgSender', type: 'address', indexed: false },
      { name: 'tokenAddress', type: 'address', indexed: true },
      { name: 'tokenAdmin', type: 'address', indexed: true },
      { name: 'tokenImage', type: 'string', indexed: false },
      { name: 'tokenName', type: 'string', indexed: false },
      { name: 'tokenSymbol', type: 'string', indexed: false },
      { name: 'tokenMetadata', type: 'string', indexed: false },
      { name: 'tokenContext', type: 'string', indexed: false },
      { name: 'startingTick', type: 'int24', indexed: false },
      { name: 'poolHook', type: 'address', indexed: false },
      { name: 'poolId', type: 'bytes32', indexed: false },
      { name: 'pairedToken', type: 'address', indexed: false },
      { name: 'locker', type: 'address', indexed: false },
      { name: 'mevModule', type: 'address', indexed: false },
      { name: 'extensionsSupply', type: 'uint256', indexed: false },
      { name: 'extensions', type: 'address[]', indexed: false },
    ],
  },
] as const;

/** NFT fee-distributor factory (Option B): deploy a per-token distributor, read its address. */
export const NFT_FACTORY_ABI = [
  {
    type: 'function',
    name: 'createDistributor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collection', type: 'address' },
      { name: 'maxEligibleTokenId', type: 'uint256' },
    ],
    outputs: [{ name: 'distributor', type: 'address' }],
  },
  {
    type: 'event',
    name: 'DistributorCreated',
    inputs: [
      { name: 'collection', type: 'address', indexed: true },
      { name: 'distributor', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'maxEligibleTokenId', type: 'uint256', indexed: false },
      { name: 'supply', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ─── Launchpad ───────────────────────────────────────────────────────────────

/**
 * Deploy tokens through the cc0.company launchpad with the enforced 75/15/10 split.
 *
 * ```ts
 * import { Cc0Launchpad } from '@cc0company/sdk';
 *
 * const launchpad = new Cc0Launchpad({ walletClient });
 * const { tokenAddress, txHash } = await launchpad.launchToken({
 *   name: 'My Token',
 *   symbol: 'MTK',
 *   image: 'ipfs://...',
 *   feeTier: 1,
 * });
 * ```
 */
export class Cc0Launchpad {
  public readonly walletClient?: WalletClient;
  public readonly sender?: ExternalSender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  /** Canonical chain slug ('base' | 'ethereum' | 'robinhood') this instance targets. */
  public readonly chainSlug: Cc0ChainSlug;
  /** Numeric chain id (8453 | 1 | 4663). */
  public readonly chainId: number;
  /** viem Chain object for the configured chain (used on every signed tx). */
  public readonly chain: (typeof VIEM_CHAINS)[Cc0ChainSlug];
  public readonly contracts: (typeof CC0_CONTRACTS)[Cc0ChainSlug];
  public readonly registryUrl: string;

  constructor(config: Cc0ClientConfig = {}) {
    // Per-chain wiring: 'base' (default) | 'ethereum' | 'robinhood'. Same factory
    // semantics + enforced split on all three; only addresses/network differ.
    this.chainSlug = toChainSlug(config.chain);
    this.chainId = CHAIN_IDS[this.chainSlug];
    this.chain = VIEM_CHAINS[this.chainSlug];
    this.contracts = CC0_CONTRACTS[this.chainSlug];

    // Accept a ready WalletClient, any viem Account (a WalletClient on the configured
    // chain is built internally), or a provider-agnostic ExternalSender (CDP, Bankr, Safe, …).
    // Explicit RPC URLs: viem's default Ethereum RPC is CORS-blocked in browsers.
    this.walletClient =
      config.walletClient ??
      (config.account
        ? createWalletClient({
            account: config.account,
            chain: this.chain,
            transport: http(DEFAULT_RPCS[this.chainSlug]),
          })
        : undefined);
    this.sender = config.sender;
    this.publicClient =
      config.publicClient ??
      createPublicClient({ chain: this.chain, transport: http(DEFAULT_RPCS[this.chainSlug]) });
    this.registryUrl = (config.registryUrl ?? 'https://cc0.company').replace(/\/$/, '');
  }

  /**
   * Read the enforced protocol slice addresses live from the factory (the contract
   * that validates the split on every deployToken). Fails closed: if the factory
   * doesn't expose them, launching would revert anyway. Paired launches pass the
   * PAIRED suite's factory via `factoryOverride` — its enforced recipients are the
   * ones the 80/20 config must name; omitted ⇒ the standard factory, unchanged.
   */
  async getProtocolAddresses(factoryOverride?: Address): Promise<{
    staking: Address;
    treasury: Address;
    admin: Address;
  }> {
    try {
      const factory = factoryOverride ?? this.contracts.FACTORY;
      const [staking, treasury, admin] = await Promise.all([
        this.publicClient.readContract({ address: factory, abi: FACTORY_PROTOCOL_ABI, functionName: 'cc0Staking' }),
        this.publicClient.readContract({ address: factory, abi: FACTORY_PROTOCOL_ABI, functionName: 'cc0Treasury' }),
        this.publicClient.readContract({ address: factory, abi: FACTORY_PROTOCOL_ABI, functionName: 'cc0Admin' }),
      ]);
      return { staking, treasury, admin };
    } catch {
      throw new Error(
        'Could not read the enforced protocol addresses from the cc0.company factory — refusing to build a launch config that would revert.',
      );
    }
  }

  /**
   * Pin an image to IPFS through cc0.company (Pinata-backed). Used automatically
   * by launchToken / prepareLaunchTransaction; call it directly if you want the
   * `ipfs://` URI up front.
   */
  async pinImage(input: LaunchImage): Promise<{ cid: string; ipfsUri: string; gatewayUrl: string }> {
    const endpoint = `${this.registryUrl}/api/store/launchpad/pin-image`;
    let res: Response;

    if (typeof input === 'string' && !input.startsWith('data:')) {
      // Remote URL — mirrored to IPFS server-side.
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input }),
      });
    } else {
      // Raw bytes (Uint8Array / Blob / data: URL) — multipart upload.
      let blob: Blob;
      if (typeof input === 'string') {
        blob = await (await fetch(input)).blob(); // data: URL
      } else if (input instanceof Uint8Array) {
        blob = new Blob([input as BlobPart], { type: sniffImageMime(input) });
      } else {
        blob = input.type ? input : new Blob([input], { type: sniffImageMime(new Uint8Array(await input.arrayBuffer())) });
      }
      const form = new FormData();
      form.append('file', blob, 'token-image');
      res = await fetch(endpoint, { method: 'POST', body: form });
    }

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success || !json?.ipfs_uri) {
      throw new Error(
        `Image pinning failed${json?.error ? `: ${json.error}` : ''} — the image URI is written on-chain forever, so the launch refuses a non-permanent URL. Pass an ipfs:// URI, or set imagePolicy: 'as-is' to bypass.`,
      );
    }
    return { cid: json.cid, ipfsUri: json.ipfs_uri, gatewayUrl: json.gateway_url };
  }

  /** Resolve any LaunchImage into the URI to write on-chain, honouring imagePolicy. */
  private async resolveImage(image: LaunchImage, policy: 'pin' | 'as-is'): Promise<string> {
    if (typeof image === 'string' && image.startsWith('ipfs://')) return image;
    if (policy === 'as-is') {
      if (typeof image !== 'string') {
        throw new Error("imagePolicy 'as-is' requires the image to be a URL string.");
      }
      return image;
    }
    return (await this.pinImage(image)).ipfsUri;
  }

  /**
   * Launch end-to-end with whatever you configured:
   *   • walletClient / account → signs + submits via viem
   *   • sender (CDP, Bankr, Safe, relayer) → SDK prepares, your infra submits,
   *     SDK waits / parses / registers
   * Either way: image pinned to IPFS, gas handled, token page live on cc0.company.
   */
  async launchToken(p: LaunchTokenParams): Promise<LaunchTokenResult> {
    // Paired launches route the FULL 80% to one wallet — the distributor split doesn't
    // apply. Checked BEFORE the distributor deploy so no transaction is wasted.
    if (p.nftCollection && p.pairedToken) {
      throw new Error('NFT-collection fee routing is not available for paired launches yet.');
    }
    // Option B — deploy a per-token NFT fee distributor (extra tx via the configured signer) and
    // route the FULL 75% to it as the sole creator slice (feePreference 'both' → holders earn WETH
    // + the launched token; admin = the distributor → the slice is frozen, trustless).
    let effective = p;
    let nftDistributor: Address | undefined;
    if (p.nftCollection) {
      nftDistributor = await this.deployNftDistributor(
        p.nftCollection.address,
        p.nftCollection.maxEligibleTokenId,
      );
      effective = {
        ...p,
        creatorRewards: [
          { recipient: nftDistributor, bps: PROTOCOL_SPLIT.CREATOR_BPS, feePreference: 'both' },
        ],
      };
    }
    const nftCollectionAddr = p.nftCollection?.address;

    // ── Path 1: viem wallet ───────────────────────────────────────────────────
    if (this.walletClient) {
      const account = this.walletClient.account;
      if (!account) throw new Error('walletClient has no account attached.');
      const creator = account.address as Address;

      const { config, totalMsgValue, imageUri, paired, factory } =
        await this.buildDeploymentConfig(effective, creator);

      const txHash = await this.walletClient.writeContract({
        account,
        // The PAIRED suite's factory for paired launches; the standard one otherwise.
        address: factory,
        abi: FACTORY_ABI,
        functionName: 'deployToken',
        args: [config as never],
        chain: this.chain,
        value: totalMsgValue,
      });

      return this.finishLaunch({
        txHash,
        params: p,
        creator,
        imageUri,
        paired,
        nftDistributor,
        nftCollection: nftCollectionAddr,
      });
    }

    // ── Path 2: external sender (CDP, Bankr, Safe, any relayer) ───────────────
    if (this.sender) {
      const creator = this.sender.address;
      const prepared = await this.prepareLaunchTransaction(effective, { creator });
      const txHash = await this.sender.send(prepared);
      // Fail fast on a bad hash instead of waiting forever for a receipt that
      // will never arrive (e.g. reading `.hash` when CDP returns `.transactionHash`).
      assertTxHash(txHash, 'Your sender.send()');
      return this.finishLaunch({
        txHash,
        params: p,
        creator,
        imageUri: prepared.imageUri,
        paired: prepared.pairedToken,
        nftDistributor,
        nftCollection: nftCollectionAddr,
      });
    }

    throw new Error(
      'No signer configured. Pass walletClient, account, or sender to the constructor — or use prepareLaunchTransaction() for fully manual flows.',
    );
  }

  /**
   * Deploy a per-token {Cc0NftFeeDistributor} for `collection` via the factory and return its
   * address (parsed from the DistributorCreated event). Works through walletClient/account or a
   * sender. `launchToken({ nftCollection })` calls this for you; call it directly for the manual
   * prepareLaunchTransaction flow, then pass the returned address as a creatorRewards recipient.
   */
  async deployNftDistributor(
    collection: Address,
    maxEligibleTokenId: bigint | number,
  ): Promise<Address> {
    const to = this.contracts.NFT_FEE_FACTORY;
    const args = [collection, BigInt(maxEligibleTokenId)] as const;
    let txHash: Hash;

    if (this.walletClient) {
      const account = this.walletClient.account;
      if (!account) throw new Error('walletClient has no account attached.');
      txHash = await this.walletClient.writeContract({
        account,
        address: to,
        abi: NFT_FACTORY_ABI,
        functionName: 'createDistributor',
        args: args as never,
        chain: this.chain,
      });
    } else if (this.sender) {
      const data = encodeFunctionData({
        abi: NFT_FACTORY_ABI,
        functionName: 'createDistributor',
        args: args as never,
      });
      let gas = BigInt(2_500_000);
      try {
        const est = (await this.publicClient.estimateGas({
          account: this.sender.address,
          to,
          data,
        })) as bigint;
        gas = (est * BigInt(120)) / BigInt(100);
      } catch {
        /* keep the fallback ceiling */
      }
      const fees = await estimateEip1559Fees(this.publicClient);
      txHash = await this.sender.send(toPreparedTx(to, data, BigInt(0), gas, fees, this.chainId));
      assertTxHash(txHash, 'Your sender.send()');
    } else {
      throw new Error(
        'No signer configured to deploy the NFT fee distributor — pass walletClient, account, or sender.',
      );
    }

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 180_000,
    });
    const logs = parseEventLogs({
      abi: NFT_FACTORY_ABI,
      eventName: 'DistributorCreated',
      logs: receipt.logs,
    });
    const distributor = (logs[0] as unknown as { args?: { distributor?: Address } })?.args
      ?.distributor;
    if (!distributor) {
      throw new Error('Distributor deploy confirmed but DistributorCreated event was not found.');
    }
    return distributor;
  }

  /**
   * Finish a launch whose transaction was submitted externally: waits for the
   * receipt, extracts the token address, registers it on cc0.company. The
   * `sender` path of launchToken calls this for you.
   */
  async finishLaunch(args: {
    txHash: Hash;
    params: Pick<
      LaunchTokenParams,
      'name' | 'symbol' | 'description' | 'airdrop' | 'register' | 'lpPreset'
    >;
    creator: Address;
    /** The resolved ipfs:// URI (from PreparedLaunchTransaction.imageUri). */
    imageUri?: string;
    /** Paired launches: the resolved paired token (from PreparedLaunchTransaction.pairedToken). */
    paired?: PairedTokenOption;
    /** Option B: the deployed per-token NFT fee distributor + its linked collection, recorded so
     *  the token page / NFT-detail / /rewards surfaces can find it. */
    nftDistributor?: Address;
    nftCollection?: Address;
  }): Promise<LaunchTokenResult> {
    assertTxHash(args.txHash, 'finishLaunch');
    // Bounded wait — surface a clear error instead of hanging forever on a
    // dropped/never-mined transaction.
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: args.txHash,
      timeout: 180_000,
    });
    const tokenAddress = parseLaunchReceipt(receipt);
    if (!tokenAddress) throw new Error('Transaction confirmed but TokenCreated event was not found.');

    // Auto-register on cc0.company — token page (chart, swap, fee-claim button)
    // + browse/search. Best-effort: a registry hiccup never fails the launch.
    let registered = false;
    if (args.params.register !== false) {
      registered = await this.registerLaunch({
        tokenAddress,
        txHash: args.txHash,
        name: args.params.name,
        symbol: args.params.symbol,
        description: args.params.description,
        image: args.imageUri,
        creator: args.creator,
        hasAirdrop: !!args.params.airdrop,
        lpPreset: args.params.lpPreset,
        paired: args.paired,
        nftFeeDistributor: args.nftDistributor,
        nftFeeCollection: args.nftCollection,
      });
    }

    return { tokenAddress, txHash: args.txHash, registered };
  }

  /**
   * Build the launch as an UNSIGNED transaction — for wallet infra that signs and
   * submits itself (Bankr's submit endpoint, CDP raw sends, Safes, …). No wallet
   * needed on this client; pass the `creator` who will send it (token admin +
   * default fee recipient).
   *
   * After the transaction lands, finish the job with:
   *   • `parseLaunchReceipt(receipt)` → the new token address
   *   • `registerLaunch({...})`       → its page on cc0.company
   */
  async prepareLaunchTransaction(
    p: LaunchTokenParams,
    opts: { creator: Address },
  ): Promise<PreparedLaunchTransaction> {
    const { config, totalMsgValue, imageUri, paired, factory } =
      await this.buildDeploymentConfig(p, opts.creator);
    // The PAIRED suite's factory for paired launches; the standard one otherwise.
    const to = factory;
    const data = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'deployToken',
      args: [config as never],
    });

    // Estimate gas from the creator with a 20% buffer. deployToken is HEAVY
    // (token + pool + locked LP + extensions ≈ 4-15M gas) — guessing low makes
    // the tx revert, guessing blind wastes integrators' time. Falls back to a
    // safe ceiling when the node refuses to estimate (e.g. unfunded creator).
    let gas = BigInt(16_000_000);
    try {
      const estimated = (await this.publicClient.estimateGas({
        account: opts.creator,
        to,
        data,
        value: totalMsgValue,
      })) as bigint;
      gas = (estimated * BigInt(120)) / BigInt(100);
    } catch {
      /* keep the fallback ceiling */
    }

    // EIP-1559 fees from the chain — transports like CDP reject an unsigned tx
    // without them ("Malformed unsigned EIP-1559 transaction").
    const fees = await estimateEip1559Fees(this.publicClient);

    return {
      ...toPreparedTx(to, data, totalMsgValue, gas, fees, this.chainId),
      imageUri,
      pairedToken: paired,
    };
  }

  /**
   * Register a launch on cc0.company — token page (chart, swap, fee claim) +
   * browse/search. `launchToken()` calls this automatically; use it directly for
   * prepareLaunchTransaction flows. Returns true on success.
   */
  async registerLaunch(params: {
    tokenAddress: Address;
    txHash: Hash;
    name: string;
    symbol: string;
    description?: string;
    image?: string;
    creator: Address;
    hasAirdrop?: boolean;
    /** Liquidity profile the launch used — recorded for the token page badge. */
    lpPreset?: Cc0LpPreset;
    /** Paired launch: the resolved paired token — recorded so the token page shows the
     *  "Paired with $SYM" badge, the 80/20 split, and the paired claim assets. */
    paired?: { address: Address; symbol: string; decimals: number };
    /** Option B: the per-token NFT fee distributor + the collection whose holders earn. */
    nftFeeDistributor?: Address;
    nftFeeCollection?: Address;
  }): Promise<boolean> {
    try {
      const res = await fetch(`${this.registryUrl}/api/store/token-launches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token_address: params.tokenAddress,
          chain: this.chainSlug,
          tx_hash: params.txHash,
          protocol: 'cc0strategy',
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
          ...(params.nftFeeDistributor && params.nftFeeCollection
            ? {
                nft_fee_distributor: params.nftFeeDistributor,
                nft_fee_collection: params.nftFeeCollection,
                nft_fee_collection_chain: this.chainSlug,
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

  // ── Deployment-config assembly (shared by launchToken + prepare) ────────────

  private async buildDeploymentConfig(
    p: LaunchTokenParams,
    creator: Address,
  ): Promise<{
    config: Record<string, unknown>;
    totalMsgValue: bigint;
    imageUri: string;
    paired?: PairedTokenOption;
    /** The factory deployToken targets — the PAIRED suite's for paired launches. */
    factory: Address;
  }> {
    const c = this.contracts;

    // Liquidity profile → starting tick (⇒ starting FDV ⇒ depth). Fail on unknown
    // names instead of silently launching a 'classic' the caller didn't ask for.
    const lpPreset = p.lpPreset ?? 'classic';
    if (!LP_PRESETS[lpPreset]) {
      throw new Error(
        `Unknown lpPreset "${lpPreset}" — use one of: ${Object.keys(LP_PRESETS).join(', ')}.`,
      );
    }

    // ── Paired launch (custom pair) — validate + resolve BEFORE any side effect ──
    // Pairing swaps the pool's quote asset from WETH to an arbitrary ERC-20: the fee
    // split becomes the two-slice 80/20 (creator/treasury, no staking — staking rewards
    // are WETH-only) and BOTH slices take fees in BOTH pool tokens. Paired launches
    // bind to the SEPARATE dual-mode PAIRED suite (CC0_PAIRED_CONTRACTS) — never the
    // standard book — and fail closed while that suite is unfilled on the chain.
    let paired: PairedTokenOption | undefined;
    const pairedBook = p.pairedToken ? getCc0PairedContracts(this.chainSlug) : null;
    if (p.pairedToken) {
      if (!pairedBook) {
        throw new Error('Paired launches are not available on this chain yet.');
      }
      if (p.devBuyEth && Number(p.devBuyEth) > 0) {
        throw new Error('Dev buy is not available for paired launches yet.');
      }
      if (p.creatorRewards && p.creatorRewards.length > 0) {
        throw new Error(
          'creatorRewards splits are not available for paired launches yet — the full 80% creator slice goes to the deployer.',
        );
      }
      paired = await resolvePairedToken(p.pairedToken, {
        publicClient: this.publicClient,
        registryUrl: this.registryUrl,
        weth: c.WETH,
      });
    }

    // The suite this launch binds to: the WHOLE config (factory target, hooks, locker,
    // MEV modules, extensions) comes from the PAIRED book for paired launches; standard
    // WETH launches keep the existing book — untouched.
    const suite = pairedBook
      ? {
          FACTORY: pairedBook.FACTORY as Address,
          HOOK_STATIC_FEE: pairedBook.HOOK_STATIC_FEE as Address,
          HOOK_DYNAMIC_FEE: pairedBook.HOOK_DYNAMIC_FEE as Address,
          LOCKER: pairedBook.LOCKER as Address,
          MEV_BLOCK_DELAY: pairedBook.MEV_BLOCK_DELAY as Address,
          MEV_SNIPER_TAX: pairedBook.MEV_SNIPER_TAX as Address,
          VAULT: pairedBook.VAULT as Address,
          AIRDROP_V2: pairedBook.AIRDROP_V2 as Address,
          DEV_BUY_V4: pairedBook.DEV_BUY_V4 as Address,
        }
      : {
          FACTORY: c.FACTORY,
          HOOK_STATIC_FEE: c.HOOK_STATIC_FEE,
          HOOK_DYNAMIC_FEE: c.HOOK_DYNAMIC_FEE,
          LOCKER: c.LOCKER,
          MEV_BLOCK_DELAY: c.MEV_BLOCK_DELAY,
          MEV_SNIPER_TAX: c.MEV_SNIPER_TAX,
          VAULT: c.VAULT,
          AIRDROP_V2: c.AIRDROP_V2,
          DEV_BUY_V4: c.DEV_BUY_V4,
        };

    // Paired pools are priced in the PAIRED token, so the preset tick (a WETH price)
    // is recomputed from the live paired price; the [0.5, 2] implied-FDV guard throws
    // when tick clamping would deploy a broken pool.
    const startingTick = paired
      ? guardedPairedStartingTick(lpPreset, DEFAULT_SUPPLY_WHOLE, paired)
      : LP_PRESETS[lpPreset].startingTick;

    // Pin the image FIRST — its URI goes on-chain forever, so permanence is
    // guaranteed before any transaction is built (fail-closed by default).
    const imageUri = await this.resolveImage(p.image, p.imagePolicy ?? 'pin');

    // ── Creator slices (their 75%, splittable) ────────────────────────────────
    // Paired launches skip the 7500-sum validation: the split is the pinned
    // two-slice 80/20 and creatorSlices collapses to the single default slice
    // (still referenced below as the vault/airdrop/dev-buy admin).
    const creatorSlices: CreatorRewardSlice[] =
      p.creatorRewards && p.creatorRewards.length > 0
        ? p.creatorRewards
        : [{ recipient: creator, bps: PROTOCOL_SPLIT.CREATOR_BPS, feePreference: 'both' }];
    if (!paired) {
      if (creatorSlices.length > 5) {
        throw new Error('At most 5 creator reward slices (7 total with the protocol slices).');
      }
      const creatorTotal = creatorSlices.reduce((s, r) => s + r.bps, 0);
      if (creatorTotal !== PROTOCOL_SPLIT.CREATOR_BPS) {
        throw new Error(
          `creatorRewards bps must sum to exactly ${PROTOCOL_SPLIT.CREATOR_BPS} (got ${creatorTotal}).`,
        );
      }
    }

    // ── Enforced protocol slices, read live from the factory ──────────────────
    // Paired launches read them from the PAIRED factory — the dual-mode contract that
    // actually validates the 80/20 config (its recipients can differ from the standard
    // suite's, e.g. the self-contained Sepolia test economics).
    const protocol = await this.getProtocolAddresses(pairedBook ? suite.FACTORY : undefined);

    const rewardRecipients = paired
      ? [creator, protocol.treasury]
      : [...creatorSlices.map((s) => s.recipient), protocol.staking, protocol.treasury];
    const rewardAdmins = paired
      ? [creator, protocol.admin]
      : [
          ...creatorSlices.map((s) => s.recipient), // each creator slice administers itself
          protocol.admin,
          protocol.admin,
        ];
    const rewardBps = paired
      ? [PAIRED_SPLIT.CREATOR_BPS, PAIRED_SPLIT.TREASURY_BPS]
      : [...creatorSlices.map((s) => s.bps), PROTOCOL_SPLIT.STAKING_BPS, PROTOCOL_SPLIT.TREASURY_BPS];
    const feePreference = paired
      ? [FEE_IN.both, FEE_IN.both] // neither pool token is assumed WETH-liquid — fees in BOTH
      : [
          ...creatorSlices.map((s) => FEE_IN[s.feePreference ?? 'both']),
          FEE_IN.paired, // staking — WETH only, enforced
          FEE_IN.paired, // treasury — WETH only, enforced
        ];

    // ── Fee hook + feeData ────────────────────────────────────────────────────
    const feeMode = p.feeMode ?? 'static';
    let hook: Address;
    let feeData: Hex;
    if (feeMode === 'dynamic') {
      hook = suite.HOOK_DYNAMIC_FEE;
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
      hook = suite.HOOK_STATIC_FEE;
      // 1e6 units: 1/2/3/6.9% -> 10000/20000/30000/69000. Round (6.9*10000 isn't exact in float).
      const feeUnits = Math.round((p.feeTier ?? 1) * 10_000);
      feeData = encodeAbiParameters(
        [{ name: 'clankerFee', type: 'uint24' }, { name: 'pairedFee', type: 'uint24' }],
        [feeUnits, feeUnits],
      );
    }

    const poolData = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'extension', type: 'address' },
            { name: 'extensionData', type: 'bytes' },
            { name: 'feeData', type: 'bytes' },
          ],
        },
      ],
      [{ extension: '0x0000000000000000000000000000000000000000', extensionData: '0x', feeData }],
    );

    const lockerData = encodeAbiParameters(
      [{ type: 'tuple', components: [{ name: 'feePreference', type: 'uint8[]' }] }],
      [{ feePreference }],
    );

    // ── MEV protection ────────────────────────────────────────────────────────
    let mevModule: Address = suite.MEV_BLOCK_DELAY;
    let mevModuleData: Hex = '0x';
    if (p.sniperTax) {
      mevModule = suite.MEV_SNIPER_TAX;
      mevModuleData = encodeAbiParameters(
        [
          {
            type: 'tuple',
            components: [
              { name: 'startingFee', type: 'uint24' },
              { name: 'endingFee', type: 'uint24' },
              { name: 'secondsToDecay', type: 'uint256' },
            ],
          },
        ],
        [
          {
            startingFee: p.sniperTax.startingBps,
            endingFee: p.sniperTax.endingBps,
            secondsToDecay: BigInt(p.sniperTax.secondsToDecay),
          },
        ],
      );
    }

    // ── Extensions ────────────────────────────────────────────────────────────
    const extensions: Array<{
      extension: Address;
      msgValue: bigint;
      extensionBps: number;
      extensionData: Hex;
    }> = [];
    let totalMsgValue = BigInt(0);

    if (p.vault && p.vault.percentage > 0) {
      extensions.push({
        extension: suite.VAULT,
        msgValue: BigInt(0),
        extensionBps: Math.round(p.vault.percentage * 100),
        extensionData: encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'admin', type: 'address' },
                { name: 'lockupDuration', type: 'uint256' },
                { name: 'vestingDuration', type: 'uint256' },
              ],
            },
          ],
          [
            {
              admin: creatorSlices[0].recipient,
              lockupDuration: BigInt(
                Math.max(p.vault.lockupSeconds, VAULT_MIN_LOCKUP_SECONDS),
              ),
              vestingDuration: BigInt(Math.max(p.vault.vestingSeconds, 0)),
            },
          ],
        ),
      });
    }

    if (p.airdrop && p.airdrop.percentage > 0) {
      extensions.push({
        extension: suite.AIRDROP_V2,
        msgValue: BigInt(0),
        extensionBps: Math.round(p.airdrop.percentage * 100),
        extensionData: encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'admin', type: 'address' },
                { name: 'merkleRoot', type: 'bytes32' },
                { name: 'lockupDuration', type: 'uint256' },
                { name: 'vestingDuration', type: 'uint256' },
              ],
            },
          ],
          [
            {
              admin: creatorSlices[0].recipient,
              merkleRoot: p.airdrop.merkleRoot,
              lockupDuration: BigInt(
                Math.max(p.airdrop.lockupSeconds ?? 0, AIRDROP_MIN_LOCKUP_SECONDS),
              ),
              vestingDuration: BigInt(Math.max(p.airdrop.vestingSeconds ?? 0, 0)),
            },
          ],
        ),
      });
    }

    if (p.devBuyEth && Number(p.devBuyEth) > 0) {
      const ethValue = parseEther(p.devBuyEth);
      totalMsgValue += ethValue;
      extensions.push({
        extension: suite.DEV_BUY_V4,
        msgValue: ethValue,
        extensionBps: 0,
        extensionData: encodeAbiParameters(
          [
            {
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
            },
          ],
          [
            {
              pairedTokenPoolKey: {
                currency0: '0x0000000000000000000000000000000000000000',
                currency1: '0x0000000000000000000000000000000000000000',
                fee: 0,
                tickSpacing: 0,
                hooks: '0x0000000000000000000000000000000000000000',
              },
              pairedTokenAmountOutMinimum: BigInt(0),
              recipient: creatorSlices[0].recipient,
            },
          ],
        ),
      });
    }

    // ── Assemble + send ───────────────────────────────────────────────────────
    const config = {
      tokenConfig: {
        tokenAdmin: creator,
        name: p.name,
        symbol: p.symbol,
        salt: p.salt ?? randomSalt(),
        image: imageUri,
        metadata: JSON.stringify({ description: p.description ?? '', socials: p.socials ?? [] }),
        context: 'cc0company-sdk',
        originatingChainId: BigInt(this.chainId),
      },
      poolConfig: {
        hook,
        pairedToken: paired ? paired.address : c.WETH,
        tickIfToken0IsClanker: startingTick,
        tickSpacing: TICK_SPACING,
        poolData,
      },
      lockerConfig: {
        locker: suite.LOCKER,
        rewardAdmins,
        rewardRecipients,
        rewardBps,
        tickLower: [startingTick],
        tickUpper: [MAX_TICK_UPPER],
        positionBps: [10_000],
        lockerData,
      },
      mevModuleConfig: { mevModule, mevModuleData },
      extensionConfigs: extensions,
    };

    return { config, totalMsgValue, imageUri, paired, factory: suite.FACTORY };
  }
}

/** Build a PreparedTransaction (incl. the BigInt-free JSON mirror) for ExternalSender flows.
 *  `chainId` defaults to Base for back-compat — chain-aware callers pass their own. */
export function toPreparedTx(
  to: Address,
  data: Hex,
  value: bigint,
  gas: bigint,
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  chainId: number = base.id,
): PreparedTransaction {
  return {
    to,
    data,
    value,
    chainId,
    gas,
    maxFeePerGas: fees?.maxFeePerGas,
    maxPriorityFeePerGas: fees?.maxPriorityFeePerGas,
    json: {
      to,
      data,
      value: `0x${value.toString(16)}` as Hex,
      chainId,
      gas: `0x${gas.toString(16)}` as Hex,
      ...(fees
        ? {
            maxFeePerGas: `0x${fees.maxFeePerGas.toString(16)}` as Hex,
            maxPriorityFeePerGas: `0x${fees.maxPriorityFeePerGas.toString(16)}` as Hex,
          }
        : {}),
    },
  };
}

/** Current EIP-1559 fees from the chain, best-effort (undefined when the node won't say). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function estimateEip1559Fees(
  publicClient: any,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | undefined> {
  try {
    const f = await publicClient.estimateFeesPerGas();
    if (f?.maxFeePerGas && f?.maxPriorityFeePerGas) {
      return { maxFeePerGas: f.maxFeePerGas as bigint, maxPriorityFeePerGas: f.maxPriorityFeePerGas as bigint };
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

// ─── Paired-token resolution (shared by the ERC-20 + B20 launch builders) ───

const ERC20_METADATA_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

/**
 * Resolve a PairedTokenParam into the full PairedTokenOption the launch builders need:
 *   • symbol + decimals — ALWAYS read on-chain from the address (never trusted).
 *   • priceWeth — explicit param wins; otherwise the cc0.company price API resolves the
 *     paired token's USD price ÷ WETH's USD price (same registry the SDK registers
 *     launches on). FAIL-CLOSED: no resolvable price ⇒ throw, never a default —
 *     a guessed price mis-ticks the pool and one small buy can drain it.
 */
export async function resolvePairedToken(
  input: PairedTokenParam,
  opts: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any;
    /** cc0.company base URL (the instance's registryUrl). */
    registryUrl: string;
    /** The chain's canonical WETH — pairing with it is just the standard launch. */
    weth: Address;
  },
): Promise<PairedTokenOption> {
  const address = input.address;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`pairedToken.address is not a valid ERC-20 address (got: ${String(address)}).`);
  }
  if (address.toLowerCase() === opts.weth.toLowerCase()) {
    throw new Error('pairedToken is WETH — that IS the standard launch; omit pairedToken.');
  }

  // symbol()/decimals() straight from the chain — any ERC-20 qualifies IF both resolve.
  let symbol: string;
  let decimals: number;
  try {
    const [sym, dec] = await Promise.all([
      opts.publicClient.readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'symbol' }),
      opts.publicClient.readContract({ address, abi: ERC20_METADATA_ABI, functionName: 'decimals' }),
    ]);
    symbol = String(sym);
    decimals = Number(dec);
  } catch {
    throw new Error(
      `Could not read symbol()/decimals() from ${address} — is it an ERC-20 on this chain? ` +
        'Paired launches require both (fail-closed).',
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Paired token ${address} reports unusable decimals (${decimals}).`);
  }

  // Explicit price wins — but an explicitly-invalid one still fails closed.
  if (input.priceWeth !== undefined) {
    if (!Number.isFinite(input.priceWeth) || input.priceWeth <= 0) {
      throw new Error(
        'pairedToken.priceWeth must be a positive number (the price of ONE whole paired token in WETH).',
      );
    }
    return { address, symbol, decimals, priceWeth: input.priceWeth };
  }

  // Live resolution: paired USD ÷ WETH USD from the cc0.company price API — the same
  // API family the SDK already uses to register launches. `types=cc0strategy` routes
  // the paired token through the on-chain V4 spot probe (instant for launchpad tokens)
  // with GeckoTerminal as its fallback; WETH resolves via the standard path.
  let priceWeth = 0;
  try {
    const url =
      `${opts.registryUrl}/api/store/token-prices` +
      `?addresses=${address},${opts.weth}&types=cc0strategy,external&chains=base,base&holders=0`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined,
    });
    const json = res.ok ? await res.json().catch(() => null) : null;
    const prices = (json?.prices ?? {}) as Record<string, { price_usd?: number }>;
    const pairedUsd = Number(prices[address.toLowerCase()]?.price_usd ?? 0);
    const wethUsd = Number(prices[opts.weth.toLowerCase()]?.price_usd ?? 0);
    if (Number.isFinite(pairedUsd) && pairedUsd > 0 && Number.isFinite(wethUsd) && wethUsd > 0) {
      priceWeth = pairedUsd / wethUsd;
    }
  } catch {
    /* fall through to the fail-closed throw */
  }
  if (!Number.isFinite(priceWeth) || priceWeth <= 0) {
    throw new Error(
      `Could not resolve the ${symbol} (${address}) price in WETH from the cc0.company price API — ` +
        'pass pairedToken.priceWeth explicitly, or launch a standard WETH pair. ' +
        'Paired launches fail closed: no price, no launch.',
    );
  }
  return { address, symbol, decimals, priceWeth };
}

/** Reject non-hashes EARLY with an actionable message instead of hanging on a
 *  receipt that will never arrive (the classic: reading `.hash` when your
 *  provider returns `{ transactionHash }` — CDP does). */
export function assertTxHash(hash: unknown, context: string): asserts hash is Hash {
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(
      `${context} returned an invalid transaction hash (got: ${String(hash)}). ` +
        `Check which field your provider returns — Coinbase CDP returns { transactionHash }, not { hash }.`,
    );
  }
}

/** Best-effort image MIME detection from magic bytes (for raw Uint8Array inputs). */
function sniffImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes.length > 11 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[0] === 0x3c) return 'image/svg+xml';
  return 'image/png';
}

/**
 * Extract the launched token's address from a deployToken transaction receipt.
 * Pairs with `prepareLaunchTransaction` flows where an external signer submitted
 * the transaction. Returns null when the receipt has no TokenCreated event.
 */
export function parseLaunchReceipt(receipt: TransactionReceipt): Address | null {
  const events = parseEventLogs({
    abi: FACTORY_ABI,
    eventName: 'TokenCreated',
    logs: receipt.logs,
  });
  return (
    (events[0] as unknown as { args: { tokenAddress: Address } })?.args?.tokenAddress ?? null
  );
}

function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return ('0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')) as Hex;
}

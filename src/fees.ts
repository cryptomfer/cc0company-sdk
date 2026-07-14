import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem';
import {
  CC0_CONTRACTS,
  CHAIN_IDS,
  DEFAULT_RPCS,
  toChainSlug,
  VIEM_CHAINS,
  type Cc0ChainSlug,
} from './addresses';
import { assertTxHash, estimateEip1559Fees, toPreparedTx } from './launchpad';
import type { Cc0ClientConfig, ExternalSender } from './launchpad';

// ═══════════════════════════════════════════════════════════════════════════════════
// CREATOR FEES — read and claim a token creator's accrued trading fees.
//
// Fees accrue in the fee locker per (feeOwner, ASSET). Which assets depends on how
// the token launched:
//   • STANDARD (WETH pool):   WETH + the launched token
//   • PAIRED (custom pool):   the launched token + the PAIRED token — NO WETH at all.
//     Missing the paired asset means missing most of the fees (real incident: a
//     paired launch had 0 WETH but 15k+ of the paired token claimable, and every
//     WETH+token-only claim path reported "nothing to claim").
// The SDK auto-detects the paired token from the cc0.company launch registry, so
// getClaimableFees/claimFees cover the right assets without the caller knowing the
// launch type. `claim` is PERMISSIONLESS: anyone can trigger it, the funds always go
// to the feeOwner (the creator's rewards wallet).
// ═══════════════════════════════════════════════════════════════════════════════════

const FEE_LOCKER_ABI = [
  {
    type: 'function',
    name: 'availableFees',
    stateMutability: 'view',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [],
  },
] as const;

export interface ClaimableFees {
  /** Claimable WETH (wei). Always 0 for paired launches (their pool has no WETH). */
  weth: bigint;
  /** Claimable launched-token amount (wei). */
  token: bigint;
  /**
   * PAIRED launches only: the paired pool asset (e.g. the token your pool trades
   * against) and its claimable amount (wei). Auto-detected from the cc0.company
   * launch registry; absent for standard WETH launches.
   */
  paired?: { address: Address; amount: bigint };
}

export interface ClaimFeesResult {
  /** Hash of the WETH claim, when there was WETH to claim. */
  wethTxHash: Hash | null;
  /** Hash of the token claim, when there was token to claim. */
  tokenTxHash: Hash | null;
  /** Hash of the PAIRED-asset claim, when the launch was paired and had a balance. */
  pairedTxHash: Hash | null;
}

/** Optional overrides for the paired-asset detection. */
export interface FeeAssetOpts {
  /**
   * The paired pool asset, when you already know it. Pass `null` to explicitly
   * skip the registry lookup (standard WETH launch). Omit to auto-detect.
   */
  pairedToken?: Address | null;
}

/**
 * Read + claim creator trading fees from the cc0.company fee locker.
 *
 * ```ts
 * import { Cc0Fees } from '@cc0company/sdk';
 *
 * const fees = new Cc0Fees({ walletClient });
 * const claimable = await fees.getClaimableFees(creator, tokenAddress);
 * if (claimable.weth > 0n || claimable.token > 0n) {
 *   await fees.claimFees(creator, tokenAddress);
 * }
 * ```
 */
export class Cc0Fees {
  public readonly walletClient?: WalletClient;
  public readonly sender?: ExternalSender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  /** Chain this instance reads/claims on ('base' default | 'ethereum' | 'robinhood'). */
  public readonly chainSlug: Cc0ChainSlug;
  public readonly chainId: number;
  public readonly chain: (typeof VIEM_CHAINS)[Cc0ChainSlug];
  public readonly contracts: (typeof CC0_CONTRACTS)[Cc0ChainSlug];
  public readonly registryUrl: string;
  /** token → paired asset (or null) — one registry lookup per token per instance. */
  private readonly pairedCache = new Map<string, Address | null>();

  constructor(config: Cc0ClientConfig = {}) {
    // Fees accrue on the chain the token LAUNCHED on — pass the same `chain` you launched with.
    this.chainSlug = toChainSlug(config.chain);
    this.chainId = CHAIN_IDS[this.chainSlug];
    this.chain = VIEM_CHAINS[this.chainSlug];
    this.contracts = CC0_CONTRACTS[this.chainSlug];
    this.registryUrl = (config.registryUrl ?? 'https://cc0.company').replace(/\/$/, '');

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
  }

  /**
   * The paired pool asset for `token`, from the cc0.company launch registry —
   * or null for standard WETH launches / unknown tokens. Best-effort + cached:
   * a registry miss must never break a fee read.
   */
  private async lookupPairedToken(token: Address): Promise<Address | null> {
    const key = token.toLowerCase();
    if (this.pairedCache.has(key)) return this.pairedCache.get(key) ?? null;
    let paired: Address | null = null;
    try {
      const res = await fetch(
        `${this.registryUrl}/api/store/token-launches?token_address=${key}&limit=1`,
        { signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10_000) : undefined },
      );
      if (res.ok) {
        const json = (await res.json()) as { launches?: Array<{ paired_token?: string }> };
        const raw = json.launches?.[0]?.paired_token;
        if (typeof raw === 'string' && /^0x[0-9a-fA-F]{40}$/.test(raw)) paired = raw as Address;
      }
    } catch {
      /* best-effort */
    }
    this.pairedCache.set(key, paired);
    return paired;
  }

  /**
   * Claimable fees for `feeOwner` on `token` — WETH, the token itself, and (for
   * PAIRED launches) the paired pool asset, auto-detected from the registry.
   */
  async getClaimableFees(
    feeOwner: Address,
    token: Address,
    opts: FeeAssetOpts = {},
  ): Promise<ClaimableFees> {
    const paired =
      opts.pairedToken !== undefined ? opts.pairedToken : await this.lookupPairedToken(token);
    const read = (asset: Address) =>
      this.publicClient.readContract({
        address: this.contracts.FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: 'availableFees',
        args: [feeOwner, asset],
      }) as Promise<bigint>;
    const [weth, tok, pairedAmount] = await Promise.all([
      read(this.contracts.WETH),
      read(token),
      paired ? read(paired) : Promise.resolve(BigInt(0)),
    ]);
    return {
      weth,
      token: tok,
      ...(paired ? { paired: { address: paired, amount: pairedAmount } } : {}),
    };
  }

  /**
   * Claim everything accrued for `feeOwner` on `token` — WETH, the token, and (for
   * PAIRED launches) the paired pool asset. One transaction per non-zero balance.
   * Permissionless: the configured signer pays gas, the funds go to `feeOwner`.
   * Works with a walletClient / account OR an ExternalSender (CDP, Bankr, Safe, …).
   */
  async claimFees(
    feeOwner: Address,
    token: Address,
    opts: FeeAssetOpts = {},
  ): Promise<ClaimFeesResult> {
    const claimable = await this.getClaimableFees(feeOwner, token, opts);
    const result: ClaimFeesResult = { wethTxHash: null, tokenTxHash: null, pairedTxHash: null };

    if (claimable.weth > BigInt(0)) {
      result.wethTxHash = await this.submitClaim(feeOwner, this.contracts.WETH);
    }
    if (claimable.token > BigInt(0)) {
      result.tokenTxHash = await this.submitClaim(feeOwner, token);
    }
    if (claimable.paired && claimable.paired.amount > BigInt(0)) {
      result.pairedTxHash = await this.submitClaim(feeOwner, claimable.paired.address);
    }
    return result;
  }

  /** Submit one claim through whichever signer is configured, and wait for it. */
  private async submitClaim(feeOwner: Address, token: Address): Promise<Hash> {
    const to = this.contracts.FEE_LOCKER;
    const data: Hex = encodeFunctionData({
      abi: FEE_LOCKER_ABI,
      functionName: 'claim',
      args: [feeOwner, token],
    });

    let hash: Hash;
    if (this.walletClient?.account) {
      hash = await this.walletClient.sendTransaction({
        account: this.walletClient.account,
        to,
        data,
        chain: this.chain,
      });
    } else if (this.sender) {
      let gas = BigInt(400_000); // claims are cheap; generous fallback
      try {
        const estimated = (await this.publicClient.estimateGas({
          account: this.sender.address,
          to,
          data,
        })) as bigint;
        gas = (estimated * BigInt(120)) / BigInt(100);
      } catch { /* keep fallback */ }
      const fees = await estimateEip1559Fees(this.publicClient);
      hash = await this.sender.send(toPreparedTx(to, data, BigInt(0), gas, fees, this.chainId));
      assertTxHash(hash, 'Your sender.send()');
    } else {
      throw new Error('A walletClient, account, or sender is required to claim.');
    }

    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    return hash;
  }
}

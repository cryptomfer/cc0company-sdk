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
import { base } from 'viem/chains';

import { CC0_CONTRACTS } from './addresses';
import { toPreparedTx } from './launchpad';
import type { Cc0ClientConfig, ExternalSender } from './launchpad';

// ═══════════════════════════════════════════════════════════════════════════════════
// CREATOR FEES — read and claim a token creator's accrued trading fees.
//
// Fees accrue in the fee locker per (feeOwner, token). A creator launched with the
// default "both" preference earns in TWO assets: WETH and the launched token — each
// with its own balance and claim. `claim` is PERMISSIONLESS: anyone can trigger it,
// the funds always go to the feeOwner (the creator's rewards wallet).
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
  /** Claimable WETH (wei). */
  weth: bigint;
  /** Claimable launched-token amount (wei). */
  token: bigint;
}

export interface ClaimFeesResult {
  /** Hash of the WETH claim, when there was WETH to claim. */
  wethTxHash: Hash | null;
  /** Hash of the token claim, when there was token to claim. */
  tokenTxHash: Hash | null;
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
  public readonly contracts = CC0_CONTRACTS.base;

  constructor(config: Cc0ClientConfig = {}) {
    this.walletClient =
      config.walletClient ??
      (config.account
        ? createWalletClient({ account: config.account, chain: base, transport: http() })
        : undefined);
    this.sender = config.sender;
    this.publicClient =
      config.publicClient ?? createPublicClient({ chain: base, transport: http() });
  }

  /** Claimable fees for `feeOwner` on `token` — WETH and the token itself. */
  async getClaimableFees(feeOwner: Address, token: Address): Promise<ClaimableFees> {
    const [weth, tok] = await Promise.all([
      this.publicClient.readContract({
        address: this.contracts.FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: 'availableFees',
        args: [feeOwner, this.contracts.WETH],
      }),
      this.publicClient.readContract({
        address: this.contracts.FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: 'availableFees',
        args: [feeOwner, token],
      }),
    ]);
    return { weth: weth as bigint, token: tok as bigint };
  }

  /**
   * Claim everything accrued for `feeOwner` on `token` — first WETH, then the token
   * (one transaction each, skipped when the balance is zero). Permissionless: the
   * configured signer pays gas, the funds go to `feeOwner`. Works with a
   * walletClient / account OR an ExternalSender (CDP, Bankr, Safe, …).
   */
  async claimFees(feeOwner: Address, token: Address): Promise<ClaimFeesResult> {
    const claimable = await this.getClaimableFees(feeOwner, token);
    const result: ClaimFeesResult = { wethTxHash: null, tokenTxHash: null };

    if (claimable.weth > BigInt(0)) {
      result.wethTxHash = await this.submitClaim(feeOwner, this.contracts.WETH);
    }
    if (claimable.token > BigInt(0)) {
      result.tokenTxHash = await this.submitClaim(feeOwner, token);
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
        chain: base,
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
      hash = await this.sender.send(toPreparedTx(to, data, BigInt(0), gas));
    } else {
      throw new Error('A walletClient, account, or sender is required to claim.');
    }

    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}

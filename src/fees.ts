import {
  createPublicClient,
  http,
  type Address,
  type Hash,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';

import { CC0_CONTRACTS } from './addresses';
import type { Cc0ClientConfig } from './launchpad';

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  public readonly contracts = CC0_CONTRACTS.base;

  constructor(config: Cc0ClientConfig = {}) {
    this.walletClient = config.walletClient;
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
   * connected wallet pays gas, the funds go to `feeOwner`.
   */
  async claimFees(feeOwner: Address, token: Address): Promise<ClaimFeesResult> {
    if (!this.walletClient) throw new Error('A walletClient is required to claim.');
    const account = this.walletClient.account;
    if (!account) throw new Error('walletClient has no account attached.');

    const claimable = await this.getClaimableFees(feeOwner, token);
    const result: ClaimFeesResult = { wethTxHash: null, tokenTxHash: null };

    if (claimable.weth > BigInt(0)) {
      result.wethTxHash = await this.walletClient.writeContract({
        account,
        address: this.contracts.FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: 'claim',
        args: [feeOwner, this.contracts.WETH],
        chain: base,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: result.wethTxHash });
    }

    if (claimable.token > BigInt(0)) {
      result.tokenTxHash = await this.walletClient.writeContract({
        account,
        address: this.contracts.FEE_LOCKER,
        abi: FEE_LOCKER_ABI,
        functionName: 'claim',
        args: [feeOwner, token],
        chain: base,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: result.tokenTxHash });
    }

    return result;
  }
}

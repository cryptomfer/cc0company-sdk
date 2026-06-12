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
// STAKING — stake $cc0company, earn WETH from the 15% staker share of every
// launchpad token's trading fees.
//
// Mechanics:
//   • stake(amount)        — starts earning immediately (auto-approves if needed)
//   • getReward()          — claim accrued WETH, anytime
//   • requestUnstake(x)    — starts the unbonding cooldown (48h); stops earning
//   • withdraw()           — get your tokens back once the cooldown elapsed
//   • cancelUnstake()      — put unbonding tokens back to work
//   • exit()               — claim all WETH + request-unstake everything, one tx
// ═══════════════════════════════════════════════════════════════════════════════════

const STAKING_ABI = [
  { type: 'function', name: 'stake', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'requestUnstake', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdraw', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'cancelUnstake', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'getReward', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'exit', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'sync', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'stakedBalance', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'earned', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalStaked', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'cooldownPeriod', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unbondingAmount', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unbondingUnlockAt', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimableFromLocker', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface StakingPosition {
  /** Currently staked and earning (wei). */
  staked: bigint;
  /** Accrued WETH rewards claimable via claimRewards() (wei). */
  earned: bigint;
  /** Tokens in the unbonding cooldown (wei). */
  unbonding: bigint;
  /** Unix seconds when the unbonding tokens become withdrawable (0 = none). */
  unbondingUnlockAt: bigint;
  /** Pool-wide total staked (wei). */
  totalStaked: bigint;
  /** Unbonding cooldown duration in seconds (48h on the live deployment). */
  cooldownSeconds: bigint;
}

/**
 * Stake $cc0company and earn WETH from every launchpad token's trading fees.
 *
 * ```ts
 * import { Cc0Staking } from '@cc0company/sdk';
 * import { parseEther } from 'viem';
 *
 * const staking = new Cc0Staking({ walletClient });
 * await staking.stake(parseEther('1000'));     // auto-approves if needed
 * const pos = await staking.getPosition(me);   // staked / earned / unbonding
 * await staking.claimRewards();                // WETH to your wallet
 * ```
 */
export class Cc0Staking {
  public readonly walletClient?: WalletClient;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  public readonly contracts = CC0_CONTRACTS.base;

  constructor(config: Cc0ClientConfig = {}) {
    this.walletClient = config.walletClient;
    this.publicClient =
      config.publicClient ?? createPublicClient({ chain: base, transport: http() });
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  /** Full staking position for `account`, plus pool-wide context. */
  async getPosition(account: Address): Promise<StakingPosition> {
    const c = this.contracts.STAKING;
    const [staked, earned, unbonding, unlockAt, totalStaked, cooldown] = await Promise.all([
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'stakedBalance', args: [account] }),
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'earned', args: [account] }),
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'unbondingAmount', args: [account] }),
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'unbondingUnlockAt', args: [account] }),
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'totalStaked', args: [] }),
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'cooldownPeriod', args: [] }),
    ]);
    return {
      staked: staked as bigint,
      earned: earned as bigint,
      unbonding: unbonding as bigint,
      unbondingUnlockAt: unlockAt as bigint,
      totalStaked: totalStaked as bigint,
      cooldownSeconds: cooldown as bigint,
    };
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  /**
   * Stake `amount` (wei) of $cc0company. Sends an ERC20 approval first when the
   * current allowance doesn't cover the amount (set `autoApprove: false` to revert
   * instead). Earning starts in the same block.
   */
  async stake(amount: bigint, opts: { autoApprove?: boolean } = {}): Promise<Hash> {
    const { account } = this.requireWallet();
    const autoApprove = opts.autoApprove ?? true;

    const allowance = (await this.publicClient.readContract({
      address: this.contracts.CC0COMPANY,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, this.contracts.STAKING],
    })) as bigint;

    if (allowance < amount) {
      if (!autoApprove) throw new Error('Insufficient allowance and autoApprove is disabled.');
      const approveHash = await this.walletClient!.writeContract({
        account,
        address: this.contracts.CC0COMPANY,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [this.contracts.STAKING, amount],
        chain: base,
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    return this.send('stake', [amount]);
  }

  /** Claim accrued WETH rewards to your wallet. */
  async claimRewards(): Promise<Hash> {
    return this.send('getReward', []);
  }

  /** Begin unbonding `amount` (wei). It stops earning now, withdrawable after the cooldown. */
  async requestUnstake(amount: bigint): Promise<Hash> {
    return this.send('requestUnstake', [amount]);
  }

  /** Withdraw unbonded tokens once the cooldown has elapsed. */
  async withdraw(): Promise<Hash> {
    return this.send('withdraw', []);
  }

  /** Cancel an in-progress unbonding — tokens go straight back to earning. */
  async cancelUnstake(): Promise<Hash> {
    return this.send('cancelUnstake', []);
  }

  /** Claim all WETH + request-unstake the entire stake, in one transaction. */
  async exit(): Promise<Hash> {
    return this.send('exit', []);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireWallet() {
    if (!this.walletClient) throw new Error('A walletClient is required for this action.');
    const account = this.walletClient.account;
    if (!account) throw new Error('walletClient has no account attached.');
    return { account };
  }

  private async send(fn: string, args: unknown[]): Promise<Hash> {
    const { account } = this.requireWallet();
    const hash = await this.walletClient!.writeContract({
      account,
      address: this.contracts.STAKING,
      abi: STAKING_ABI,
      functionName: fn as never,
      args: args as never,
      chain: base,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}

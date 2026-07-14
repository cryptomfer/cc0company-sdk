import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';

import { CC0_CONTRACTS } from './addresses';
import { assertTxHash, estimateEip1559Fees, toPreparedTx } from './launchpad';
import type { Cc0ClientConfig, ExternalSender } from './launchpad';

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
  // NB: the deployed pool exposes `rewards(address)` (checkpointed WETH, realized by
  // getReward()) — there is NO `earned(address)` on this deployment. Verified against
  // the live bytecode; reading `earned` reverts.
  { type: 'function', name: 'rewards', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
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
  /**
   * Checkpointed WETH rewards claimable via claimRewards() (wei). Read from the
   * pool's `rewards(address)` view — a lower bound: getReward() settles the exact
   * amount (anything accrued since the last checkpoint is added at claim time).
   */
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

  // ── Views ──────────────────────────────────────────────────────────────────

  /** Full staking position for `account`, plus pool-wide context. */
  async getPosition(account: Address): Promise<StakingPosition> {
    const c = this.contracts.STAKING;
    const [staked, earned, unbonding, unlockAt, totalStaked, cooldown] = await Promise.all([
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'stakedBalance', args: [account] }),
      this.publicClient.readContract({ address: c, abi: STAKING_ABI, functionName: 'rewards', args: [account] }),
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
    const signer = this.signerAddress();
    const autoApprove = opts.autoApprove ?? true;

    const allowance = (await this.publicClient.readContract({
      address: this.contracts.CC0COMPANY,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [signer, this.contracts.STAKING],
    })) as bigint;

    if (allowance < amount) {
      if (!autoApprove) throw new Error('Insufficient allowance and autoApprove is disabled.');
      await this.submit(
        this.contracts.CC0COMPANY,
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [this.contracts.STAKING, amount],
        }),
      );
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

  /** Address of whichever signer is configured (walletClient account or sender). */
  private signerAddress(): Address {
    if (this.walletClient?.account) return this.walletClient.account.address as Address;
    if (this.sender) return this.sender.address;
    throw new Error('A walletClient, account, or sender is required for this action.');
  }

  private async send(fn: string, args: unknown[]): Promise<Hash> {
    return this.submit(
      this.contracts.STAKING,
      encodeFunctionData({ abi: STAKING_ABI as Abi, functionName: fn, args }),
    );
  }

  /** Submit raw calldata through whichever signer is configured, and wait for it. */
  private async submit(to: Address, data: Hex): Promise<Hash> {
    let hash: Hash;
    if (this.walletClient?.account) {
      hash = await this.walletClient.sendTransaction({
        account: this.walletClient.account,
        to,
        data,
        chain: base,
      });
    } else if (this.sender) {
      let gas = BigInt(500_000); // staking ops are light; generous fallback
      try {
        const estimated = (await this.publicClient.estimateGas({
          account: this.sender.address,
          to,
          data,
        })) as bigint;
        gas = (estimated * BigInt(120)) / BigInt(100);
      } catch { /* keep fallback */ }
      const fees = await estimateEip1559Fees(this.publicClient);
      hash = await this.sender.send(toPreparedTx(to, data, BigInt(0), gas, fees));
      assertTxHash(hash, 'Your sender.send()');
    } else {
      throw new Error('A walletClient, account, or sender is required for this action.');
    }
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    return hash;
  }
}

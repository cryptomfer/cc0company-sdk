# @cc0company/sdk

The official [cc0.company](https://cc0.company) SDK. Launch tokens on the launchpad,
claim creator fees, and stake $cc0company — from any website, app, or AI agent.

- **`Cc0Launchpad`** — deploy a token on Base in one transaction, with the on-chain
  enforced **75/15/10** fee split: 75% of every trade's LP fee to you, 15% to
  $cc0company stakers, 10% to the platform.
- **`Cc0Fees`** — read and claim your accrued trading fees (WETH + your token).
- **`Cc0Staking`** — stake $cc0company and earn WETH from every launch.

One peer dependency: [viem](https://viem.sh).

## Installation

```bash
npm install @cc0company/sdk viem
```

## Launch a token

```typescript
import { Cc0Launchpad } from '@cc0company/sdk';
import { createWalletClient, custom } from 'viem';
import { base } from 'viem/chains';

const walletClient = createWalletClient({
  chain: base,
  transport: custom(window.ethereum),
});

const launchpad = new Cc0Launchpad({ walletClient });

const { tokenAddress, txHash } = await launchpad.launchToken({
  name: 'My Token',
  symbol: 'MTK',
  image: 'ipfs://QmYourImageHash', // stored on-chain
  description: 'My awesome token', // stored on-chain
  feeTier: 1,                      // 1 | 2 | 3 % static LP fee, or feeMode: 'dynamic'
});
```

One transaction: token + Uniswap V4 pool + locked LP + fee split, atomically.
The token trades the moment it lands.

### All launch options

```typescript
await launchpad.launchToken({
  name: 'My Token',
  symbol: 'MTK',
  image: 'ipfs://QmYourImageHash',

  // Fees: static tier or the dynamic 1%→3% volatility preset
  feeMode: 'static',                 // 'static' (default) | 'dynamic'
  feeTier: 1,                        // 1 | 2 | 3 (static only)

  // Split YOUR 75% across up to 5 wallets (bps of total fees, must sum to 7500)
  creatorRewards: [
    { recipient: '0xYou',       bps: 5000, feePreference: 'both' },
    { recipient: '0xCofounder', bps: 2500, feePreference: 'paired' }, // WETH only
  ],

  // Anti-snipe: descending tax (80% → 5% over 15s), or omit for a 2-block MEV delay
  sniperTax: { startingBps: 800_000, endingBps: 50_000, secondsToDecay: 15 },

  // Lock part of the supply for yourself (lockup ≥ 7 days, optional vesting)
  vault: { percentage: 10, lockupSeconds: 604800, vestingSeconds: 2592000 },

  // Merkle airdrop (lockup ≥ 1 day)
  airdrop: { merkleRoot: '0x…', percentage: 5 },

  // Buy your own token at launch with ETH
  devBuyEth: '0.05',
});
```

### The enforced split

The factory validates every launch **on-chain**: the staking (15%) and treasury (10%)
slices must be present — configs that drop or resize them revert with
`Cc0InvalidProtocolSplit`. Nobody (including this SDK) can launch around them. You stay
in full control of your 75%: split it at launch via `creatorRewards`, redirect it later.

```typescript
import { PROTOCOL_SPLIT } from '@cc0company/sdk';
// { CREATOR_BPS: 7500, STAKING_BPS: 1500, TREASURY_BPS: 1000 }

const { staking, treasury, admin } = await launchpad.getProtocolAddresses();
```

## Claim your creator fees

```typescript
import { Cc0Fees } from '@cc0company/sdk';

const fees = new Cc0Fees({ walletClient });

const claimable = await fees.getClaimableFees(creatorWallet, tokenAddress);
// { weth: 123450000000000n, token: 9876000000000000000000n }

await fees.claimFees(creatorWallet, tokenAddress);
// claims WETH then the token — funds always go to the creator wallet
```

The claim is permissionless: any wallet can trigger it, the creator always gets paid.

## Stake $cc0company

```typescript
import { Cc0Staking } from '@cc0company/sdk';
import { parseEther } from 'viem';

const staking = new Cc0Staking({ walletClient });

await staking.stake(parseEther('1000'));     // auto-approves if needed
await staking.claimRewards();                // accrued WETH → your wallet

const pos = await staking.getPosition(me);
// { staked, earned, unbonding, unbondingUnlockAt, totalStaked, cooldownSeconds }

await staking.requestUnstake(parseEther('500')); // starts the 48h cooldown
await staking.withdraw();                        // after the cooldown
await staking.exit();                            // claim all + unstake all, one tx
```

## Your token on cc0.company — automatic

Every launch is **registered on cc0.company automatically**: your token gets its page
at `cc0.company/token/{address}` — live chart, swap widget, a one-tap claim button for
your fees — and shows up in browse + search. Nothing to do.

```typescript
const { tokenAddress, registered } = await launchpad.launchToken({ ... });
// registered === true → your token page is live
// registered === false → the registry was unreachable; the token is still fully
//                        live on-chain (registration is never allowed to fail a launch)
```

Opt out with `register: false`, or point the SDK at a self-hosted registry via
`new Cc0Launchpad({ walletClient, registryUrl: 'https://...' })`.

Integrating at the raw contract level without this SDK? Register by POSTing the same
payload yourself — see [cc0.company/docs/launchpad-sdk](https://cc0.company/docs/launchpad-sdk).

## Contracts (Base mainnet)

All verified on Basescan — full list at
[cc0.company/docs/smart-contracts](https://cc0.company/docs/smart-contracts).

| Contract | Address |
|----------|---------|
| Factory (enforcing) | `0xf9007657b627c5421d6eBD5D71F86CDfCdc7dA8D` |
| Fee locker | `0xC04bdF721FA5CEc839819864FA86F3D48B89Fcee` |
| Staking | `0x38cE743b88c54eD1aF84816Ff596E518d16DFF95` |
| $cc0company | `0x67c5F00491c09cbCF6359f95690574E6106bb3CF` |

## License

CC0-1.0 — public domain, like everything we do.

# @cc0company/sdk

The official [cc0.company](https://cc0.company) SDK. Launch tokens on the launchpad,
claim creator fees, and stake $cc0company — from any website, app, or AI agent.

- **`Cc0Launchpad`** — deploy a token on **Base, Ethereum, or Robinhood Chain** in one
  transaction, with the on-chain enforced **75/15/10** fee split: 75% of every trade's
  LP fee to you, 15% to $cc0company stakers, 10% to the platform.
- **`Cc0Fees`** — read and claim your accrued trading fees (WETH + your token), on the
  chain you launched on.
- **`Cc0Staking`** — stake $cc0company (on Base) and earn WETH from every launch on
  every chain — the Ethereum and Robinhood Chain staking slices bridge to the Base pool.
- **`Cc0Drops`** — the full IPFS NFT drop lifecycle (CC0Drop ERC721-C + CC0Drop1155):
  pin art + metadata, deploy in one signature, record on cc0.company, then manage the
  drop exactly like the dashboard — phases, allowlists (merkle), royalties, airdrops,
  open-edition numbering, NEW editions on a live 1155, withdraw, seal — and mint.

```ts
// Pick the chain at construction — 'base' (default) | 'ethereum' | 'robinhood':
const launchpad = new Cc0Launchpad({ account, chain: 'robinhood' });
```

One peer dependency: [viem](https://viem.sh).

## Installation

```bash
npm install @cc0company/sdk viem
```

## Wallets — what the SDK accepts

Every client (`Cc0Launchpad`, `Cc0Fees`, `Cc0Staking`, `Cc0Drops`) takes ONE of three signers:

```typescript
// 1. Browser wallet (MetaMask, Rabby, …) — viem walletClient
const walletClient = createWalletClient({ chain: base, transport: custom(window.ethereum) });
new Cc0Launchpad({ walletClient });

// 2. Private key (server / agent) — viem account
import { privateKeyToAccount } from 'viem/accounts';
new Cc0Launchpad({ account: privateKeyToAccount('0x…') });

// 3. ANY other wallet infra (Coinbase CDP, Bankr, Safe, relayers) — a `sender`:
//    { address, send }. The SDK builds + gas-estimates the tx; your infra signs
//    and submits it; the SDK waits, parses, and registers. `tx.json` is the
//    BigInt-free mirror for JSON transports.
new Cc0Launchpad({
  sender: {
    address: '0xYourSignerAddress',
    send: async (tx) => {
      const hash = await yourInfra.sendTransaction(tx.json); // { to, data, value, gas, chainId } — all hex
      return hash;
    },
  },
});
```

### Coinbase CDP recipe (proven in production)

CDP's account objects are not viem-compatible — use a `sender`:

```typescript
import { CdpClient } from '@coinbase/cdp-sdk';
import { Cc0Launchpad } from '@cc0company/sdk';

const cdp = new CdpClient();
const account = await cdp.evm.getOrCreateAccount({ name: 'launcher' });

const launchpad = new Cc0Launchpad({
  sender: {
    address: account.address,
    send: async (tx) => {
      const { transactionHash } = await cdp.evm.sendTransaction({
        address: account.address,
        network: 'base',
        // CDP's TypeScript SDK wants the BIGINT fields (tx.*), not the hex
        // mirror — hex fee strings throw TipAboveFeeCapError. Everything is
        // pre-estimated. (tx.json is for RAW JSON transports/relayers only.)
        transaction: {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gas: tx.gas,
          maxFeePerGas: tx.maxFeePerGas,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        },
      });
      return transactionHash; // NOTE: CDP's field is `transactionHash`, not `hash`
    },
  },
});

// Now EVERYTHING just works — launch, claim fees, stake:
const { tokenAddress, registered } = await launchpad.launchToken({ ... });
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
  image: 'https://my.site/art.png', // ANY url or raw bytes — pinned to IPFS for you
  description: 'My awesome token',  // stored on-chain
  feeTier: 1,                       // 1 | 2 | 3 % static LP fee, or feeMode: 'dynamic'
});
```

One transaction: token + Uniswap V4 pool + locked LP + fee split, atomically.
The token trades the moment it lands.

## Token images — IPFS, guaranteed

The image URI is written **on-chain forever** at launch, so the SDK refuses to
write a rottable URL. Whatever you pass is normalized to `ipfs://` (pinned
through cc0.company's infrastructure) before the transaction is built:

| You pass | What happens |
|----------|--------------|
| `ipfs://CID` | Used as-is |
| `https://…` URL | Mirrored to IPFS server-side |
| `data:` URL, `Blob`/`File`, `Uint8Array` | Uploaded + pinned (8MB max, images only) |

If pinning fails, **the launch fails** — by design. Escape hatch:
`imagePolicy: 'as-is'` trusts your URL verbatim. Need the URI up front?
`await launchpad.pinImage(input)` → `{ cid, ipfsUri, gatewayUrl }`.

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

## Fully manual flow (when even `sender` is too much)

Prefer the `sender` config above — `launchToken()` then handles everything. But if
you want raw control:

```typescript
import { Cc0Launchpad } from '@cc0company/sdk';

const launchpad = new Cc0Launchpad(); // no signer at all

// 1. Build the unsigned transaction (image pinned to IPFS, gas estimated +20%)
const tx = await launchpad.prepareLaunchTransaction(
  { name: 'My Token', symbol: 'MTK', image: imageBytes, feeTier: 1 },
  { creator: '0xYourSenderAddress' }, // MUST be the address that submits it
);
// → { to, data, value, chainId, gas, imageUri, json }
//   tx.json = BigInt-free (hex) — pass it straight to JSON transports.

// 2. Submit through your infra → txHash, then ONE call finishes everything
//    (waits for the receipt, extracts the token address, registers the page):
const { tokenAddress, registered } = await launchpad.finishLaunch({
  txHash,
  params: { name: 'My Token', symbol: 'MTK' },
  creator: '0xYourSenderAddress',
  imageUri: tx.imageUri,
});
```

## Launch a B20 (Base-only)

B20 is Base's native token standard. `Cc0B20Launchpad` launches a **tradeable B20** —
same Uniswap V4 pool, same enforced 75/15/10 fee split, same extensions (vault, airdrop,
dev buy, sniper tax) as the ERC-20 launchpad — the factory just mints a B20 via Base's
precompile instead of an ERC-20.

```typescript
import { Cc0B20Launchpad } from '@cc0company/sdk';

const b20 = new Cc0B20Launchpad({ walletClient, chainId: 84532 }); // Base Sepolia today
const { tokenAddress, configWarnings } = await b20.launchB20({
  name: 'My B20',
  symbol: 'MYB20',
  image: 'ipfs://…',
  supply: '1000000000',   // whole tokens; empty = the 100B default
  lpPreset: 'degen',      // 'classic' (default, deep) | 'degen' (thin — price moves ~7× easier)
  adminMode: 'trustless', // default: admin-less at birth, supply fixed forever
});
```

`adminMode: 'managed'` keeps you as the token's admin and lets the optional `b20` config
apply a supply cap, role grants, an allowlist/blocklist compliance policy, or freeze &
seize right after launch — each step is fail-soft and reported in `configWarnings`.

Availability is **fail-closed**: Base Sepolia (84532) is live; the Base-mainnet entry
ships pre-staged and the constructor refuses `chainId: 8453` until the audited mainnet
cutover lands. Works with `walletClient`, `account`, or `sender` — exactly like
`Cc0Launchpad`.

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

## NFT drops — deploy, manage, mint (IPFS)

The full CC0Drop (ERC721-C) / CC0Drop1155 lifecycle. Deploys need a
`walletClient`/`account` (raw contract creation); everything else — management,
minting, pinning — works with ANY signer, including a Bankr `sender` that
provides `signMessage` (validated via EIP-1271 server-side).

```typescript
import { Cc0Drops } from '@cc0company/sdk';

const drops = new Cc0Drops({ walletClient }); // or { account } / { sender }

// 1. Pin art + metadata
const art  = await drops.pinArt(pngBytes, 'art.png');
const meta = await drops.pinDropMetadata({ name: 'My Drop', image: art.ipfsUri });

// 2. Deploy (one signature) — recorded on cc0.company automatically
const { contractAddress } = await drops.deployDrop721({
  name: 'My Drop', symbol: 'DROP',
  baseURI: meta.baseURI, contractURI: meta.contractURI,
  maxSupply: 1000,                       // 0 = open edition
  publicPhase: { priceEth: '0.001' },
  allowlist: { entries: [{ address: '0x…', quantity: 2 }], priceEth: '0' },
});

// 3. Manage — full dashboard parity
await drops.setPublicPhase721(contractAddress, { priceEth: '0.002' });
await drops.setAllowlist721(contractAddress, entries);        // root + phase + preimage
await drops.enableOpenEditionNumbering(contractAddress);      // "Name #1, #2…"
await drops.ownerMint721(contractAddress, 10, '0xFriend…');  // airdrop
await drops.withdraw(contractAddress);
await drops.sealContract(contractAddress);                    // PERMANENT freeze

// 4. Multi-edition 1155 — including NEW editions on a LIVE collection
const d1155 = await drops.deployDrop1155({
  name: 'Editions', symbol: 'ED', baseURI: meta1155.baseURI,
  firstEdition: { maxSupply: 100, publicPhase: { priceEth: '0.001' } },
});
await drops.addEdition1155(d1155.contractAddress,
  { tokenId: 2, maxSupply: 0 },          // 0 = open edition
  { name: 'Editions', editions: [ed1Meta, ed2Meta] }, // folder covers ALL ids
);

// 5. Mint (buyer side — any signer)
await drops.mint721(contractAddress, 1);
await drops.mintAllowlist721(contractAddress, 1, { entries }); // proof built locally
```

Signer-only integrations (Bankr): `drops.resolveAgent()` fetches your agent
identity + profile from the wallet address alone, and the authed routes (pin)
sign the `cc0.company:agent-auth` message via `sender.signMessage`. Legacy
`agentApiKey` remains a fallback credential.

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

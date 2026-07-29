import type { Address, Chain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { defineChain } from 'viem';

/**
 * cc0.company launchpad contracts — per chain.
 *
 * The launchpad is live on THREE networks (same Clanker-fork factory, same enforced 75/15/10
 * split, independently deployed + verified on each chain's explorer):
 *   • Base (8453)            — basescan.org
 *   • Ethereum mainnet (1)   — etherscan.io
 *   • Robinhood Chain (4663) — robinhoodchain.blockscout.com (Arbitrum-Orbit L2, ETH gas)
 *
 * `STAKING` is the enforced 15% recipient on each chain. On Base it's the actual Cc0Staking pool;
 * on Ethereum it's the bridge forwarder (WETH → OP bridge → Base pool); on Robinhood Chain it's
 * the escrow feeding the Relay bridge to the same Base pool. Either way: stake $cc0company on
 * BASE, earn from launches on all three chains.
 */

export const CC0_CONTRACTS = {
  base: {
    /** Launchpad factory — validates the 75/15/10 split on every deployToken. */
    FACTORY: '0xf9007657b627c5421d6eBD5D71F86CDfCdc7dA8D' as Address,
    /** LP locker — holds the locked liquidity + reward slice config per token. */
    LOCKER: '0x09385aba38D7007cde80F137a629f7f43dA40A3F' as Address,
    /** Fee locker — accrues claimable trading fees per (feeOwner, token). */
    FEE_LOCKER: '0xC04bdF721FA5CEc839819864FA86F3D48B89Fcee' as Address,
    /** $cc0company staking — stake cc0, earn WETH from the 15% staker share. */
    STAKING: '0x38cE743b88c54eD1aF84816Ff596E518d16DFF95' as Address,
    /** $cc0company token (the staking token). */
    CC0COMPANY: '0x67c5F00491c09cbCF6359f95690574E6106bb3CF' as Address,
    HOOK_STATIC_FEE: '0x1aEA38f06deCE45c252eF1Ac5AF989D51Dc8E8cc' as Address,
    HOOK_DYNAMIC_FEE: '0x7e0648DeADed459A201fA35231189E214b1AA8cc' as Address,
    MEV_BLOCK_DELAY: '0x844a62e0e25E3754578A22F909ca462E150DdEa7' as Address,
    MEV_SNIPER_TAX: '0x94eBf54bbd4BD68F98F7A68a6C0f9f1A8c154FEC' as Address,
    VAULT: '0x72BD9058A9072f25CFc783eDF0EF3e5fFF124580' as Address,
    AIRDROP_V2: '0x8f6f4612CDdcFE0454aA3c448cb05bFCA5479994' as Address,
    DEV_BUY_V4: '0xA9AF8A07FdeB2775646ad5071bAF14CA3749FfC5' as Address,
    WETH: '0x4200000000000000000000000000000000000006' as Address,
    /** NFT-holder fee distribution (Option B): factory deploys a per-token distributor; */
    /** router claims a holder's rewards across many distributors in one tx. */
    NFT_FEE_FACTORY: '0x7867f16Cf2abF38C592b7b4f4807AC28B284a727' as Address,
    NFT_REWARDS_ROUTER: '0x49E2386CdBEC0030C792c0943A59baCE293c1e2a' as Address,
  },
  ethereum: {
    FACTORY: '0x70baFfe8783396142385Ece53f2cDF8D1cf9872C' as Address,
    LOCKER: '0x757711674f94d952d83b6b24CAe9ACA941554100' as Address,
    FEE_LOCKER: '0x0De94068195C5d85e31406804357F44E0D20E255' as Address,
    /** Cc0EthStakingForwarder — the 15% slice, bridged to the Base staking pool. */
    STAKING: '0xF84D22728E7f4DdD56Fd3BE7Cb30148e727A8a1a' as Address,
    /** $cc0company lives on Base only — kept for shape parity (staking UIs read the Base entry). */
    CC0COMPANY: '0x67c5F00491c09cbCF6359f95690574E6106bb3CF' as Address,
    HOOK_STATIC_FEE: '0x2Cb78e8B725a51bC6215184C24c8626De7D868Cc' as Address,
    HOOK_DYNAMIC_FEE: '0x78F30C01eB7DB973a1Cb3456c377BB78F311e8cc' as Address,
    MEV_BLOCK_DELAY: '0x17566b5eB895f7550f820d28615e29B8F2a08212' as Address,
    MEV_SNIPER_TAX: '0x5e2eE3BA478DF294C167bd6245B04bD1762f7f39' as Address,
    VAULT: '0xfd0327Adf529fA856Eb1225b9761E332A7646c3F' as Address,
    AIRDROP_V2: '0x8Fa248F99a98B8E2cCC8A0A3Bb620ACe65B92eF5' as Address,
    DEV_BUY_V4: '0xbFD1e50b1dDB2657D6F61930fECa44C591606834' as Address,
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    NFT_FEE_FACTORY: '0xF283576Ed3b2eE25BE27772Fc98f3c70d54aBc41' as Address,
    NFT_REWARDS_ROUTER: '0xEcc5b3318236Fa5c569F72609F22Ea453bC5DF7B' as Address,
  },
  robinhood: {
    FACTORY: '0x79F331d3d7977062d5c78Ad122851fC57Ee3DC1a' as Address,
    LOCKER: '0x99595FB33e2599688b78F93569875c010648A359' as Address,
    FEE_LOCKER: '0x343d77D94A119D5cEA495aeE8336A3a7Aa5CD385' as Address,
    /** Cc0StakingEscrow — the 15% slice, auto-bridged (Relay) to the Base staking pool. */
    STAKING: '0xE4542b52Ed212bDcFb10f3C9F8A12f2cEeeF35b2' as Address,
    /** $cc0company lives on Base only — kept for shape parity. */
    CC0COMPANY: '0x67c5F00491c09cbCF6359f95690574E6106bb3CF' as Address,
    HOOK_STATIC_FEE: '0xe6eDB82cd1eFfb8b3A685b4ef4DEe22e6698a8cc' as Address,
    HOOK_DYNAMIC_FEE: '0xe1e7CEa9649aeccaA30286060305c07b1ea428Cc' as Address,
    MEV_BLOCK_DELAY: '0x0De94068195C5d85e31406804357F44E0D20E255' as Address,
    MEV_SNIPER_TAX: '0x70baFfe8783396142385Ece53f2cDF8D1cf9872C' as Address,
    VAULT: '0xB8bC0bb444a65B1896D0557A273C5Be269d701C9' as Address,
    AIRDROP_V2: '0xD4B6AE01Ddcb336DCcACcca28f02cC70195c0b8f' as Address,
    DEV_BUY_V4: '0x17566b5eB895f7550f820d28615e29B8F2a08212' as Address,
    WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
    NFT_FEE_FACTORY: '0xfd0327Adf529fA856Eb1225b9761E332A7646c3F' as Address,
    NFT_REWARDS_ROUTER: '0x140b6EE50e1a218c3df9984dec42eA3eDaB1d06c' as Address,
  },
} as const;

/** Chain selector accepted everywhere in the SDK: a slug or a chain id. */
export type Cc0Chain = 'base' | 'ethereum' | 'robinhood' | 8453 | 1 | 4663;

export type Cc0ChainSlug = keyof typeof CC0_CONTRACTS;

/** Robinhood Chain (4663) — not shipped in viem's chain list yet, defined here. */
export const robinhoodChain: Chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
});

/** Normalise a Cc0Chain (slug or id) to the canonical slug. Defaults to 'base'. */
export function toChainSlug(chain?: Cc0Chain): Cc0ChainSlug {
  if (chain === 1 || chain === 'ethereum') return 'ethereum';
  if (chain === 4663 || chain === 'robinhood') return 'robinhood';
  return 'base';
}

/** Per-slug numeric chain id. */
export const CHAIN_IDS: Record<Cc0ChainSlug, number> = {
  base: 8453,
  ethereum: 1,
  robinhood: 4663,
};

/** Per-slug viem Chain object (for wallet/public clients). */
export const VIEM_CHAINS: Record<Cc0ChainSlug, Chain> = {
  base,
  ethereum: mainnet,
  robinhood: robinhoodChain,
};

/**
 * Default public RPC per chain. Explicit URLs on purpose:
 *   • Ethereum — viem's default (eth.merkle.io) is CORS-blocked in browsers; publicnode isn't.
 *   • Robinhood — the official RPC (rate-limited but fine for launches).
 *   • Base — viem's default works; pinned here for symmetry.
 * Pass your own `publicClient` / `walletClient` (e.g. Alchemy-backed) for production volume.
 */
export const DEFAULT_RPCS: Record<Cc0ChainSlug, string> = {
  base: 'https://mainnet.base.org',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  robinhood: 'https://rpc.mainnet.chain.robinhood.com',
};

/**
 * The protocol fee split, enforced ON-CHAIN by the factory at every launch — the SAME on all
 * three chains. Configs that drop or resize the staking/treasury slices revert
 * (Cc0InvalidProtocolSplit) — changing these constants only breaks your launch.
 */
export const PROTOCOL_SPLIT = {
  /** Creator's share of LP fees, in basis points. Splittable across up to 5 wallets. */
  CREATOR_BPS: 7500,
  /** $cc0company stakers' share — enforced on-chain. */
  STAKING_BPS: 1500,
  /** cc0.company treasury share — enforced on-chain. */
  TREASURY_BPS: 1000,
} as const;

/**
 * The PAIRED-launch fee split (pool paired with an arbitrary ERC-20 instead of WETH),
 * enforced on-chain by the factory: 80% creator / 20% treasury — NO staking slice
 * (staking rewards are WETH-only; a paired-token slice would strand in the fee locker).
 * Both slices take fees in BOTH pool tokens.
 */
export const PAIRED_SPLIT = {
  /** Creator's share of LP fees for paired launches, in basis points. */
  CREATOR_BPS: 8000,
  /** cc0.company treasury share for paired launches — enforced on-chain. */
  TREASURY_BPS: 2000,
} as const;

/** On-chain extension minimums (from the vault / airdrop contracts). */
export const VAULT_MIN_LOCKUP_SECONDS = 7 * 86400; // 7 days
export const AIRDROP_MIN_LOCKUP_SECONDS = 86400; // 1 day

// ═══ PAIRED launchpad (ERC-20) — a SEPARATE dual-mode suite, additive to the existing one ═══════
//
// PAIRED launches (pool vs an arbitrary ERC-20, enforced 80/20 creator/treasury, FeeIn.Both, no
// staking slice) require the dual-mode factory (weth ctor immutable + _checkCc0PairedSplit). The
// live suites in CC0_CONTRACTS above stay THE path for every standard WETH launch — they are never
// re-pointed, never deprecated, and tokens already launched keep resolving on them forever. This
// book only ADDS a second, independent suite used exclusively when `pairedToken` is set; while a
// chain's entry is unfilled, paired launches there fail closed and nothing else changes.

/** One PAIRED (dual-mode) ERC-20 launchpad deployment's address set. Pre-staged fields are ''. */
export interface Cc0PairedContracts {
  chainId: number;
  FACTORY: Address | '';
  HOOK_STATIC_FEE: Address | '';
  HOOK_DYNAMIC_FEE: Address | '';
  LOCKER: Address | '';
  MEV_BLOCK_DELAY: Address | '';
  MEV_SNIPER_TAX: Address | '';
  VAULT: Address | '';
  AIRDROP_V2: Address | '';
  DEV_BUY_V4: Address | '';
  /** Reused LIVE infra — shared with the standard suite on mainnet. */
  FEE_LOCKER: Address;
  STAKING: Address;
  WETH: Address;
  CC0COMPANY: Address;
}

/**
 * Per-chain PAIRED ERC-20 launchpad deployments. LIVE on Base (8453) and Robinhood Chain (4663);
 * a chain with no entry (or an empty factory) makes `isCc0PairedAvailable()` false and every
 * paired ERC-20 launch there fail closed, so nothing can silently target a non-existent factory.
 * Reused live infra (feeLocker/staking) is pre-filled — same shared fee locker as every launch.
 */
export const CC0_PAIRED_CONTRACTS: Partial<Record<Cc0ChainSlug, Cc0PairedContracts>> = {
  base: {
    chainId: 8453,
    // LIVE — deployed + Basescan-verified 11/11 on 2026-07-10 (DeployPairedSuite.s.sol).
    // The standard factory was NOT touched; MEV modules are the reused live ones.
    FACTORY: '0x6097FD2e8773cA8ED342aA8d9a999e05397e2705',
    HOOK_STATIC_FEE: '0x24E081f4DA1ce6f8C194A031ae7AeCB7910968cC',
    HOOK_DYNAMIC_FEE: '0x90d9960E70d737a5433Bbe725A8364128d9CA8cC',
    LOCKER: '0x402F8cb1fbd1292CcdD6C2f5e562Fee917C66Ab3',
    MEV_BLOCK_DELAY: '0x844a62e0e25E3754578A22F909ca462E150DdEa7',
    MEV_SNIPER_TAX: '0x94eBf54bbd4BD68F98F7A68a6C0f9f1A8c154FEC',
    VAULT: '0xa04aA26cF14D4C94f02f4a73382A2b61BbE0AdF7',
    AIRDROP_V2: '0x3eAe62D6EFCA8bb163c4177C105A22683dcC6650',
    DEV_BUY_V4: '0x0AAA146160cC58959a7AC6632C0f954D8791cCe7',
    FEE_LOCKER: '0xC04bdF721FA5CEc839819864FA86F3D48B89Fcee',
    STAKING: '0x38cE743b88c54eD1aF84816Ff596E518d16DFF95',
    WETH: '0x4200000000000000000000000000000000000006',
    CC0COMPANY: '0x67c5F00491c09cbCF6359f95690574E6106bb3CF',
  },
  robinhood: {
    chainId: 4663,
    // LIVE — deployed + Blockscout-verified 9/9 (robinhoodchain.blockscout.com).
    // The standard RH factory (0x79F331d3…) was NOT touched: existing Robinhood tokens keep
    // their pages, swaps and fee claims on it. This suite is used ONLY when `pairedToken` is
    // set — which on RH means pairing against one of the 100+ official tokenized stocks.
    FACTORY: '0x65D667870E7B5b4b7113e5BaB255efE052cf3B36',
    HOOK_STATIC_FEE: '0x3f27fB70d91ad868FD6b94dB67CB919b38B7E8cC',
    HOOK_DYNAMIC_FEE: '0xE461d34701abCD106663fb54d8E49ad253a6a8cC',
    LOCKER: '0x4FbAccF2CC6aA1F93a99eA087003Ad61af6608CA',
    MEV_BLOCK_DELAY: '0x0De94068195C5d85e31406804357F44E0D20E255',
    MEV_SNIPER_TAX: '0x70baFfe8783396142385Ece53f2cDF8D1cf9872C',
    VAULT: '0xE3D6539B9Bc2E1b7e0Be45a7A97cc28714FF411B',
    AIRDROP_V2: '0xa8F76d9e1722548aE7981dFD0C039abd72705999',
    DEV_BUY_V4: '0x788350DF3F53202dBA9bED1Ce05488C6c2C75737',
    FEE_LOCKER: '0x343d77D94A119D5cEA495aeE8336A3a7Aa5CD385',
    /** Cc0StakingEscrow — unused by paired launches (80/20 has no staking slice); kept for
     *  shape parity with the standard book. */
    STAKING: '0xE4542b52Ed212bDcFb10f3C9F8A12f2cEeeF35b2',
    WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
    /** $cc0company lives on Base only — kept for shape parity. */
    CC0COMPANY: '0x67c5F00491c09cbCF6359f95690574E6106bb3CF',
  },
};

/**
 * The official Robinhood tokenized-stock issuer on Robinhood Chain (4663). Every one of the
 * 100+ tokenized stocks (AAPL, TSLA, NVDA, MSFT, SPY, QQQ, COIN, MSTR, GME, …) is a contract
 * this proxy created — all 18-decimals, named "<Company> • Robinhood Token". Any of them can
 * be the `pairedToken` of a paired launch on RH.
 *
 * Enumerate them from the explorer's internal-transactions feed:
 *   GET https://robinhoodchain.blockscout.com/api/v2/addresses/{issuer}/internal-transactions
 *   → paginate via `next_page_params`, keep items where /create/i.test(item.type),
 *     take `item.created_contract.hash`, then resolve symbol()/name()/decimals() on-chain.
 */
export const ROBINHOOD_TOKENIZED_STOCK_ISSUER =
  '0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046' as Address;

/** PAIRED-suite address book for a chain, or null when not deployed/filled there (fail-closed). */
export function getCc0PairedContracts(chain?: Cc0Chain): Cc0PairedContracts | null {
  const c = CC0_PAIRED_CONTRACTS[toChainSlug(chain)] ?? null;
  return c && /^0x[a-fA-F0-9]{40}$/.test(c.FACTORY) ? c : null;
}

/** True when paired (80/20) ERC-20 launches are possible on `chain` (fail-closed). */
export function isCc0PairedAvailable(chain?: Cc0Chain): boolean {
  return getCc0PairedContracts(chain) !== null;
}

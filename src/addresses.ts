import type { Address } from 'viem';

/**
 * cc0.company contracts on Base mainnet (chain 8453).
 * Every contract is verified on Basescan — see https://cc0.company/docs/smart-contracts.
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
} as const;

/**
 * The protocol fee split, enforced ON-CHAIN by the factory at every launch.
 * Configs that drop or resize the staking/treasury slices revert
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

/** On-chain extension minimums (from the vault / airdrop contracts). */
export const VAULT_MIN_LOCKUP_SECONDS = 7 * 86400; // 7 days
export const AIRDROP_MIN_LOCKUP_SECONDS = 86400; // 1 day

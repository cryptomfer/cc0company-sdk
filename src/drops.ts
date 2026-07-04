/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Cc0Drops — IPFS NFT drops (CC0Drop ERC721-C + CC0Drop1155) for cc0.company
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  The full IPFS drop lifecycle, agent-first (generative onchain collections
 *  are a separate, human-wizard-only flow):
 *
 *    pin art → pin metadata → deploy (1 sig) → record on cc0.company →
 *    phases / allowlist / royalties / airdrops / withdraw / seal →
 *    open-edition numbering → NEW editions on a live 1155 → mint.
 *
 *  Contracts are the platform's audited CC0Drop / CC0Drop1155 (ERC721-C /
 *  ERC1155-C, Limit Break enforcement seeded in the constructor, 5% platform
 *  fee baked in the bytecode). ABI + creation bytecode are fetched from the
 *  registry's public artifacts endpoint — deploys of those exact bytecodes
 *  auto-verify on Basescan via Similar Match.
 *
 *  AUTH — two credentials, resolved automatically:
 *    · wallet signature (preferred): the SDK signs the SIWE-style message
 *      "cc0.company:agent-auth:<unix_ms>" with your walletClient/account, or
 *      with `sender.signMessage` if your ExternalSender provides it (Bankr
 *      smart wallets validate via EIP-1271). Sent as the X-Owner-* trio.
 *    · agentApiKey (legacy): passed as Authorization: Bearer.
 *  Purely on-chain methods need NO HTTP auth at all.
 *
 *  BANKR / signer-only integrations: `resolveAgent()` fetches your agent
 *  identity + profile from the wallet address alone (public endpoint), so
 *  drops are attributed to the right profile without any credential.
 *
 *  ETH-ONLY MVP: drops priced in an ERC-20 store token are not covered here
 *  (deploys use the ETH payment path; mints check paymentToken and refuse
 *  ERC-20-priced drops with an actionable error).
 */

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getAddress,
  http,
  keccak256,
  parseEther,
  zeroAddress,
  type Abi,
  type Account,
  type Address,
  type Hash,
  type Hex,
  type WalletClient,
} from 'viem';

import {
  DEFAULT_RPCS,
  VIEM_CHAINS,
  toChainSlug,
  type Cc0Chain,
  type Cc0ChainSlug,
} from './addresses';
import {
  assertTxHash,
  estimateEip1559Fees,
  toPreparedTx,
  type ExternalSender,
} from './launchpad';

// ─── Constants ───────────────────────────────────────────────────────────────

export const EMPTY_MERKLE_ROOT: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

const AGENT_AUTH_SCOPE = 'cc0.company:agent-auth';

/** Gas fallback ceilings (estimate × 1.2 is used when estimation succeeds). */
const GAS_FALLBACK_CALL = BigInt(900_000);
const GAS_FALLBACK_MINT = BigInt(500_000);

// ─── Minimal ABI fragments (management + mint; full ABI is fetched for deploys) ──

const PHASE_COMPONENTS = [
  { name: 'enabled', type: 'bool' },
  { name: 'price', type: 'uint256' },
  { name: 'start', type: 'uint256' },
  { name: 'end', type: 'uint256' },
  { name: 'maxPerWallet', type: 'uint256' },
] as const;

const AL_PHASE_COMPONENTS = [
  ...PHASE_COMPONENTS,
  { name: 'maxSupplyForPhase', type: 'uint256' },
] as const;

/** CC0Drop (ERC721-C) — owner + mint + view fragments. */
export const CC0_DROP_ABI = [
  // views
  { name: 'publicPhase', type: 'function', stateMutability: 'view', inputs: [], outputs: PHASE_COMPONENTS as unknown as { name: string; type: string }[] },
  { name: 'allowlistPhase', type: 'function', stateMutability: 'view', inputs: [], outputs: AL_PHASE_COMPONENTS as unknown as { name: string; type: string }[] },
  { name: 'merkleRoot', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { name: 'maxSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalMinted', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'paymentToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'isContractSealed', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  // mints
  { name: 'mint', type: 'function', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }], outputs: [] },
  { name: 'mintTo', type: 'function', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { name: 'mintAllowlist', type: 'function', stateMutability: 'payable', inputs: [{ name: 'quantity', type: 'uint256' }, { name: 'maxQuantity', type: 'uint256' }, { name: 'merkleProof', type: 'bytes32[]' }], outputs: [] },
  // owner
  { name: 'setPublicPhase', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newPhase', type: 'tuple', components: PHASE_COMPONENTS as unknown as { name: string; type: string }[] }], outputs: [] },
  { name: 'setAllowlistPhase', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newPhase', type: 'tuple', components: AL_PHASE_COMPONENTS as unknown as { name: string; type: string }[] }], outputs: [] },
  { name: 'setMerkleRoot', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'root', type: 'bytes32' }], outputs: [] },
  { name: 'setBaseURI', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newBaseURI', type: 'string' }], outputs: [] },
  { name: 'setContractURI', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newContractURI', type: 'string' }], outputs: [] },
  { name: 'setRoyalty', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'bps', type: 'uint96' }], outputs: [] },
  { name: 'sealContract', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'ownerMint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'quantity', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'withdrawERC20', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'erc20', type: 'address' }], outputs: [] },
  { name: 'transferOwnership', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
] as const;

/** CC0Drop1155 (ERC1155-C) — everything is keyed by tokenId. */
export const CC0_DROP_1155_ABI = [
  // views
  { name: 'publicPhase', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: PHASE_COMPONENTS as unknown as { name: string; type: string }[] },
  { name: 'allowlistPhase', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: AL_PHASE_COMPONENTS as unknown as { name: string; type: string }[] },
  { name: 'merkleRoot', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'bytes32' }] },
  { name: 'maxSupply', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'totalMinted', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'editionExists', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'editionClosed', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'owner', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { name: 'paymentToken', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  // mints
  { name: 'mint', type: 'function', stateMutability: 'payable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'quantity', type: 'uint256' }], outputs: [] },
  { name: 'mintAllowlist', type: 'function', stateMutability: 'payable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'quantity', type: 'uint256' }, { name: 'maxQuantity', type: 'uint256' }, { name: 'merkleProof', type: 'bytes32[]' }], outputs: [] },
  // owner
  {
    name: 'createEdition', type: 'function', stateMutability: 'nonpayable', outputs: [],
    inputs: [{
      name: 'e', type: 'tuple',
      components: [
        { name: 'tokenId', type: 'uint256' },
        { name: 'maxSupply', type: 'uint256' },
        { name: 'publicPhase', type: 'tuple', components: PHASE_COMPONENTS as unknown as { name: string; type: string }[] },
        { name: 'allowlistPhase', type: 'tuple', components: AL_PHASE_COMPONENTS as unknown as { name: string; type: string }[] },
        { name: 'merkleRoot', type: 'bytes32' },
      ],
    }],
  },
  { name: 'setPublicPhase', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'newPhase', type: 'tuple', components: PHASE_COMPONENTS as unknown as { name: string; type: string }[] }], outputs: [] },
  { name: 'setAllowlistPhase', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'newPhase', type: 'tuple', components: AL_PHASE_COMPONENTS as unknown as { name: string; type: string }[] }], outputs: [] },
  { name: 'setMerkleRoot', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'root', type: 'bytes32' }], outputs: [] },
  { name: 'setMaxSupply', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'newMax', type: 'uint256' }], outputs: [] },
  { name: 'setBaseURI', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newBaseURI', type: 'string' }], outputs: [] },
  { name: 'setContractURI', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newContractURI', type: 'string' }], outputs: [] },
  { name: 'setRoyalty', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'recipient', type: 'address' }, { name: 'bps', type: 'uint96' }], outputs: [] },
  { name: 'sealContract', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'ownerMint', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'tokenId', type: 'uint256' }, { name: 'quantity', type: 'uint256' }, { name: 'to', type: 'address' }], outputs: [] },
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { name: 'withdrawERC20', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'erc20', type: 'address' }], outputs: [] },
  { name: 'transferOwnership', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'newOwner', type: 'address' }], outputs: [] },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Cc0DropsConfig {
  /** 'base' (default) or 'ethereum'. Drops are not deployed on Robinhood Chain. */
  chain?: Cc0Chain;
  /** viem/wagmi WalletClient (must carry .account). Signs txs AND auth messages. */
  walletClient?: WalletClient;
  /** viem Account (e.g. privateKeyToAccount) — wrapped in an internal WalletClient. */
  account?: Account;
  /** Provider-agnostic signer (CDP/Bankr/Safe). On-chain CALLS + (with
   *  signMessage) authed HTTP routes work; raw contract DEPLOYS do not —
   *  use walletClient/account for deploys. */
  sender?: ExternalSender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient?: any;
  /** cc0.company front origin (the SDK talks to its /api proxies). */
  registryUrl?: string;
  /** Legacy agent API key — fallback credential for the authed HTTP routes
   *  when no signer can produce a wallet signature. */
  agentApiKey?: string;
}

export interface AllowlistEntry {
  address: string;
  /** Per-wallet max mint quantity — part of the merkle leaf identity. */
  quantity: number;
}

/** Public phase config. Times are unix SECONDS; 0 = unbounded on that side. */
export interface PhaseInput {
  enabled?: boolean;
  priceEth?: string;
  start?: number;
  end?: number;
  maxPerWallet?: number;
}

export interface AllowlistPhaseInput extends PhaseInput {
  maxSupplyForPhase?: number;
}

export interface DeployDrop721Params {
  name: string;
  symbol: string;
  /** From pinDropMetadata(): no trailing slash = one shared metadata doc
   *  (open edition); trailing slash = per-token folder (tokenURI = baseURI+id). */
  baseURI: string;
  contractURI?: string;
  /** 0 = open edition (unlimited). */
  maxSupply: number;
  publicPhase?: PhaseInput;
  allowlist?: AllowlistPhaseInput & { entries: AllowlistEntry[] };
  royaltyBps?: number;
  royaltyRecipient?: Address;
  /** Receives 100% of creator proceeds on withdraw(). Default: the signer. */
  creatorPayout?: Address;
  /** Persist the drop on cc0.company after deploy (default true). */
  record?: boolean;
  /** Record enrichment (all optional). */
  description?: string;
  collectionImage?: string;
  socialLinks?: { website?: string; x?: string; telegram?: string; discord?: string };
}

export interface EditionInput {
  /** Defaults to 1 for the first edition. */
  tokenId?: number;
  /** 0 = open edition. WARNING: an open edition whose window passes is closed FOREVER. */
  maxSupply: number;
  publicPhase?: PhaseInput;
  allowlist?: AllowlistPhaseInput & { entries: AllowlistEntry[] };
}

export interface DeployDrop1155Params extends Omit<DeployDrop721Params, 'maxSupply' | 'allowlist' | 'publicPhase'> {
  firstEdition: EditionInput;
}

export interface DeployDropResult {
  contractAddress: Address;
  txHash: Hash;
  /** Whether the cc0.company record was persisted (best-effort). */
  recorded: boolean;
}

export interface PinResult {
  ipfsUri: string;
  url: string;
  ipfsHash: string;
}

export interface DropMetadataInput {
  name: string;
  description?: string;
  /** ipfs:// or https:// URI (pin the art with pinArt() first). Required
   *  unless every entry in `editions` carries its own image. */
  image?: string;
  animationUrl?: string;
  externalUrl?: string;
  attributes?: Array<{ trait_type: string; value: string | number }>;
  royaltyBps?: number;
  royaltyRecipient?: Address;
  /** Per-token metadata (limited-edition sets & 1155 editions): files "1".."N"
   *  are pinned as an IPFS folder and baseURI gets a trailing slash. */
  editions?: Array<{ image?: string; name?: string; description?: string; attributes?: Array<{ trait_type: string; value: string | number }> }>;
}

export interface PinDropMetadataResult {
  baseURI: string;
  contractURI: string;
}

// ─── Merkle allowlist (byte-identical to the platform's allowlist-tree.ts) ──
//
// Leaf = keccak256(abi.encodePacked(address, uint256 quantity)), OpenZeppelin
// sorted-pair hashing, odd layers duplicate the last node, duplicates deduped
// keeping the FIRST occurrence. A root computed here verifies against proofs
// computed here AND against the CC0Drop/CC0Drop1155 onchain verifier.

function hashAllowlistLeaf(entry: AllowlistEntry): Hex {
  const checksummed = getAddress(entry.address);
  return keccak256(
    encodePacked(['address', 'uint256'], [checksummed, BigInt(entry.quantity)]),
  );
}

function hashPair(a: Hex, b: Hex): Hex {
  const [low, high] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(encodePacked(['bytes32', 'bytes32'], [low, high]));
}

function dedupeEntries(entries: AllowlistEntry[]): AllowlistEntry[] {
  const seen = new Set<string>();
  const unique: AllowlistEntry[] = [];
  for (const e of entries) {
    const key = e.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return unique;
}

/** Merkle root for an allowlist. Empty set → bytes32(0) = "no allowlist". */
export function computeAllowlistRoot(entries: AllowlistEntry[]): Hex {
  if (entries.length === 0) return EMPTY_MERKLE_ROOT;
  let layer: Hex[] = dedupeEntries(entries).map(hashAllowlistLeaf);
  while (layer.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : left;
      next.push(hashPair(left, right));
    }
    layer = next;
  }
  return layer[0];
}

/** Sibling-hash proof for one wallet. [] when absent (or for a 1-entry list — valid). */
export function computeAllowlistProof(entries: AllowlistEntry[], targetAddress: string): Hex[] {
  if (entries.length === 0) return [];
  const unique = dedupeEntries(entries);
  const targetLower = targetAddress.toLowerCase();
  let index = unique.findIndex((e) => e.address.toLowerCase() === targetLower);
  if (index === -1) return [];
  let layer: Hex[] = unique.map(hashAllowlistLeaf);
  const proof: Hex[] = [];
  while (layer.length > 1) {
    const siblingIndex = index % 2 === 1 ? index - 1 : index + 1;
    proof.push(siblingIndex < layer.length ? layer[siblingIndex] : layer[index]);
    const next: Hex[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : left;
      next.push(hashPair(left, right));
    }
    layer = next;
    index = Math.floor(index / 2);
  }
  return proof;
}

// ─── Phase builders (mirror useDeployCC0Drop's fail-closed defaults) ─────────

interface PhaseStruct {
  enabled: boolean; price: bigint; start: bigint; end: bigint; maxPerWallet: bigint;
}
interface AlPhaseStruct extends PhaseStruct { maxSupplyForPhase: bigint }

function buildPublicPhase(p?: PhaseInput): PhaseStruct {
  const enabled = p?.enabled !== false;
  const now = Math.floor(Date.now() / 1000);
  return {
    enabled,
    price: parseEther(p?.priceEth || '0'),
    start: BigInt(p?.start ?? (enabled ? now - 60 : 0)),
    end: BigInt(p?.end ?? (enabled ? now + 30 * 86400 : 0)),
    maxPerWallet: BigInt(Math.max(0, p?.maxPerWallet || 0)),
  };
}

function buildAllowlistPhase(al?: AllowlistPhaseInput & { entries?: AllowlistEntry[] }): AlPhaseStruct {
  const enabled = !!al && (al.entries?.length ?? 0) > 0;
  return {
    enabled,
    price: parseEther(al?.priceEth || '0'),
    start: BigInt(al?.start ?? 0),
    end: BigInt(al?.end ?? 0),
    // Per-leaf quantity carries the cap; the phase-level cap stays 0 like the dashboard.
    maxPerWallet: BigInt(al?.maxPerWallet ?? 0),
    maxSupplyForPhase: BigInt(al?.maxSupplyForPhase ?? 0),
  };
}

// ─── The client ──────────────────────────────────────────────────────────────

/**
 * IPFS NFT drops on cc0.company — deploy, manage and mint CC0Drop (ERC721-C)
 * and CC0Drop1155 collections with any signer.
 *
 * ```ts
 * import { Cc0Drops } from '@cc0company/sdk';
 *
 * const drops = new Cc0Drops({ walletClient });
 *
 * const art = await drops.pinArt(pngBytes, 'art.png');
 * const meta = await drops.pinDropMetadata({ name: 'My Drop', image: art.ipfsUri });
 * const { contractAddress } = await drops.deployDrop721({
 *   name: 'My Drop', symbol: 'DROP',
 *   baseURI: meta.baseURI, contractURI: meta.contractURI,
 *   maxSupply: 1000, publicPhase: { priceEth: '0.001' },
 * });
 * // later: manage exactly like the dashboard
 * await drops.setAllowlist721(contractAddress, [{ address: '0x…', quantity: 2 }]);
 * await drops.mint721(contractAddress, 1);
 * ```
 */
export class Cc0Drops {
  public readonly walletClient?: WalletClient;
  public readonly sender?: ExternalSender;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public readonly publicClient: any;
  public readonly chainSlug: Cc0ChainSlug;
  public readonly chainId: number;
  public readonly chain;
  public readonly registryUrl: string;
  private readonly agentApiKey?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private artifactsCache: any = null;

  constructor(config: Cc0DropsConfig = {}) {
    this.chainSlug = toChainSlug(config.chain);
    if (this.chainSlug === 'robinhood') {
      throw new Error(
        "NFT drops are not deployed on Robinhood Chain — pass chain: 'base' (default) or 'ethereum'.",
      );
    }
    this.chain = VIEM_CHAINS[this.chainSlug];
    this.chainId = this.chain.id;
    if (config.walletClient) {
      this.walletClient = config.walletClient;
    } else if (config.account) {
      this.walletClient = createWalletClient({
        account: config.account,
        chain: this.chain,
        transport: http(DEFAULT_RPCS[this.chainSlug]),
      });
    }
    this.sender = config.sender;
    this.publicClient =
      config.publicClient ??
      createPublicClient({ chain: this.chain, transport: http(DEFAULT_RPCS[this.chainSlug]) });
    this.registryUrl = (config.registryUrl ?? 'https://cc0.company').replace(/\/+$/, '');
    this.agentApiKey = config.agentApiKey;
  }

  // ─── Identity & auth ───────────────────────────────────────────────────────

  private signerAddress(): Address {
    if (this.walletClient?.account) return this.walletClient.account.address;
    if (this.sender) return this.sender.address;
    throw new Error(
      'No signer configured. Pass walletClient, account, or sender to the constructor.',
    );
  }

  /**
   * Sign the agent-auth message and return the X-Owner-* header trio. Works
   * with walletClient/account natively, or an ExternalSender that provides
   * signMessage (Bankr smart wallets verify via EIP-1271 server-side).
   */
  async signAgentAuth(scope: string = AGENT_AUTH_SCOPE): Promise<Record<string, string>> {
    const message = `${scope}:${Date.now()}`;
    let signature: Hex;
    if (this.walletClient?.account) {
      signature = await this.walletClient.signMessage({
        account: this.walletClient.account,
        message,
      });
    } else if (this.sender?.signMessage) {
      signature = await this.sender.signMessage(message);
    } else {
      throw new Error(
        'This route needs an authenticated agent. Provide a walletClient/account, an ' +
          'ExternalSender with signMessage, or an agentApiKey in the constructor.',
      );
    }
    return {
      'X-Owner-Address': this.signerAddress(),
      'X-Owner-Signature': signature,
      'X-Owner-Message': message,
    };
  }

  /** Auth headers for the pin routes: wallet signature first, API key fallback. */
  private async authedHeaders(): Promise<Record<string, string>> {
    const canSign = !!this.walletClient?.account || !!this.sender?.signMessage;
    if (canSign) return this.signAgentAuth();
    if (this.agentApiKey) return { Authorization: `Bearer ${this.agentApiKey}` };
    throw new Error(
      'This route needs an authenticated agent. Provide a walletClient/account, an ' +
        'ExternalSender with signMessage, or an agentApiKey in the constructor.',
    );
  }

  /**
   * Resolve the agent registered for the configured signer's wallet — the
   * "who am I" for signer-only (Bankr) integrations. Public data only; used
   * to attribute drop records to your profile automatically.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async resolveAgent(): Promise<any> {
    const address = this.signerAddress();
    const res = await fetch(`${this.registryUrl}/api/store/agents/by-wallet/${address}`);
    if (res.status === 404) {
      throw new Error(
        `No agent is registered for wallet ${address}. Register first: POST /store/agents/register ` +
          'with a signed "cc0.company:agent-register:<unix_ms>" proof.',
      );
    }
    if (!res.ok) throw new Error(`Agent lookup failed (${res.status}).`);
    const json = await res.json();
    return json.agent;
  }

  // ─── Pinning ───────────────────────────────────────────────────────────────

  /**
   * Pin artwork to IPFS via cc0.company (Pinata-backed). Accepts raw bytes,
   * a Blob, or a base64 / data: URL string. Max 10MB; jpeg/png/gif/webp/svg.
   */
  async pinArt(input: Uint8Array | ArrayBuffer | Blob | string, filename?: string): Promise<PinResult> {
    const headers = await this.authedHeaders();
    let res: Response;
    if (typeof input === 'string') {
      res = await fetch(`${this.registryUrl}/api/upload`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: input, filename }),
      });
    } else {
      // BlobPart cast: TS 5.7 DOM typings reject Uint8Array<ArrayBufferLike>
      // (SharedArrayBuffer strictness) — runtime behavior is identical.
      const blob =
        input instanceof Blob
          ? input
          : new Blob([(input instanceof ArrayBuffer ? new Uint8Array(input) : input) as unknown as BlobPart]);
      const form = new FormData();
      form.append('file', blob, filename ?? `art_${Date.now()}.png`);
      res = await fetch(`${this.registryUrl}/api/upload`, { method: 'POST', headers, body: form });
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      throw new Error(`Art pinning failed (${res.status}): ${json?.error ?? 'unknown error'}`);
    }
    return { ipfsUri: `ipfs://${json.ipfsHash}`, url: json.url, ipfsHash: json.ipfsHash };
  }

  /**
   * Pin the drop's metadata JSON(s). Without `editions`: ONE shared token
   * metadata (open-edition; baseURI has NO trailing slash). With `editions`:
   * an IPFS folder "1".."N" (baseURI HAS a trailing slash; tokenURI = baseURI+id).
   */
  async pinDropMetadata(params: DropMetadataInput): Promise<PinDropMetadataResult & { editions?: number }> {
    const headers = await this.authedHeaders();
    const res = await fetch(`${this.registryUrl}/api/store/nft-minting/seadrop/pin`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: params.name,
        description: params.description,
        image: params.image,
        animationUrl: params.animationUrl,
        externalUrl: params.externalUrl,
        attributes: params.attributes,
        royaltyBps: params.royaltyBps,
        royaltyRecipient: params.royaltyRecipient,
        editions: params.editions,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      throw new Error(`Metadata pinning failed (${res.status}): ${json?.error ?? 'unknown error'}`);
    }
    return { baseURI: json.baseURI, contractURI: json.contractURI, editions: json.editions };
  }

  // ─── Artifacts (ABI + creation bytecode from the registry) ────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getArtifacts(): Promise<any> {
    if (this.artifactsCache) return this.artifactsCache;
    const res = await fetch(`${this.registryUrl}/api/store/nft-minting/drop/artifacts`);
    if (!res.ok) throw new Error(`Could not fetch drop artifacts (${res.status}).`);
    const json = await res.json();
    if (!json?.contracts?.erc721?.bytecode || !json?.contracts?.erc1155?.bytecode) {
      throw new Error('Drop artifacts endpoint returned an unexpected shape.');
    }
    // Fail-closed: the 5% platform fee recipient comes from the registry, never
    // hardcoded here. A null value means the deployment env is misconfigured.
    if (!json.platformFeeRecipient) {
      throw new Error(
        'The registry did not provide a platform fee recipient — deploys are disabled until it does.',
      );
    }
    this.artifactsCache = json;
    return json;
  }

  // ─── Deploys (walletClient/account only — raw CREATE txs) ─────────────────

  private deployClient(): WalletClient {
    if (!this.walletClient?.account) {
      throw new Error(
        'Contract deploys need a walletClient or account (a raw contract-creation tx has no `to`, ' +
          'which ExternalSender transports cannot express). Managing and minting work with any signer.',
      );
    }
    return this.walletClient;
  }

  /** Deploy a CC0Drop (ERC721-C) — one signature — then record it on cc0.company. */
  async deployDrop721(p: DeployDrop721Params): Promise<DeployDropResult> {
    const wallet = this.deployClient();
    const artifacts = await this.getArtifacts();
    const creator = this.signerAddress();
    const royaltyRecipient = p.royaltyRecipient ?? creator;
    const creatorPayout = p.creatorPayout ?? creator;
    const publicPhase = buildPublicPhase(p.publicPhase);
    const allowlistPhase = buildAllowlistPhase(p.allowlist);
    const root = p.allowlist?.entries?.length ? computeAllowlistRoot(p.allowlist.entries) : EMPTY_MERKLE_ROOT;

    const hash = await wallet.deployContract({
      account: wallet.account!,
      chain: this.chain,
      abi: artifacts.contracts.erc721.abi as Abi,
      bytecode: artifacts.contracts.erc721.bytecode as Hex,
      args: [
        p.name,
        p.symbol,
        p.baseURI,
        p.contractURI ?? '',
        BigInt(p.maxSupply),
        zeroAddress, // ETH payment
        publicPhase,
        allowlistPhase,
        root,
        [{ recipient: creatorPayout, percentage: BigInt(10000) }],
        royaltyRecipient,
        BigInt(p.royaltyBps ?? 0),
        artifacts.platformFeeRecipient as Address,
        creator, // _owner
      ],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const contractAddress = receipt.contractAddress as Address | null;
    if (!contractAddress) throw new Error('Deploy receipt carried no contract address.');

    let recorded = false;
    if (p.record !== false) {
      recorded = await this.recordDrop({
        contractAddress,
        name: p.name,
        symbol: p.symbol,
        baseURI: p.baseURI,
        contractURI: p.contractURI,
        description: p.description,
        deploymentTxHash: hash,
        maxSupply: p.maxSupply,
        mintPriceEth: p.publicPhase?.priceEth,
        royaltyBps: p.royaltyBps,
        royaltyRecipient,
        maxPerWallet: p.publicPhase?.maxPerWallet,
        collectionImage: p.collectionImage,
        socialLinks: p.socialLinks,
        tokenStandard: 'ERC721',
        allowlist: p.allowlist?.entries?.length
          ? { root, entries: p.allowlist.entries, phase: p.allowlist }
          : undefined,
      });
    }
    return { contractAddress, txHash: hash, recorded };
  }

  /** Deploy a CC0Drop1155 with its FIRST edition — one signature — then record. */
  async deployDrop1155(p: DeployDrop1155Params): Promise<DeployDropResult & { tokenId: number }> {
    const wallet = this.deployClient();
    const artifacts = await this.getArtifacts();
    const creator = this.signerAddress();
    const royaltyRecipient = p.royaltyRecipient ?? creator;
    const creatorPayout = p.creatorPayout ?? creator;
    const ed = p.firstEdition;
    const tokenId = ed.tokenId ?? 1;
    const root = ed.allowlist?.entries?.length ? computeAllowlistRoot(ed.allowlist.entries) : EMPTY_MERKLE_ROOT;

    const hash = await wallet.deployContract({
      account: wallet.account!,
      chain: this.chain,
      abi: artifacts.contracts.erc1155.abi as Abi,
      bytecode: artifacts.contracts.erc1155.bytecode as Hex,
      args: [
        p.name,
        p.symbol,
        p.baseURI,
        p.contractURI ?? '',
        zeroAddress, // ETH payment
        {
          tokenId: BigInt(tokenId),
          maxSupply: BigInt(ed.maxSupply),
          publicPhase: buildPublicPhase(ed.publicPhase),
          allowlistPhase: buildAllowlistPhase(ed.allowlist),
          merkleRoot: root,
        },
        [{ recipient: creatorPayout, percentage: BigInt(10000) }],
        royaltyRecipient,
        BigInt(p.royaltyBps ?? 0),
        artifacts.platformFeeRecipient as Address,
        creator,
      ],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const contractAddress = receipt.contractAddress as Address | null;
    if (!contractAddress) throw new Error('Deploy receipt carried no contract address.');

    let recorded = false;
    if (p.record !== false) {
      recorded = await this.recordDrop({
        contractAddress,
        name: p.name,
        symbol: p.symbol,
        baseURI: p.baseURI,
        contractURI: p.contractURI,
        description: p.description,
        deploymentTxHash: hash,
        maxSupply: ed.maxSupply,
        mintPriceEth: ed.publicPhase?.priceEth,
        royaltyBps: p.royaltyBps,
        royaltyRecipient,
        collectionImage: p.collectionImage,
        socialLinks: p.socialLinks,
        tokenStandard: 'ERC1155',
        tokenId1155: tokenId,
        allowlist: ed.allowlist?.entries?.length
          ? { root, entries: ed.allowlist.entries, phase: ed.allowlist }
          : undefined,
      });
    }
    return { contractAddress, txHash: hash, recorded, tokenId };
  }

  // ─── Record (cc0.company persistence — best-effort, like registerLaunch) ──

  /**
   * Persist a deployed drop on cc0.company (drop page, home, search). The
   * record is attributed to YOUR agent profile (resolved from the signer's
   * wallet). Returns false instead of throwing — the drop is onchain either way.
   */
  async recordDrop(p: {
    contractAddress: Address;
    name: string;
    baseURI: string;
    symbol?: string;
    contractURI?: string;
    description?: string;
    deploymentTxHash?: Hash;
    maxSupply?: number;
    mintPriceEth?: string;
    royaltyBps?: number;
    royaltyRecipient?: Address;
    maxPerWallet?: number;
    collectionImage?: string;
    socialLinks?: { website?: string; x?: string; telegram?: string; discord?: string };
    tokenStandard?: 'ERC721' | 'ERC1155';
    tokenId1155?: number;
    /** Attribution override; defaults to your agent's profile via resolveAgent(). */
    profileId?: string;
    allowlist?: { root: Hex; entries: AllowlistEntry[]; phase?: AllowlistPhaseInput };
  }): Promise<boolean> {
    try {
      let profileId = p.profileId;
      if (!profileId) {
        const agent = await this.resolveAgent();
        profileId = agent?.profile_id;
      }
      if (!profileId) return false;
      const res = await fetch(`${this.registryUrl}/api/store/nft-minting/seadrop/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: p.name,
          symbol: p.symbol,
          description: p.description,
          contract_address: p.contractAddress,
          base_uri: p.baseURI,
          contract_uri: p.contractURI,
          chain: this.chainSlug,
          deployment_tx_hash: p.deploymentTxHash,
          max_supply: p.maxSupply != null ? String(p.maxSupply) : undefined,
          mint_price: p.mintPriceEth,
          royalty_bps: p.royaltyBps,
          royalty_recipient: p.royaltyRecipient,
          max_per_wallet: p.maxPerWallet,
          collection_image: p.collectionImage,
          social_links: p.socialLinks ?? null,
          drop_contract: 'cc0drop',
          token_standard: p.tokenStandard ?? 'ERC721',
          token_id_1155: p.tokenId1155,
          profile_id: profileId,
          seadrop_allowlist: p.allowlist
            ? {
                kind: 'cc0drop',
                merkleRoot: p.allowlist.root,
                phase: {
                  priceEth: p.allowlist.phase?.priceEth ?? '0',
                  startTime: p.allowlist.phase?.start ?? 0,
                  endTime: p.allowlist.phase?.end ?? 0,
                  maxSupplyForPhase: p.allowlist.phase?.maxSupplyForPhase ?? 0,
                },
                entries: dedupeEntries(p.allowlist.entries).map((e) => ({
                  address: e.address.toLowerCase(),
                  quantity: Math.max(1, Math.floor(e.quantity)),
                })),
              }
            : undefined,
        }),
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(15_000) : undefined,
      });
      return res.ok;
    } catch {
      /* best-effort — the drop lives onchain regardless */
      return false;
    }
  }

  // ─── Generic contract call (three-branch: walletClient / sender) ──────────

  private async call(
    address: Address,
    abi: Abi | readonly unknown[],
    functionName: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: any[],
    value: bigint = BigInt(0),
    gasFallback: bigint = GAS_FALLBACK_CALL,
  ): Promise<Hash> {
    let hash: Hash;
    if (this.walletClient?.account) {
      hash = await this.walletClient.writeContract({
        account: this.walletClient.account,
        address,
        abi: abi as Abi,
        functionName,
        args,
        chain: this.chain,
        value,
      });
    } else if (this.sender) {
      const data = encodeFunctionData({ abi: abi as Abi, functionName, args });
      let gas = gasFallback;
      try {
        const estimated = await this.publicClient.estimateGas({
          account: this.sender.address,
          to: address,
          data,
          ...(value > BigInt(0) ? { value } : {}),
        });
        gas = (estimated * BigInt(120)) / BigInt(100);
      } catch {
        /* keep the fallback ceiling */
      }
      const fees = await estimateEip1559Fees(this.publicClient);
      hash = await this.sender.send(toPreparedTx(address, data, value, gas, fees, this.chainId));
      assertTxHash(hash, 'Your sender.send()');
    } else {
      throw new Error(
        'No signer configured. Pass walletClient, account, or sender to the constructor.',
      );
    }
    await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    return hash;
  }

  // ─── Management — CC0Drop (721) ────────────────────────────────────────────

  /** Update the public phase (price / window / cap / on-off) — mirrors the dashboard's Save. */
  async setPublicPhase721(contract: Address, phase: PhaseInput): Promise<Hash> {
    return this.call(contract, CC0_DROP_ABI, 'setPublicPhase', [buildPublicPhase(phase)]);
  }

  /**
   * Set (or replace) the allowlist: onchain root + phase, then persist the
   * public preimage on cc0.company so the drop page can build proofs.
   * Two signatures, exactly like the dashboard.
   */
  async setAllowlist721(
    contract: Address,
    entries: AllowlistEntry[],
    phase?: AllowlistPhaseInput,
  ): Promise<{ root: Hex; txHashes: Hash[]; persisted: boolean }> {
    const unique = dedupeEntries(entries);
    if (unique.length === 0) {
      const cleared = await this.clearAllowlist721(contract);
      return { root: EMPTY_MERKLE_ROOT, txHashes: [cleared.txHash], persisted: cleared.persisted };
    }
    const root = computeAllowlistRoot(unique);
    const tx1 = await this.call(contract, CC0_DROP_ABI, 'setMerkleRoot', [root]);
    const tx2 = await this.call(contract, CC0_DROP_ABI, 'setAllowlistPhase', [
      { ...buildAllowlistPhase({ ...(phase ?? {}), entries: unique }), enabled: true },
    ]);
    const persisted = await this.persistAllowlistPreimage(contract, root, unique, phase);
    return { root, txHashes: [tx1, tx2], persisted };
  }

  /** Remove the allowlist (root → 0) + clear the stored preimage. */
  async clearAllowlist721(contract: Address): Promise<{ txHash: Hash; persisted: boolean }> {
    const txHash = await this.call(contract, CC0_DROP_ABI, 'setMerkleRoot', [EMPTY_MERKLE_ROOT]);
    const persisted = await this.persistAllowlistPreimage(contract, null, null, undefined);
    return { txHash, persisted };
  }

  private async persistAllowlistPreimage(
    contract: Address,
    root: Hex | null,
    entries: AllowlistEntry[] | null,
    phase?: AllowlistPhaseInput,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.registryUrl}/api/store/nft-minting/seadrop/allowlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contract_address: contract,
          seadrop_allowlist:
            root && entries
              ? {
                  kind: 'cc0drop',
                  merkleRoot: root,
                  phase: {
                    priceEth: phase?.priceEth ?? '0',
                    startTime: phase?.start ?? 0,
                    endTime: phase?.end ?? 0,
                    maxSupplyForPhase: phase?.maxSupplyForPhase ?? 0,
                  },
                  entries: entries.map((e) => ({
                    address: e.address.toLowerCase(),
                    quantity: Math.max(1, Math.floor(e.quantity)),
                  })),
                }
              : null,
        }),
      });
      return res.ok;
    } catch {
      /* preimage is deny-only public data; the onchain root is authoritative */
      return false;
    }
  }

  /** Point tokenURI at new metadata (reveal, art replacement). */
  async setBaseURI(contract: Address, baseURI: string, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'setBaseURI', [baseURI]);
  }

  async setContractURI(contract: Address, contractURI: string, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'setContractURI', [contractURI]);
  }

  async setRoyalty(contract: Address, recipient: Address, bps: number, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'setRoyalty', [recipient, BigInt(bps)]);
  }

  /** PERMANENT metadata freeze — after this every set* metadata call reverts. */
  async sealContract(contract: Address, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'sealContract', []);
  }

  /** Airdrop: owner-mint `quantity` to a wallet (defaults to the signer). */
  async ownerMint721(contract: Address, quantity: number, to?: Address): Promise<Hash> {
    return this.call(contract, CC0_DROP_ABI, 'ownerMint', [BigInt(quantity), to ?? this.signerAddress()]);
  }

  /** Withdraw accumulated ETH to the configured recipients (5% platform cut applies). */
  async withdraw(contract: Address, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'withdraw', []);
  }

  async withdrawERC20(contract: Address, erc20: Address, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'withdrawERC20', [erc20]);
  }

  async transferOwnership(contract: Address, newOwner: Address, is1155 = false): Promise<Hash> {
    return this.call(contract, is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI, 'transferOwnership', [newOwner]);
  }

  /**
   * Retrofit per-token numbering ("Name #1, #2…") on an open edition: the
   * registry mints a metadata slug and the contract's baseURI is pointed at
   * the numbered endpoint. One signature.
   */
  async enableOpenEditionNumbering(contract: Address): Promise<{ slug: string; baseURI: string; txHash: Hash }> {
    const res = await fetch(`${this.registryUrl}/api/store/nft-minting/oe/enable-numbering`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_address: contract }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) {
      throw new Error(`Could not enable numbering (${res.status}): ${json?.error ?? 'unknown error'}`);
    }
    const txHash = await this.setBaseURI(contract, json.base_uri);
    return { slug: json.slug, baseURI: json.base_uri, txHash };
  }

  /** Update the numbered open edition's served metadata (image/attributes/description). */
  async updateOpenEdition(
    contract: Address,
    fields: { imageUri?: string | null; attributes?: Array<{ trait_type: string; value: string }> | null; description?: string | null },
  ): Promise<boolean> {
    const res = await fetch(`${this.registryUrl}/api/store/nft-minting/oe/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contract_address: contract,
        ...(fields.imageUri !== undefined ? { image_uri: fields.imageUri } : {}),
        ...(fields.attributes !== undefined ? { attributes: fields.attributes } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
      }),
    });
    return res.ok;
  }

  // ─── Management — CC0Drop1155 (per-token) ─────────────────────────────────

  /**
   * Add a NEW edition to a live CC0Drop1155 — the dashboard flow: pin a fresh
   * metadata folder covering ALL editions (existing + new, files "1".."N"),
   * re-point baseURI at it, then createEdition. Two signatures + one pin.
   *
   * `allEditionsMetadata` MUST include every existing edition's metadata in
   * token-id order — the folder replaces the previous one wholesale.
   */
  async addEdition1155(
    contract: Address,
    edition: EditionInput & { tokenId: number },
    allEditionsMetadata: DropMetadataInput,
  ): Promise<{ tokenId: number; baseURI: string; txHashes: Hash[] }> {
    if (!allEditionsMetadata.editions?.length) {
      throw new Error(
        'addEdition1155 needs allEditionsMetadata.editions — the metadata of EVERY edition ' +
          '(existing + new, in token-id order), because the pinned folder replaces the previous one.',
      );
    }
    const pinned = await this.pinDropMetadata(allEditionsMetadata);
    const tx1 = await this.setBaseURI(contract, pinned.baseURI, true);
    const root = edition.allowlist?.entries?.length
      ? computeAllowlistRoot(edition.allowlist.entries)
      : EMPTY_MERKLE_ROOT;
    const tx2 = await this.call(contract, CC0_DROP_1155_ABI, 'createEdition', [
      {
        tokenId: BigInt(edition.tokenId),
        maxSupply: BigInt(edition.maxSupply),
        publicPhase: buildPublicPhase(edition.publicPhase),
        allowlistPhase: buildAllowlistPhase(edition.allowlist),
        merkleRoot: root,
      },
    ]);
    return { tokenId: edition.tokenId, baseURI: pinned.baseURI, txHashes: [tx1, tx2] };
  }

  /** Create an edition WITHOUT touching metadata (baseURI folder already covers its id). */
  async createEdition1155(contract: Address, edition: EditionInput & { tokenId: number }): Promise<Hash> {
    const root = edition.allowlist?.entries?.length
      ? computeAllowlistRoot(edition.allowlist.entries)
      : EMPTY_MERKLE_ROOT;
    return this.call(contract, CC0_DROP_1155_ABI, 'createEdition', [
      {
        tokenId: BigInt(edition.tokenId),
        maxSupply: BigInt(edition.maxSupply),
        publicPhase: buildPublicPhase(edition.publicPhase),
        allowlistPhase: buildAllowlistPhase(edition.allowlist),
        merkleRoot: root,
      },
    ]);
  }

  async setPublicPhase1155(contract: Address, tokenId: number, phase: PhaseInput): Promise<Hash> {
    return this.call(contract, CC0_DROP_1155_ABI, 'setPublicPhase', [BigInt(tokenId), buildPublicPhase(phase)]);
  }

  /** Per-token allowlist: setMerkleRoot(tokenId) + setAllowlistPhase(tokenId). */
  async setAllowlist1155(
    contract: Address,
    tokenId: number,
    entries: AllowlistEntry[],
    phase?: AllowlistPhaseInput,
  ): Promise<{ root: Hex; txHashes: Hash[] }> {
    const unique = dedupeEntries(entries);
    if (unique.length === 0) {
      const tx = await this.call(contract, CC0_DROP_1155_ABI, 'setMerkleRoot', [BigInt(tokenId), EMPTY_MERKLE_ROOT]);
      return { root: EMPTY_MERKLE_ROOT, txHashes: [tx] };
    }
    const root = computeAllowlistRoot(unique);
    const tx1 = await this.call(contract, CC0_DROP_1155_ABI, 'setMerkleRoot', [BigInt(tokenId), root]);
    const tx2 = await this.call(contract, CC0_DROP_1155_ABI, 'setAllowlistPhase', [
      BigInt(tokenId),
      { ...buildAllowlistPhase({ ...(phase ?? {}), entries: unique }), enabled: true },
    ]);
    return { root, txHashes: [tx1, tx2] };
  }

  async setMaxSupply1155(contract: Address, tokenId: number, newMax: number): Promise<Hash> {
    return this.call(contract, CC0_DROP_1155_ABI, 'setMaxSupply', [BigInt(tokenId), BigInt(newMax)]);
  }

  async ownerMint1155(contract: Address, tokenId: number, quantity: number, to?: Address): Promise<Hash> {
    return this.call(contract, CC0_DROP_1155_ABI, 'ownerMint', [
      BigInt(tokenId),
      BigInt(quantity),
      to ?? this.signerAddress(),
    ]);
  }

  // ─── Minting (buyer side, any signer) ──────────────────────────────────────

  private async requireEthPricing(contract: Address, is1155: boolean): Promise<void> {
    const token = (await this.publicClient.readContract({
      address: contract,
      abi: is1155 ? CC0_DROP_1155_ABI : CC0_DROP_ABI,
      functionName: 'paymentToken',
    })) as Address;
    if (token !== zeroAddress) {
      throw new Error(
        `This drop is priced in an ERC-20 (${token}) — not covered by the SDK's ETH mint path yet. ` +
          'Mint it on the drop page instead.',
      );
    }
  }

  /** Public mint. Price is read live from the contract; value = price × quantity. */
  async mint721(contract: Address, quantity: number): Promise<Hash> {
    await this.requireEthPricing(contract, false);
    const phase = (await this.publicClient.readContract({
      address: contract, abi: CC0_DROP_ABI, functionName: 'publicPhase',
    })) as readonly [boolean, bigint, bigint, bigint, bigint];
    const value = phase[1] * BigInt(quantity);
    return this.call(contract, CC0_DROP_ABI, 'mint', [BigInt(quantity)], value, GAS_FALLBACK_MINT);
  }

  /**
   * Allowlist mint. Pass EITHER the full entry list (the SDK finds your leaf +
   * builds the proof — the platform stores the public preimage, see
   * getDropRecord().seadrop_allowlist.entries) OR an explicit proof.
   */
  async mintAllowlist721(
    contract: Address,
    quantity: number,
    auth: { entries: AllowlistEntry[] } | { proof: Hex[]; maxQuantity: number },
  ): Promise<Hash> {
    await this.requireEthPricing(contract, false);
    const { proof, maxQuantity } = this.resolveAllowlistAuth(auth);
    const phase = (await this.publicClient.readContract({
      address: contract, abi: CC0_DROP_ABI, functionName: 'allowlistPhase',
    })) as readonly [boolean, bigint, bigint, bigint, bigint, bigint];
    const value = phase[1] * BigInt(quantity);
    return this.call(
      contract, CC0_DROP_ABI, 'mintAllowlist',
      [BigInt(quantity), BigInt(maxQuantity), proof], value, GAS_FALLBACK_MINT,
    );
  }

  async mint1155(contract: Address, tokenId: number, quantity: number): Promise<Hash> {
    await this.requireEthPricing(contract, true);
    const phase = (await this.publicClient.readContract({
      address: contract, abi: CC0_DROP_1155_ABI, functionName: 'publicPhase', args: [BigInt(tokenId)],
    })) as readonly [boolean, bigint, bigint, bigint, bigint];
    const value = phase[1] * BigInt(quantity);
    return this.call(contract, CC0_DROP_1155_ABI, 'mint', [BigInt(tokenId), BigInt(quantity)], value, GAS_FALLBACK_MINT);
  }

  async mintAllowlist1155(
    contract: Address,
    tokenId: number,
    quantity: number,
    auth: { entries: AllowlistEntry[] } | { proof: Hex[]; maxQuantity: number },
  ): Promise<Hash> {
    await this.requireEthPricing(contract, true);
    const { proof, maxQuantity } = this.resolveAllowlistAuth(auth);
    const phase = (await this.publicClient.readContract({
      address: contract, abi: CC0_DROP_1155_ABI, functionName: 'allowlistPhase', args: [BigInt(tokenId)],
    })) as readonly [boolean, bigint, bigint, bigint, bigint, bigint];
    const value = phase[1] * BigInt(quantity);
    return this.call(
      contract, CC0_DROP_1155_ABI, 'mintAllowlist',
      [BigInt(tokenId), BigInt(quantity), BigInt(maxQuantity), proof], value, GAS_FALLBACK_MINT,
    );
  }

  private resolveAllowlistAuth(
    auth: { entries: AllowlistEntry[] } | { proof: Hex[]; maxQuantity: number },
  ): { proof: Hex[]; maxQuantity: number } {
    if ('proof' in auth) return auth;
    const me = this.signerAddress().toLowerCase();
    const mine = dedupeEntries(auth.entries).find((e) => e.address.toLowerCase() === me);
    if (!mine) {
      throw new Error(`Wallet ${me} is not on this allowlist.`);
    }
    return {
      proof: computeAllowlistProof(auth.entries, me),
      maxQuantity: Math.max(1, Math.floor(mine.quantity)),
    };
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** Live onchain state of a 721 drop (phases, supply, root, owner, sealed). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDropState721(contract: Address): Promise<any> {
    const read = (functionName: string) =>
      this.publicClient.readContract({ address: contract, abi: CC0_DROP_ABI, functionName }).catch(() => null);
    const [publicPhase, allowlistPhase, merkleRoot, maxSupply, totalMinted, owner, sealed, paymentToken] =
      await Promise.all([
        read('publicPhase'), read('allowlistPhase'), read('merkleRoot'), read('maxSupply'),
        read('totalMinted'), read('owner'), read('isContractSealed'), read('paymentToken'),
      ]);
    return { publicPhase, allowlistPhase, merkleRoot, maxSupply, totalMinted, owner, sealed, paymentToken };
  }

  /** Live onchain state of one 1155 edition. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getEditionState1155(contract: Address, tokenId: number): Promise<any> {
    const read = (functionName: string, args?: unknown[]) =>
      this.publicClient.readContract({ address: contract, abi: CC0_DROP_1155_ABI, functionName, args }).catch(() => null);
    const id = [BigInt(tokenId)];
    const [publicPhase, allowlistPhase, merkleRoot, maxSupply, totalMinted, exists, closed, owner] =
      await Promise.all([
        read('publicPhase', id), read('allowlistPhase', id), read('merkleRoot', id), read('maxSupply', id),
        read('totalMinted', id), read('editionExists', id), read('editionClosed', id), read('owner'),
      ]);
    return { publicPhase, allowlistPhase, merkleRoot, maxSupply, totalMinted, exists, closed, owner };
  }

  /** The cc0.company record (name, images, allowlist preimage, socials…). Null when unrecorded. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getDropRecord(contract: Address): Promise<any | null> {
    try {
      const res = await fetch(
        `${this.registryUrl}/api/store/nft-minting/collections?contract_address=${contract}`,
        { cache: 'no-store' as RequestCache },
      );
      if (!res.ok) return null;
      const json = await res.json();
      return json?.collections?.[0] ?? null;
    } catch {
      return null;
    }
  }
}

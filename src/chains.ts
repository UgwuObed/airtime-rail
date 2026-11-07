// Origin chains a customer can pay from. USDC contracts and decimals match 1Click's /v0/tokens
// (verified with `npm run quote` on 2026-11-07); createOrder re-checks them against the live list per order.

export type ChainKind = 'evm' | 'sol' | 'near';

interface ChainBase {
  id: string;            // 1Click blockchain id
  name: string;
  /** USDC contract: EVM in EIP-55 checksum form (computed with keccak), near as hex, Solana mint (case-sensitive base58). */
  usdc: string;
  decimals: number;
  explorerTx: string;    // prefix; append the tx hash
}
export interface EvmChain extends ChainBase {
  kind: 'evm';
  chainId: number;
  /** wallet_addEthereumChain params for wallets that don't know the chain yet. */
  rpcUrl: string;
  nativeCurrency: { name: string; symbol: string; decimals: 18 };
  explorer: string;
}
export interface NonEvmChain extends ChainBase { kind: 'sol' | 'near' }
export type Chain = EvmChain | NonEvmChain;

const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 } as const;
const evm = (c: Omit<EvmChain, 'kind'>): EvmChain => ({ kind: 'evm', ...c });

export const CHAINS: Record<string, Chain> = {
  arb: evm({ id: 'arb', name: 'Arbitrum One', chainId: 42161, usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6,
    explorer: 'https://arbiscan.io', explorerTx: 'https://arbiscan.io/tx/', rpcUrl: 'https://arb1.arbitrum.io/rpc', nativeCurrency: ETH }),
  base: evm({ id: 'base', name: 'Base', chainId: 8453, usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6,
    explorer: 'https://basescan.org', explorerTx: 'https://basescan.org/tx/', rpcUrl: 'https://mainnet.base.org', nativeCurrency: ETH }),
  eth: evm({ id: 'eth', name: 'Ethereum', chainId: 1, usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,
    explorer: 'https://etherscan.io', explorerTx: 'https://etherscan.io/tx/', rpcUrl: 'https://ethereum-rpc.publicnode.com', nativeCurrency: ETH }),
  op: evm({ id: 'op', name: 'OP Mainnet', chainId: 10, usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6,
    explorer: 'https://optimistic.etherscan.io', explorerTx: 'https://optimistic.etherscan.io/tx/', rpcUrl: 'https://mainnet.optimism.io', nativeCurrency: ETH }),
  pol: evm({ id: 'pol', name: 'Polygon', chainId: 137, usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6,
    explorer: 'https://polygonscan.com', explorerTx: 'https://polygonscan.com/tx/', rpcUrl: 'https://polygon-rpc.com',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 } }),
  bsc: evm({ id: 'bsc', name: 'BNB Smart Chain', chainId: 56, usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18,
    explorer: 'https://bscscan.com', explorerTx: 'https://bscscan.com/tx/', rpcUrl: 'https://bsc-dataseed.binance.org',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 } }),
  sol: { kind: 'sol', id: 'sol', name: 'Solana', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6,
    explorerTx: 'https://solscan.io/tx/' },
  near: { kind: 'near', id: 'near', name: 'NEAR', usdc: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6,
    explorerTx: 'https://nearblocks.io/txns/' },
};
export const ALL_ORIGINS = Object.keys(CHAINS);
export const chainIdHex = (c: EvmChain) => '0x' + c.chainId.toString(16);

/** Does 1Click's contractAddress for this chain's USDC equal ours? EVM hex is case-insensitive, base58 is not. */
export function sameToken(c: Chain, contractAddress: string) {
  return c.kind === 'sol' ? contractAddress === c.usdc : contractAddress.toLowerCase() === c.usdc.toLowerCase();
}

// --- address formats ---------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Decoded byte length of a base58 string, or -1 if it isn't base58. */
function base58Length(s: string): number {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  let bytes = 0;
  while (n > 0n) { n >>= 8n; bytes++; }
  for (const ch of s) { if (ch !== '1') break; bytes++; } // leading '1's are zero bytes
  return bytes;
}
export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
/** Solana public key: base58 that decodes to exactly 32 bytes. */
export const isSolanaAddress = (s: string) => s.length >= 32 && s.length <= 44 && base58Length(s) === 32;
/** NEAR account: implicit (64 lowercase hex), named (2-64 chars, lowercase, parts joined by . with - or _ inside).
 *  ETH-implicit accounts (0x + 40 lowercase hex, NEP-518) pass as named. */
export const isNearAccount = (s: string) =>
  s.length >= 2 && s.length <= 64 && (/^[0-9a-f]{64}$/.test(s) || /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s));

export function isAddressFor(c: Chain, s: string) {
  return c.kind === 'evm' ? isEvmAddress(s) : c.kind === 'sol' ? isSolanaAddress(s) : isNearAccount(s);
}
export const addressHint = (c: Chain) =>
  c.kind === 'evm' ? `your own ${c.name} address (0x…)` : c.kind === 'sol' ? 'your own Solana address' : 'your own NEAR account (e.g. alice.near)';

/** Integer base units -> decimal string, without floats. "1020000",6 -> "1.02". */
export function formatUnits(base: string, decimals: number): string {
  const s = base.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** What the browser needs to show the chain selector. */
export const publicChain = (id: string) => {
  const c = CHAINS[id];
  return c ? { id: c.id, name: c.name, kind: c.kind } : undefined;
};

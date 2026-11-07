// Everything the browser needs to pay an order, built on the server so the UI does no amount math.
import { Chain, CHAINS, chainIdHex, EvmChain, formatUnits, isAddressFor, isEvmAddress } from './chains.js';
import type { Order } from './orders.js';

export const ARBITRUM_ONE = { chainId: 42161, chainIdHex: '0xa4b1' } as const;
/** Native USDC on Arbitrum One (Circle). */
export const USDC_ARBITRUM = CHAINS.arb.usdc;

const pad32 = (hex: string) => hex.padStart(64, '0');

/** ABI-encoded calldata for ERC-20 transfer(address to, uint256 amount). */
export function erc20TransferData(to: string, amountBase: string): string {
  if (!isEvmAddress(to)) throw new Error(`not an EVM address: ${to}`);
  if (!/^[1-9]\d*$/.test(amountBase)) throw new Error(`amount must be a positive integer string: ${amountBase}`);
  return '0xa9059cbb' + pad32(to.slice(2).toLowerCase()) + pad32(BigInt(amountBase).toString(16));
}

/** EIP-681 payment request, readable by mobile wallets from a QR code. */
export function eip681TransferUri(token: string, chainId: number, to: string, amountBase: string): string {
  return `ethereum:${token}@${chainId}/transfer?address=${to}&uint256=${amountBase}`;
}

/** Solana Pay transfer request (SPL token). amount is a decimal string in whole USDC. */
export function solanaPayUri(recipient: string, mint: string, amount: string): string {
  return `solana:${recipient}?amount=${amount}&spl-token=${mint}`;
}

export interface EvmPayment {
  kind: 'evm';
  chain: string; chainName: string;
  chainId: number; chainIdHex: string;
  token: string; decimals: number;
  /** Ready for eth_sendTransaction (add `from`). */
  tx: { to: string; data: string; value: '0x0' };
  uri: string;
  explorerTx: string;
  /** wallet_addEthereumChain params, for wallets that don't know this chain. */
  addChain: { chainId: string; chainName: string; nativeCurrency: EvmChain['nativeCurrency']; rpcUrls: string[]; blockExplorerUrls: string[] };
}
export interface ManualPayment {
  kind: 'sol' | 'near';
  chain: string; chainName: string;
  token: string; decimals: number;
  /** QR content: a Solana Pay request for sol; the bare deposit account for near (no standard request URI). */
  uri: string;
  explorerTx: string;
}
export type PaymentRequest = EvmPayment | ManualPayment;

/** Undefined when the order can't be paid this way (unknown chain, malformed deposit address, or no amountBase). */
export function paymentFor(o: Pick<Order, 'originChain' | 'depositAddress' | 'amountBase'>): PaymentRequest | undefined {
  const c: Chain | undefined = CHAINS[o.originChain];
  if (!c || !o.amountBase || !/^[1-9]\d*$/.test(o.amountBase) || !isAddressFor(c, o.depositAddress)) return undefined;
  const base = { chain: c.id, chainName: c.name, token: c.usdc, decimals: c.decimals, explorerTx: c.explorerTx };
  if (c.kind === 'evm') {
    const hex = chainIdHex(c);
    return {
      kind: 'evm', ...base, chainId: c.chainId, chainIdHex: hex,
      tx: { to: c.usdc, data: erc20TransferData(o.depositAddress, o.amountBase), value: '0x0' },
      uri: eip681TransferUri(c.usdc, c.chainId, o.depositAddress, o.amountBase),
      addChain: { chainId: hex, chainName: c.name, nativeCurrency: c.nativeCurrency, rpcUrls: [c.rpcUrl], blockExplorerUrls: [c.explorer] },
    };
  }
  const uri = c.kind === 'sol' ? solanaPayUri(o.depositAddress, c.usdc, formatUnits(o.amountBase, c.decimals)) : o.depositAddress;
  return { kind: c.kind, ...base, uri };
}

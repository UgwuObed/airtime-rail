// Thin client for the NEAR Intents 1Click API. No keys or signing live here.
const BASE = process.env.ONECLICK_BASE_URL || 'https://1click.chaindefuser.com';

export interface Token { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number }

export interface QuoteParams {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  amount: string;            // smallest unit, e.g. "1000000" = 1 USDC
  recipient: string;         // where the settled funds land
  refundTo: string;          // where a failed swap is refunded (customer's own address)
  recipientType?: 'DESTINATION_CHAIN' | 'INTENTS';
  deadlineMinutes?: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.ONECLICK_JWT) headers.Authorization = `Bearer ${process.env.ONECLICK_JWT}`;
  const res = await fetch(BASE + path, { ...init, headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`1Click ${res.status} on ${path}: ${text}`);
  return JSON.parse(text) as T;
}

export const getTokens = () => call<Token[]>('/v0/tokens');

export function findToken(tokens: Token[], symbol: string, blockchain: string): Token | undefined {
  return tokens.find((t) => t.symbol.toUpperCase() === symbol && t.blockchain === blockchain);
}

export function getQuote(p: QuoteParams) {
  const deadline = new Date(Date.now() + (p.deadlineMinutes ?? 10) * 60_000).toISOString();
  return call<{ quote: Record<string, unknown> }>('/v0/quote', {
    method: 'POST',
    body: JSON.stringify({
      dry: p.dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100, // 1%
      originAsset: p.originAsset,
      destinationAsset: p.destinationAsset,
      amount: p.amount,
      depositType: 'ORIGIN_CHAIN',
      refundTo: p.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: p.recipient,
      recipientType: p.recipientType ?? 'DESTINATION_CHAIN',
      deadline,
    }),
  });
}

export const getStatus = (depositAddress: string) =>
  call<{ status: string }>(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getQuote, getStatus, getTokens, Token } from './intents.js';
import { Network, vtu } from './vtu.js';

/** External calls, grouped so tests can replace them. */
export const deps = { getQuote, getStatus, getTokens, vtu };

export type OrderStatus =
  | 'awaiting_payment' | 'paid' | 'fulfilling' | 'delivered'
  | 'refund_due' | 'swap_refunded' | 'swap_failed' | 'expired';

export interface Order {
  id: string; network: Network; phone: string; amountNgn: number; originChain: string; refundTo: string;
  usdcAmount: string; depositAddress: string; deadline: string; status: OrderStatus;
  providerRef?: string; error?: string; events: { t: number; msg: string }[];
}

const NETWORKS: Network[] = ['mtn', 'airtel', 'glo', '9mobile'];
const orders = new Map<string, Order>();
if (fs.existsSync(config.dataFile)) {
  for (const o of JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) as Order[]) orders.set(o.id, o);
}
function save() {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  fs.writeFileSync(config.dataFile, JSON.stringify([...orders.values()], null, 2));
}
function setStatus(o: Order, status: OrderStatus, msg: string) {
  o.status = status;
  o.events.push({ t: Date.now(), msg });
  save();
}
export const getOrder = (id: string) => orders.get(id);
/** Tests only: start each test with an empty store. */
export const resetOrdersForTests = () => orders.clear();

let tokens: Token[] | undefined;
async function usdc(chain: string): Promise<Token> {
  tokens ??= await deps.getTokens();
  const t = tokens.find((x) => x.symbol.toUpperCase() === 'USDC' && x.blockchain === chain);
  if (!t) throw new Error(`USDC not available on ${chain}`);
  return t;
}

export async function createOrder(i: { network: string; phone: string; amountNgn: number; originChain: string; refundTo: string }) {
  if (!NETWORKS.includes(i.network as Network)) throw new Error(`network must be one of ${NETWORKS.join(', ')}`);
  if (!/^0[789][01]\d{8}$/.test(i.phone)) throw new Error('phone must be an 11-digit Nigerian number like 08031234567');
  if (!Number.isFinite(i.amountNgn) || i.amountNgn < 100 || i.amountNgn > 50_000) throw new Error('amountNgn must be 100-50000');
  if (!config.origins.includes(i.originChain)) throw new Error(`originChain must be one of ${config.origins.join(', ')}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(i.refundTo)) throw new Error('refundTo must be your own EVM address (0x...)');

  const from = await usdc(i.originChain);
  const to = await usdc('near');
  const cents = Math.ceil((i.amountNgn / config.ngnPerUsd) * (1 + config.marginPct / 100) * 100);
  const amount = (BigInt(cents) * 10n ** BigInt(from.decimals - 2)).toString();

  const { quote } = await deps.getQuote({
    dry: false, originAsset: from.assetId, destinationAsset: to.assetId, amount,
    recipient: config.merchantAccount, recipientType: 'INTENTS', refundTo: i.refundTo,
  });
  const depositAddress = quote.depositAddress as string | undefined;
  if (!depositAddress) throw new Error('1Click returned no deposit address');

  const o: Order = {
    id: randomUUID(), ...i, network: i.network as Network, usdcAmount: (cents / 100).toFixed(2),
    depositAddress, deadline: String(quote.deadline ?? ''), status: 'awaiting_payment',
    events: [{ t: Date.now(), msg: `Quote ok: send ${(cents / 100).toFixed(2)} USDC (${i.originChain}) to the deposit address` }],
  };
  orders.set(o.id, o);
  save();
  return o;
}

export async function fulfil(o: Order) {
  if (o.status !== 'paid') return; // idempotency guard: only one fulfilment per order
  setStatus(o, 'fulfilling', 'Buying airtime');
  const r = await deps.vtu.buyAirtime({ network: o.network, phone: o.phone, amountNgn: o.amountNgn, reference: o.id });
  if (r.ok) {
    o.providerRef = r.providerRef;
    setStatus(o, 'delivered', `Airtime delivered (ref ${r.providerRef})`);
  } else {
    o.error = r.error;
    setStatus(o, 'refund_due', `Fulfilment failed (${r.error}). Refund of ${o.usdcAmount} USDC owed to ${o.refundTo}`);
  }
}

export function markPaid(o: Order, msg: string) {
  if (o.status !== 'awaiting_payment') return false;
  setStatus(o, 'paid', msg);
  void fulfil(o);
  return true;
}

/** Poll NEAR Intents for every order still waiting on its swap. */
export async function tick() {
  for (const o of orders.values()) {
    if (o.status !== 'awaiting_payment') continue;
    try {
      const { status } = await deps.getStatus(o.depositAddress);
      if (status === 'SUCCESS') markPaid(o, 'Swap settled into NEAR Intents');
      else if (status === 'REFUNDED') setStatus(o, 'swap_refunded', 'Swap failed; NEAR Intents refunded the customer');
      else if (status === 'FAILED') setStatus(o, 'swap_failed', 'Swap failed');
      else if (status === 'PENDING_DEPOSIT' && o.deadline && Date.now() > Date.parse(o.deadline) + 60_000)
        setStatus(o, 'expired', 'No deposit before the quote expired');
    } catch (e) {
      console.error(`poll ${o.id}:`, (e as Error).message);
    }
  }
}

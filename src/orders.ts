import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getQuote, getStatus, getTokens, submitDeposit, Token } from './intents.js';
import { addressHint, CHAINS, isAddressFor, sameToken } from './chains.js';
import { Network, vtu, VtuResult } from './vtu.js';

/** External calls, grouped so tests can replace them. */
export const deps = { getQuote, getStatus, getTokens, submitDeposit, vtu };

export type OrderStatus =
  | 'awaiting_payment' | 'paid' | 'fulfilling' | 'fulfilment_pending' | 'delivered'
  | 'refund_due' | 'swap_refunded' | 'swap_failed' | 'expired';

export interface Order {
  id: string; network: Network; phone: string; amountNgn: number; originChain: string; refundTo: string;
  /** Display amount, e.g. "1.02". */
  usdcAmount: string;
  /** Exact amount to send, in the origin chain's USDC base units (6 decimals; 18 on bsc). Same value sent to 1Click. */
  amountBase: string;
  /** Hash of the customer's deposit tx, when they paid from a connected wallet. */
  txHash?: string;
  depositAddress: string; deadline: string; status: OrderStatus;
  providerRef?: string; error?: string;
  /** When the airtime purchase was sent (ms). Used to re-query outcomes that were unclear. */
  fulfilAt?: number;
  events: { t: number; msg: string }[];
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
let tokens: Token[] | undefined;
/** Tests only: start each test with an empty store and no cached token list. */
export const resetOrdersForTests = () => { orders.clear(); tokens = undefined; };

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
  const chain = CHAINS[i.originChain];
  if (!chain) throw new Error(`originChain ${i.originChain} is not a known chain`);
  if (!isAddressFor(chain, i.refundTo)) throw new Error(`refundTo must be ${addressHint(chain)}`);

  // Don't let a customer pay for airtime the provider wallet can't cover. Unknown balance doesn't block.
  const available = await deps.vtu.availableNgn?.().catch(() => undefined);
  if (available !== undefined && available < i.amountNgn)
    throw new Error('Airtime is temporarily unavailable for this amount. No payment was taken; try a smaller amount or later.');

  const from = await usdc(i.originChain);
  // The customer is told to send chain.usdc, so the asset 1Click quotes must be that exact token, with the same decimals.
  if (from.contractAddress && !sameToken(chain, from.contractAddress))
    throw new Error(`1Click ${chain.id} USDC contract ${from.contractAddress} does not match ${chain.usdc}`);
  if (from.decimals !== chain.decimals)
    throw new Error(`1Click ${chain.id} USDC has ${from.decimals} decimals, expected ${chain.decimals}`);
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
    id: randomUUID(), ...i, network: i.network as Network, usdcAmount: (cents / 100).toFixed(2), amountBase: amount,
    depositAddress, deadline: String(quote.deadline ?? ''), status: 'awaiting_payment',
    events: [{ t: Date.now(), msg: `Quote ok: send ${(cents / 100).toFixed(2)} USDC (${i.originChain}) to the deposit address` }],
  };
  orders.set(o.id, o);
  save();
  return o;
}

/**
 * The customer's wallet broadcast the deposit. Record the hash and tell 1Click (optional speed-up).
 * Only invalid input throws: a 1Click failure is logged on the order and the poller still detects the deposit.
 */
export async function recordDepositTx(o: Order, txHash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('txHash must be a 0x-prefixed 32-byte hash');
  if (o.txHash) return o; // first hash wins; repeats (retries, reloads) are no-ops
  o.txHash = txHash;
  o.events.push({ t: Date.now(), msg: `Payment sent from wallet (tx ${txHash.slice(0, 10)}…)` });
  save();
  try {
    await deps.submitDeposit({ txHash, depositAddress: o.depositAddress });
    o.events.push({ t: Date.now(), msg: 'NEAR Intents notified of the deposit' });
  } catch (e) {
    console.error(`deposit submit ${o.id}:`, (e as Error).message);
    o.events.push({ t: Date.now(), msg: 'Could not notify NEAR Intents; the deposit will still be detected' });
  }
  save();
  return o;
}

export async function fulfil(o: Order) {
  if (o.status !== 'paid') return; // idempotency guard: only one fulfilment per order
  o.fulfilAt = Date.now();
  setStatus(o, 'fulfilling', 'Buying airtime');
  let r: VtuResult;
  try {
    r = await deps.vtu.buyAirtime({ network: o.network, phone: o.phone, amountNgn: o.amountNgn, reference: o.id });
  } catch (e) {
    r = { ok: false, pending: true, error: `provider call threw: ${(e as Error).message}` };
  }
  applyVtuResult(o, r);
}

function applyVtuResult(o: Order, r: VtuResult) {
  if (r.ok) {
    o.providerRef = r.providerRef;
    o.error = undefined;
    setStatus(o, 'delivered', `Airtime delivered (ref ${r.providerRef})`);
  } else if (r.pending) {
    // Outcome unknown. Do NOT resend (that could deliver twice); the poller re-queries by reference.
    if (o.status !== 'fulfilment_pending') setStatus(o, 'fulfilment_pending', `Confirming delivery with the provider (${r.error})`);
  } else {
    o.error = r.error;
    setStatus(o, 'refund_due', `Fulfilment failed (${r.error}). Refund of ${o.usdcAmount} USDC owed to ${o.refundTo}`);
  }
}

/** Give the provider this long before trusting "no record of that reference" as a failure. */
export const NOT_FOUND_GRACE_MS = 5 * 60_000;
/** An order still 'fulfilling' after this long lost its response (e.g. a restart) and is re-queried. */
export const STUCK_FULFILLING_MS = 2 * 60_000;

async function resolveFulfilment(o: Order) {
  const check = deps.vtu.checkAirtime;
  if (!check) return;
  const age = Date.now() - (o.fulfilAt ?? 0);
  if (o.status === 'fulfilling') {
    if (age < STUCK_FULFILLING_MS) return;
    setStatus(o, 'fulfilment_pending', 'No answer from the provider; confirming delivery');
  }
  const r = await check.call(deps.vtu, o.id);
  if (r.notFound) {
    if (age >= NOT_FOUND_GRACE_MS) applyVtuResult(o, { ok: false, error: r.error ?? 'provider has no record of the purchase' });
    return;
  }
  applyVtuResult(o, r);
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
    if (o.status === 'fulfilment_pending' || o.status === 'fulfilling') {
      try { await resolveFulfilment(o); } catch (e) { console.error(`requery ${o.id}:`, (e as Error).message); }
      continue;
    }
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

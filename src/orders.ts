import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getQuote, getStatus, getTokens, submitDeposit, Token } from './intents.js';
import { addressHint, Chain, CHAINS, isAddressFor, sameToken } from './chains.js';
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
  /** Set on lines of a bulk batch: the batch owns the payment; this order is one airtime purchase. */
  batchId?: string;
  line?: number;
  events: { t: number; msg: string }[];
}

export type BatchStatus = 'awaiting_payment' | 'paid' | 'swap_refunded' | 'swap_failed' | 'expired';
/** One payment for many airtime lines. Each line is an Order with batchId set. */
export interface Batch {
  id: string; originChain: string; refundTo: string;
  /** Sum of the lines' usdcAmount, so every line's refund is exactly what was paid for it. */
  usdcAmount: string; amountBase: string;
  depositAddress: string; deadline: string; status: BatchStatus;
  lineIds: string[]; txHash?: string;
  events: { t: number; msg: string }[];
}
export const MAX_BULK_LINES = 50;

/** Thrown when the service is at capacity; the HTTP layer maps it to 503. */
export class BusyError extends Error {}

const NETWORKS: Network[] = ['mtn', 'airtel', 'glo', '9mobile'];
const orders = new Map<string, Order>();
const batches = new Map<string, Batch>();
const batchFile = config.dataFile.replace(/(\.json)?$/, '.batches.json');
if (fs.existsSync(config.dataFile)) {
  for (const o of JSON.parse(fs.readFileSync(config.dataFile, 'utf8')) as Order[]) orders.set(o.id, o);
}
if (fs.existsSync(batchFile)) {
  for (const b of JSON.parse(fs.readFileSync(batchFile, 'utf8')) as Batch[]) batches.set(b.id, b);
}
function save() {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  fs.writeFileSync(config.dataFile, JSON.stringify([...orders.values()], null, 2));
  fs.writeFileSync(batchFile, JSON.stringify([...batches.values()], null, 2));
}
function setStatus(o: Order, status: OrderStatus, msg: string) {
  o.status = status;
  o.events.push({ t: Date.now(), msg });
  save();
}
export const getOrder = (id: string) => orders.get(id);
export const getBatch = (id: string) => batches.get(id);
let tokens: Token[] | undefined;
/** Batches whose lines are being sent to the provider right now (in this process). */
const fanning = new Set<string>();
/** Tests only: start each test with an empty store and no cached token list. */
export const resetOrdersForTests = () => { orders.clear(); batches.clear(); fanning.clear(); tokens = undefined; };

async function usdc(chain: string): Promise<Token> {
  tokens ??= await deps.getTokens();
  const t = tokens.find((x) => x.symbol.toUpperCase() === 'USDC' && x.blockchain === chain);
  if (!t) throw new Error(`USDC not available on ${chain}`);
  return t;
}

// --- shared checks and quoting (single orders and bulk batches) ---------------------------------
function checkLine(network: string, phone: string, amountNgn: number, prefix = '') {
  if (!NETWORKS.includes(network as Network)) throw new Error(`${prefix}network must be one of ${NETWORKS.join(', ')}`);
  if (!/^0[789][01]\d{8}$/.test(phone)) throw new Error(`${prefix}phone must be an 11-digit Nigerian number like 08031234567`);
  if (!Number.isFinite(amountNgn) || amountNgn < 100 || amountNgn > 50_000) throw new Error(`${prefix}amountNgn must be 100-50000`);
}
function checkPayer(originChain: string, refundTo: string) {
  if (!config.origins.includes(originChain)) throw new Error(`originChain must be one of ${config.origins.join(', ')}`);
  const chain = CHAINS[originChain];
  if (!chain) throw new Error(`originChain ${originChain} is not a known chain`);
  if (!isAddressFor(chain, refundTo)) throw new Error(`refundTo must be ${addressHint(chain)}`);
  return chain;
}
/** Orders and batches still waiting for a deposit. Bulk lines don't count; their batch does. */
export const openPaymentCount = () =>
  [...orders.values()].filter((o) => o.status === 'awaiting_payment' && !o.batchId).length
  + [...batches.values()].filter((b) => b.status === 'awaiting_payment').length;
function checkCapacity() {
  if (openPaymentCount() >= config.maxOpenOrders)
    throw new BusyError('Too many orders are waiting for payment right now. No payment was taken; try again in a few minutes.');
}
// Don't let a customer pay for airtime the provider wallet can't cover. Unknown balance doesn't block.
async function checkBalance(totalNgn: number) {
  const available = await deps.vtu.availableNgn?.().catch(() => undefined);
  if (available !== undefined && available < totalNgn)
    throw new Error('Airtime is temporarily unavailable for this amount. No payment was taken; try a smaller amount or later.');
}
/** USDC cents for an NGN amount, margin included, rounded up. */
const centsFor = (amountNgn: number) => Math.ceil((amountNgn / config.ngnPerUsd) * (1 + config.marginPct / 100) * 100);
const fmtCents = (cents: number) => (cents / 100).toFixed(2);

async function quoteDeposit(chain: Chain, cents: number, refundTo: string) {
  const from = await usdc(chain.id);
  // The customer is told to send chain.usdc, so the asset 1Click quotes must be that exact token, with the same decimals.
  if (from.contractAddress && !sameToken(chain, from.contractAddress))
    throw new Error(`1Click ${chain.id} USDC contract ${from.contractAddress} does not match ${chain.usdc}`);
  if (from.decimals !== chain.decimals)
    throw new Error(`1Click ${chain.id} USDC has ${from.decimals} decimals, expected ${chain.decimals}`);
  const to = await usdc('near');
  const toBase = (c: number) => (BigInt(c) * 10n ** BigInt(from.decimals - 2)).toString();
  const amount = toBase(cents);
  const { quote } = await deps.getQuote({
    dry: false, originAsset: from.assetId, destinationAsset: to.assetId, amount,
    recipient: config.merchantAccount, recipientType: 'INTENTS', refundTo,
  });
  const depositAddress = quote.depositAddress as string | undefined;
  if (!depositAddress) throw new Error('1Click returned no deposit address');
  return { amount, toBase, depositAddress, deadline: String(quote.deadline ?? '') };
}

export async function createOrder(i: { network: string; phone: string; amountNgn: number; originChain: string; refundTo: string }) {
  checkLine(i.network, i.phone, i.amountNgn);
  const chain = checkPayer(i.originChain, i.refundTo);
  checkCapacity();
  await checkBalance(i.amountNgn);

  const cents = centsFor(i.amountNgn);
  const q = await quoteDeposit(chain, cents, i.refundTo);
  const o: Order = {
    id: randomUUID(), ...i, network: i.network as Network, usdcAmount: fmtCents(cents), amountBase: q.amount,
    depositAddress: q.depositAddress, deadline: q.deadline, status: 'awaiting_payment',
    events: [{ t: Date.now(), msg: `Quote ok: send ${fmtCents(cents)} USDC (${i.originChain}) to the deposit address` }],
  };
  orders.set(o.id, o);
  save();
  return o;
}

// --- bulk -----------------------------------------------------------------------------------------
export interface BulkItem { network: string; phone: string; amountNgn: number }

/** One quote and one deposit address for many lines. Lines are bought after the swap settles. */
export async function createBatch(i: { items: BulkItem[]; originChain: string; refundTo: string }) {
  if (!Array.isArray(i.items) || i.items.length === 0) throw new Error('items must list at least one line');
  if (i.items.length > MAX_BULK_LINES) throw new Error(`at most ${MAX_BULK_LINES} lines per batch (got ${i.items.length})`);
  i.items.forEach((it, n) => checkLine(it.network, it.phone, it.amountNgn, `line ${n + 1}: `));
  const chain = checkPayer(i.originChain, i.refundTo);
  checkCapacity();
  const totalNgn = i.items.reduce((s, it) => s + it.amountNgn, 0);
  await checkBalance(totalNgn);

  const lineCents = i.items.map((it) => centsFor(it.amountNgn));
  const totalCents = lineCents.reduce((a, b) => a + b, 0);
  const q = await quoteDeposit(chain, totalCents, i.refundTo);
  const id = randomUUID();
  const now = Date.now();
  // Each line gets its own random id, so its provider reference (derived from the id) is unique and stable.
  const lines: Order[] = i.items.map((it, n) => ({
    id: randomUUID(), batchId: id, line: n + 1,
    network: it.network as Network, phone: it.phone, amountNgn: it.amountNgn,
    originChain: i.originChain, refundTo: i.refundTo,
    usdcAmount: fmtCents(lineCents[n]), amountBase: q.toBase(lineCents[n]),
    depositAddress: q.depositAddress, deadline: q.deadline, status: 'awaiting_payment',
    events: [{ t: now, msg: 'Waiting for the batch payment' }],
  }));
  const b: Batch = {
    id, originChain: i.originChain, refundTo: i.refundTo, usdcAmount: fmtCents(totalCents), amountBase: q.amount,
    depositAddress: q.depositAddress, deadline: q.deadline, status: 'awaiting_payment', lineIds: lines.map((l) => l.id),
    events: [{ t: now, msg: `Quote ok: send ${fmtCents(totalCents)} USDC (${i.originChain}) for ${lines.length} numbers, ₦${totalNgn.toLocaleString('en-NG')} of airtime` }],
  };
  for (const l of lines) orders.set(l.id, l);
  batches.set(id, b);
  save();
  return b;
}

export const batchLines = (b: Batch) => b.lineIds.map((id) => orders.get(id)).filter((o): o is Order => !!o);

/** Per-line status counts and the USDC owed back for failed lines. */
export function batchSummary(b: Batch) {
  const lines = batchLines(b);
  const count = (...s: OrderStatus[]) => lines.filter((l) => s.includes(l.status)).length;
  const refundCents = lines.filter((l) => l.status === 'refund_due').reduce((s, l) => s + Math.round(Number(l.usdcAmount) * 100), 0);
  const final: OrderStatus[] = ['delivered', 'refund_due', 'swap_refunded', 'swap_failed', 'expired'];
  return {
    lines: lines.length,
    totalNgn: lines.reduce((s, l) => s + l.amountNgn, 0),
    delivered: count('delivered'),
    refundDue: count('refund_due'),
    inProgress: count('paid', 'fulfilling', 'fulfilment_pending'),
    refundDueUsdc: fmtCents(refundCents),
    complete: lines.every((l) => final.includes(l.status)),
  };
}

function setBatchStatus(b: Batch, status: BatchStatus, msg: string) {
  b.status = status;
  b.events.push({ t: Date.now(), msg });
  // Swap-level outcomes apply to every line that was still waiting for the payment.
  if (status !== 'paid') for (const l of batchLines(b)) if (l.status === 'awaiting_payment') setStatus(l, status, msg);
  save();
}

export function markBatchPaid(b: Batch, msg: string) {
  if (b.status !== 'awaiting_payment') return false;
  setBatchStatus(b, 'paid', msg);
  void fanOut(b);
  return true;
}

/**
 * Buy each line, one at a time, through the same fulfil() as single orders: one purchase per line, unclear outcomes
 * go to fulfilment_pending and are re-queried. Safe to call again (e.g. after a restart): lines already sent are skipped.
 */
export async function fanOut(b: Batch) {
  if (b.status !== 'paid' || fanning.has(b.id)) return;
  fanning.add(b.id);
  try {
    for (const l of batchLines(b)) {
      if (l.status === 'awaiting_payment') setStatus(l, 'paid', 'Batch payment settled');
      if (l.status === 'paid') await fulfil(l);
    }
  } finally {
    fanning.delete(b.id);
  }
}

/**
 * The customer's wallet broadcast the deposit. Record the hash and tell 1Click (optional speed-up).
 * Only invalid input throws: a 1Click failure is logged on the order and the poller still detects the deposit.
 */
export async function recordDepositTx<T extends Pick<Order, 'id' | 'depositAddress' | 'txHash' | 'events'>>(o: T, txHash: string) {
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
    if (o.status !== 'awaiting_payment' || o.batchId) continue; // bulk lines follow their batch
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
  for (const b of batches.values()) {
    if (b.status === 'paid') {
      // Resume a fan-out interrupted by a restart: lines never sent are still awaiting_payment or paid.
      if (batchLines(b).some((l) => l.status === 'awaiting_payment' || l.status === 'paid')) void fanOut(b);
      continue;
    }
    if (b.status !== 'awaiting_payment') continue;
    try {
      const { status } = await deps.getStatus(b.depositAddress);
      if (status === 'SUCCESS') markBatchPaid(b, 'Swap settled into NEAR Intents');
      else if (status === 'REFUNDED') setBatchStatus(b, 'swap_refunded', 'Swap failed; NEAR Intents refunded the customer');
      else if (status === 'FAILED') setBatchStatus(b, 'swap_failed', 'Swap failed');
      else if (status === 'PENDING_DEPOSIT' && b.deadline && Date.now() > Date.parse(b.deadline) + 60_000)
        setBatchStatus(b, 'expired', 'No deposit before the quote expired');
    } catch (e) {
      console.error(`poll batch ${b.id}:`, (e as Error).message);
    }
  }
}

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.RECIPIENT_NEAR_ACCOUNT = 'merchant.near';
process.env.NGN_PER_USD = '1000';
process.env.MARGIN_PCT = '2';
process.env.SUPPORTED_ORIGINS = 'arb,bsc';
process.env.MAX_OPEN_ORDERS = '3';
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airtime-bulk-')), 'orders.json');

const {
  createBatch, createOrder, tick, deps, resetOrdersForTests, batchLines, batchSummary, markBatchPaid, fanOut,
  getOrder, recordDepositTx, BusyError, NOT_FOUND_GRACE_MS,
} = await import('../src/orders.js');
const { topupboxRef } = await import('../src/topupbox.js');
type VtuResult = import('../src/vtu.js').VtuResult;

const TOKENS = [
  { assetId: 'arb-usdc', symbol: 'USDC', blockchain: 'arb', decimals: 6 },
  { assetId: 'bsc-usdc', symbol: 'USDC', blockchain: 'bsc', decimals: 18 },
  { assetId: 'near-usdc', symbol: 'USDC', blockchain: 'near', decimals: 6 },
];
const REFUND = '0x' + 'a'.repeat(40);
const DEPOSIT = '0x' + 'd'.repeat(40);
const items = [
  { network: 'mtn', phone: '08031234567', amountNgn: 1000 },   // 1.02 USDC
  { network: 'glo', phone: '08051234567', amountNgn: 500 },    // 0.51
  { network: 'airtel', phone: '08021230000', amountNgn: 250 }, // 0.255 -> 0.26 (rounded up per line)
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let quotes: any[], statusCalls: number, swapStatus: string, buys: { phone: string; reference: string }[];
let resultFor: (phone: string) => VtuResult;
let checkResult: (reference: string) => VtuResult & { notFound?: boolean };

beforeEach(() => {
  resetOrdersForTests();
  quotes = []; statusCalls = 0; swapStatus = 'PENDING_DEPOSIT'; buys = [];
  resultFor = (phone) => (phone.endsWith('0000') ? { ok: false, error: 'rejected' } : { ok: true, providerRef: 'P-' + phone });
  checkResult = () => ({ ok: false, pending: true });
  deps.getTokens = async () => TOKENS;
  deps.getQuote = async (p) => {
    quotes.push(p);
    return { quote: { depositAddress: DEPOSIT, deadline: new Date(Date.now() + 600_000).toISOString() } };
  };
  deps.getStatus = async () => { statusCalls++; return { status: swapStatus }; };
  deps.submitDeposit = async () => ({ status: 'KNOWN_DEPOSIT_TX' });
  deps.vtu = {
    buyAirtime: async (a) => { buys.push({ phone: a.phone, reference: a.reference }); return resultFor(a.phone); },
    checkAirtime: async (ref) => checkResult(ref),
  };
});
const newBatch = (over: object = {}) => createBatch({ items, originChain: 'arb', refundTo: REFUND, ...over });
const settle = async () => { swapStatus = 'SUCCESS'; await tick(); await sleep(30); };

test('one quote and one deposit address for the total; each line keeps its own USDC share', async () => {
  const b = await newBatch();
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].amount, '1790000'); // 102 + 51 + 26 cents
  assert.equal(b.usdcAmount, '1.79');
  assert.equal(b.amountBase, '1790000');
  const lines = batchLines(b);
  assert.deepEqual(lines.map((l) => [l.line, l.usdcAmount, l.amountBase, l.status]),
    [[1, '1.02', '1020000', 'awaiting_payment'], [2, '0.51', '510000', 'awaiting_payment'], [3, '0.26', '260000', 'awaiting_payment']]);
  assert.ok(lines.every((l) => l.depositAddress === DEPOSIT && l.batchId === b.id && l.refundTo === REFUND));
});

test('BSC batch: total and line shares in 18-decimal base units', async () => {
  const b = await newBatch({ originChain: 'bsc' });
  assert.equal(b.amountBase, '1790000000000000000');
  assert.equal(batchLines(b)[2].amountBase, '260000000000000000');
});

test('validation: per-line errors name the line; 1 to 50 lines; refund format per chain', async () => {
  await assert.rejects(newBatch({ items: [] }), /at least one line/);
  await assert.rejects(newBatch({ items: Array(51).fill(items[0]) }), /at most 50 lines/);
  await assert.rejects(newBatch({ items: [items[0], { ...items[1], phone: '123' }] }), /^Error: line 2: phone/);
  await assert.rejects(newBatch({ items: [{ ...items[0], network: 'vodafone' }] }), /line 1: network/);
  await assert.rejects(newBatch({ items: [items[0], items[1], { ...items[2], amountNgn: 60_000 }] }), /line 3: amountNgn/);
  await assert.rejects(newBatch({ refundTo: 'alice.near' }), /refundTo must be your own Arbitrum One address/);
  await assert.rejects(newBatch({ originChain: 'sol' }), /originChain/);
  assert.equal(quotes.length, 0);
  await newBatch({ items: Array(50).fill(items[0]) });
  assert.equal(quotes.length, 1);
});

test('the provider wallet must cover the batch total', async () => {
  deps.vtu.availableNgn = async () => 1700; // total is 1750
  await assert.rejects(newBatch(), /temporarily unavailable/);
  assert.equal(quotes.length, 0);
});

test('lines are not polled individually: one status call per batch', async () => {
  await newBatch();
  await tick();
  assert.equal(statusCalls, 1);
  assert.equal(buys.length, 0);
});

test('after the swap: one purchase per line, each with its own reference; mixed results', async () => {
  const b = await newBatch();
  await settle();
  assert.equal(b.status, 'paid');
  assert.deepEqual(buys.map((x) => x.phone), ['08031234567', '08051234567', '08021230000']);
  const refs = buys.map((x) => topupboxRef(x.reference));
  assert.equal(new Set(refs).size, 3);
  assert.deepEqual(buys.map((x) => x.reference), b.lineIds); // reference is the line's own id

  const [l1, l2, l3] = batchLines(b);
  assert.equal(l1.status, 'delivered');
  assert.equal(l2.status, 'delivered');
  assert.equal(l3.status, 'refund_due');
  assert.match(l3.events.at(-1)!.msg, /Refund of 0\.26 USDC owed to 0xaaaa/);
  const s = batchSummary(b);
  assert.deepEqual({ ...s }, { lines: 3, totalNgn: 1750, delivered: 2, refundDue: 1, inProgress: 0, refundDueUsdc: '0.26', complete: true });

  await tick(); await sleep(30); // SUCCESS seen again: no second fan-out
  assert.equal(markBatchPaid(b, 'dup'), false);
  assert.equal(buys.length, 3);
});

test('an unclear line is re-queried, never re-bought, and resolves on its own', async () => {
  resultFor = (phone) => (phone === '08051234567' ? { ok: false, pending: true, error: 'timeout' } : { ok: true, providerRef: 'P' });
  const b = await newBatch();
  await settle();
  const l2 = batchLines(b)[1];
  assert.equal(l2.status, 'fulfilment_pending');
  assert.equal(batchSummary(b).inProgress, 1);
  assert.equal(batchSummary(b).complete, false);
  await tick();
  assert.equal(buys.length, 3);
  checkResult = (ref) => (ref === l2.id ? { ok: true, providerRef: 'LATE' } : { ok: false, pending: true });
  await tick();
  assert.equal(l2.status, 'delivered');
  assert.equal(l2.providerRef, 'LATE');
  assert.equal(buys.length, 3);
  assert.equal(batchSummary(b).complete, true);
});

test('a line the provider never recorded becomes refund_due after the grace period', async () => {
  resultFor = (phone) => (phone === '08031234567' ? { ok: false, pending: true } : { ok: true, providerRef: 'P' });
  checkResult = () => ({ ok: false, notFound: true, error: 'no record' });
  const b = await newBatch();
  await settle();
  const l1 = batchLines(b)[0];
  l1.fulfilAt = Date.now() - NOT_FOUND_GRACE_MS - 1;
  await tick();
  assert.equal(l1.status, 'refund_due');
  assert.equal(batchSummary(b).refundDueUsdc, '1.02');
  assert.equal(buys.length, 3);
});

test('restart mid fan-out: only lines never sent are bought', async () => {
  const b = await newBatch();
  // State as if the process died after line 1 was delivered: batch paid, lines 2-3 never sent.
  b.status = 'paid';
  const [l1, l2] = batchLines(b);
  l1.status = 'delivered';
  l2.status = 'paid';
  await tick(); await sleep(30);
  assert.deepEqual(buys.map((x) => x.phone), ['08051234567', '08021230000']);
  await fanOut(b);
  assert.equal(buys.length, 2);
});

test('swap refunded or expired: no line is bought, every line gets the swap outcome', async () => {
  const b = await newBatch();
  swapStatus = 'REFUNDED';
  await tick(); await sleep(30);
  assert.equal(b.status, 'swap_refunded');
  assert.ok(batchLines(b).every((l) => l.status === 'swap_refunded'));

  const e = await newBatch();
  swapStatus = 'PENDING_DEPOSIT';
  e.deadline = new Date(Date.now() - 120_000).toISOString();
  await tick();
  assert.equal(e.status, 'expired');
  assert.ok(batchLines(e).every((l) => l.status === 'expired'));
  assert.equal(buys.length, 0);
});

test('wallet tx hash on a batch is recorded once', async () => {
  const b = await newBatch();
  const tx = '0x' + '1'.repeat(64);
  await recordDepositTx(b, tx);
  await recordDepositTx(b, '0x' + '2'.repeat(64));
  assert.equal(b.txHash, tx);
});

test('cap on open payments: a batch counts once, its lines do not; settled ones free a slot', async () => {
  const b = await newBatch(); // 3 lines, 1 open payment
  await createOrder({ ...items[0], originChain: 'arb', refundTo: REFUND });
  await createOrder({ ...items[0], originChain: 'arb', refundTo: REFUND });
  await assert.rejects(createOrder({ ...items[0], originChain: 'arb', refundTo: REFUND }), (e) => e instanceof BusyError);
  await assert.rejects(newBatch(), /Too many orders are waiting for payment/);
  assert.equal(quotes.length, 3);
  markBatchPaid(b, 'paid'); await sleep(30); // the batch's payment arrived: no longer open
  await createOrder({ ...items[0], originChain: 'arb', refundTo: REFUND });
  assert.equal(quotes.length, 4);
  assert.ok(getOrder(b.lineIds[0]));
});

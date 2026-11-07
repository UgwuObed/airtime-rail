import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Config is read at import time, so set the environment first. No network, no real data file.
process.env.RECIPIENT_NEAR_ACCOUNT = 'merchant.near';
process.env.NGN_PER_USD = '1000';
process.env.MARGIN_PCT = '2';
process.env.SUPPORTED_ORIGINS = 'arb';
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airtime-')), 'orders.json');

const { createOrder, tick, markPaid, recordDepositTx, deps, resetOrdersForTests, NOT_FOUND_GRACE_MS, STUCK_FULFILLING_MS } = await import('../src/orders.js');

const TOKENS = [
  { assetId: 'arb-usdc', symbol: 'USDC', blockchain: 'arb', decimals: 6 },
  { assetId: 'near-usdc', symbol: 'USDC', blockchain: 'near', decimals: 6 },
];
const valid = { network: 'mtn', phone: '08031234567', amountNgn: 1000, originChain: 'arb', refundTo: '0x' + 'a'.repeat(40) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let quotes: any[], submits: any[], submitFails: boolean, swapStatus: string, buys: number, buyResult: { ok: boolean; providerRef?: string; error?: string };

beforeEach(() => {
  resetOrdersForTests();
  quotes = []; submits = []; submitFails = false; swapStatus = 'PENDING_DEPOSIT'; buys = 0; buyResult = { ok: true, providerRef: 'R1' };
  deps.getTokens = async () => TOKENS;
  deps.getQuote = async (p) => {
    quotes.push(p);
    return { quote: { depositAddress: '0xdeposit', deadline: new Date(Date.now() + 600_000).toISOString() } };
  };
  deps.getStatus = async () => ({ status: swapStatus });
  deps.submitDeposit = async (p) => {
    submits.push(p);
    if (submitFails) throw new Error('1Click 503 on /v0/deposit/submit');
    return { status: 'KNOWN_DEPOSIT_TX' };
  };
  deps.vtu = { buyAirtime: async () => { buys++; return buyResult; } };
});

test('rejects invalid input before calling the API', async () => {
  await assert.rejects(createOrder({ ...valid, phone: '123' }), /phone/);
  await assert.rejects(createOrder({ ...valid, network: 'vodafone' }), /network/);
  await assert.rejects(createOrder({ ...valid, amountNgn: 50 }), /amountNgn/);
  await assert.rejects(createOrder({ ...valid, originChain: 'bsc' }), /originChain/);
  await assert.rejects(createOrder({ ...valid, refundTo: 'nope' }), /refundTo/);
  assert.equal(quotes.length, 0);
});

test('converts naira to USDC base units and settles into NEAR Intents', async () => {
  const o = await createOrder(valid); // 1000 NGN / 1000 * 1.02 = 1.02 USDC
  assert.equal(o.usdcAmount, '1.02');
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(quotes[0].amount, '1020000');
  assert.equal(quotes[0].dry, false);
  assert.equal(quotes[0].originAsset, 'arb-usdc');
  assert.equal(quotes[0].destinationAsset, 'near-usdc');
  assert.equal(quotes[0].recipient, 'merchant.near');
  assert.equal(quotes[0].recipientType, 'INTENTS');
  assert.equal(quotes[0].refundTo, valid.refundTo);
});

test('swap SUCCESS delivers airtime exactly once', async () => {
  const o = await createOrder(valid);
  swapStatus = 'SUCCESS';
  await tick(); await sleep(30);
  assert.equal(o.status, 'delivered');
  assert.equal(buys, 1);
  await tick(); await sleep(30);
  assert.equal(markPaid(o, 'duplicate'), false);
  assert.equal(buys, 1);
});

test('provider failure after payment becomes refund_due', async () => {
  buyResult = { ok: false, error: 'rejected' };
  const o = await createOrder(valid);
  swapStatus = 'SUCCESS';
  await tick(); await sleep(30);
  assert.equal(o.status, 'refund_due');
  assert.match(o.events.at(-1)!.msg, /Refund of 1\.02 USDC owed to 0xaaaa/);
});

test('swap REFUNDED never buys airtime', async () => {
  const o = await createOrder(valid);
  swapStatus = 'REFUNDED';
  await tick(); await sleep(30);
  assert.equal(o.status, 'swap_refunded');
  assert.equal(buys, 0);
});

test('unpaid order expires after the quote deadline, not before', async () => {
  const o = await createOrder(valid);
  await tick();
  assert.equal(o.status, 'awaiting_payment');
  o.deadline = new Date(Date.now() - 120_000).toISOString();
  await tick();
  assert.equal(o.status, 'expired');
});

const TX = '0x' + 'ab'.repeat(32);

test('amountBase is the exact base-unit amount quoted to 1Click', async () => {
  const o = await createOrder(valid);
  assert.equal(o.amountBase, '1020000');
  assert.equal(o.amountBase, quotes[0].amount);
});

test('refuses to quote if 1Click arb USDC is not the contract the wallet will pay', async () => {
  deps.getTokens = async () => [{ ...TOKENS[0], contractAddress: '0x' + '1'.repeat(40) }, TOKENS[1]];
  await assert.rejects(createOrder(valid), /does not match/);
  assert.equal(quotes.length, 0);
});

test('wallet tx hash is recorded and submitted to 1Click once', async () => {
  const o = await createOrder(valid);
  await recordDepositTx(o, TX);
  await recordDepositTx(o, TX);
  assert.equal(o.txHash, TX);
  assert.deepEqual(submits, [{ txHash: TX, depositAddress: '0xdeposit' }]);
  assert.match(o.events.at(-1)!.msg, /notified/);
});

test('deposit-submit failure never fails the order', async () => {
  submitFails = true;
  const o = await createOrder(valid);
  await recordDepositTx(o, TX); // must not throw
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.txHash, TX);
  swapStatus = 'SUCCESS';
  await tick(); await sleep(30);
  assert.equal(o.status, 'delivered');
});

test('rejects a malformed tx hash without calling 1Click', async () => {
  const o = await createOrder(valid);
  await assert.rejects(recordDepositTx(o, '0x123'), /txHash/);
  assert.equal(o.txHash, undefined);
  assert.equal(submits.length, 0);
});

// --- unclear provider outcomes: never resend, resolve by re-query
async function paidOrder() {
  const o = await createOrder(valid);
  swapStatus = 'SUCCESS';
  await tick(); await sleep(30);
  return o;
}
function withCheck(result: { ok: boolean; pending?: boolean; notFound?: boolean; providerRef?: string; error?: string }) {
  let checks = 0;
  deps.vtu = {
    buyAirtime: async () => { buys++; return buyResult; },
    checkAirtime: async () => { checks++; return result; },
  };
  return () => checks;
}

test('unclear purchase becomes fulfilment_pending, then re-query delivers without a second purchase', async () => {
  buyResult = { ok: false, pending: true, error: 'timeout' } as typeof buyResult;
  const result = { ok: false, pending: true } as { ok: boolean; pending?: boolean; providerRef?: string };
  const checks = withCheck(result);
  const o = await paidOrder();
  assert.equal(o.status, 'fulfilment_pending');
  await tick();
  assert.equal(o.status, 'fulfilment_pending');
  result.ok = true; result.pending = undefined; result.providerRef = 'T7';
  await tick();
  assert.equal(o.status, 'delivered');
  assert.equal(o.providerRef, 'T7');
  assert.equal(buys, 1);
  assert.equal(checks(), 2);
});

test('a provider that throws leaves the order pending, not refund_due', async () => {
  deps.vtu = { buyAirtime: async () => { buys++; throw new Error('socket hang up'); } };
  const o = await paidOrder();
  assert.equal(o.status, 'fulfilment_pending');
  assert.equal(buys, 1);
});

test('re-query failure becomes refund_due', async () => {
  buyResult = { ok: false, pending: true } as typeof buyResult;
  withCheck({ ok: false, error: 'statusCode 5010' });
  const o = await paidOrder();
  await tick();
  assert.equal(o.status, 'refund_due');
  assert.equal(buys, 1);
});

test('"no record" only counts as failure after the grace period', async () => {
  buyResult = { ok: false, pending: true } as typeof buyResult;
  withCheck({ ok: false, notFound: true, error: 'no record' });
  const o = await paidOrder();
  await tick();
  assert.equal(o.status, 'fulfilment_pending');
  o.fulfilAt = Date.now() - NOT_FOUND_GRACE_MS - 1;
  await tick();
  assert.equal(o.status, 'refund_due');
  assert.equal(buys, 1);
});

test('an order stuck in fulfilling (e.g. after a restart) is re-queried, not re-bought', async () => {
  const checks = withCheck({ ok: true, providerRef: 'T8' });
  const o = await createOrder(valid);
  o.status = 'fulfilling';
  o.fulfilAt = Date.now() - 10_000;
  await tick();
  assert.equal(o.status, 'fulfilling'); // too early to tell
  o.fulfilAt = Date.now() - STUCK_FULFILLING_MS - 1;
  await tick();
  assert.equal(o.status, 'delivered');
  assert.equal(buys, 0);
  assert.equal(checks(), 1);
});

test('refuses to quote when the airtime wallet cannot cover the order', async () => {
  deps.vtu = { buyAirtime: async () => { buys++; return buyResult; }, availableNgn: async () => 900 };
  await assert.rejects(createOrder(valid), /temporarily unavailable/); // valid is ₦1000
  assert.equal(quotes.length, 0);
  deps.vtu.availableNgn = async () => undefined; // balance unknown: don't block
  await createOrder(valid);
  deps.vtu.availableNgn = async () => 5900;
  await createOrder(valid);
  assert.equal(quotes.length, 2);
});

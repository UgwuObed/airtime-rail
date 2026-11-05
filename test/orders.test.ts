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

const { createOrder, tick, markPaid, deps, resetOrdersForTests } = await import('../src/orders.js');

const TOKENS = [
  { assetId: 'arb-usdc', symbol: 'USDC', blockchain: 'arb', decimals: 6 },
  { assetId: 'near-usdc', symbol: 'USDC', blockchain: 'near', decimals: 6 },
];
const valid = { network: 'mtn', phone: '08031234567', amountNgn: 1000, originChain: 'arb', refundTo: '0x' + 'a'.repeat(40) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let quotes: any[], swapStatus: string, buys: number, buyResult: { ok: boolean; providerRef?: string; error?: string };

beforeEach(() => {
  resetOrdersForTests();
  quotes = []; swapStatus = 'PENDING_DEPOSIT'; buys = 0; buyResult = { ok: true, providerRef: 'R1' };
  deps.getTokens = async () => TOKENS;
  deps.getQuote = async (p) => {
    quotes.push(p);
    return { quote: { depositAddress: '0xdeposit', deadline: new Date(Date.now() + 600_000).toISOString() } };
  };
  deps.getStatus = async () => ({ status: swapStatus });
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

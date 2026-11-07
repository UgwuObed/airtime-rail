import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.RECIPIENT_NEAR_ACCOUNT = 'merchant.near';
process.env.NGN_PER_USD = '1000';
process.env.SUPPORTED_ORIGINS = 'arb';
process.env.DEMO_MODE = 'true';
process.env.VTU_PROVIDER = 'mock';
process.env.ORDER_RATE_LIMIT = '10';
process.env.MAX_OPEN_ORDERS = '1000';
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airtime-safety-')), 'orders.json');

const { unsafeConfig } = await import('../src/config.js');
const { createRateLimiter } = await import('../src/ratelimit.js');
const { createApp } = await import('../src/app.js');
const { deps } = await import('../src/orders.js');

test('unsafeConfig: demo mode only with the mock provider', () => {
  assert.match(unsafeConfig({ DEMO_MODE: 'true', VTU_PROVIDER: 'topupbox' })!, /Refusing to start/);
  assert.equal(unsafeConfig({ DEMO_MODE: 'true', VTU_PROVIDER: 'mock' }), undefined);
  assert.equal(unsafeConfig({ DEMO_MODE: 'true' }), undefined); // provider defaults to mock
  assert.equal(unsafeConfig({ DEMO_MODE: 'false', VTU_PROVIDER: 'topupbox' }), undefined);
  assert.equal(unsafeConfig({ VTU_PROVIDER: 'topupbox' }), undefined);
});

test('the server process refuses to start with DEMO_MODE=true and a real provider', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, DEMO_MODE: 'true', VTU_PROVIDER: 'topupbox', TOPUPBOX_TOKEN: 'x', PORT: '0' },
    encoding: 'utf8', timeout: 20_000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Refusing to start: DEMO_MODE=true with VTU_PROVIDER=topupbox/);
});

test('rate limiter: 10 per window per key, then resets', () => {
  let t = 0;
  const l = createRateLimiter({ limit: 10, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 10; i++) assert.equal(l.hit('a').ok, true);
  const r = l.hit('a');
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterSec, 60);
  assert.equal(l.hit('b').ok, true); // other IPs unaffected
  t = 30_000;
  assert.equal(l.hit('a').retryAfterSec, 30);
  t = 60_000;
  assert.equal(l.hit('a').ok, true);
});

// --- HTTP: real Express app on an ephemeral port, 1Click mocked ------------------------------------
let server: Server, base: string;
before(async () => {
  deps.getTokens = async () => [
    { assetId: 'arb-usdc', symbol: 'USDC', blockchain: 'arb', decimals: 6 },
    { assetId: 'near-usdc', symbol: 'USDC', blockchain: 'near', decimals: 6 },
  ];
  deps.getQuote = async () => ({ quote: { depositAddress: '0x' + 'd'.repeat(40), deadline: new Date(Date.now() + 600_000).toISOString() } });
  deps.vtu = { buyAirtime: async () => ({ ok: true, providerRef: 'R' }) };
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const order = { network: 'mtn', phone: '08031234567', amountNgn: 1000, originChain: 'arb', refundTo: '0x' + 'a'.repeat(40) };

test('HTTP: bulk create, line guards, and the 10/min limit shared by /api/orders and /api/bulk', async () => {
  const r = await post('/api/bulk', { items: [{ network: 'mtn', phone: '08031234567', amountNgn: 1000 }, { network: 'glo', phone: '08051234567', amountNgn: 500 }],
    originChain: 'arb', refundTo: order.refundTo });
  assert.equal(r.status, 201);
  const b = await r.json();
  assert.equal(b.kind, 'bulk');
  assert.equal(b.lines.length, 2);
  assert.equal(b.payment.kind, 'evm');
  assert.equal(b.summary.totalNgn, 1500);

  // A bulk line is not separately payable.
  const line = await (await fetch(`${base}/api/orders/${b.lines[0].id}`)).json();
  assert.equal(line.payment, undefined);
  assert.equal((await post(`/api/orders/${b.lines[0].id}/tx`, { txHash: '0x' + '1'.repeat(64) })).status, 404);
  assert.equal((await post(`/api/dev/orders/${b.lines[0].id}/simulate-paid`, {})).status, 404);
  assert.equal((await fetch(`${base}/api/bulk/${b.id}/qr.svg`)).headers.get('content-type'), 'image/svg+xml; charset=utf-8');

  const bad = await post('/api/bulk', { items: 'nope', originChain: 'arb', refundTo: order.refundTo });
  assert.equal(bad.status, 400);

  // 2 creation requests so far in this window (the rejected one counts too), so 8 more pass and the 11th is limited.
  const statuses: number[] = [];
  for (let i = 0; i < 9; i++) statuses.push((await post('/api/orders', order)).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 201, 201, 429]);
  const limited = await post('/api/bulk', { items: [], originChain: 'arb', refundTo: order.refundTo });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match((await limited.json()).error, /Too many orders/);
  // Reading is never limited.
  assert.equal((await fetch(`${base}/api/bulk/${b.id}`)).status, 200);
});

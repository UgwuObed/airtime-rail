import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Own process (node --test isolates files), so all eight origins can be enabled here.
process.env.RECIPIENT_NEAR_ACCOUNT = 'merchant.near';
process.env.NGN_PER_USD = '1000';
process.env.MARGIN_PCT = '2';
process.env.SUPPORTED_ORIGINS = '';
process.env.DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airtime-chains-')), 'orders.json');

const { CHAINS, ALL_ORIGINS, formatUnits, isNearAccount, isSolanaAddress } = await import('../src/chains.js');
const { erc20TransferData, paymentFor } = await import('../src/payment.js');
const { createOrder, deps, resetOrdersForTests } = await import('../src/orders.js');
const { config } = await import('../src/config.js');
type EvmPayment = import('../src/payment.js').EvmPayment;

const EVM_DEPOSIT = '0x' + 'Cd'.repeat(20);
const SOL_ADDR = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV'; // valid-format 32-byte key
const NEAR_IMPLICIT = 'a'.repeat(64);

const TOKENS = Object.values(CHAINS).map((c) => ({
  assetId: `${c.id}-usdc`, symbol: 'USDC', blockchain: c.id, decimals: c.decimals,
  contractAddress: c.kind === 'evm' ? c.usdc.toLowerCase() : c.usdc, // 1Click reports EVM in lowercase
}));
let quotes: any[];
beforeEach(() => {
  resetOrdersForTests();
  quotes = [];
  deps.getTokens = async () => TOKENS;
  deps.getQuote = async (p) => {
    quotes.push(p);
    return { quote: { depositAddress: EVM_DEPOSIT, deadline: new Date(Date.now() + 600_000).toISOString() } };
  };
  deps.vtu = { buyAirtime: async () => ({ ok: true, providerRef: 'R' }) };
});
const order = { network: 'mtn', phone: '08031234567', amountNgn: 1000 };

test('SUPPORTED_ORIGINS defaults to all eight chains', () => {
  assert.deepEqual(config.origins, ['arb', 'base', 'eth', 'op', 'pol', 'bsc', 'sol', 'near']);
  assert.deepEqual(ALL_ORIGINS, config.origins);
});

test('EVM payment per chain: chain id, USDC contract, calldata and EIP-681 URI', () => {
  const expected: Record<string, [string, number, string]> = {
    arb: ['0xa4b1', 42161, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
    base: ['0x2105', 8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    eth: ['0x1', 1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    op: ['0xa', 10, '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'],
    pol: ['0x89', 137, '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'],
    bsc: ['0x38', 56, '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'],
  };
  for (const [id, [hex, chainId, token]] of Object.entries(expected)) {
    const amountBase = id === 'bsc' ? '1020000000000000000' : '1020000';
    const p = paymentFor({ originChain: id, depositAddress: EVM_DEPOSIT, amountBase }) as EvmPayment;
    assert.equal(p.kind, 'evm', id);
    assert.equal(p.chainIdHex, hex, id);
    assert.equal(p.addChain.chainId, hex, id);
    assert.equal(p.tx.to, token, id);
    assert.equal(p.tx.data, erc20TransferData(EVM_DEPOSIT, amountBase), id);
    assert.equal(p.uri, `ethereum:${token}@${chainId}/transfer?address=${EVM_DEPOSIT}&uint256=${amountBase}`, id);
    assert.ok(p.explorerTx.startsWith('https://') && p.explorerTx.endsWith('/tx/'), id);
  }
});

test('BSC: amountBase uses 18 decimals and calldata encodes it exactly', async () => {
  const o = await createOrder({ ...order, originChain: 'bsc', refundTo: '0x' + 'a'.repeat(40) });
  assert.equal(o.amountBase, '1020000000000000000'); // 1.02 USDC at 18 decimals
  assert.equal(quotes[0].amount, o.amountBase);
  assert.equal(o.usdcAmount, '1.02');
  const p = paymentFor(o) as EvmPayment;
  assert.equal(p.tx.data.slice(-64), BigInt('1020000000000000000').toString(16).padStart(64, '0')); // 0x0e27c49886e60000
});

test('sol and near: QR/copy only, no wallet tx', () => {
  const sol = paymentFor({ originChain: 'sol', depositAddress: SOL_ADDR, amountBase: '1020000' })!;
  assert.equal(sol.kind, 'sol');
  assert.equal('tx' in sol, false);
  assert.equal(sol.uri, `solana:${SOL_ADDR}?amount=1.02&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`);
  const near = paymentFor({ originChain: 'near', depositAddress: NEAR_IMPLICIT, amountBase: '1020000' })!;
  assert.equal(near.kind, 'near');
  assert.equal(near.uri, NEAR_IMPLICIT);
  // A deposit address in the wrong format for the chain is never turned into a payment request.
  assert.equal(paymentFor({ originChain: 'sol', depositAddress: EVM_DEPOSIT, amountBase: '1' }), undefined);
  assert.equal(paymentFor({ originChain: 'arb', depositAddress: SOL_ADDR, amountBase: '1' }), undefined);
});

test('formatUnits is exact, without floats', () => {
  assert.equal(formatUnits('1020000', 6), '1.02');
  assert.equal(formatUnits('1000000', 6), '1');
  assert.equal(formatUnits('5', 6), '0.000005');
  assert.equal(formatUnits('1020000000000000000', 18), '1.02');
});

test('guard: 1Click token must match our contract and decimals, per chain', async () => {
  const bad = (chain: string, patch: object) => {
    deps.getTokens = async () => TOKENS.map((t) => (t.blockchain === chain ? { ...t, ...patch } : t));
    resetOrdersForTests();
    deps.getTokens = async () => TOKENS.map((t) => (t.blockchain === chain ? { ...t, ...patch } : t));
  };
  bad('base', { contractAddress: '0x' + '1'.repeat(40) });
  await assert.rejects(createOrder({ ...order, originChain: 'base', refundTo: '0x' + 'a'.repeat(40) }), /base USDC contract .* does not match/);
  bad('sol', { contractAddress: CHAINS.sol.usdc.toLowerCase() }); // base58 is case-sensitive
  await assert.rejects(createOrder({ ...order, originChain: 'sol', refundTo: SOL_ADDR }), /sol USDC contract .* does not match/);
  bad('bsc', { decimals: 6 });
  await assert.rejects(createOrder({ ...order, originChain: 'bsc', refundTo: '0x' + 'a'.repeat(40) }), /18/);
  assert.equal(quotes.length, 0);
  bad('base', {}); // EVM comparison ignores checksum case
  await createOrder({ ...order, originChain: 'base', refundTo: '0x' + 'a'.repeat(40) });
  assert.equal(quotes.length, 1);
});

test('non-EVM address validation', () => {
  for (const ok of [SOL_ADDR, CHAINS.sol.usdc, '11111111111111111111111111111111']) assert.ok(isSolanaAddress(ok), ok);
  for (const bad of ['0x' + 'a'.repeat(40), 'O0Il' + SOL_ADDR.slice(4), SOL_ADDR.slice(0, 20), SOL_ADDR + 'abc', 'alice.near'])
    assert.equal(isSolanaAddress(bad), false, bad);
  // '0x' + 40 lowercase hex is a valid NEAR account too (ETH-implicit account, NEP-518).
  for (const ok of ['alice.near', 'lunquasar.tg', 'my-shop_01.near', 'aa', NEAR_IMPLICIT, '0x' + 'a'.repeat(40)]) assert.ok(isNearAccount(ok), ok);
  for (const bad of ['Alice.near', 'a', '-bad.near', 'bad..near', 'bad.', 'x'.repeat(65), '0x' + 'A'.repeat(40), SOL_ADDR])
    assert.equal(isNearAccount(bad), false, bad);
});

test('refundTo must match the origin chain format', async () => {
  await assert.rejects(createOrder({ ...order, originChain: 'sol', refundTo: '0x' + 'a'.repeat(40) }), /refundTo must be your own Solana address/);
  await assert.rejects(createOrder({ ...order, originChain: 'near', refundTo: SOL_ADDR }), /refundTo must be your own NEAR account/);
  await assert.rejects(createOrder({ ...order, originChain: 'base', refundTo: 'alice.near' }), /refundTo must be your own Base address/);
  assert.equal(quotes.length, 0);
  await createOrder({ ...order, originChain: 'sol', refundTo: SOL_ADDR });
  await createOrder({ ...order, originChain: 'near', refundTo: 'alice.near' });
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].refundTo, SOL_ADDR);
});

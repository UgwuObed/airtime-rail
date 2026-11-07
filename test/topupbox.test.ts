import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRecharge, classifyRequery, createTopupBox, parseBalance, topupboxRef } from '../src/topupbox.js';

const ID = '098cca49-3bfd-4b0b-ba3b-ccaf0685a018';
const REF = topupboxRef(ID);
const j = (v: unknown) => JSON.stringify(v);

test('reference is deterministic, alphanumeric, 20 chars', () => {
  assert.equal(REF, 'AR098cca493bfd4b0bba');
  assert.equal(topupboxRef(ID), REF);
});

test('recharge: "0" envelope is delivered, definite 4xx is failed', () => {
  assert.deepEqual(classifyRecharge(200, j({ response: '0', message: 'Success', result: { transactionId: 'T9' } }), REF),
    { ok: true, providerRef: 'T9' });
  assert.equal(classifyRecharge(200, j({ response: '0', message: 'Success' }), REF).providerRef, REF);
  for (const s of [400, 401, 403]) {
    const r = classifyRecharge(s, j({ message: 'bad' }), REF);
    assert.equal(r.ok, false); assert.equal(r.pending, undefined);
  }
  const d = classifyRecharge(200, j({ response: '17', message: 'Insufficient wallet balance' }), REF);
  assert.equal(d.ok, false); assert.equal(d.pending, undefined); assert.match(d.error!, /Insufficient/);
});

test('recharge: anything unclear is pending, never failed', () => {
  for (const [s, body] of [[201, j({})], [202, j({ status: '2000' })], [500, ''], [502, '<html>'], [200, 'not json'], [200, j({ foo: 1 })],
    [200, j({ statusCode: 202 })]] as const) {
    const r = classifyRecharge(s, body, REF);
    assert.equal(r.ok, false, `${s} ${body}`); assert.equal(r.pending, true, `${s} ${body}`);
  }
});

test('requery: statusCode 200 delivered, failure codes failed, 404 not found, unclear pending', () => {
  assert.equal(classifyRequery(200, j({ response: '0', result: { statusCode: 200, transactionId: 'T1' } }), REF).ok, true);
  assert.equal(classifyRequery(200, j({ response: '0', result: [{ status: 'SUCCESSFUL' }] }), REF).ok, true);
  assert.equal(classifyRequery(200, j({ response: '0', result: { content: [{ statusCode: '200' }] } }), REF).ok, true);
  const f = classifyRequery(200, j({ response: '0', result: { statusCode: 5010 } }), REF);
  assert.equal(f.ok, false); assert.equal(f.pending, undefined);
  assert.equal(classifyRequery(404, '', REF).notFound, true);
  assert.equal(classifyRequery(200, j({ response: '99', message: 'Record not found' }), REF).notFound, true);
  assert.equal(classifyRequery(200, j({ response: '0', result: null }), REF).notFound, true);
  assert.equal(classifyRequery(200, j({ response: '0', result: { status: 'PENDING' } }), REF).pending, true);
  assert.equal(classifyRequery(500, '', REF).pending, true);
});

test('provider sends the documented request, and a network error is pending (not resent)', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let fail = false;
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (fail) throw new Error('ECONNRESET');
    return new Response(j({ response: '0', message: 'Success' }), { status: 200 });
  }) as unknown as typeof fetch;
  const p = createTopupBox({ token: 'tok', fetch: fake });

  const r = await p.buyAirtime({ network: '9mobile', phone: '08091234567', amountNgn: 500, reference: ID });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, 'https://api.topupbox.com/services/api/v2/w1/recharge/9MOBILE/AIRTIME');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'tok'); // bare token (Bearer gets 401)
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),
    { amount: '500', beneficiary: '08091234567', customer_reference: REF, tariffTypeId: '0' });

  await p.checkAirtime(ID);
  assert.equal(calls[1].url, `https://api.topupbox.com/services/api/v2/w1/query/${REF}`);

  fail = true;
  const n = await p.buyAirtime({ network: 'mtn', phone: '08031234567', amountNgn: 100, reference: ID });
  assert.equal(n.pending, true);
  assert.equal(calls.length, 3); // one attempt, no retry

  const raw = createTopupBox({ token: 'tok', auth: 'bearer', baseUrl: 'https://sandbox-api.topupbox.com/services/', fetch: fake });
  fail = false; calls.length = 0;
  await raw.checkAirtime(ID);
  assert.equal(calls[0].url, `https://sandbox-api.topupbox.com/services/api/v2/w1/query/${REF}`);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer tok');
});

// Bodies below were captured from the live API on 2026-11-05.
test('live shapes: data-style envelope', () => {
  const unknownRef = j({ status: '2000', description: 'Success', data: [] });
  assert.equal(classifyRequery(200, unknownRef, REF).notFound, true);
  // A found record inside data[] must NOT be read as "not found" (that would refund a delivered order).
  const found = classifyRequery(200, j({ status: '2000', description: 'Success', data: [{ statusCode: '200', transactionId: 'X1' }] }), REF);
  assert.deepEqual(found, { ok: true, providerRef: 'X1' });
  assert.equal(classifyRequery(200, j({ status: '2000', data: [{ statusCode: '5010' }] }), REF).pending, undefined);
  assert.equal(classifyRequery(200, j({ status: '2000', data: [{ statusCode: '5010' }] }), REF).ok, false);
  assert.equal(classifyRequery(200, j({ status: '2000', data: [{ foo: 1 }] }), REF).pending, true);

  assert.equal(classifyRecharge(200, j({ status: '2000', description: 'Success', data: { transactionId: 'X2' } }), REF).providerRef, 'X2');
  assert.equal(classifyRecharge(200, j({ status: '2001', description: 'Processing' }), REF).pending, true);
  const bad = classifyRecharge(200, j({ status: '4005', description: 'Insufficient balance' }), REF);
  assert.equal(bad.pending, undefined); assert.match(bad.error!, /Insufficient balance/);
  // Spring's error body also has a numeric "status"; HTTP status decides that case.
  assert.equal(classifyRecharge(401, j({ status: 401, error: 'Unauthorized' }), REF).pending, undefined);
});

// Exact bodies from the live ₦100 MTN purchase on 2026-11-05.
const LIVE_RECHARGE = {"status":"2000","response":"Success","message":"Success","amount":"100","discountAmount":"100.00","balance":"5900.00","statusCode":null,"customer_reference":"AR4bc96959f87242c292","referenceNumber":"2026110515084160857513734","correlationId":"dd6a4470-eadb-4203-a361-65543117f677","messageFromNetwork":"Success","confirmationCode":"2026110515084160857513734"};
const LIVE_REQUERY = {"status":"2000","description":"Success","data":[{"id":4010153910,"amount":100.0,"requestType":"AIRTIME","customerReference":"AR4bc96959f87242c292","correlationId":"dd6a4470-eadb-4203-a361-65543117f677","beneficiary":"09065809240","statusCode":"200","statusMessage":"Success","messageFromNetwork":"0::Successful","network":"MTN","confirmationCode":"2026110515084160857513734"}]};

test('live recharge (HTTP 201, response: "Success") is delivered', () => {
  const r = { ok: true, providerRef: '2026110515084160857513734' };
  assert.deepEqual(classifyRecharge(201, j(LIVE_RECHARGE), 'AR4bc96959f87242c292'), r);
  // The same body over HTTP 200 must also be delivered, never "declined (Success)".
  assert.deepEqual(classifyRecharge(200, j(LIVE_RECHARGE), 'AR4bc96959f87242c292'), r);
});

test('live re-query is delivered with the same confirmation code', () => {
  assert.deepEqual(classifyRequery(200, j(LIVE_REQUERY), 'AR4bc96959f87242c292'), { ok: true, providerRef: '2026110515084160857513734' });
});

test('envelope success but the network reports failure: pending, re-query decides', () => {
  const r = classifyRecharge(201, j({ ...LIVE_RECHARGE, messageFromNetwork: 'Failed: invalid number' }), 'X');
  assert.equal(r.ok, false); assert.equal(r.pending, true);
});

test('balance parses the live shape and ignores anything else', () => {
  assert.equal(parseBalance(200, j({ status: '2000', description: 'Success', data: { time: 't', accountBalance: '5900.00' } })), 5900);
  assert.equal(parseBalance(401, j({ status: 401, error: 'Unauthorized' })), undefined);
  assert.equal(parseBalance(200, 'nope'), undefined);
});

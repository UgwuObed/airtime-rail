// TopupBox airtime adapter (Nigeria: MTN, Airtel, Glo, 9mobile).
//
// What the public docs and Postman collection establish:
//   - POST {base}/api/v2/w1/recharge/{NETWORK}/AIRTIME  body { amount, beneficiary, customer_reference, tariffTypeId }
//   - GET  {base}/api/v2/w1/query/{customerReference}  re-query one transaction by our own reference
//   - Network codes come from GET /api/v2/w1/get-all-telco: MTN, GLO, AIRTEL, 9MOBILE
//   - Auth is the bare token: `Authorization: <token>`. "Bearer <token>" gets 401 (verified live, 2026-11-05).
//   - Two envelopes exist (verified live): { status: "2000", description, data } on balance/query, and
//     { response: "0", message, result } on get-all-telco. Both mean success.
//   - Re-query of an unknown reference: 200 { status: "2000", description: "Success", data: [] } (verified live).
//   - Recharge (live ₦100, 2026-11-05): HTTP 201 { status: "2000", response: "Success", message: "Success",
//     messageFromNetwork: "Success", statusCode: null, customer_reference, referenceNumber, confirmationCode, balance }
//     Note `response` is TEXT here, while get-all-telco uses response: "0". Codes are read from numeric strings only.
//   - Re-query of that reference: 200 { status: "2000", data: [{ statusCode: "200", statusMessage: "Success",
//     messageFromNetwork: "0::Successful", confirmationCode, customerReference, ... }] }
//   - Balance: 200 { status: "2000", data: { accountBalance: "6000.00" } }. Merchant is charged face value.
// Still NOT established: whether customer_reference is idempotent. So this adapter stays conservative:
//   - Anything ambiguous (timeout, 5xx, 201, unknown shape) is PENDING, never a failure and never re-sent.
//   - Pending orders are resolved only by re-querying our reference. A recharge is sent at most once per order.
import type { Network, VtuProvider, VtuResult } from './vtu.js';

export const TOPUPBOX_NETWORK: Record<Network, string> = { mtn: 'MTN', airtel: 'AIRTEL', glo: 'GLO', '9mobile': '9MOBILE' };

/** Our customer_reference for an order: deterministic, so a re-query never needs stored state. 20 alphanumerics. */
export const topupboxRef = (orderId: string) => 'AR' + orderId.replace(/[^0-9a-zA-Z]/g, '').slice(0, 18);

type Json = Record<string, unknown>;
const parse = (text: string): Json | undefined => {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? (v as Json) : undefined; } catch { return undefined; }
};
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const msgOf = (b: Json | undefined, fallback: string) =>
  (str(b?.description) ?? str(b?.message) ?? str(b?.error) ?? str(b?.responseMessage) ?? fallback).slice(0, 200);
const SUCCESS_CODES = new Set(['0', '00', '200', '2000']);
/**
 * Envelope code. "status" ("2000") on the data-style envelope, "response" ("0") on the result-style one.
 * Only numeric strings count: the recharge body has response: "Success" next to status: "2000".
 * A numeric `status` (Spring error bodies) is ignored; the HTTP status covers those.
 */
function envelopeCode(b: Json): string | undefined {
  for (const v of [typeof b.status === 'string' ? b.status : undefined, str(b.response), str(b.responseCode)])
    if (v !== undefined && /^\d+$/.test(v)) return v;
  return undefined;
}
const NETWORK_FAILED = /fail|error|declin|reject|invalid|insufficient/i;
const payload = (b: Json): unknown => (b.data !== undefined ? b.data : b.result);
const isEmpty = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0);
/** 2xxx other than 2000, 201/202: accepted but not final. */
const isInFlight = (code: string) => code === '201' || code === '202' || (/^2\d{3}$/.test(code) && code !== '2000');

/** First transaction-looking record in a response: data/result, its [0], its .content[0], or the body itself. */
function record(b: Json): Json {
  const r = payload(b);
  const first = (x: unknown) => (Array.isArray(x) ? x[0] : x);
  const inner = first(r);
  if (inner && typeof inner === 'object') {
    const content = first((inner as Json).content);
    return (content && typeof content === 'object' ? content : inner) as Json;
  }
  return b;
}
/** confirmationCode is in both the recharge and the re-query response, so the ref is stable either way. */
const refOf = (rec: Json) =>
  str(rec.confirmationCode) ?? str(rec.referenceNumber) ?? str(rec.transactionId) ?? str(rec.transactionRef) ?? str(rec.id);

/** Classify the synchronous recharge response. Pure, so it is unit-tested. */
export function classifyRecharge(httpStatus: number, text: string, ref: string): VtuResult {
  const b = parse(text);
  if (httpStatus === 401 || httpStatus === 403)
    return { ok: false, error: `TopupBox rejected the token (HTTP ${httpStatus}); nothing was sent` };
  if (httpStatus >= 400 && httpStatus < 500) return { ok: false, error: `TopupBox rejected the request: ${msgOf(b, `HTTP ${httpStatus}`)}` };
  // 201 is what a successful recharge actually returns, so 200 and 201 both carry a readable outcome.
  if ((httpStatus !== 200 && httpStatus !== 201) || !b)
    return { ok: false, pending: true, error: `TopupBox outcome unclear (HTTP ${httpStatus}); re-querying` };

  const rec = record(b);
  const code = envelopeCode(b) ?? str(rec.statusCode) ?? str(b.statusCode);
  if (code === undefined) return { ok: false, pending: true, error: 'TopupBox response had no status; re-querying' };
  if (SUCCESS_CODES.has(code)) {
    // Envelope says success; if the record carries its own non-final code, trust the record.
    const sc = str(rec.statusCode);
    if (rec !== b && sc && !SUCCESS_CODES.has(sc)) return { ok: false, pending: true, error: `TopupBox record status ${sc}; re-querying` };
    // The network's own answer can disagree with the envelope; let the re-query settle it.
    const net = str(b.messageFromNetwork) ?? str(rec.messageFromNetwork);
    if (net && NETWORK_FAILED.test(net)) return { ok: false, pending: true, error: `Network said "${net.slice(0, 80)}"; re-querying` };
    return { ok: true, providerRef: refOf(b) ?? refOf(rec) ?? ref };
  }
  if (isInFlight(code)) return { ok: false, pending: true, error: `TopupBox accepted the recharge for processing (${code})` };
  return { ok: false, error: `TopupBox declined (${code}): ${msgOf(b, 'no message')}` };
}

/** Classify a re-query of our reference. `notFound` means TopupBox has no record of it at all. */
export function classifyRequery(httpStatus: number, text: string, ref: string): VtuResult & { notFound?: boolean } {
  const b = parse(text);
  if (httpStatus === 404) return { ok: false, notFound: true, error: 'TopupBox has no record of this recharge' };
  if (httpStatus !== 200 || !b) return { ok: false, pending: true, error: `Re-query unclear (HTTP ${httpStatus})` };

  const envelope = envelopeCode(b);
  if (envelope !== undefined && !SUCCESS_CODES.has(envelope)) {
    return /not\s*found|no\s*record|does\s*not\s*exist/i.test(msgOf(b, ''))
      ? { ok: false, notFound: true, error: 'TopupBox has no record of this recharge' }
      : { ok: false, pending: true, error: `Re-query returned ${envelope}: ${msgOf(b, 'no message')}` };
  }
  if (isEmpty(payload(b))) return { ok: false, notFound: true, error: 'TopupBox has no record of this recharge' };
  const rec = record(b);
  const sc = str(rec.statusCode);
  const status = str(rec.status) ?? str(rec.transactionStatus) ?? '';
  if ((sc && SUCCESS_CODES.has(sc) && sc !== '0') || /^(success|successful|completed|delivered)$/i.test(status))
    return { ok: true, providerRef: refOf(rec) ?? ref };
  if (/fail|declin|revers|refund|reject/i.test(status)) return { ok: false, error: `TopupBox reports the recharge failed (${status})` };
  if (sc && !isInFlight(sc) && /^\d+$/.test(sc)) return { ok: false, error: `TopupBox reports the recharge failed (statusCode ${sc})` };
  return { ok: false, pending: true, error: 'TopupBox is still processing the recharge' };
}

export interface TopupBoxOptions {
  token: string;
  baseUrl?: string;                 // default https://api.topupbox.com/services
  auth?: 'raw' | 'bearer';          // default raw: Authorization: "<token>" (Bearer is rejected by TopupBox)
  airtimeTariffTypeId?: string;     // required field, only meaningful for data; docs give no airtime value
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Parse the balance response; undefined if the shape is not the known one. */
export function parseBalance(httpStatus: number, text: string): number | undefined {
  const b = parse(text);
  if (httpStatus !== 200 || !b || envelopeCode(b) !== '2000') return undefined;
  const n = Number((b.data as Json | undefined)?.accountBalance);
  return Number.isFinite(n) ? n : undefined;
}

export function createTopupBox(o: TopupBoxOptions): VtuProvider & { checkAirtime(reference: string): Promise<VtuResult & { notFound?: boolean }> } {
  const base = (o.baseUrl || 'https://api.topupbox.com/services').replace(/\/+$/, '');
  const f = o.fetch ?? fetch;
  const headers = () => ({
    'Content-Type': 'application/json',
    Authorization: o.auth === 'bearer' ? `Bearer ${o.token}` : o.token,
  });
  const timeout = () => AbortSignal.timeout(o.timeoutMs ?? 45_000);

  return {
    async availableNgn() {
      try {
        const res = await f(`${base}/api/v2/w1/balance`, { headers: headers(), signal: AbortSignal.timeout(10_000) });
        return parseBalance(res.status, await res.text());
      } catch { return undefined; }
    },

    async buyAirtime(a) {
      const ref = topupboxRef(a.reference);
      let res: Response;
      try {
        res = await f(`${base}/api/v2/w1/recharge/${TOPUPBOX_NETWORK[a.network]}/AIRTIME`, {
          method: 'POST', headers: headers(), signal: timeout(),
          body: JSON.stringify({
            amount: String(a.amountNgn), beneficiary: a.phone, customer_reference: ref,
            tariffTypeId: o.airtimeTariffTypeId ?? '0',
          }),
        });
      } catch (e) {
        // The request may or may not have reached TopupBox. Never resend: re-query instead.
        return { ok: false, pending: true, error: `TopupBox unreachable (${(e as Error).name}); re-querying` };
      }
      return classifyRecharge(res.status, await res.text().catch(() => ''), ref);
    },

    async checkAirtime(reference) {
      const ref = topupboxRef(reference);
      try {
        const res = await f(`${base}/api/v2/w1/query/${encodeURIComponent(ref)}`, { headers: headers(), signal: timeout() });
        return classifyRequery(res.status, await res.text().catch(() => ''), ref);
      } catch (e) {
        return { ok: false, pending: true, error: `Re-query failed (${(e as Error).name})` };
      }
    },
  };
}

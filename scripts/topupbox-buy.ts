// ONE live TopupBox airtime purchase. SPENDS REAL WALLET BALANCE.
// Usage: npm run topupbox:buy -- <mtn|airtel|glo|9mobile> <phone> <amountNgn> --confirm
// Prints the raw recharge and re-query responses, so the adapter's classifier can be checked against reality.
import { randomUUID } from 'node:crypto';
import { createTopupBox, topupboxRef, TOPUPBOX_NETWORK } from '../src/topupbox.js';
import type { Network } from '../src/vtu.js';

const [network, phone, amount] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!(network in TOPUPBOX_NETWORK) || !/^0[789][01]\d{8}$/.test(phone ?? '') || !(Number(amount) >= 50))
  throw new Error('usage: npm run topupbox:buy -- <mtn|airtel|glo|9mobile> <08xxxxxxxxx> <amountNgn> --confirm');
if (!process.argv.includes('--confirm')) throw new Error(`Refusing to spend without --confirm (would send ₦${amount} ${network} to ${phone})`);
const token = process.env.TOPUPBOX_TOKEN;
if (!token) throw new Error('Set TOPUPBOX_TOKEN in .env');

// Wrap fetch to print the raw exchange.
const loud = (async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  const text = await r.text();
  console.log(`\n${init?.method ?? 'GET'} ${url}\n${init?.body ?? ''}\n-> HTTP ${r.status}\n${text}`);
  return new Response(text, { status: r.status, headers: r.headers });
}) as typeof fetch;

const p = createTopupBox({
  token, fetch: loud, baseUrl: process.env.TOPUPBOX_BASE_URL,
  auth: process.env.TOPUPBOX_AUTH === 'bearer' ? 'bearer' : 'raw',
  airtimeTariffTypeId: process.env.TOPUPBOX_AIRTIME_TARIFF_ID || undefined,
});
const id = randomUUID();
console.log(`reference ${topupboxRef(id)}`);
console.log('\nadapter verdict (recharge):', await p.buyAirtime({ network: network as Network, phone, amountNgn: Number(amount), reference: id }));
await new Promise((r) => setTimeout(r, 5000));
console.log('\nadapter verdict (re-query):', await p.checkAirtime(id));

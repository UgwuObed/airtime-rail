// Dry-quote probe against the 1Click API. Never creates a deposit address (dry: true) and moves no funds.
//   npm run quote            -> origin matrix: USDC on each chain -> NEAR USDC (recipientType INTENTS)
//   npm run quote -- --routes -> the original route probes (control swap, recipient variants)
import crypto from 'node:crypto';
import { getQuote, getTokens, Token } from '../src/intents.js';

const nearAccount = process.env.RECIPIENT_NEAR_ACCOUNT;
const evm = process.env.REFUND_EVM_ADDRESS;
if (!nearAccount || !evm) throw new Error('Set RECIPIENT_NEAR_ACCOUNT and REFUND_EVM_ADDRESS in .env');

const tokens = await getTokens();
const tok = (symbol: string, chain: string): Token => {
  const t = tokens.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase() && x.blockchain === chain);
  if (!t) throw new Error(`token not found: ${symbol} on ${chain}`);
  return t;
};
// whole-dollar amount -> integer string in the token's smallest unit (no exponent notation)
const toBase = (usd: number, decimals: number) => (BigInt(Math.round(usd * 100)) * 10n ** BigInt(decimals - 2)).toString();
const errText = (e: unknown) => {
  const msg = (e as Error).message;
  const m = msg.match(/"message":"([^"]+)"/);
  return m ? m[1] : msg.replace(/\s+/g, ' ').slice(0, 120);
};

// --- original route probes -------------------------------------------------------------------
async function probe(label: string, from: Token, to: Token, usd: number, recipient: string, recipientType?: 'DESTINATION_CHAIN' | 'INTENTS') {
  try {
    const { quote } = await getQuote({
      dry: true, originAsset: from.assetId, destinationAsset: to.assetId,
      amount: toBase(usd, from.decimals), recipient, refundTo: evm!, recipientType,
    });
    console.log(`OK    ${label}: out=${quote.amountOutFormatted} eta=${quote.timeEstimate}s`);
  } catch (e) {
    console.log(`FAIL  ${label}: ${errText(e)}`);
  }
}

if (process.argv.includes('--routes')) {
  const from = tok('USDC', 'arb');
  const nearUsdc = tok('USDC', 'near');
  const solAddr = '11111111111111111111111111111111'; // placeholder, dry quote only
  await probe('control: arb->base USDC $10', from, tok('USDC', 'base'), 10, evm);
  await probe('arb->near USDC, DESTINATION_CHAIN, your .tg', from, nearUsdc, 10, nearAccount);
  await probe('arb->near USDC, INTENTS, your .tg', from, nearUsdc, 10, nearAccount, 'INTENTS');
  await probe('arb->near USDC, DESTINATION_CHAIN, account "near"', from, nearUsdc, 10, 'near');
  await probe('arb->sol USDC, DESTINATION_CHAIN', from, tok('USDC', 'sol'), 10, solAddr);
  await probe('bsc->near USDC $1000', tok('USDC', 'bsc'), nearUsdc, 1000, nearAccount);
  process.exit(0);
}

// --- origin matrix ---------------------------------------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array) {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}
// Refund address in the origin chain's own format. Solana: REFUND_SOL_ADDRESS, else a random
// valid-format public key (dry quotes only; nothing is ever refunded from a dry quote).
const solRefund = process.env.REFUND_SOL_ADDRESS || base58(crypto.randomBytes(32));
const nearRefund = process.env.REFUND_NEAR_ACCOUNT || nearAccount;
const refundFor = (chain: string) => (chain === 'sol' ? solRefund : chain === 'near' ? nearRefund : evm);

const ORIGINS = ['arb', 'base', 'eth', 'op', 'pol', 'bsc', 'sol', 'near'];
const AMOUNTS = [1, 10, 100];
const dest = tok('USDC', 'near');

type Row = { origin: string; usd: number; ok: boolean; detail: string };
const jobs: (() => Promise<Row>)[] = [];
for (const origin of ORIGINS) for (const usd of AMOUNTS) jobs.push(async () => {
  try {
    const from = tok('USDC', origin);
    const { quote } = await getQuote({
      dry: true, originAsset: from.assetId, destinationAsset: dest.assetId, amount: toBase(usd, from.decimals),
      recipient: nearAccount, recipientType: 'INTENTS', refundTo: refundFor(origin),
    });
    return { origin, usd, ok: true, detail: `out=${quote.amountOutFormatted} USDC, eta=${quote.timeEstimate}s` };
  } catch (e) {
    return { origin, usd, ok: false, detail: errText(e) };
  }
});

// Small concurrency so the public API isn't hammered.
const rows: Row[] = [];
for (let i = 0; i < jobs.length; i += 4) rows.push(...(await Promise.all(jobs.slice(i, i + 4).map((j) => j()))));

const table = [['origin', 'amount', 'result', 'amountOutFormatted / timeEstimate, or error'],
  ...rows.map((r) => [r.origin, `$${r.usd}`, r.ok ? 'OK' : 'FAIL', r.detail])];
const w = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
const line = (row: string[]) => '| ' + row.map((cell, c) => cell.padEnd(w[c])).join(' | ') + ' |';
console.log(`\nUSDC -> near USDC, recipient ${nearAccount} (INTENTS), dry quotes\n`);
console.log(line(table[0]));
console.log('|' + w.map((n) => '-'.repeat(n + 2)).join('|') + '|');
for (const row of table.slice(1)) console.log(line(row));

console.log('\nUSDC per chain (from /v0/tokens)\n');
for (const origin of ORIGINS) {
  const t = tokens.find((x) => x.symbol.toUpperCase() === 'USDC' && x.blockchain === origin);
  console.log(`${origin.padEnd(5)} decimals=${t ? t.decimals : '-'}  ${t?.contractAddress ?? 'not listed'}`);
}
console.log(`\nrefundTo used: evm=${evm.slice(0, 6)}…  sol=${solRefund.slice(0, 6)}…${process.env.REFUND_SOL_ADDRESS ? '' : ' (random valid-format)'}  near=${nearRefund}`);

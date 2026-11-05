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

async function probe(label: string, from: Token, to: Token, usd: number, recipient: string, recipientType?: 'DESTINATION_CHAIN' | 'INTENTS') {
  try {
    const { quote } = await getQuote({
      dry: true, originAsset: from.assetId, destinationAsset: to.assetId,
      amount: toBase(usd, from.decimals), recipient, refundTo: evm!, recipientType,
    });
    console.log(`OK    ${label}: out=${quote.amountOutFormatted} eta=${quote.timeEstimate}s`);
  } catch (e) {
    const m = (e as Error).message.match(/"message":"([^"]+)"/);
    console.log(`FAIL  ${label}: ${m ? m[1] : (e as Error).message.slice(0, 120)}`);
  }
}

const from = tok('USDC', 'arb');
const nearUsdc = tok('USDC', 'near');
const solAddr = '11111111111111111111111111111111'; // placeholder, dry quote only
await probe('control: arb->base USDC $10', from, tok('USDC', 'base'), 10, evm);
await probe('arb->near USDC, DESTINATION_CHAIN, your .tg', from, nearUsdc, 10, nearAccount);
await probe('arb->near USDC, INTENTS, your .tg', from, nearUsdc, 10, nearAccount, 'INTENTS');
await probe('arb->near USDC, DESTINATION_CHAIN, account "near"', from, nearUsdc, 10, 'near');
await probe('arb->sol USDC, DESTINATION_CHAIN', from, tok('USDC', 'sol'), 10, solAddr);
await probe('bsc->near USDC $1000', tok('USDC', 'bsc'), nearUsdc, 1000, nearAccount);
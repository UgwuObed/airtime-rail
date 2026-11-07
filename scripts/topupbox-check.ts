// READ-ONLY TopupBox diagnostics. Spends nothing. Usage: npm run topupbox:check
const token = process.env.TOPUPBOX_TOKEN;
const base = (process.env.TOPUPBOX_BASE_URL || 'https://api.topupbox.com/services').replace(/\/+$/, '');
if (!token) throw new Error('Set TOPUPBOX_TOKEN in .env');

// 1. The token is a JWT; read its expiry locally (no signature check needed for this).
try {
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  const exp = new Date(claims.exp * 1000);
  console.log(`token: user=${claims.userId} role=${claims.roleName} expires=${exp.toISOString()}`);
  if (exp.getTime() < Date.now()) console.log('  ✗ EXPIRED. Regenerate it on the TopupBox dashboard; every call will be 401 until then.');
} catch { console.log('token: not a readable JWT'); }

const show = async (label: string, url: string, headers: Record<string, string> = {}) => {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    console.log(`${r.status}  ${label}\n     ${(await r.text()).replace(/\s+/g, ' ').slice(0, 600)}`);
    return r.status;
  } catch (e) { console.log(`ERR  ${label}: ${(e as Error).message}`); return 0; }
};

// 2. No auth needed: confirms the host and the network codes.
await show('get-all-telco', `${base}/api/v2/w1/get-all-telco`);

// 3. Find which Authorization format is accepted.
let works: string | undefined;
for (const [name, value] of [['raw', token], ['bearer', `Bearer ${token}`]] as const) {
  const s = await show(`balance (auth=${name})`, `${base}/api/v2/w1/balance`, { Authorization: value });
  if (s >= 200 && s < 300 && !works) works = name;
}
console.log(works ? `\n✓ set TOPUPBOX_AUTH=${works}` : '\n✗ no auth format accepted (expired/invalid token, or wrong host)');

// 4. What a re-query of an unknown reference looks like (the adapter treats it as "not found").
if (works) {
  const auth = works === 'bearer' ? `Bearer ${token}` : token;
  await show('requery unknown reference', `${base}/api/v2/w1/query/ARcheck000000000000`, { Authorization: auth });
  await show('last 3 transactions', `${base}/api/v2/w1/query/page/0/3?startDate=2025-01-01&endDate=2030-12-31`, { Authorization: auth });
}

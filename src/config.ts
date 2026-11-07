import { ALL_ORIGINS } from './chains.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k} (see .env.example)`);
  return v;
};

/**
 * Settings that must never be combined. DEMO_MODE exposes /api/dev/.../simulate-paid, which marks an order paid
 * without any money arriving; with a real airtime provider that would hand out real airtime for free.
 */
export function unsafeConfig(env: NodeJS.ProcessEnv): string | undefined {
  const provider = env.VTU_PROVIDER || 'mock';
  if (env.DEMO_MODE === 'true' && provider !== 'mock')
    return `Refusing to start: DEMO_MODE=true with VTU_PROVIDER=${provider}. Demo mode can mark orders paid without payment, `
      + 'which would buy real airtime for free. Set DEMO_MODE=false, or VTU_PROVIDER=mock.';
  return undefined;
}
const unsafe = unsafeConfig(process.env);
if (unsafe) throw new Error(unsafe);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  merchantAccount: need('RECIPIENT_NEAR_ACCOUNT'),
  ngnPerUsd: Number(need('NGN_PER_USD')),
  marginPct: Number(process.env.MARGIN_PCT ?? 2),
  origins: (process.env.SUPPORTED_ORIGINS || ALL_ORIGINS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
  demoMode: process.env.DEMO_MODE === 'true',
  pollMs: 5000,
  dataFile: process.env.DATA_FILE ?? 'data/orders.json',
  /** Orders + bulk batches still waiting for payment, across all customers. Each holds a live 1Click deposit address. */
  maxOpenOrders: Number(process.env.MAX_OPEN_ORDERS || 100),
  /** POST /api/orders and POST /api/bulk, per client IP, per minute. */
  orderRateLimit: Number(process.env.ORDER_RATE_LIMIT || 10),
  /** Express "trust proxy" setting, so req.ip is the client behind a reverse proxy (e.g. "1" for one hop). */
  trustProxy: process.env.TRUST_PROXY || '',
};

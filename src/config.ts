import { ALL_ORIGINS } from './chains.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k} (see .env.example)`);
  return v;
};
export const config = {
  port: Number(process.env.PORT ?? 3000),
  merchantAccount: need('RECIPIENT_NEAR_ACCOUNT'),
  ngnPerUsd: Number(need('NGN_PER_USD')),
  marginPct: Number(process.env.MARGIN_PCT ?? 2),
  origins: (process.env.SUPPORTED_ORIGINS || ALL_ORIGINS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
  demoMode: process.env.DEMO_MODE === 'true',
  pollMs: 5000,
  dataFile: process.env.DATA_FILE ?? 'data/orders.json',
};

// VTU (airtime) provider boundary. Pick the provider with VTU_PROVIDER; the order flow does not change.
import { createTopupBox } from './topupbox.js';

export type Network = 'mtn' | 'airtel' | 'glo' | '9mobile';
/**
 * ok: airtime delivered. ok=false + pending: outcome unknown, resolve with checkAirtime (never resend).
 * ok=false without pending: definitely not delivered.
 */
export interface VtuResult { ok: boolean; pending?: boolean; providerRef?: string; error?: string }
export interface VtuProvider {
  buyAirtime(a: { network: Network; phone: string; amountNgn: number; reference: string }): Promise<VtuResult>;
  /** Look up an earlier buyAirtime by the same reference. notFound = the provider never recorded it. */
  checkAirtime?(reference: string): Promise<VtuResult & { notFound?: boolean }>;
  /** Wallet balance in NGN, or undefined if it can't be read right now. */
  availableNgn?(): Promise<number | undefined>;
}

const seen = new Map<string, VtuResult>();
/** MOCK provider: succeeds, except numbers ending in 0000 (to demo the refund path). Idempotent by reference. */
export const mockProvider: VtuProvider = {
  async buyAirtime(a) {
    const prior = seen.get(a.reference);
    if (prior) return prior;
    await new Promise((r) => setTimeout(r, 800));
    const res: VtuResult = a.phone.endsWith('0000')
      ? { ok: false, error: 'MOCK: provider rejected this number' }
      : { ok: true, providerRef: `MOCK-${a.reference.slice(0, 8)}` };
    seen.set(a.reference, res);
    return res;
  },
  async checkAirtime(reference) {
    return seen.get(reference) ?? { ok: false, notFound: true, error: 'MOCK: unknown reference' };
  },
};

function select(): VtuProvider {
  const which = process.env.VTU_PROVIDER ?? 'mock';
  if (which === 'mock') return mockProvider;
  if (which === 'topupbox') {
    const token = process.env.TOPUPBOX_TOKEN;
    if (!token) throw new Error('VTU_PROVIDER=topupbox needs TOPUPBOX_TOKEN (see .env.example)');
    return createTopupBox({
      token,
      baseUrl: process.env.TOPUPBOX_BASE_URL,
      auth: process.env.TOPUPBOX_AUTH === 'bearer' ? 'bearer' : 'raw',
      airtimeTariffTypeId: process.env.TOPUPBOX_AIRTIME_TARIFF_ID || undefined,
    });
  }
  throw new Error(`VTU_PROVIDER must be mock or topupbox, got ${which}`);
}
export const vtu: VtuProvider = select();

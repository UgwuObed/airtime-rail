// VTU (airtime) provider boundary. Swap `vtu` for a real adapter; the order flow does not change.
export type Network = 'mtn' | 'airtel' | 'glo' | '9mobile';
export interface VtuResult { ok: boolean; providerRef?: string; error?: string }
export interface VtuProvider {
  buyAirtime(a: { network: Network; phone: string; amountNgn: number; reference: string }): Promise<VtuResult>;
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
};
export const vtu: VtuProvider = mockProvider;

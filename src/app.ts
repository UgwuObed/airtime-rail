import express, { RequestHandler, Response } from 'express';
import QRCode from 'qrcode';
import { publicChain } from './chains.js';
import { config } from './config.js';
import {
  Batch, batchLines, batchSummary, BusyError, createBatch, createOrder, getBatch, getOrder, markBatchPaid, markPaid,
  Order, recordDepositTx,
} from './orders.js';
import { paymentFor } from './payment.js';
import { createRateLimiter } from './ratelimit.js';

/** Order plus the ready-made wallet payment request. Bulk lines are paid by their batch, so they carry none. */
const view = (o: Order) => ({ ...o, payment: o.batchId ? undefined : paymentFor(o) });
const batchView = (b: Batch) => ({
  ...b, kind: 'bulk' as const, payment: paymentFor(b), summary: batchSummary(b),
  lines: batchLines(b).map((l) => ({
    id: l.id, line: l.line, network: l.network, phone: l.phone, amountNgn: l.amountNgn, usdcAmount: l.usdcAmount,
    status: l.status, providerRef: l.providerRef, error: l.error,
  })),
});

const fail = (res: Response, e: unknown) =>
  res.status(e instanceof BusyError ? 503 : 400).json({ error: (e as Error).message });

async function sendQr(res: Response, uri: string | undefined) {
  if (!uri) return res.status(404).json({ error: 'not found' });
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600')
    .send(await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
}

export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static('public'));

  // One budget per client IP for creating orders and batches: each one asks 1Click for a live deposit address.
  const limiter = createRateLimiter({ limit: config.orderRateLimit, windowMs: 60_000 });
  const limitOrders: RequestHandler = (req, res, next) => {
    const r = limiter.hit(req.ip ?? 'unknown');
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec))
      .status(429).json({ error: `Too many orders from this address. Try again in ${r.retryAfterSec} seconds.` });
  };

  // Chains in the order SUPPORTED_ORIGINS lists them; unknown ids are dropped.
  app.get('/api/config', (_req, res) =>
    res.json({ demoMode: config.demoMode, origins: config.origins.map(publicChain).filter(Boolean) }));

  // --- single orders ------------------------------------------------------------------------------
  app.post('/api/orders', limitOrders, async (req, res) => {
    try {
      const o = await createOrder({
        network: String(req.body?.network ?? ''), phone: String(req.body?.phone ?? ''),
        amountNgn: Number(req.body?.amountNgn), originChain: String(req.body?.originChain ?? ''),
        refundTo: String(req.body?.refundTo ?? ''),
      });
      res.status(201).json(view(o));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/orders/:id', (req, res) => {
    const o = getOrder(req.params.id);
    return o ? res.json(view(o)) : res.status(404).json({ error: 'not found' });
  });

  // QR for wallets that aren't injected into this page (e.g. a phone wallet).
  app.get('/api/orders/:id/qr.svg', async (req, res) => {
    const o = getOrder(req.params.id);
    await sendQr(res, o && !o.batchId ? paymentFor(o)?.uri : undefined);
  });

  // The browser wallet broadcast the deposit; record it and hint 1Click. Never fails because of 1Click.
  app.post('/api/orders/:id/tx', async (req, res) => {
    const o = getOrder(req.params.id);
    if (!o || o.batchId) return res.status(404).json({ error: 'not found' });
    try { res.json(view(await recordDepositTx(o, String(req.body?.txHash ?? '')))); } catch (e) { fail(res, e); }
  });

  // --- bulk ----------------------------------------------------------------------------------------
  app.post('/api/bulk', limitOrders, async (req, res) => {
    try {
      const raw = req.body?.items;
      if (!Array.isArray(raw)) throw new Error('items must be a list of {network, phone, amountNgn}');
      const b = await createBatch({
        items: raw.map((it: Record<string, unknown>) => ({
          network: String(it?.network ?? ''), phone: String(it?.phone ?? ''), amountNgn: Number(it?.amountNgn),
        })),
        originChain: String(req.body?.originChain ?? ''), refundTo: String(req.body?.refundTo ?? ''),
      });
      res.status(201).json(batchView(b));
    } catch (e) { fail(res, e); }
  });

  app.get('/api/bulk/:id', (req, res) => {
    const b = getBatch(req.params.id);
    return b ? res.json(batchView(b)) : res.status(404).json({ error: 'not found' });
  });
  app.get('/api/bulk/:id/qr.svg', async (req, res) => {
    const b = getBatch(req.params.id);
    await sendQr(res, b && paymentFor(b)?.uri);
  });
  app.post('/api/bulk/:id/tx', async (req, res) => {
    const b = getBatch(req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    try { res.json(batchView(await recordDepositTx(b, String(req.body?.txHash ?? '')))); } catch (e) { fail(res, e); }
  });

  // --- DEMO ONLY: pretend the swap settled, so the flow can be shown without moving real funds. -----
  app.post('/api/dev/orders/:id/simulate-paid', (req, res) => {
    if (!config.demoMode) return res.status(404).json({ error: 'not found' });
    const o = getOrder(req.params.id);
    if (!o || o.batchId) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: markPaid(o, 'DEMO: payment simulated') });
  });
  app.post('/api/dev/bulk/:id/simulate-paid', (req, res) => {
    if (!config.demoMode) return res.status(404).json({ error: 'not found' });
    const b = getBatch(req.params.id);
    if (!b) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: markBatchPaid(b, 'DEMO: payment simulated') });
  });

  return app;
}

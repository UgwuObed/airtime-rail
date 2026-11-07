import express from 'express';
import QRCode from 'qrcode';
import { config } from './config.js';
import { createOrder, getOrder, markPaid, Order, recordDepositTx, tick } from './orders.js';
import { publicChain } from './chains.js';
import { paymentFor } from './payment.js';

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
// Chains in the order SUPPORTED_ORIGINS lists them; unknown ids are dropped.
app.get('/api/config', (_req, res) =>
  res.json({ demoMode: config.demoMode, origins: config.origins.map(publicChain).filter(Boolean) }));

/** Order plus the ready-made wallet payment request (calldata, EIP-681 URI). */
const view = (o: Order) => ({ ...o, payment: paymentFor(o) });

app.post('/api/orders', async (req, res) => {
  try {
    const o = await createOrder({
      network: String(req.body?.network ?? ''), phone: String(req.body?.phone ?? ''),
      amountNgn: Number(req.body?.amountNgn), originChain: String(req.body?.originChain ?? ''),
      refundTo: String(req.body?.refundTo ?? ''),
    });
    res.status(201).json(view(o));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const o = getOrder(req.params.id);
  return o ? res.json(view(o)) : res.status(404).json({ error: 'not found' });
});

// EIP-681 QR for wallets that aren't injected into this page (e.g. a phone wallet).
app.get('/api/orders/:id/qr.svg', async (req, res) => {
  const o = getOrder(req.params.id);
  const p = o && paymentFor(o);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.type('image/svg+xml').set('Cache-Control', 'private, max-age=3600')
    .send(await QRCode.toString(p.uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
});

// The browser wallet broadcast the deposit; record it and hint 1Click. Never fails because of 1Click.
app.post('/api/orders/:id/tx', async (req, res) => {
  const o = getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  try {
    res.json(view(await recordDepositTx(o, String(req.body?.txHash ?? ''))));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// DEMO ONLY: pretend the swap settled, so the flow can be shown without moving real funds.
app.post('/api/dev/orders/:id/simulate-paid', (req, res) => {
  if (!config.demoMode) return res.status(404).json({ error: 'not found' });
  const o = getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  return res.json({ ok: markPaid(o, 'DEMO: payment simulated') });
});

setInterval(() => void tick(), config.pollMs);
app.listen(config.port, () => console.log(`airtime-rail on :${config.port} (demo mode: ${config.demoMode})`));

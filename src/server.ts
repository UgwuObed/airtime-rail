import express from 'express';
import { config } from './config.js';
import { createOrder, getOrder, markPaid, tick } from './orders.js';

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
app.get('/api/config', (_req, res) => res.json({ demoMode: config.demoMode, origins: config.origins }));

app.post('/api/orders', async (req, res) => {
  try {
    const o = await createOrder({
      network: String(req.body?.network ?? ''), phone: String(req.body?.phone ?? ''),
      amountNgn: Number(req.body?.amountNgn), originChain: String(req.body?.originChain ?? ''),
      refundTo: String(req.body?.refundTo ?? ''),
    });
    res.status(201).json(o);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const o = getOrder(req.params.id);
  return o ? res.json(o) : res.status(404).json({ error: 'not found' });
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

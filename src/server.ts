// Entry point. Importing config first means an unsafe combination (see unsafeConfig) stops the process here.
import { createApp } from './app.js';
import { config } from './config.js';
import { tick } from './orders.js';

setInterval(() => void tick(), config.pollMs);
createApp().listen(config.port, () => console.log(`airtime-rail on :${config.port} (demo mode: ${config.demoMode})`));

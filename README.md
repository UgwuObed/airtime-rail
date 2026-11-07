# airtime-rail

**Buy Nigerian mobile airtime with USDC from any of eight chains, settled through NEAR Intents.**
A customer (or a business paying for up to 50 numbers at once) pays USDC on Arbitrum, Base, Ethereum, OP Mainnet, Polygon, BNB Smart Chain, Solana or NEAR. NEAR Intents swaps it into USDC in the merchant's NEAR Intents account. Once that settles, the backend buys the airtime from a Nigerian provider (TopupBox) and reports each number's status.

Built for the NEAR Hackathon, Real-World Money track (development window 2026-11-01 to 2026-11-14). License: [MIT](LICENSE).

## The problem
Stablecoins are widely held in Nigeria, but spending them on everyday things still means selling to an exchange or a P2P trader, waiting for naira, then topping up. A merchant who wants to accept stablecoins has to support every chain its customers use and reconcile each payment. airtime-rail turns "USDC on whatever chain you have" into airtime on a phone in one payment, and gives the merchant a single settled balance.

## How NEAR Intents is used
- **One deposit address per order.** The backend asks the NEAR Intents 1Click API (`POST /v0/quote`, `dry: false`) for a quote from USDC on the customer's chain to USDC on NEAR, with `recipientType: INTENTS` and the merchant's NEAR account as recipient. 1Click returns a one-time deposit address on the customer's chain.
- **Settlement into the merchant's NEAR Intents balance.** Whatever chain the customer paid from, the merchant receives USDC in one place.
- **Refunds of failed swaps are automatic.** Each quote carries the customer's own `refundTo` address on their chain; if the swap fails, NEAR Intents returns the funds there.
- **Status drives fulfilment.** A poller reads `GET /v0/status`; airtime is bought only after `SUCCESS`. When a browser wallet pays, the tx hash is sent to `POST /v0/deposit/submit` to speed up detection (optional; a failure there never fails the order).
- Code: [src/intents.ts](src/intents.ts) (client), [src/orders.ts](src/orders.ts) (order and batch state machine), [scripts/quote.ts](scripts/quote.ts) (dry-quote probe across all chains).

## What has been verified, and how
| What | Status | Evidence |
|---|---|---|
| Customer payment with real USDC, any chain | **Not yet verified.** No chain has been paid end to end with real money. | Every chain below is "quoted only". |
| Arbitrum One, Base, Solana, NEAR | Quoted only (live quote + real deposit address issued by 1Click) | Browser runs against the live 1Click API, 2026-11-05 to 2026-11-07 |
| Ethereum, OP Mainnet, Polygon, BNB Smart Chain | Quoted only (dry quote) | `npm run quote`: $1, $10 and $100 all OK, 2026-11-07 |
| Real airtime delivery via TopupBox | **Verified with real money:** ₦100 MTN delivered, 2026-11-05 | Direct provider call (`npm run topupbox:buy`); the adapter is tested against those exact responses in [test/topupbox.test.ts](test/topupbox.test.ts). This was not paid through a crypto order. |

## Trust model
- **The backend holds no private keys** and no wallet seed. It cannot move customer funds or the merchant's NEAR Intents balance. Customers sign their own payment in their own wallet; NEAR Intents holds funds in flight.
- The only credential it can hold is the airtime provider's API token (`TOPUPBOX_TOKEN`), and only when real airtime is enabled. Demo mode needs no secrets.
- **Refunds for failed airtime are recorded for merchant approval, not sent automatically.** If the swap succeeded but a purchase definitely failed, the order (or bulk line) becomes `refund_due` with the exact USDC amount and the customer's refund address. The merchant reviews and pays it from their NEAR Intents balance.
- **A purchase is never sent twice.** Each order or bulk line has a fixed provider reference. If the provider's answer is unclear (timeout, server error, "accepted for processing"), the order waits in `fulfilment_pending` and the poller re-queries by reference until the answer is clear.
- `DEMO_MODE=true` can mark orders paid without payment, so the server **refuses to start** with demo mode and a real provider.

## Try it: demo mode, mock airtime provider, no secrets
Needs Node.js 20 or newer and internet access (quotes come from the live 1Click API; nothing is paid). In demo mode the airtime provider is a mock: numbers ending in `0000` fail, all others succeed. **Do not send real USDC to a demo deposit address**: the placeholder `RECIPIENT_NEAR_ACCOUNT` is not yours.

Each step: **do** the command, **see** the expected result, **where** the code or test is.

**1. Install and test.**
```sh
git clone https://github.com/UgwuObed/airtime-rail.git && cd airtime-rail
npm ci
npm test
```
See `ℹ pass 55` and `ℹ fail 0`. Where: [test/](test/). On npm 11, `npm ci` may warn that esbuild's install script is not approved; that is harmless (tests and `npm start` still work).

**2. Configure and start** (keep this terminal open).
```sh
cp .env.example .env
npm start
```
See `airtime-rail on :3000 (demo mode: true)`. The example config is demo-ready: `DEMO_MODE=true`, `VTU_PROVIDER=mock`, all eight chains. Port 3000 busy? Run `PORT=3001 npm start` and use that port below.

**3. In a second terminal, set two helpers.**
```sh
export BASE=http://localhost:3000
json() { node -pe "const o=JSON.parse(require('fs').readFileSync(0,'utf8')); $1"; }
curl -s $BASE/api/config | json 'o.demoMode + " " + o.origins.map(c => c.id).join(",")'
```
See `true arb,base,eth,op,pol,bsc,sol,near`.

**4. Create an order paid from Base.**
```sh
ID=$(curl -s -X POST $BASE/api/orders -H 'content-type: application/json' \
  -d '{"network":"mtn","phone":"08031234567","amountNgn":1000,"originChain":"base","refundTo":"0x1111111111111111111111111111111111111111"}' | json o.id)
curl -s $BASE/api/orders/$ID | json '[o.status, o.usdcAmount, o.payment.chainIdHex, o.payment.tx.to, o.payment.tx.data.slice(0, 10)].join(" ")'
```
See `awaiting_payment 0.86 0x2105 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0xa9059cbb`: chain id 8453, Base USDC, ERC-20 `transfer` calldata built on the server. Where: [src/payment.ts](src/payment.ts), [src/chains.ts](src/chains.ts).

**5. Simulate the payment settling, then watch the airtime go out.**
```sh
curl -s -X POST $BASE/api/dev/orders/$ID/simulate-paid; echo
sleep 2
curl -s $BASE/api/orders/$ID | json '[o.status, o.providerRef].join(" ")'
```
See `{"ok":true}`, then `delivered MOCK-…`. Where: `markPaid` and `fulfil` in [src/orders.ts](src/orders.ts).

**6. The failure path: the provider rejects the number.**
```sh
FID=$(curl -s -X POST $BASE/api/orders -H 'content-type: application/json' \
  -d '{"network":"glo","phone":"08050000000","amountNgn":500,"originChain":"arb","refundTo":"0x1111111111111111111111111111111111111111"}' | json o.id)
curl -s -X POST $BASE/api/dev/orders/$FID/simulate-paid; echo
sleep 2
curl -s $BASE/api/orders/$FID | json 'o.status + ": " + o.events.at(-1).msg'
```
See `refund_due: Fulfilment failed (MOCK: provider rejected this number). Refund of 0.43 USDC owed to 0x1111…`. Recorded for merchant approval, not sent.

**7. Bulk: three numbers, one payment, one of them fails.**
```sh
BID=$(curl -s -X POST $BASE/api/bulk -H 'content-type: application/json' -d '{"originChain":"sol","refundTo":"7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV","items":[
  {"network":"mtn","phone":"08031234567","amountNgn":1000},
  {"network":"airtel","phone":"08021230000","amountNgn":250},
  {"network":"9mobile","phone":"08091234567","amountNgn":2000}]}' | json o.id)
curl -s $BASE/api/bulk/$BID | json '[o.status, o.usdcAmount, o.payment.kind, o.lines.length].join(" ")'
curl -s -X POST $BASE/api/dev/bulk/$BID/simulate-paid; echo
sleep 4
curl -s $BASE/api/bulk/$BID | json 'o.lines.map(l => l.line + ":" + l.status).join(" ") + " | refund due " + o.summary.refundDueUsdc + " USDC"'
```
See `awaiting_payment 2.79 sol 3` (one Solana deposit address for 0.86 + 0.22 + 1.71 USDC), then `1:delivered 2:refund_due 3:delivered | refund due 0.22 USDC`. Where: `createBatch` and `fanOut` in [src/orders.ts](src/orders.ts), [test/bulk.test.ts](test/bulk.test.ts).

**8. Input is checked against the paying chain.**
```sh
curl -s -X POST $BASE/api/orders -H 'content-type: application/json' \
  -d '{"network":"mtn","phone":"08031234567","amountNgn":1000,"originChain":"sol","refundTo":"0x1111111111111111111111111111111111111111"}'; echo
```
See `{"error":"refundTo must be your own Solana address"}`. Where: [src/chains.ts](src/chains.ts), [test/chains.test.ts](test/chains.test.ts).

**9. Demo mode refuses to run with a real airtime provider.**
```sh
DEMO_MODE=true VTU_PROVIDER=topupbox npm start
```
See `Error: Refusing to start: DEMO_MODE=true with VTU_PROVIDER=topupbox …` and exit code 1. Where: `unsafeConfig` in [src/config.ts](src/config.ts), [test/safety.test.ts](test/safety.test.ts).

**10. The web UI.** Open `$BASE` (http://localhost:3000) in a browser. Pick a chain and fill in one number, or choose **Pay for many numbers** and paste CSV (`network,phone,amount`). With a browser wallet on an EVM chain you get **Pay with wallet**; otherwise a QR code and copy buttons. In demo mode, **Simulate payment (demo)** settles the order, and the heading changes from "Pay … USDC on …" to "Buying airtime", then "Airtime delivered" (bulk: "2 of 3 delivered" when a line fails).

**11. Optional: dry quotes on every chain.**
```sh
npm run quote
```
See a table of 24 rows (8 chains × $1, $10, $100), each `OK`. No deposit addresses are created. The NEAR rows need `REFUND_NEAR_ACCOUNT` to be an existing NEAR account (the example uses `intents.near`); with an account that doesn't exist, 1Click answers `Internal server error`.

## How it works
1. The customer picks the chain they hold USDC on. On an EVM chain they connect a browser wallet (EIP-1193, e.g. MetaMask or Rabby) and its address becomes the refund address. On Solana or NEAR, or without a wallet, they type a refund address, checked against that chain's format. On NEAR the refund account must already exist; 1Click refuses to quote otherwise.
2. `POST /api/orders` validates the order, checks the airtime wallet can cover it, and gets a 1Click quote and deposit address. The order carries `amountBase` (the exact amount in that chain's USDC base units: 6 decimals, 18 on BNB Smart Chain) and a ready-made `payment` request, so the browser does no amount math. USDC contracts and decimals are re-checked against 1Click's token list on every order.
3. **EVM chains:** one click. The page switches the wallet to the right chain (adding it if needed) and sends one ERC-20 `transfer`. **Solana, NEAR, or no wallet:** a QR code (EIP-681, Solana Pay, or the NEAR deposit account) and copy buttons.
4. The poller sees the swap settle and buys the airtime. Outcomes: `delivered`, `refund_due` (definite failure), `fulfilment_pending` (unclear; re-queried, never re-bought), or swap-level `swap_refunded`, `swap_failed`, `expired`.
5. **Bulk** (`POST /api/bulk`, up to 50 lines): one quote and one deposit address for the total. Each line's USDC share is rounded up separately and the total is their sum, so a failed line's refund is exactly what was paid for it. After the swap, lines are bought one at a time through the same code as single orders; a restart resumes with the lines not yet sent.

API: `GET /api/config`, `POST /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/qr.svg`, `POST /api/orders/:id/tx`, and the same under `/api/bulk`. Demo only: `POST /api/dev/orders/:id/simulate-paid`, `POST /api/dev/bulk/:id/simulate-paid`.

## Safety limits
- Creating orders and batches is limited to `ORDER_RATE_LIMIT` (default 10) per client IP per minute (HTTP 429 with `Retry-After`).
- At most `MAX_OPEN_ORDERS` (default 100) orders and batches can wait for payment at once (HTTP 503 after that).
- The limits are in memory, for a single server process.

## Hosting the demo behind nginx (mock provider only)
For a public demo, run in demo mode with the mock provider and **do not put a `TOPUPBOX_TOKEN` on the server**.

`.env` on the server: copy `.env.example`, then set `DEMO_MODE=true`, `VTU_PROVIDER=mock`, `TRUST_PROXY=1`. Keep the `data/` directory between restarts (orders are stored there). Block port 3000 from outside (the app listens on all interfaces), so traffic only arrives through nginx.

```nginx
server {
    listen 443 ssl;
    server_name demo.example.com;
    # ssl_certificate / ssl_certificate_key: e.g. from certbot

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
- `TRUST_PROXY=1` tells Express there is exactly one proxy in front, so the rate limit uses the client address that nginx appends to `X-Forwarded-For`. Without it every visitor shares nginx's IP and one limit. With another proxy in front of nginx (e.g. a CDN), use `2`. Never set it higher than the real number of proxies, or clients can spoof their IP.
- Use HTTPS: the copy buttons need a secure context, and wallets warn on plain HTTP.
- Keep it running with your process manager, e.g. a systemd unit with `WorkingDirectory` set to the repo and `ExecStart=/usr/bin/npm start`.

## Real airtime with TopupBox (not needed for the demo)
Set `DEMO_MODE=false`, `VTU_PROVIDER=topupbox` and `TOPUPBOX_TOKEN` (from the TopupBox dashboard).
```sh
npm run topupbox:check                                  # read-only: token expiry, auth format, balance
npm run topupbox:buy -- mtn 08031234567 100 --confirm   # one real ₦100 purchase; prints raw responses
```
Auth is the bare token in `Authorization` (TopupBox rejects `Bearer <token>`). The adapter ([src/topupbox.ts](src/topupbox.ts)) uses `POST /api/v2/w1/recharge/{MTN|AIRTEL|GLO|9MOBILE}/AIRTIME` and re-queries with `GET /api/v2/w1/query/{customer_reference}`. Orders are refused before payment if the TopupBox wallet can't cover them.

## Libraries and services
Runtime dependencies (see [package.json](package.json)):
- [express](https://expressjs.com/) 4: HTTP server.
- [qrcode](https://github.com/soldair/node-qrcode) 1.5: QR codes, rendered as SVG on the server.

Development: [TypeScript](https://www.typescriptlang.org/) 5, [tsx](https://github.com/privatenumber/tsx) 4 (runs TypeScript directly), `@types/express`, `@types/node`, `@types/qrcode`. Tests use Node's built-in `node:test`.

The web UI is one HTML file with no frontend libraries; it talks to the wallet through the standard EIP-1193 `window.ethereum` interface.

External services: the [NEAR Intents 1Click API](https://docs.near-intents.org/) (quotes, deposit addresses, status, deposit submit) and the [TopupBox API](https://developer.topupbox.com/) (airtime; only when `VTU_PROVIDER=topupbox`).

Used during development only, not part of the repository: `puppeteer-core` (driving headless Chrome for UI checks and screenshots) and `js-sha3` (computing the EIP-55 checksums of the USDC contract addresses in [src/chains.ts](src/chains.ts)).

## AI-generated code
Most of the code in this repository was generated by AI coding agents, chiefly Claude Code (Anthropic), working from the team's instructions. That includes the wallet payment flow, multi-chain support, the TopupBox adapter, bulk top-up, the safety limits, the web UI, the tests and this README. The team set the requirements, ran the live checks (including the real ₦100 TopupBox purchase) and made the product decisions.

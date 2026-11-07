# airtime-rail
Pay for Nigerian airtime with USDC from Arbitrum, Base, Ethereum, OP Mainnet, Polygon, BNB Smart Chain, Solana or NEAR. Payments settle into the merchant's account inside NEAR Intents; once the swap is confirmed, the backend buys the airtime.

Status: work in progress for the NEAR Hackathon (Real-World Money track).

## How it works
1. The customer picks the chain they hold USDC on (`GET /api/config` lists `SUPPORTED_ORIGINS`; default: all eight). On an EVM chain they connect their wallet (any injected EIP-1193 wallet, e.g. MetaMask or Rabby) and its address becomes `refundTo`. On Solana or NEAR, or without a wallet, they type a refund address, checked against that chain's format.
2. `POST /api/orders` quotes the NGN amount in USDC and asks the NEAR Intents 1Click API for a one-time deposit address. The order carries `amountBase` (the exact USDC amount in that chain's base units, as a string: 6 decimals, 18 on BNB Smart Chain) and a ready-made `payment` request, so the browser does no amount math. Chain ids, USDC contracts and decimals live in [src/chains.ts](src/chains.ts); each order re-checks them against 1Click's token list and refuses to quote on a mismatch.
3. **Pay with wallet (EVM chains):** the page switches the wallet to the chosen chain (adding it if needed) and sends one ERC-20 `transfer(depositAddress, amountBase)` to that chain's USDC. The customer confirms once. On the tx hash it shows "Payment sent" with a link to the chain's explorer.
   **Solana, NEAR, or no wallet in this browser:** the receipt shows the address, the amount and a QR code (`/api/orders/:id/qr.svg`): EIP-681 for EVM chains, Solana Pay for Solana, the deposit account for NEAR.
4. The server records the tx hash (`POST /api/orders/:id/tx`) and passes it to 1Click's `POST /v0/deposit/submit`, which lets 1Click pick up the deposit sooner. This step is optional: if it fails, the order carries on.
5. A poller watches the swap status. On `SUCCESS` the order is paid and the airtime purchase starts (TopupBox, or the mock).
6. If the swap fails, NEAR Intents refunds the customer's wallet. If the swap succeeds but airtime fails, the order becomes `refund_due`.
7. If the airtime provider's answer is unclear (timeout, server error, "accepted for processing"), the order becomes `fulfilment_pending`. The poller re-queries the provider by the order's reference until it gets a clear answer. **A purchase is never sent twice.**

TopupBox is live-tested: a real ₦100 MTN purchase on 2026-11-05 succeeded and the adapter is tested against those exact responses. Orders are refused before payment if the TopupBox wallet can't cover them. Not done yet: refunds for failed fulfilment are recorded, not sent; only Arbitrum is verified as an origin chain.

## Run it
    npm install
    cp .env.example .env      # set RECIPIENT_NEAR_ACCOUNT and NGN_PER_USD
    npm start

## Try the flow without real funds (DEMO_MODE=true)
    curl -s -X POST localhost:3000/api/orders -H 'content-type: application/json' \
      -d '{"network":"mtn","phone":"08031234567","amountNgn":1000,"originChain":"arb","refundTo":"0xYourEvmAddress"}'
    # the response includes amountBase and payment.tx (to, data) for the wallet
    # copy the "id" from the response, then:
    curl -s -X POST localhost:3000/api/dev/orders/<id>/simulate-paid
    curl -s localhost:3000/api/orders/<id>        # status: delivered
Use a phone number ending in `0000` (e.g. 08030000000) to see the fulfilment-failure path (`refund_due`).

## Real airtime with TopupBox
    # .env: VTU_PROVIDER=topupbox and TOPUPBOX_TOKEN=<token from the TopupBox dashboard>
    npm run topupbox:check        # read-only: token expiry, which auth header works, sample responses
    npm run topupbox:buy -- mtn 08031234567 100 --confirm   # ONE real ₦100 purchase; prints raw responses

Auth is the bare token in `Authorization` (TopupBox rejects `Bearer <token>`). The merchant wallet is charged face value. The adapter ([src/topupbox.ts](src/topupbox.ts)) uses `POST /api/v2/w1/recharge/{MTN|AIRTEL|GLO|9MOBILE}/AIRTIME` and re-queries with `GET /api/v2/w1/query/{customer_reference}`. Each order has a fixed `customer_reference` derived from its id.

## Quote smoke test
    npm run quote

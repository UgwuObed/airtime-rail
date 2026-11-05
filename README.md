# airtime-rail
Pay for Nigerian airtime with stablecoins from another chain. Payments settle into the merchant's account inside NEAR Intents; once the swap is confirmed, the backend buys the airtime.

Status: work in progress for the NEAR Hackathon (Real-World Money track).

## How it works
1. `POST /api/orders` quotes the NGN amount in USDC and asks the NEAR Intents 1Click API for a one-time deposit address.
2. The customer sends USDC (Arbitrum) to that address.
3. A poller watches the swap status. On `SUCCESS` the order is paid and the airtime purchase starts.
4. If the swap fails, NEAR Intents refunds the customer. If the swap succeeds but airtime fails, the order becomes `refund_due`.

Not done yet: the VTU provider is a **mock**; refunds for failed fulfilment are recorded, not sent; only Arbitrum is verified as an origin chain.

## Run it
    npm install
    cp .env.example .env      # set RECIPIENT_NEAR_ACCOUNT and NGN_PER_USD
    npm start

## Try the flow without real funds (DEMO_MODE=true)
    curl -s -X POST localhost:3000/api/orders -H 'content-type: application/json' \
      -d '{"network":"mtn","phone":"08031234567","amountNgn":1000,"originChain":"arb","refundTo":"0xYourEvmAddress"}'
    # copy the "id" from the response, then:
    curl -s -X POST localhost:3000/api/dev/orders/<id>/simulate-paid
    curl -s localhost:3000/api/orders/<id>        # status: delivered
Use a phone number ending in `0000` (e.g. 08030000000) to see the fulfilment-failure path (`refund_due`).

## Quote smoke test
    npm run quote

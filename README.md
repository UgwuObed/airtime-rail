# airtime-rail
Pay for Nigerian airtime, data and bills with stablecoins from any chain, settled through NEAR Intents.

Status: early work in progress for the NEAR Hackathon (Real-World Money track).

## Run the quote smoke test
    npm install
    cp .env.example .env     # then set RECIPIENT_NEAR_ACCOUNT
    npm run quote

Expected: a token count, the chains USDC exists on, and a dry quote for 1 USDC (Arbitrum -> NEAR). No funds move.

# Nadcab AMM v2 DEX

A constant-product (Uniswap V2 style) exchange for any EVM chain, packaged so the Nadcab Console can host it.

- `contracts/`: Solidity 0.8.24 factory, pair, router and wrapped native coin. The swap fee (0.01%–10%), the protocol's share of it, the fee receiver and the LP token name are set at deploy time and can be changed by the fee admin.
- `server/`: Fastify API that indexes pools, swaps and liquidity events into SQLite, prices tokens through the wrapped native coin, proxies read-only RPC for the site and serves the web app.
- `web/`: Next.js static site with swap (multi-hop routing), pool positions, add/remove liquidity, explore (TVL, volume, tokens, pools, transactions) and per-pool charts.
- `artifacts/nadcab-v2.json`: ABIs and bytecode the Console uses to deploy the contracts from the owner's wallet.

## Develop

```bash
cd contracts && forge install foundry-rs/forge-std --no-git && forge test
node scripts/export-artifacts.mjs

anvil --port 8545 &
cd server && npm install && node test/seed.mjs   # deploys and trades, prints addresses
FACTORY_ADDRESS=… ROUTER_ADDRESS=… WNATIVE_ADDRESS=… CHAIN_ID=31337 npm run dev
cd web && npm install && npm run dev
```

## Server environment

| Variable | Meaning |
| --- | --- |
| `RPC_URL` | Chain RPC the indexer reads from |
| `PUBLIC_RPC_URL` | RPC URL wallets are asked to add (defaults to `RPC_URL`) |
| `CHAIN_ID`, `CHAIN_NAME`, `NATIVE_SYMBOL`, `NATIVE_NAME`, `EXPLORER_URL` | Chain details shown to users |
| `FACTORY_ADDRESS`, `ROUTER_ADDRESS`, `WNATIVE_ADDRESS`, `START_BLOCK` | Deployed contracts and the block to index from |
| `ADMIN_SECRET` | Bearer token for `/api/admin/*` (branding, token list, logo) |
| `PORT`, `DATA_DIR`, `WEB_DIR`, `CONFIRMATIONS`, `POLL_MS`, `LOG_CHUNK` | Runtime tuning |

## Release

Every push to `main` runs the contract tests, builds `dist/dex.tar.gz`, runs `test/e2e.sh` against anvil and uploads the bundle and `nadcab-v2.json` to the `latest` release. Hosts run it with `node:22-alpine sh /app/run.sh`.

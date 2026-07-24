# Autoservice Aggregator

Node.js 24 service that searches configured automotive-parts suppliers and streams normalized results to the browser over SSE.

## Local Run

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm start
```

The application listens on `127.0.0.1:3000` by default. `PORT` can override the port.

## Batch Article Audit

With the server running, audit articles through the same SSE API used by the frontend:

```sh
pnpm audit:articles -- 90915YZZJ1 5050LR VAP-021-2375
pnpm audit:articles -- --file articles.txt
Get-Content articles.txt | pnpm audit:articles
pnpm audit:articles -- --sample
```

Use one article per line in an input file; blank lines and `#` comments are ignored. Run
`pnpm audit:articles -- --help` for server URL, supplier, concurrency, timeout, and output
options. Each run creates `article-audit-reports/<timestamp>/report.md` and `report.json`
relative to the directory where the command is started. A failed article makes the command
exit with code `2`; command/configuration failures use code `1`.

## Rossko SOAP Diagnostic

`rossko:search` is a standalone diagnostic utility for the official Rossko SOAP API.
It does not use the browser session integration, normalize results, or persist credentials.
It prints the complete SOAP XML response, including all product, stock, and cross fields
returned by Rossko.

Set keys only in the current shell or a secret manager. Do not place them in `.env.example`
or the repository:

```powershell
$env:ROSSKO_KEY1 = "..."
$env:ROSSKO_KEY2 = "..."
pnpm rossko:search -- --checkout
```

`--checkout` calls `GetCheckoutDetails`. From its response, use an account-available
`delivery_id` and, unless the delivery method is pickup, an `address_id` for the search:

```powershell
pnpm rossko:search -- 90915YZZJ1 --delivery-id "..." --address-id "..."
```

Alternatively, set `ROSSKO_DELIVERY_ID` and `ROSSKO_ADDRESS_ID`; then `pnpm rossko:search`
prompts only for the article. The SOAP API has a 300 requests/minute and 100,000 requests/day
limit, and returns at most 80 product cards and 80 crosses per product.

## Production

- Use Node.js 24 and install dependencies from `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`.
- Run `pnpm exec playwright install chromium` when no system Chrome or Edge path is configured.
- Set `STATE_DIR` to a directory outside the application checkout. Restrict it to the dedicated service account because it contains supplier cookies and tokens.
- Log in to Rossko from the supplier settings using the business-account login and password.
- Terminate TLS and require authentication at the reverse proxy before exposing `/api/*`.
- Keep the service bound to loopback and proxy only from a trusted local endpoint.
- Pass supplier credentials and API keys through environment variables or the runtime authorization UI. Do not store them in files in the checkout.
- Armtek stores API-discovered `VKORG` and `KUNNR_RG` in `STATE_DIR/armtek-api-account-state.json`, bound to a hash of the active login and protected with mode `0600`. Explicit `ARMTEK_VKORG` and `ARMTEK_KUNNR_RG` take precedence.
- Armtek uses only its WebService API for authorization and search. API failures are reported as Armtek errors; the service does not query ETP or use a browser-session fallback.
- STParts uses ABCP `user/info` for session checks and combines up to 100 brand/article pairs in each `search/batch` request. Batch search excludes online stocks by ABCP design; successful searches are cached in memory for one minute to reduce repeated API usage.

Copy the variable names from `.env.example` into the server's secret manager or service environment. The application does not load `.env` files itself.

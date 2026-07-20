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

## Production

- Use Node.js 24 and install dependencies from `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`.
- Run `pnpm exec playwright install chromium` when no system Chrome or Edge path is configured.
- Set `STATE_DIR` to a directory outside the application checkout. Restrict it to the dedicated service account because it contains supplier cookies and tokens.
- Keep `ROSSKO_USE_STUB=0`. Stub mode returns fabricated development data.
- Terminate TLS and require authentication at the reverse proxy before exposing `/api/*`.
- Keep the service bound to loopback and proxy only from a trusted local endpoint.
- Pass supplier credentials and API keys through environment variables or the runtime authorization UI. Do not store them in files in the checkout.

Copy the variable names from `.env.example` into the server's secret manager or service environment. The application does not load `.env` files itself.

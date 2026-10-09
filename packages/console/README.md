# Blossom Console

React + Vite + TypeScript SPA for the paid Blossom service, served by
`proxy/blossom` at the blossom hostname (the Docker image builds this app and
copies `dist` into the proxy image; see `proxy/blossom/Dockerfile`).

Routes:

- `/` — welcome/landing, pricing CTA, FAQ
- `/pricing` — plans from `formstr-backend` `/api/tiers/storage`; purchase
  flow: connect signer → accept T&C (required) → generate invoice → QR +
  WebSocket payment status. Actions are derived from the caller's current
  entitlement (renew / upgrade while live, downgrade only after expiry).
- `/dashboard` — plan, expiry countdown, status banners, blobs (list/delete),
  invoices from `formstr-backend`, notification history
- `/legal/terms`, `/legal/privacy` — Markdown rendered from
  `src/legal/{terms,privacy}.md`; the `version` frontmatter field is the
  version stamped at purchase, and acceptance is skipped when the user's
  stored `termsVersion` already matches

The admin console UI (`/admin`) is not shipped yet — the `admin*` helpers in
`src/api.ts` and the proxy's NIP-98-gated `/admin/*` endpoints remain, so the
page can be re-added without backend changes.

Auth: NIP-07 (`window.nostr`) with BUD-11 for Blossom routes and NIP-98 for
backend routes. When no extension is present (development), a local key
is generated and stored in `localStorage` so the flow is usable.

## Development

From the repo root (the console is a pnpm workspace member):

```bash
pnpm install
pnpm --filter @orchestrator/console run dev
```

Or run it directly from this directory once dependencies are installed:

```bash
npm run dev
```

Set the backend/proxy bases when they are not on the Vite dev server:

```bash
VITE_BACKEND_URL=http://localhost:5000 npm run dev
```

## Production build

```bash
VITE_BACKEND_URL=https://<formstr-backend-host> npm run build
```

`VITE_BACKEND_URL` defaults to `http://localhost:5000` for local dev. The
proxy serves `packages/console/dist` for all extension-less paths; an explicit hash
route (`/<sha256>`) is registered first so blob reads are never shadowed.

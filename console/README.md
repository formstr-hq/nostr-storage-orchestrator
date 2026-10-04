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
- `/admin` — unified-admin gated (formstr-backend `users.role = admin`),
  users, blob search, plan grant, force status, moderation delete + audit log
- `/legal/terms`, `/legal/privacy` — Markdown rendered from
  `src/legal/{terms,privacy}.md`; the `version` frontmatter field is the
  version stamped at purchase, and acceptance is skipped when the user's
  stored `termsVersion` already matches

Auth: NIP-07 (`window.nostr`) with BUD-11 for Blossom routes and NIP-98 for
admin/backend routes. When no extension is present (development), a local key
is generated and stored in `localStorage` so the flow is usable.

## Development

```bash
npm install
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
proxy serves `console/dist` for all extension-less paths; an explicit hash
route (`/<sha256>`) is registered first so blob reads are never shadowed.

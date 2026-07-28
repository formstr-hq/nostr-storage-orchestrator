# Blossom Proxy — BUD Compliance

Reviewed and brought into conformance with BUD-00/01/02/06/11/12 from
[hzrd149/blossom](https://github.com/hzrd149/blossom).
Files: `src/index.ts`, `src/servers.ts`, `src/nostr.ts`.

## Endpoints (BUD-01/02/06/12)

| Endpoint | Behavior |
|---|---|
| `PUT /upload` | Accepts raw bytes, hashes them server-side, returns a [Blob Descriptor](https://github.com/hzrd149/blossom/blob/master/buds/02.md#blob-descriptor) (`url`, `sha256`, `size`, `type`, `uploaded`). `201` when newly stored, `200` on dedup. Validates a client-supplied `X-SHA-256` header against the computed hash and responds `409` on mismatch. |
| `HEAD /upload` | Pre-flight check per BUD-06: reads `X-SHA-256`/`X-Content-Length`/`X-Content-Type`, validates the auth token and plan limits, responds with a status code only (no body). |
| `GET /<sha256>` / `GET /<sha256>.ext` | Returns blob bytes. Optional extension is accepted and ignored for lookup (`HASH_PATTERN` strips it). |
| `HEAD /<sha256>` | Same checks as GET, no body. |
| `DELETE /<sha256>` | Removes the blob from the DB record **and** from its backing replicas (`servers.ts:deleteBlob`) — the previous implementation only removed the DB row and silently leaked the blob on replica storage. |
| `GET /storage` | Non-standard, kept as an app-specific account/usage endpoint (not part of the BUDs), gated by the same BUD-11 token check as every other route. |
| `GET /list/<pubkey>` | Not implemented. BUD-12 marks this endpoint optional and explicitly "unrecommended"; there is no per-npub blob listing in the DB API to back it, so it's left out rather than added speculatively. |

All Blossom routes are now served from the domain root, so a client speaking
stock BUD-01/02/12 can talk to this proxy without knowing about it — that
was the main structural gap before (`/download/:hash`, `/delete/:hash`,
`POST /upload` never matched the spec's paths/verbs).

## Blob Descriptor

`type` and the `url` file extension are derived from the client's
`Content-Type` header at upload time via a small local MIME→extension table
(`MIME_EXTENSIONS` in `index.ts`), falling back to `application/octet-stream`
/ `.bin` for unknown types — the fallback BUD-01/02 explicitly sanction. The
proxy does not persist MIME type, so `GET`/`HEAD /<sha256>` always report
`application/octet-stream`; this is the spec's documented behavior for a
server that doesn't track a blob's type, not a shortcut.

## Nostr Authorization (BUD-11)

`src/nostr.ts:verifyAuthToken()` replaces the old "any valid signature is
enough" check with full token validation:

- `kind` MUST be `24242`.
- `created_at` MUST be in the past.
- `expiration` tag MUST be present and in the future.
- `t` tag MUST match the endpoint's action (`get`/`upload`/`delete`).
- `x` tag scoping: REQUIRED (token must carry a matching `x` tag) for
  `upload`/`delete`; OPTIONAL for `get` (only enforced if the token happens
  to carry an `x` tag, per the spec's tag-scoping section).

Every route funnels through this one function, so action/hash binding can't
be bypassed on any endpoint, including the custom `/storage`.

## CORS / errors (BUD-01)

- `cors()` now explicitly sets `methods: [GET, HEAD, PUT, DELETE]` and
  `allowedHeaders: [Authorization, *]` to match the BUD-01 preflight
  requirement literally, plus `maxAge: 86400`.
- Error responses set `X-Reason` (previously only a JSON body), and it's
  added to `exposedHeaders` so browser `fetch()` clients can actually read
  it cross-origin — without that, the header would be set but invisible to
  JS callers.

## In-repo client compatibility

`nostr-docs/src/blossom/client.ts` and
`nostr-forms/packages/formstr-app/src/utils/blossom.ts` were already written
against real BUD-01/02/12 servers (`PUT /upload`, `GET`/`DELETE /<sha256>`,
kind-24242 tokens with `t`/`x`/`expiration`) — this proxy's contract now
matches what they expect, closing the gap noted in the original audit.

## Smoke tests (`packages/smoke-test/src/index.ts`)

Rewritten to exercise the compliant contract end-to-end:
- `PUT`/`HEAD /upload`, `GET`/`HEAD /<sha256>` (with and without an
  extension), `DELETE /<sha256>`.
- Blob Descriptor shape and `201` vs `200` (dedup) status codes.
- BUD-11 negative cases: non-`24242` kind, expired token, mismatched `t`
  tag, missing required `x` tag on upload/delete, and an `x` tag naming the
  wrong hash on a scoped `get`.

## Known remaining gaps (intentionally out of scope)

- **`GET /list/<pubkey>`** (BUD-12, optional/unrecommended) — not
  implemented; would need a new "list blobs by npub" route on the DB API.
- **MIME type persistence** — not stored, so `type` on `GET`/`HEAD` always
  falls back to `application/octet-stream` rather than the blob's real type.
  Fixing this needs a schema change in `packages/db` (Prisma `Blob` model)
  plus threading `type` through `db-client` and `packages/db/src/index.ts`.
- **`PUT /mirror`** (BUD-04) and **`PUT /report`** (BUD-09) — both optional,
  not implemented.
- **`storage-client/blossom/server.js`** (the mock backing store this proxy
  talks to) still uses its own non-standard shape (`POST /upload`,
  `GET`/`DELETE /blob/:hash`). That's an internal replica protocol between
  the proxy and its storage nodes, not the public-facing contract, so it was
  left as-is.

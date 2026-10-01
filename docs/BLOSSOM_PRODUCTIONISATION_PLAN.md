# Plan: Productionise the Blossom Service

## Status

Proposed — 2026-10-01, revised after maintainer review. This revision drops
the previous incremental framing: the existing `PLAN_CONFIG` (per-plan
replicas, global cap, FREE tier) is **not** carried forward. The new service
has no free tier, enforces only **total storage allowance** and **plan time**,
holds no payment records, and derives all payment/billing data from
`formstr-backend`. T&C acceptance is recorded here (orchestrator), not in the
backend. The prior draft's `PlanGrant`, notification preferences, and
backend-side T&C fields are removed rather than iterated on.

## Goal

Turn `proxy/blossom` into a self-serve, paid storage service:

- A public welcome/landing page explaining Blossom, with signer connect and
  pricing; purchase is required before any upload.
- Paid plans (total storage allowance + duration + price) sold through the
  existing Lightning/zap pipeline in `formstr-backend`; on payment the
  entitlement is pushed to the orchestrator. Duration is **additive**: buying
  the same plan again adds days; buying a higher tier upgrades immediately and
  adds its days; a lower tier can only be bought once the current plan is over.
- A user dashboard (own blobs, upload times, storage used, plan,
  expiry, invoices from the backend).
- An admin dashboard (all users/blobs, lifecycle, moderation) with one
  unified admin identity, and a content-moderation panel whose deletions
  notify the owner.
- Privacy policy and terms & conditions; T&C accepted at purchase, and
  purchase is required.
- Expiry notifications over Nostr DM (NIP-17) and email, with a time-based
  lifecycle: grace → uploads blocked → reads blocked → purge and close.
  Retention/timing comes from a config file.

## Decisions

| # | Decision | Choice |
| - | -------- | ------ |
| 1 | Plan contents | **Only** total storage allowance and time. No per-file upload limit, no per-plan replicas, no global cap, no free tier |
| 2 | Plan catalog owner | `formstr-backend` config file (price is payment info; it also owns duration + marketing copy) |
| 3 | Orchestrator state | Only the entitlement: `plan`, `planExpiresAt`, `storageBytes`, `status` |
| 3a | Duration semantics | Days are **additive**; upgrades apply immediately (plan + allowance swap, days added); downgrades apply only after the current plan expires, then over-quota users enter grace |
| 4 | Payment records | Stay entirely in `formstr-backend` (invoices, amounts, hashes); console fetches them from there |
| 5 | Plan assignment | `formstr-backend` → `db-api` over a **shared docker network**, service token |
| 6 | Expiry behaviour | `ACTIVE` → `GRACE` → `WRITE_BLOCKED` → `READ_BLOCKED` → `CLOSED`/purged; timings from a config file |
| 7 | Console | New React + Vite SPA in this repo, served at the blossom hostname |
| 8 | Notifications | NIP-17 DM + email, both best-effort, no per-user channel preferences |
| 9 | Admin identity | Single registry: `formstr-backend.users.role='admin'`; both systems check it |
| 10 | T&C | Recorded in the orchestrator (`db-api`); acceptance is a required field of the purchase request. Only payment info lives in the backend |

## Architecture

```
                 ┌──────────────────────── blossom hostname ────────────────────────┐
                 │  Console SPA (welcome / pricing / pay / dashboard / admin / legal)│
                 └───────┬───────────────────────────┬──────────────────┬──────────┘
        BUD-11 (24242)   │             NIP-98 (27235)│                  │ NIP-98
                         ▼                           ▼                  ▼
                 proxy/blossom  ◄── account + admin ─┘          formstr-backend
                 ├ BUD-01/02/06/12 + /account/*                  ├ plan catalog (config file)
                 ├ /admin/* (NIP-98 + unified admin)             ├ /api/generate-invoice/storage
                 └ /internal/purge/:npub (service token)         ├ /api/invoices (billing)
                         │            ▲                           ├ /api/auth/me (role)
                         ▼            │ db-api                    └ /api/storage/notify (service)
                 storage nodes        │
                          ┌───────────┴──────────┐
                          │ packages/db (db-api) │  Postgres: User(entitlement), Blob,
                          └───────────┬──────────┘  NotificationLog, ModerationAction
                                      ▲
                          packages/notifier (scheduler)
                          ├ NIP-17 DMs (NOTIFY_NSEC)
                          └ email → formstr-backend /api/storage/notify
```

- **formstr-backend owns money and plans**: plan catalog (config file),
  invoices, prices, payment receipts. It exposes billing and role endpoints
  the console uses.
- **Orchestrator owns storage, entitlement, and compliance**: who may upload,
  how much total storage, until when; blob metadata; T&C acceptance records;
  notifications already sent; moderation audit. It stores no amounts,
  invoices, or hashes.

## Plans

Defined in a `formstr-backend` config file (e.g.
`config/storage-plans.json`), validated at boot (ids unique, positive
integer prices in sats, positive durations, positive storage allowances):

```jsonc
{
  "plans": [
    {
      "id": "basic",
      "name": "Basic",
      "rank": 1,                           // tier ordering; drives upgrade/downgrade
      "priceSats": 5000,
      "durationDays": 30,                  // additive on renewal/upgrade
      "storageBytes": 524288000,           // 500 MB total
      "features": ["..."]
    },
    {
      "id": "pro",
      "name": "Pro",
      "rank": 2,
      "priceSats": 15000,
      "durationDays": 30,
      "storageBytes": 2147483648,          // 2 GB total
      "features": ["..."]
    }
  ]
}
```

- `rank` makes the tier order explicit; the backend derives `mode` from the
  buyer's current plan (`rank` higher → `upgrade`, same or lower → `extend`)
  and rejects a lower-tier purchase while an equal-or-higher plan is live.
  The buyer never supplies `mode`; it is never trusted from the request.
- Served by `formstr-backend` (`GET /api/tiers/storage`) and rendered by the
  console; the orchestrator never reads this file.
- Prices/durations are static config, not DB rows. Adding a plan is a config
  change + redeploy of the backend only.
- **Replica count is no longer a plan property.** If replication still needs
  a target, it becomes a global placement setting in the proxy/storage
  config, owned by operators — not sold as a plan feature.
- **Per-file size is an operator limit, not a plan feature.** A global hard
  cap (e.g. proxy body limit / storage-node `maxSize`) still protects the
  service, but the plan sells total storage allowance only.
- **No free tier.** A user with no active entitlement cannot upload; they
  land on pricing on first sign-in.

## Entitlement model (`proxy/blossom` + `db-api`)

The only per-user state the orchestrator stores:

- `plan` — plan id string (nullable; null = never purchased)
- `planExpiresAt` — timestamp (nullable)
- `storageBytes` — total storage allowance in bytes for the current
  entitlement
- `status` — denormalised lifecycle mirror (see below)

`usedStorage` is the running total of blob bytes and **is** the value checked
against `storageBytes`; enforcement is: entitlement active at `now`, and
`usedStorage + Content-Length <= storageBytes`. There is no separate per-file
limit.

Assignment is a single atomic `db-api` transaction
(`POST /users/:npub/entitlement`, service token):

```jsonc
// request
{
  "plan": "pro",
  "durationDays": 30,
  "storageBytes": 2147483648,
  "termsVersion": "2026-10-01",
  "source": "payment",       // or "admin"
  "mode": "extend"           // "extend" (same/lower plan) | "upgrade"
}
// db-api computes, in the transaction:
//   "extend":
//     base = max(now, user.planExpiresAt ?? now)
//     planExpiresAt = base + durationDays
//     plan/allowance: only set if there is no live plan; otherwise unchanged
//   "upgrade":
//     plan = request.plan; storageBytes = request.storageBytes   (immediate)
//     planExpiresAt = max(now, user.planExpiresAt ?? now) + durationDays
//   both: termsVersion = request.termsVersion; termsAcceptedAt = now
//         status = ACTIVE if usedStorage <= storageBytes, else GRACE
```

`mode` is optional on the wire and derived when absent: `request.plan`'s
`rank` vs the live plan's decides `upgrade`/`extend`; a lower-rank purchase is
rejected with `downgrade_not_allowed` while a plan is live (backend) or
`plan_active` (db-api, as a final invariant check).

Purchase rules (all durations additive):

- **Same plan again** → `extend`: days are added to the current expiry. The
  plan and allowance do not change.
- **Higher tier** → `upgrade`: the new plan and allowance apply immediately;
  remaining days are preserved (`max(now, expiry)`) and the purchased
  duration is added on top. The proxy picks up the larger allowance on its
  next cached read.
- **Lower tier with a live plan** → refused at invoice time with
  `downgrade_not_allowed`; the console hides the buy action for lower tiers
  while a plan is active.
- **Lower tier with no live plan** (expired; the normal "downgrade") →
  accepted: `plan`/`storageBytes` take the lower plan's values, days are
  added from `now`. Then the allowance is checked against data:
  - `usedStorage <= storageBytes` → `ACTIVE`;
  - `usedStorage > storageBytes` → `GRACE`: reads, downloads, and deletes
    continue, uploads are blocked, and the user must delete blobs down to the
    allowance or upgrade. If neither happens before the grace clock runs out,
    the normal `WRITE_BLOCKED` → `READ_BLOCKED` → purge progression follows.
- **Renew before expiry, allowance now short** (edge case) → same as the
  downgrade check: if the renewed allowance is below `usedStorage`, the user
  enters `GRACE` rather than `ACTIVE`.
- Admin grants use the same endpoint with `source: "admin"` and may force
  either mode regardless of the rules above (recorded in the admin audit
  log).

## Lifecycle state machine

Time-only. A pure `deriveAccess(user, now, lifecycleConfig)` function in the
proxy is the single enforcement source; `User.status` is a mirror written by
the notifier for dashboards and audit (the proxy still derives from dates,
so enforcement never lags if the notifier is down).

| State | Entered when | Uploads | Reads | Deletes |
| ----- | ------------ | ------- | ----- | ------- |
| `UNPAID` | no `planExpiresAt` (never purchased) | no | no | n/a |
| `ACTIVE` | now < `planExpiresAt`, within `storageBytes` | yes, within `storageBytes` | yes | yes |
| `GRACE` | expiry ≤ now < grace end, **or** downgraded/renewed and `usedStorage > storageBytes` | only if already within `storageBytes` | yes | yes |
| `WRITE_BLOCKED` | grace elapsed (or over-quota grace elapsed) | no (403 `quota_exceeded` / `grace_expired`) | yes | yes |
| `READ_BLOCKED` | `writeBlockedDays` elapsed | no | no (403) | yes (owner may still delete) |
| `CLOSED` | purge completed | no | no | n/a |

- `GRACE` has two entry reasons and one exit: the user returns to `ACTIVE`
  as soon as `usedStorage <= storageBytes` (deleted blobs and/or upgraded),
  otherwise the time-based progression continues.
- Re-purchase or upgrade from any restricted state returns the user to
  `ACTIVE` when the new allowance covers `usedStorage`; a downgrade that
  still leaves the user over the allowance enters `GRACE` instead.
- Owner deletes remain allowed in `GRACE`/`WRITE_BLOCKED`/`READ_BLOCKED` so a
  user can free data before purge.

**Lifecycle config file** (mounted read-only into proxy and notifier, e.g.
`config/lifecycle.yml`):

```yaml
graceDays: 7
writeBlockedDays: 30
readBlockedDays: 30
purgeEnabled: false        # operator opt-in; READ_BLOCKED is terminal until true
notify:
  expiryWarningDays: [14, 3, 1]
  quotaWarningPercent: [80, 100]
```

`graceDays` applies both to expiry and to a downgrade that leaves the user
over the new allowance, so over-quota recovery follows the same clock.
Parsed and validated at boot with fail-fast errors; `purgeEnabled` gates the
only destructive operation.

## Data model (`packages/db/prisma/schema.prisma`)

Additive migration (own commit, reviewed before it runs anywhere):

- `enum UserStatus { UNPAID ACTIVE GRACE WRITE_BLOCKED READ_BLOCKED CLOSED }`
- `User`:
  - `plan String?`
  - `planExpiresAt DateTime?`
  - `storageBytes BigInt?`
  - `status UserStatus @default(UNPAID)`
  - `statusChangedAt DateTime?`
  - existing `usedStorage` (checked against `storageBytes`), `createdAt`
  - `termsVersion String?`, `termsAcceptedAt DateTime?` (compliance record;
    written by the entitlement call, versioned by the lifecycle/T&C config)
  - indexes on `status`, `planExpiresAt`
  - **no** `notifyNostr` / `notifyEmail` (no per-user prefs; both channels
    are attempted whenever configured)
  - **no** `storageLimit`
- `NotificationLog` — `id`, `npub`, `kind`, `ref String?`, `channel`,
  `sentAt`, unique `(npub, kind, ref, channel)`; orchestrator-specific
  dedupe.
- `ModerationAction` — `id`, `hash`, `npub`, `adminNpub`, `reason`,
  `createdAt`.
- **No `PlanGrant`** — all money-related rows (invoices, amounts, payment
  hashes) live in `formstr-backend`; T&C acceptance lives here, on `User`.

Existing rows are untouched; legacy FREE users land in `UNPAID` under the new
derivation (no plan expiry) and simply cannot upload until they purchase or
are granted a plan. A one-off backfill is unnecessary; migration defaults
handle it.

### Orchestrator migration (Prisma)

One additive migration, `packages/db/prisma/migrations/<ts>_entitlements/`,
in its own commit and reviewed before it runs anywhere. Generated with
`prisma migrate dev`; the reviewed SQL is what ships.

| Change | Object | Detail |
| ------ | ------ | ------ |
| `CREATE TYPE "UserStatus"` | enum | `UNPAID, ACTIVE, GRACE, WRITE_BLOCKED, READ_BLOCKED, CLOSED` |
| `ALTER TABLE "User"` | column | `plan TEXT` (nullable) |
| `ALTER TABLE "User"` | column | `planExpiresAt TIMESTAMP(3)` (nullable) |
| `ALTER TABLE "User"` | column | `storageBytes BIGINT` (nullable) |
| `ALTER TABLE "User"` | column | `status "UserStatus" NOT NULL DEFAULT 'UNPAID'` |
| `ALTER TABLE "User"` | column | `statusChangedAt TIMESTAMP(3)` (nullable) |
| `ALTER TABLE "User"` | column | `termsVersion TEXT` (nullable) |
| `ALTER TABLE "User"` | column | `termsAcceptedAt TIMESTAMP(3)` (nullable) |
| `CREATE INDEX` | `User` | `User_status_idx (status)` |
| `CREATE INDEX` | `User` | `User_planExpiresAt_idx (planExpiresAt)` |
| `CREATE TABLE` | `NotificationLog` | `id`, `npub TEXT`, `kind TEXT`, `ref TEXT?`, `channel TEXT`, `sentAt TIMESTAMP(3)`, unique `(npub, kind, ref, channel)` |
| `CREATE TABLE` | `ModerationAction` | `id`, `hash TEXT`, `npub TEXT`, `adminNpub TEXT`, `reason TEXT`, `createdAt TIMESTAMP(3)`, indexes on `hash`, `npub` |

Notes:

- Purely additive: no existing column is altered or dropped, so the running
  proxy keeps working through the deploy; enforcement switches on in a later
  phase.
- `status` default `UNPAID` means pre-existing users are locked out of
  uploads until they purchase or are granted a plan — intentional, since
  there is no free tier.
- `Blob`, `Member`, `Storage` and the mesh-PG tables are unchanged. The
  legacy `User.plan` enum (`Plan FREE/BASIC/PRO`) is replaced by the nullable
  text column above; a follow-up cleanup migration may drop the old enum only
  after nothing references it.
- Rollback: `prisma migrate resolve` + a hand-written down migration (drop
  the two tables, drop the six columns, drop the enum); not run
  automatically.

## `db-api` changes (`packages/db`, `packages/db-client`)

`db-api` stays logic-free CRUD. Service-token auth (`DB_API_SERVICE_TOKEN`)
applies to the new admin/mutation endpoints; the existing internal endpoints
keep their current behaviour. Reachability from `formstr-backend` is via the
**shared docker network** (point 5).

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| POST | `/users/:npub/entitlement` | service | atomic assign/extend/upgrade (plan, durationDays, storageBytes, termsVersion, source, mode?) |
| GET | `/users` | service | paginated list with filters (`status`, `plan`, `query`) |
| GET | `/users/:npub` | none | extended serialization (plan, expiry, storageBytes, status, usedStorage) |
| PATCH | `/users/:npub/status` | service | notifier/admin status mirror |
| GET | `/users/:npub/blobs` | none | paginated own blobs (hash, size, createdAt, replicas) |
| GET | `/users/attention` | service | users due for lifecycle/notification evaluation |
| GET | `/blobs` | service | admin global blob search/filter/pagination |
| DELETE | `/users/:npub/blobs` | service | transactional bulk delete (purge) |
| POST | `/notifications` | service | log row, 409 on duplicate (dedupe) |
| GET | `/notifications` | service | list by npub |
| POST | `/moderation` | service | moderation audit row |
| GET | `/storage-stats` | service | users/blobs/bytes/plan + lifecycle counts (no money) |

Revenue/billing stats are **not** here; the console gets them from
`formstr-backend` (`/api/invoices/all` + analytics). `packages/db-client`
gains typed methods; `serialize.ts` covers the new fields.

## Proxy changes (`proxy/blossom`)

1. **Enforcement**:
   - Delete the `ALLOWED_NPUBS` gate, `GLOBAL_STORAGE_LIMIT_MB`, and all
     per-plan replica/upload-size checks. `HEAD/PUT /upload` verify auth,
     derive access from `(planExpiresAt, storageBytes, usedStorage, now,
     lifecycle config)`, and enforce total-storage and time only.
   - Error codes: 403 `unpaid`, `grace_expired`, `write_blocked`,
     `read_blocked`, `account_closed`, `quota_exceeded`; 401 for bad auth as
     today. `quota_exceeded` reports `usedStorage`/`storageBytes` and an
     upgrade URL.
   - `GET/HEAD /:hash`: reads public for `ACTIVE`/`GRACE`/`WRITE_BLOCKED`
     owners, 403 for `READ_BLOCKED`/`CLOSED`/`UNPAID` owners. Per-hash cached
     owner-access lookup (short TTL).
   - `DELETE /:hash`: owner-only, allowed in every state where a blob exists.
2. **Account API** (`GET /account`, `PATCH` not needed without prefs):
   - `GET /storage` extended with `status`, `plan`, `planExpiresAt`,
     `storageBytes`, `usedStorage`, `purgeAt`.
   - `GET /account/blobs` — BUD-11 action `list` (already in `nostr.ts`),
     paginated own blobs.
   - `GET /account/notifications` — own notification log.
   - Billing is not proxied: the console calls `formstr-backend` directly
     with NIP-98 for invoices.
3. **Admin API** (`/admin/*`, NIP-98 + unified admin check):
   users list/detail, blob search, moderation delete, manual plan grant via
   `/users/:npub/entitlement`, force status, resend notification, storage
   stats, audit log.
4. **Internal purge** (`POST /internal/purge/:npub`, `INTERNAL_API_TOKEN`):
   list blobs → delete bytes on all replicas via `servers.ts` → delete rows →
   set `CLOSED`; returns counts. Keeps byte deletion in the service that owns
   the storage registry.
5. **Serve the console**: static `console/dist` + SPA fallback, registered
   before an explicit hash route (`/^[a-f0-9]{64}(\.[a-z0-9]+)?$/`) so the
   old `/:hashWithExt` catch-all cannot swallow `/dashboard`, `/admin`,
   `/legal/*`. nginx may serve the same `dist` instead; both documented.
6. **Hardening**: request ids + structured logs, rate limits on
   upload/account/admin, explicit CORS origins, plan/access cache TTLs.

## formstr-backend changes

1. `config/storage-plans.json` + loader/validator; `GET /api/tiers/storage`
   serves it for the console.
2. `paymentController.ts`: `generateStorageInvoiceHandler` — NIP-98 auth,
   `{plan, termsAccepted, termsVersion}` body; reject unknown plan or
   unaccepted terms (the backend validates only that acceptance was sent — the
   authoritative record is written by the orchestrator on entitlement);
   resolve the buyer's current plan/expiry from `db-api` and reject a
   lower-rank purchase while a plan is live (`downgrade_not_allowed`); derive
   `mode` (`upgrade` when rank is higher, else `extend`); zap request with
   `product=storage` + plan tag; store
   pending row; `paymentManager.listenForPayment(hash)`; respond with
   invoice/hash/amount. Route `POST /api/generate-invoice/storage`.
3. `handlers/zapReceiptHandler.ts`: allow `product === "storage"`; on paid,
   `POST {DB_API_URL}/users/:npub/entitlement` with the service token, the
   catalog's `durationDays`/`storageBytes`, and the derived `mode`; write the
   invoice via the existing ledger; send purchase email; trigger the DM (via
   notifier); publish the existing `paid` WS message. Idempotent by pending
   row + invoice ledger; the effective `mode` is re-derived at grant time from
   db-api state, since time may have passed between invoice and payment.
4. `services/paymentCheck.ts` + `scripts/reconcilePendingStoragePlans.ts`
   follow the mail reconciler so a missed live receipt still grants.
5. T&C acceptance is carried through the purchase (`termsAccepted` +
   `termsVersion` in the request) but is **recorded by the orchestrator** on
   the entitlement write — the pending/invoice rows only note the version
   sent, keeping the compliance record in one place.
6. `POST /api/storage/notify` (service token): `{pubkey, event, data}` →
   resolve an address from the mail/nip-05 tables → render a template
   (`storage-expiry.md`, `storage-quota.md`, `storage-moderation.md`,
   `storage-purge.md`) → `sendBridgeMail`. Returns `sent`/`no_address` so the
   notifier can log accurately.
7. Internal admin check for the orchestrator: `GET
   /api/internal/admin-check/:pubkey` (service token) → `{admin: boolean}`
   from `users.role`. The console uses `GET /api/auth/me` (existing).
8. Compose: join the orchestrator **shared network** so `db-api` is reachable
   as `db:<DB_API_PORT>` with no host gateway.

### Backend migrations (Knex)

Two additive migrations, each in its own commit, reviewed before deployment
(migrations run automatically at container start via
`entrypoint.sh` → `run-migrations.ts`, per `AGENTS.md`). Existing tables are
never altered.

**1. `pendingStoragePlan`** — mirrors `pendingDomainOrders`
(`migrations/20260925140000_pending_domain_orders.ts`), the row a zap receipt
is matched against:

| Column | Type | Notes |
| ------ | ---- | ----- |
| `id` | increments | primary key |
| `pubkey` | string | buyer npub/hex, from NIP-98 auth |
| `plan` | string | catalog plan id (`basic`, `pro`, …) |
| `amount_sats` | integer | amount actually invoiced, from the catalog, never the request |
| `ln_invoice` | text | BOLT11 can run long — `text`, matching `pendingMails`/`pendingDomainOrders` |
| `payment_hash` | string | **unique**, notNullable — the zap-request pubkey the receipt carries in `#p` |
| `terms_version` | string | version the buyer accepted, kept so provisioning/audit can see what was shown |
| `granted_at` | timestamp | nullable; set when entitlement is written, so duplicate receipts are detectable |
| `created_at` / `updated_at` | timestamp | default `now()` |
| index | `pubkey` | buyer lookups |

**2. `invoices` — additive ALTER only** (existing table, existing rows):

| Change | Column | Notes |
| ------ | ------ | ----- |
| `ALTER TABLE invoices` | `terms_version TEXT` (nullable) | version sent with the storage purchase; null for mail/form/workspace invoices |

No changes to `users`, `invoices` other than the above, or any other table.
T&C acceptance itself is **not** stored here (orchestrator owns it); the
backend only records which version the purchase carried.

Rollback for both is `down()` (drop table / drop column) and is not run
automatically.

## Unified admin identity

`formstr-backend`'s `users.role='admin'` is the single admin registry:

- Console: gates `/admin` on `GET /api/auth/me` role.
- Orchestrator admin API: after NIP-98 verification, calls
  `GET /api/internal/admin-check/:pubkey` (service token), cached ~60 s.
- `control-plane-backend`'s `Member.role=ADMIN` remains only for storage
  infrastructure operations (linking storage, invites). It no longer confers
  product admin and is out of scope for this change; the plan notes this
  explicitly so nobody adds blossom admins there.

## Notifier (`packages/notifier`)

- **Library**: NIP-17 DM sender (`NOTIFY_NSEC`), email client
  (`formstr-backend /api/storage/notify`), templates, dedupe writes to
  `db-api /notifications`. Used by the proxy for moderation notifications.
- **Service** (own Dockerfile, compose service) every
  `NOTIFY_INTERVAL_MS` (default 15 min):
  1. `GET /users/attention`; derive each user's state.
  2. Mirror changed states via `PATCH /users/:npub/status`.
  3. Send due notifications (dedupe key `npub + kind + ref`):
     purchase confirmation, expiry warnings at the configured days
     (14/3/1), grace entered, uploads blocked, reads blocked (with purge
     date), purged/closed, moderation deletion.
  4. Both channels attempted independently; a missing email address or
     unreachable DM relay is logged, not retried forever.
  5. If `purgeEnabled` and the retention window elapsed, call
     `POST /internal/purge/:npub`, then log the purge notification.
- No preference storage: DMs are always sent; email is sent when the user
  has an address.

## Console (`console/`, `@orchestrator/console`)

React + Vite + TypeScript, NIP-07 signer connect (`window.nostr`,
compatible with `packages/browser-signer`), helpers to sign BUD-11 and
NIP-98.

- `/` — welcome: what Blossom is, how it works, pricing, FAQ, connect CTA.
- `/pricing` — plans from `formstr-backend`; purchase flow: connect → accept
  T&C (required) → choose action → invoice modal (QR, copy, WebSocket status).
  Actions are computed from the user's current entitlement:
  - **Renew / add days** on the current plan (always available);
  - **Upgrade** to any higher-tier plan (applies immediately);
  - **Downgrade** to a lower tier only when no plan is live; the UI warns
    when `usedStorage` exceeds the lower allowance and explains that it will
    start a grace period requiring deletes or an upgrade.
  The backend is authoritative and re-checks the action at invoice time.
- `/dashboard` — plan + expiry countdown + status banners; Blobs (paginated,
  upload time, size, download, delete); Billing (invoices from
  `formstr-backend`); Notifications history; Account (close request). When
  over the allowance, the banner shows a "delete blobs" action to exit
  `GRACE`.
- `/admin` — unified-admin gated: users, storage stats, blob search,
  Moderation (delete with required reason → notify owner; audit log), plan
  grants (admin may force extend, upgrade, or downgrade).
- `/legal/terms`, `/legal/privacy` — versioned static Markdown; purchase
  sends the current version.

## Notifications

| Trigger | Timing | Channels |
| ------- | ------ | -------- |
| Purchase confirmed | on entitlement write (renew or upgrade) | email + DM |
| Expiry warning | T-14d, T-3d, T-1d (config) | email + DM |
| Quota warning | 80 %, 100 % of `storageBytes` (config) | email + DM |
| Grace entered | expiry, or downgrade/renewal leaving `usedStorage > storageBytes` | email + DM |
| Uploads blocked | grace elapsed | email + DM |
| Reads blocked | write-block window elapsed | email + DM (purge date) |
| Purged / closed | purge | email + DM |
| Moderation deletion | on action | email + DM (hash, reason, appeals contact) |

## Moderation flow

1. Admin finds the blob in `/admin` (hash or owner).
2. Delete requires a reason.
3. Proxy (NIP-98 + admin check) deletes bytes on every replica via
   `servers.ts`, deletes the row, writes `ModerationAction`.
4. Owner is notified on both channels (violation of T&C, hash, reason,
   appeal contact).
5. Entry appears in the admin audit log.

BUD-09 reports remain on the storage node for now; surfacing them into the
admin queue is future work.

## Security and productionisation

- Service tokens (`DB_API_SERVICE_TOKEN`, `INTERNAL_API_TOKEN`,
  `STORAGE_SERVICE_TOKEN`, admin-check token) compared constant-time, all
  required outside dev; db-api and the purge endpoint stay on internal
  networks only.
- NIP-98 replay cache is currently in-memory; note single-instance constraint
  and move to Postgres/Redis before scaling the proxy horizontally.
- Rate limits per npub on upload/account and per admin on admin routes.
- Audit trail: entitlement source (`payment`/`admin`) is recorded in the
  assignment call and the admin audit log; moderation and purge rows are
  persisted.
- `purgeEnabled` defaults false; enabling it is a deliberate ops decision.
- Legal copy reviewed; version bump is explicit in the config.
- Backups: Postgres + storage-node data; restore runbook.

## Phasing

1. **Foundations** — Prisma migration (own commit), db-api/db-client
   entitlement + admin endpoints, lifecycle config loader, state-machine
   tests. No public behaviour change.
2. **Enforcement** — proxy derives access; two-rule checks; `/storage` and
   account endpoints; read gating; smoke-test updates.
3. **Payments** — backend plan config, storage product, entitlement push over
   the shared network, T&C at purchase, reconciliation, notify endpoint +
   email templates; migrations in their own commits; `npx tsc --noEmit` +
   `npx jest` per AGENTS.md.
4. **Console (user)** — shell, welcome/pricing/purchase, dashboard, legal;
   proxy serves `dist`.
5. **Notifier** — package, scheduler, DM + email, lifecycle mirroring, purge
   (disabled).
6. **Admin + moderation + unification** — backend admin-check endpoint,
   proxy admin API, console admin/moderation pages, deletion notifications.
7. **Hardening** — rate limits, logging, metrics, backups, nginx/deploy docs,
   load test, legal sign-off, README updates.

## Testing

- db-api tests: atomic entitlement extend/replace/upgrade, additive-day
  arithmetic across boundaries, over-quota downgrade → `GRACE`, status
  mirror, admin filters, purge transaction.
- Backend jest: storage invoice (price from catalog, T&C required, unknown
  plan rejected, lower-tier-while-live rejected, `mode` derivation for
  same/higher/lower rank), duplicate receipt idempotency,
  entitlement-call failure handling, reconciler; migrations run clean via
  `npx knex migrate:latest` against the compose Postgres, and `down()`
  reverses both.
- Proxy unit tests: enforcement at every lifecycle boundary
  (`ACTIVE`/`GRACE`/`WRITE_BLOCKED`/`READ_BLOCKED`, expiry and over-quota);
  read-gating; admin auth delegation; error codes.
- `packages/smoke-test` additions: unpaid 403, quota-exceeded 403, expired
  upload
  403, restricted read 403, delete still allowed, renew-adds-days, upgrade
  immediate, downgrade-over-quota → grace, admin NIP-98 pass/fail.
- End-to-end compose: fake zap receipt → entitlement visible in `/storage`
  and console; upgrade changes allowance immediately; downgrade-after-expiry
  with data over the new allowance enters grace; expiry simulation →
  notification + stage transitions.

## Open items

1. Actual plan ids, prices, durations, and storage allowances for the catalog.
2. Lifecycle config values (grace/write/read windows) and whether purge is
   ever enabled by default.
3. Whether `control-plane-backend` `Member` roles should eventually be
   derived from the unified admin registry too (currently separate, infra
   only).
4. DM bot identity (`NOTIFY_NSEC`) and relay set for NIP-17 delivery.
5. Storage-node admin dashboard/landing: recommend disabling in production in
   favour of this console.

# Plan: Admin/Client Control Plane

## Status

Proposed — 2026-08-07, revised 2026-08-07 after a review pass against the
codebase. The revision changed five things materially, all recorded inline as
"an earlier draft of this plan…": replicas are now keyed by storage npub
instead of URL (decision 10), the storage's tunnel IP is host-resolved instead
of self-reported (decision 9), `storage-agent` no longer runs `nvpn` at all
(which also closed the plan's former top open risk), capacity is "reported"
rather than "verified" with total and free kept separate (decision 5), and the
admin view gained the `MemberList`/revoke screen without which the source
doc's headline admin capability had no UI. Written against the repo state:
`admin-backend`
(923-line single-file Axum crate), `admin-app` (Tauri 2 + wasm, role-agnostic
single-host-at-a-time UI), `packages/db` (3-model Prisma schema: `User`,
`Blob`, `RelayEvent`), and the already-completed NVPN sidecar mesh
(`docs/NVPN_SIDECAR_PLAN.md`). Source requirements: `docs/admin-client-apps.md`.

## Goal

Turn `admin-backend` into a real **control-plane backend** with two DB-backed
roles — **Admin** (manages the roster: authorizes/removes clients, views
aggregate stats, and implicitly has every Client capability) and **Client**
(an npub that donates storage: once authorized, is entirely responsible for
requesting their own mesh invite, bootstrapping a storage machine, and
linking its resulting npub to the roster themselves — every step a deliberate
action they take, never something the server does on their behalf). Replace
today's `.env`-only config (`ADMIN_ALLOWED_PUBKEYS`, `BLOSSOM_SERVERS`,
`BACKEND_RELAYS`) with DB-backed state that the public proxies pick up
without a restart, and let `admin-app` render role-appropriate screens
instead of assuming every unlocked key is fully privileged.

## Design decisions

These resolve the ambiguities in `docs/admin-client-apps.md` explicitly, so
implementation doesn't re-litigate them. Each is a deliberate, confirmed
choice, not a default — flag in review if any should change.

Two reading notes. **"Decision N" and the source doc's "requirement N" are
unrelated numbering** — decision 7 is not about requirement 7, and the
collision is accidental; requirements are always named as "requirement N in
`admin-client-apps.md`". And **requirement 7 is deliberately not implemented as
written**: it asks for "the control plane server for the storage [to] need the
client npub as .env input for authorization", i.e. ownership asserted by
config on the storage machine. Decision 7 replaces that with ownership
asserted by the client from their authenticated app session, because a
`.env`-declared owner is an unauthenticated claim the host would have to trust,
and because it would put a second identity (the operator's npub) onto every
storage machine — the exact thing decision 3 avoids.

### Where the source requirements ended up

| Req | Disposition |
| --- | ----------- |
| 1 (dynamic blossom/relay clients from DB) | Done — `Storage` + polling registry |
| 2 (available storage from client, control plane verifies) | **Partly** — declared + reported are done; real verification deferred (decision 5) |
| 3 (authorized clients from DB, admin-editable) | Done — `Member` + `MemberList` |
| 4 (admins from DB) | Done — `ADMIN_ALLOWED_PUBKEYS` demoted to bootstrap seed |
| 5 (refresh caches when storage added) | Done — 15s poll of `/storages/active` |
| 6 (FIPS transport, NIP-98 on all APIs) | **Partly** — NIP-98 everywhere already; FIPS for app→control-plane deferred with reasons (decision 2) |
| 7 (client npub as storage `.env` input) | **Replaced** — see above |
| 8 (multi-host, role-gated views) | Done — client-side profiles + `/v1/me` (decision 1) |
| 9 (script to view FIPS address / nvpn ip) | Done — `scripts/nvpn-whoami.sh`, now load-bearing (decision 2) |

1. **Per-host, independent control planes.** Each host keeps running its own
   `control-plane-backend` + `db-api` + Postgres, exactly like today. "A user
   can be part of multiple hosts" (requirement 8) is handled entirely
   client-side — `admin-app` already persists multiple host profiles
   (`useProfiles.ts`) and now additionally fetches a role per profile. There
   is no shared multi-tenant directory service, no cross-host DB, no new
   trust boundary.

2. **FIPS transport for the app→control-plane hop is deferred, not delivered —
   and no separate "bootstrap transport" is introduced either.** Requirement 6
   ("run a FIPS node, reachable via FIPS") is **partially** met: the two hops
   that carry real data already run over the mesh, but the app→control-plane
   hop stays plain HTTPS. Being explicit about that, per path:
   - **`admin-app` → control plane.** Stays plain HTTPS + NIP-98, exactly as
     today. Every enrollment action a client takes — requesting an invite,
     linking a storage npub (decision 3/7) — goes through this same path,
     from the app, by the human. **This is the part of requirement 6 that is
     not delivered, and the reason is not that the app "isn't" a mesh peer —
     the requirement is asking for it to become one.** The real blocker:
     `abh3po/fips-capacitor` ships as `@formstr/fips-capacitor-plugin`, an
     **Android-only Capacitor plugin** (Rust compiled to JNI via `cargo ndk`,
     arm64-v8a/armeabi-v7a/x86_64), with iOS merely planned and web
     explicitly unsupported because FIPS needs raw UDP. `admin-app` ships
     web, desktop and Android from one codebase, so adopting it would give
     mesh transport to exactly one of three targets while the other two keep
     a second, divergent transport — and `admin-core::normalize_url`
     (`crates/admin-core/src/lib.rs:149`) plus every NIP-98 signature in the
     app is bound to an `https://` origin today, so it is a real refactor of
     the shared core, not a swap at the edge. Deferred deliberately; revisit
     when there is a server-side/desktop FIPS binding to target.
   - **`storage-agent` → control plane.** Because decision 7 makes "add this
     npub to the mesh roster" an explicit action the client performs
     themselves *before* the corresponding storage machine ever starts
     reporting, that machine's mesh device already exists and its tunnel is
     already up by the time `storage-agent`'s process starts. There is no
     "first report before approval" case to handle: every report,
     from the first one, goes over the internal NVPN tunnel (plain HTTP
     inside the already-encrypted mesh) to the host's tunnel IP. This is
     simpler than an earlier draft of this plan, which tried to have
     `storage-agent` trigger its own approval via a public bootstrap call —
     unnecessary once approval is the client's explicit act, not the
     server's inference from a ping.
   - **The data-plane hop** — host's `proxy/blossom`/`proxy/relay` reaching
     into a storage-client's backend — is already solved by the NVPN
     sidecar mesh from `docs/NVPN_SIDECAR_PLAN.md`. Nothing new there.
   - The "FIPS" terminology in `nvpn status --json`
     (`fips_endpoint_npub`) is NVPN's own internal rendezvous protocol,
     unrelated to that library.
   - **Requirement 9's "script to view the FIPS address / nvpn ip" is kept,
     and this plan makes it load-bearing rather than optional.** Decision 7
     requires every client to set `CONTROL_PLANE_HOST_NPUB` on their storage
     machine, which means the *host* operator has to read their own mesh
     identity off a running host and hand it out alongside each invite.
     Both values are already sitting in the sidecar's own state, so this is
     a three-line script (`scripts/nvpn-whoami.sh`):
     `docker compose exec nvpn jq -r '.npub, .listenPort' /data/.sidecar-complete`
     for the identity (written by `commit_state()` in `nvpn/entrypoint.sh`,
     schema-versioned and validated on every boot) and
     `docker compose exec nvpn ip -o -4 addr show "${NVPN_TUN_IFACE:-nvpn0}"`
     for the tunnel IP. `nvpn status --json` is deliberately *not* used for
     either: `nvpn/firewall.sh:8-11` records the verified-against-4.0.87
     fact that it carries no tunnel-interface field at all.

3. **Every storage has its own identity, separate from the client's own
   operator identity.** The npub an operator uses to unlock `admin-app` (their
   `Member` row) is **not** reused as a storage machine's mesh device
   identity — each storage machine generates its own fresh Nostr keypair
   during its own NVPN bootstrap, exactly as `nvpn init`/`bootstrap-client`
   already does today for every peer. A client may own several storage
   machines, each with a distinct npub. Ownership is never inferred from key
   reuse; it's established by one explicit act: **the client submits that
   storage's npub to the control plane themselves**, from their own
   authenticated session — see decision 7. This is a correction from an
   earlier draft of this plan, which incorrectly assumed one npub could serve
   both roles; that would have required copying the operator's own key onto
   every storage machine, which is both unnecessary and a needless key-reuse
   risk.

4. **Control-plane Admin and NVPN mesh admin stay separate grants.**
   Promoting someone to control-plane `Admin` (DB role, can authorize clients
   / view roster) never runs `nvpn add-admin`. Mesh-level co-admin (a full
   mesh signing key, per `scripts/nvpn-add-admin.sh`) stays a separate,
   rarer, manual action. NVPN mesh device approval remains a prerequisite
   before a storage can ever ping successfully — decision 7 has the *client*
   perform that approval for their own storage, not an admin and not the
   server acting automatically.

5. **Capacity has a declared cap and a *reported* measurement — and
   requirement 2's actual verification is explicitly deferred.** "Client
   should be able to signal how much storage is available to share and this
   should be configurable even after the storage is added to the roster"
   (source doc, "Who are clients?"; the closest numbered item is requirement
   2) becomes `declaredCapacityBytes` on each individual `Storage` row,
   editable from the app at any time. `storage-agent` separately measures
   the data volumes and reports **two** numbers on every ping —
   `reportedTotalBytes` and `reportedFreeBytes`.

   Three deliberate choices here, each of which an earlier draft of this plan
   got wrong:
   - **The measurement is named "reported", not "verified".** Requirement 2
     says "the control plane will need to *verify* if the claimed amount of
     storage is present in the storage." A number `statvfs`-measured by the
     storage itself and sent to the host is not verification of anything —
     it is the storage's second claim. Calling the column
     `verifiedCapacityBytes` would encode a guarantee this plan does not
     provide. Real verification (host-side probe writes, e.g. uploading and
     reading back a sized blob through the mesh) is **out of scope for v1
     and left as a follow-up**, called out as such rather than implied away.
   - **Total and free are separate fields, because they are different
     quantities.** `min(declared, reported)` in an earlier draft compared a
     *cap* against *free space right now*, which is dimensionally wrong and
     would shrink a node's advertised size every time it filled up. Usable
     capacity is `min(declaredCapacityBytes, reportedTotalBytes)`; headroom
     is `reportedFreeBytes`. The client "My storage" gauge needs both
     independently (declared cap vs. free on disk), so collapsing them was
     never going to survive the UI anyway.
   - `storage-agent` never receives the declared value back — it only ever
     reports what it measures; the declared cap is a control-plane-side
     accounting concern, set per node since one client can own several nodes
     with different caps.

6. **`User` (consumer of proxy storage) and `Member` (donor of storage) stay
   separate models.** They're different populations that happen to both be
   identified by npub; conflating them would let a paying user's identity
   leak into the storage-donor roster or vice versa. Likewise
   `ALLOWED_NPUBS` (who may upload *through* the public proxy) is untouched
   — it gates a different population than the new `Member` roster.

7. **Enrollment is two client-driven steps — self-service, not automated.**
   Verified against the current implementation
   (`admin-backend/src/lib.rs:264-310`): `create_invite` and `add_device` are
   two fully independent Axum handlers today, both admin-only. `POST
   /v1/invites` takes an empty body and only calls `nvpn create-invite`;
   `POST /v1/devices` takes `{npub}` and only calls `nvpn add-device --device
   <npub> --publish` + `nvpn reload`. Nothing links them today — an admin
   runs step 1, hands the invite to the client out of band, gets a resulting
   npub back out of band, then manually runs step 2 *for the client*.
   The new design keeps exactly these two steps and exactly this manual,
   human character — it just moves both steps onto the client, who is
   already a human fully capable of doing them, rather than requiring an
   admin as an intermediary:
   - **Step 1 — invite.** `POST /v1/invites`'s handler is unchanged; only its
     auth gate loosens from admin-only to "any `ACTIVE` `Member`", so a
     client can request their own invite directly.
   - **Step 2 — link the storage.** The client takes that invite to the
     machine they're donating, runs the existing `bootstrap-client` flow
     there, and gets back a fresh npub identifying *that machine* (decision
     3) — unchanged from today's `storage-client/scripts/nvpn-join.sh`. They
     then bring that npub back to `admin-app` and submit it themselves via a
     **new** self-service endpoint, `POST /v1/storage {npub}`. Its handler
     performs the exact operation `POST /v1/devices` already performs
     (`nvpn add-device --device <npub> --publish` + `nvpn reload` — literally
     "adding the storage npub to the roster") and, in the same request,
     creates a `Storage` row with `npub` = the submitted value and
     `ownerNpub` = the caller. This is the one and only place ownership is
     established, and it only ever happens because the client deliberately
     did it — there is no path by which a storage becomes linked to anyone
     without this explicit call. **`POST /v1/devices` and `POST
     /v1/devices/remove` are removed entirely**, not kept alongside
     `/v1/storage` — they were a POC-era, admin-only, storage-agnostic
     primitive with no remaining caller once this flow covers the real use
     case, and keeping a second route that does almost the same thing as
     `/v1/storage` would just be duplicated surface area. `admin-app`'s
     current "Approve device"/"Remove device" controls (`Dashboard.tsx`,
     backed by the `add_device`/`remove_device` Tauri commands) go away with
     them — see "admin-app changes" below. If an admin ever needs to touch
     the raw mesh roster for something genuinely unrelated to a storage
     donation, the host-side tools that predate this API entirely
     (`scripts/nvpn-approve.sh`, `docker compose exec nvpn ...`) are still
     there, untouched by this removal.
   - Because step 2 already performs the mesh approval, `storage-agent`
     never needs to "wait to be approved" or discover it *afterward* — by
     construction, its device already exists and its tunnel is already up
     before that process is ever started (see decision 2).

8. **An admin who contributes storage goes through the identical two steps
   as any client — no separate "admin storage" path.** The doc says admins
   "also have client privileges... they can give their own storage to the
   host." Concretely: an admin's own npub is a `Member` row like any other
   (just with `role = ADMIN`), so decision 7's two steps — request invite,
   bootstrap the storage machine, submit its npub via `POST /v1/storage`
   themselves — apply to them unchanged. `Storage.ownerNpub` is simply their
   own npub; the `Storage` model has no role check on ownership, and
   `control-plane-backend` never distinguishes "admin's storage" from
   "client's storage" anywhere in the enrollment or ping handling. The only
   place role matters is which *screens* `admin-app` shows (see the
   two-view model below) — never which API calls are permitted for
   enrolling storage.

9. **A storage's tunnel IP is read out of the host's own mesh state, never
   taken from the storage's ping.** This is a security decision, not a
   plumbing one. `proxy/blossom` and `proxy/relay` build backend URLs by
   string-interpolating whatever address the control plane holds
   (`http://${tunnelIp}:${blossomPort}`) and then `PUT` real user uploads at
   it. If that address came from the storage's own request body, any member
   who controls a storage key could aim the host's proxies at an arbitrary
   host inside the sidecar's network namespace — another peer's tunnel IP, or
   `db:4000`, which is `db-api`, deliberately unauthenticated because it is
   supposed to be internal-only. Every subsequent upload would flow there.
   So:
   - The control plane resolves `tunnelIp` itself, by matching the ping's
     signing npub against `fips_endpoint_npub` in its own
     `nvpn status --json` peers list (the shape `parse_status` already
     handles today, `admin-backend/src/lib.rs:512-564`). The host is
     authoritative about mesh addressing because it *is* the mesh admin.
   - `POST /v1/storage/ping` therefore carries **no `tunnelIp` field at
     all** — an absent field cannot be spoofed, and there is nothing for a
     reviewer to remember to validate later.
   - Ports stay client-supplied (the storage genuinely knows which ports it
     bound) but are validated: `1024..=65535`, and rejected unless they
     match the ports the mesh firewall actually permits for that peer.
   - Belt-and-braces: any resolved address outside `NVPN_PRIVATE_CIDR`
     (default `10.44.0.0/16`, already an env var on the sidecar) is refused
     and the ping is rejected without setting `lastPingAt`, so the storage keeps
     reading as pending rather than becoming an upload target at an address the
     mesh can't have assigned (decision 12).

10. **Replica records are keyed by storage npub, not by URL.** Today
    `Blob.replicas` and `RelayEvent.replicas` persist absolute backend URLs
    (`proxy/blossom/src/index.ts:240` writes them, `:315` and `:355` read
    them back for download/delete; `proxy/relay/src/index.ts:174` writes
    them, `:149` reads them back to route a kind-5 deletion). That is safe
    *only* because those URLs come from a static env list and therefore never
    change. The moment backends are DB-driven — a storage re-bootstraps, the
    mesh re-addresses it, an operator moves a port — every already-persisted
    replica URL becomes a dead pointer, and the failure is **silent**:
    `downloadBlob` logs each miss and moves to the next replica, so blobs
    simply become un-downloadable one replica at a time with no error
    surfaced anywhere. This is the single largest correctness risk in the
    whole change and an earlier draft of this plan missed it entirely.
    Therefore:
    - `replicas` holds `Storage.npub` values — stable, already the primary
      key, and never re-assigned (decision 3 guarantees a machine's identity
      outlives its address).
    - Both proxies resolve npub → URL at request time through the same
      registry that already polls `/storages/active`, so a re-addressed
      storage keeps serving its existing blobs with no data migration.
    - Existing rows are migrated in the `packages/db` step by mapping each
      stored URL back to the npub of the storage that currently answers at
      it; rows whose URL matches no known storage keep their raw value and
      are logged, since a URL with no owner is exactly the dangling state
      this decision exists to prevent and it should be visible, not
      silently dropped.

11. **Every NIP-98 mutation stays a `POST`.** (Scoped to the public
    `control-plane-backend` surface only — `db-api` is internal, unauthenticated
    and keeps its existing REST verbs, including `PATCH /storages/:npub`.)
    `admin-backend/src/lib.rs:143-145`
    records the existing convention and its reason: `nostr`'s
    `nip98::HttpMethod` covers GET/POST/PUT/PATCH but not DELETE, so the repo
    routes *all* mutations through POST to keep exactly one signing path in
    `admin-core`. `cors()` (`lib.rs:167`) allows only `[GET, POST]` to match.
    An earlier draft of this plan specified `PATCH
    /v1/storage/:npub/capacity`, which would have required widening the CORS
    method list and adding a second signing path to `admin-core` for one
    route's benefit. It is `POST /v1/storage/:npub/capacity` instead.

12. **Nothing derivable is stored, with one justified exception.** An earlier
    draft had `Storage.status` holding four values, three of which were pure
    functions of `lastPingAt` (`PENDING_VERIFICATION` = never pinged, `ACTIVE`
    = pinged inside the freshness window, `UNREACHABLE` = outside it) and one
    of which — `REMOVED` — was an authoritative soft-delete decision derivable
    from nothing. Mixing the two in one column is what forced a background
    sweep to exist, and created a window where a storage reads `ACTIVE` while
    being 20 minutes stale. Split instead:
    - **`lifecycle` (stored, authoritative):** `LINKED` | `REMOVED`. A
      decision someone made; nothing else records it.
    - **Liveness (computed at read time):** `lastPingAt IS NULL` → pending;
      `lastPingAt > now - window` → active; else unreachable. Never stored, so
      it cannot be wrong.

    This is not a performance sacrifice: `/storages/active` becomes
    `WHERE lifecycle = 'LINKED' AND lastPingAt > $cutoff`, served by the
    composite `@@index([lifecycle, lastPingAt])` as a range scan. The 60s
    sweep loses its flip-to-`UNREACHABLE` job entirely and keeps only the work
    that is genuinely authoritative — reaping never-reported rows past the 24h
    grace period, which is a deletion decision, not a computation.

    **The exception is `tunnelIp`**, which is a cache of NVPN daemon state and
    stays one. The proxies are Node services with no `nvpn` binary and no mesh
    config (see decision 2), so the address has to reach them through
    `db-api`; recomputing it per read would put an `nvpn` subprocess in the
    proxies' hot path. The cost is a bounded staleness window — up to
    `PING_INTERVAL_SECS` after the mesh re-addresses a peer. **This is exactly
    why decision 10 keys replicas by npub rather than URL**: because
    `tunnelIp` is allowed to be temporarily wrong, nothing durable may point
    at it. The two decisions only work together.

    For completeness, the pre-existing schema has one derived aggregate that
    already drifts and is out of scope here: `User.usedStorage` should equal
    `SUM(Blob.size) + SUM(RelayEvent.size)` per npub, but
    `DELETE /relay-events/:eventId` deliberately skips the decrement
    (`packages/db/src/index.ts:184-186`) and that is the path the real kind-5
    flow takes (`proxy/relay/src/index.ts:150`), so it inflates permanently.
    Worth a separate fix; noted so nobody assumes it is trustworthy when
    building the roster's byte totals.

## Architecture

```
admin-app (the client, a human, at the keyboard)
  │  HTTPS + NIP-98
  │  1. POST /v1/invites          — self-service, enrollment step 1
  │  2. POST /v1/storage {npub}   — self-service, enrollment step 2:
  │                                 the client's own act of linking the
  │                                 storage machine's npub to the roster
  ▼
control-plane-backend (Rust/Axum, was admin-backend)
  │                                   │
  │  nvpn CLI (subprocess, unchanged) │  HTTP (new: members/storage CRUD)
  ▼                                   ▼
nvpn sidecar (mesh, unchanged)      db-api ──► Postgres (new tables)
  │
  │  mesh tunnel — the device was already approved in step 2 above,
  │  before storage-agent (below) is ever started
  ▼
storage-client host
  ├── blossom :3000 ─┐
  ├── strfry  :7777 ─┤ (unchanged, mesh-only, no host ports)
  └── storage-agent (NEW, Rust)
        - own identity: this storage's own bootstrap-generated npub
          (decision 3), never the client's own operator credential
        - reads total + free disk on BLOSSOM_DATA_PATH/RELAY_DATA_PATH
        - does NOT run `nvpn`: host address comes from config, own npub
          from the /data/.sidecar-complete marker, own tunnel IP not
          needed at all (decision 9)
        - every report, from the first one:
            ──internal NVPN tunnel, HTTP+NIP-98──► control-plane-backend
              (reached at the host's 10.44.x.y tunnel IP — no public
               HTTPS path needed, since the device is already on the
               roster by the time this process starts)

proxy/blossom, proxy/relay (unchanged processes, new config source)
  - poll db-api's new GET /storages/active every 15s instead of reading
    BLOSSOM_SERVERS/BACKEND_RELAYS once at startup
  - persist and resolve replicas by storage npub, not URL (decision 10),
    so a re-addressed storage keeps serving the blobs it already holds
```

## Data model (`packages/db`)

New Prisma models, additive migration — `User`/`Blob`/`RelayEvent` untouched.
`Storage` is keyed by its own npub (decision 3), not a synthetic id:

```prisma
enum MemberRole {
  CLIENT
  ADMIN   // strict superset of CLIENT privileges
}

enum MemberStatus {
  ACTIVE
  REVOKED
}

model Member {
  npub        String       @id
  role        MemberRole   @default(CLIENT)
  status      MemberStatus @default(ACTIVE)
  addedByNpub String?      // null for the bootstrap admin(s) seeded from env/CLI
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt

  storages    Storage[]
}

// Only the authoritative half of the old StorageStatus. Liveness
// (pending / active / unreachable) is NOT stored — see decision 12.
enum StorageLifecycle {
  LINKED   // linked via POST /v1/storage, mesh device approved
  REMOVED  // soft-deleted, kept for audit
}

model Storage {
  npub                  String        @id // this storage's own mesh identity
  ownerNpub             String            // the Member who linked it (decision 7)
  owner                 Member        @relation(fields: [ownerNpub], references: [npub])
  tunnelIp              String?           // 10.44.x.y — resolved by the HOST from its
                                          // own nvpn peers list, never from a ping body
                                          // (decision 9). A cache of NVPN state; see
                                          // decision 12 for why it stays cached.
  blossomPort           Int?
  relayPort             Int?
  declaredCapacityBytes BigInt?           // operator-set cap, editable any time
  reportedTotalBytes    BigInt?           // last statvfs total from storage-agent
  reportedFreeBytes     BigInt?           // last statvfs free from storage-agent
  lifecycle             StorageLifecycle @default(LINKED)
  lastPingAt            DateTime?         // null = never reported in
  createdAt             DateTime      @default(now())

  // Serves the proxies' hot query directly:
  //   WHERE lifecycle = 'LINKED' AND lastPingAt > $cutoff
  @@index([lifecycle, lastPingAt])
  @@index([ownerNpub])
}
```

Note on why ownership appears three times and is stored once. `Storage.ownerNpub`
is the only stored fact — a `TEXT` column with an FK constraint. `Storage.owner`
and `Member.storages` are both virtual navigation fields that occupy no column
(compare the existing `User.blobs`/`Blob.user` pair: the `20260706233319_1st`
migration creates no `blobs` column on `User`, only
`Blob_npub_fkey`). Prisma also *requires* the back-relation — a `@relation`
field whose model has no opposite field fails schema validation — so
`Member.storages` is not optional and not duplication. **Do not "simplify"
this by adding a `storageNpubs String[]` or a cached `storageCount` to
`Member`**; those would be genuine second copies that can drift from the FK,
which is the thing the current shape rules out by construction.

The one place this needs care is reads. `MemberList` shows a per-member storage
count, so `GET /members` takes it from the relation in the same query rather
than the caller fanning out one `GET /storages?ownerNpub=` per row:

```ts
prisma.member.findMany({ include: { _count: { select: { storages: true } } } })
```

serialized as `storageCount` alongside each member. `GET /storages?ownerNpub=`
stays for the case that actually needs the rows (the owner's own Client view).

Note on soft deletes: `Member.npub` is the primary key, so revoking is a
status flip, not a row removal — re-authorizing a previously revoked npub is
an update back to `ACTIVE` (what `PUT /members/:npub`'s upsert already does),
never an insert that would collide. Same for `Storage.lifecycle = REMOVED`: a
client who re-links a storage npub they previously removed reactivates that
row rather than creating a second one, which is also what keeps decision 10's
`replicas` npub references resolvable across a remove/re-add cycle.

`verifiedCapacityBytes`/`verifiedAt` from an earlier draft are gone — there is
no verification step in v1 (decision 5), and columns named for a guarantee the
system doesn't make are how that guarantee ends up assumed downstream.

New `db-api` endpoints (Express, `packages/db/src`, split out of the
now-203-line `index.ts` into `routes/members.ts` and `routes/storages.ts` to
keep files small). Same conventions as today: BigInt fields serialized as
decimal strings, no auth (internal-only), no business logic — just CRUD plus
the one aggregate read the roster overview needs.

| Method | Path                     | Notes                                                              |
| ------ | ------------------------ | ------------------------------------------------------------------- |
| GET    | `/members/:npub`         | read                                                                |
| GET    | `/members`               | list, optional `?role=`/`?status=` filter — roster overview source. Includes `storageCount` per row via `_count` (see the data-model note), so `MemberList` needs no per-member follow-up call |
| PUT    | `/members/:npub`         | upsert (authorize / change role)                                   |
| DELETE | `/members/:npub`         | soft-delete (`status = REVOKED`)                                   |
| GET    | `/storages/:npub`        | read                                                                |
| GET    | `/storages`              | list, optional `?ownerNpub=` filter                                |
| GET    | `/storages/active`       | `lifecycle = LINKED AND lastPingAt > cutoff` — computed, not a stored flag (decision 12). What the proxies poll |
| POST   | `/storages`              | create — called once, when a client links a storage npub            |
| PATCH  | `/storages/:npub`        | update capacity/lifecycle/ping fields                               |
| DELETE | `/storages/:npub`        | soft-delete (`lifecycle = REMOVED`)                                 |

`packages/db-client` gets matching typed methods (`getMember`, `putMember`,
`getStorage`, `listActiveStorages`, etc.) mirroring the existing `DbClient`
class shape.

## `control-plane-backend` (rename of `admin-backend`)

The doc explicitly asks for this rename plus a module split — `lib.rs` is
already 923 lines and every new route only adds to it. Target layout, each
file under 300 lines per the doc's guidance:

```
control-plane-backend/src/
  main.rs           # unchanged shape: build Config, build Router, serve
  config.rs         # env parsing (was Config::from_env in lib.rs)
  error.rs          # shared error type + IntoResponse
  auth.rs           # NIP-98 verify + replay cache (was authorize/consume_auth_event)
  nvpn.rs           # CLI subprocess wrapper (unchanged logic, moved as-is)
  db_client.rs       # thin reqwest client to db-api, mirrors packages/db-client
  routes/
    health.rs
    me.rs            # NEW: GET /v1/me
    status.rs         # existing GET /v1/status (peer observability only now —
                      #   see "admin-app changes" for why it lost its Revoke action)
    invites.rs         # existing POST /v1/invites, gate loosened (see below)
    members.rs           # NEW: admin-only roster CRUD
    storage.rs             # NEW: link/ping/edit/remove a storage — absorbs and
                            #   replaces the old devices.rs entirely (removed)
    roster.rs                # NEW: GET /v1/roster aggregate
```

### Full route table

| Method | Route                        | Auth                          | Purpose                                                                                  |
| ------ | ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| GET    | `/health`                     | none                            | unchanged                                                                                   |
| GET    | `/v1/me`                      | NIP-98                          | **NEW.** `{npub, role: "admin"\|"client"\|"none", memberSince}` — what `admin-app` uses to gate UI |
| GET    | `/v1/status`                  | NIP-98, admin                   | unchanged (raw nvpn peer status)                                                            |
| GET    | `/v1/roster`                  | NIP-98, admin                   | **NEW.** Aggregate: member counts by role, storage counts by lifecycle+liveness (computed, decision 12), total/free bytes |
| GET    | `/v1/members`                 | NIP-98, admin                   | **NEW.** List roster                                                                        |
| POST   | `/v1/members`                 | NIP-98, admin                   | **NEW.** `{npub, role}` — authorize a client or promote an admin                            |
| POST   | `/v1/members/remove`          | NIP-98, admin                   | **NEW.** Revoke; cascades to the member's storages (`REMOVED`, `nvpn remove-device --publish` each — the verb `remove_device_and_reload` already uses, `lib.rs:439`) |
| POST   | `/v1/invites`                 | NIP-98, **active member**       | **CHANGED gate.** Any authorized member (client or admin) can self-serve their own mesh invite |
| POST   | `/v1/storage`                 | NIP-98, **active member**       | **NEW.** `{npub}` — enrollment step 2: the caller links a storage's npub to their own roster entry, approving its mesh device in the same call |
| POST   | `/v1/storage/ping`            | NIP-98, **signed by an existing `Storage.npub`** | **NEW.** Body below — the storage-agent heartbeat, arrives over the mesh tunnel |
| POST   | `/v1/storage/:npub/capacity`  | NIP-98, owning member or admin  | **NEW.** `{declaredCapacityBytes}`. POST, not PATCH — decision 11                            |
| POST   | `/v1/storage/:npub/remove`    | NIP-98, owning member or admin  | **NEW.** Also runs `nvpn remove-device --publish` + `nvpn reload`                             |

**Removed:** `POST /v1/devices` and `POST /v1/devices/remove`. Both existed
only as a POC-era, admin-only, storage-agnostic wrapper around `nvpn
add-device`/mesh removal; `/v1/storage` and `/v1/storage/:npub/remove` now
cover that operation for the one thing this system actually uses it for
(linking/unlinking a storage), so the old pair has no remaining caller and is
deleted rather than kept alongside its replacement.

`POST /v1/storage` handler:

1. Reject if caller's `Member.status != ACTIVE`.
2. Reject if `{npub}` is already a `Storage` row owned by someone else — a
   client can only ever link a storage to themselves, never claim or
   reassign one that's already claimed (the doc is explicit that even
   admins "cannot reassign any storage to any other client").
3. Run `nvpn add-device --device <npub> --publish` + `nvpn reload` — this
   *is* "adding the storage npub to the roster."
4. Create the `Storage` row, `ownerNpub` = caller, `status =
   LINKED`, `lastPingAt = null` — which is what makes it read as pending.

`POST /v1/storage/ping` body: `{blossomPort, relayPort, reportedTotalBytes,
reportedFreeBytes}`, NIP-98 signed by the storage's own npub (not a `Member` —
the storage itself never has a `Member` row, only its owner does). **No
`tunnelIp` field** — per decision 9 the host resolves that itself, so there is
nothing here for a caller to lie about. Handler:

1. Look up `Storage` by the signing npub; `404` if none exists — this can
   only happen if nobody has ever run `POST /v1/storage` for it, which
   shouldn't occur since the mesh device (and therefore the tunnel this
   request arrived over) only exists once that call already ran.
2. Resolve the peer's tunnel IP from this host's own `nvpn status --json`,
   matching `fips_endpoint_npub` against the signing npub. If the peer isn't
   in the list, or its address falls outside `NVPN_PRIVATE_CIDR`, record the
   ping's capacity numbers but leave `lastPingAt` untouched and log
   it — a storage the host's own mesh doesn't know about must never enter the
   proxies' backend rotation.
3. Validate the ports (`1024..=65535`, and permitted by the mesh firewall for
   that peer). Reject the ping otherwise; a bad port is a misconfiguration
   worth surfacing, not something to store and let the proxies discover.
4. Update `tunnelIp` (host-resolved), ports, `reportedTotalBytes`,
   `reportedFreeBytes`, `lastPingAt = now` — which is all "active" means
   (decision 12); there is no status column to flip.
5. Rely on `db-api`'s `/storages/active` being polled by the proxies — no
   push needed (see below).

Note that step 2 makes `nvpn status --json` a per-ping dependency on the host.
That call is already serialized behind `Nvpn::command_lock`
(`lib.rs:418`) and subject to the 45s `COMMAND_TIMEOUT`, so at the default
`PING_INTERVAL_SECS=300` across a few dozen storages it is nowhere near
contended — but cache the parsed peers list for ~15s inside the handler
anyway, so a thundering herd of pings after a host restart can't serialize
into a queue of subprocess spawns.

A background sweep (`tokio::time::interval`, e.g. every 60s) has exactly one
job, because decision 12 removed the other: reap rows that have never been
pinged (`lastPingAt IS NULL`) and are older than a generous grace period (e.g.
24h) — cheap cleanup for a client who linked a storage's npub but never
actually started `storage-agent` on it. It does **not** maintain a liveness
flag; "unreachable" is `lastPingAt` older than the freshness window (e.g. 3
missed 5-minute pings ≈ 16 min), evaluated wherever it is read, so it is never
stale and never waits on a sweep tick.

`GET /v1/me` computes role by looking up the caller's npub in `Member`; keep
`ADMIN_ALLOWED_PUBKEYS` only as an optional **bootstrap seed** — on first
boot with an empty `Member` table, seed those pubkeys as `ADMIN` rows so a
fresh deployment isn't locked out before anyone can call `POST /v1/members`
themselves. After that, the DB is authoritative and the env var is ignored.

## Dynamic backend list for `proxy/blossom` / `proxy/relay`

Both currently read `BLOSSOM_SERVERS`/`BACKEND_RELAYS` once at module import
(`proxy/blossom/src/servers.ts:9`, `proxy/relay/src/relay.ts:27`) with no
refresh path. Replace the module-level constant with a small registry that
polls `db-api`'s new `GET /storages/active` on an interval and swaps the
in-memory list atomically:

Because replicas are persisted by npub (decision 10), the registry is a
two-way map, not a list — resolution by npub is what keeps already-stored
blobs reachable after a storage is re-addressed:

```ts
// proxy/blossom/src/servers.ts (shape, not final code)
class ServerRegistry {
  private byNpub = new Map<string, string>();   // npub -> http://ip:port
  async refresh() {
    const active = await dbClient.listActiveStorages();
    this.byNpub = new Map(
      active.map(s => [s.npub, `http://${s.tunnelIp}:${s.blossomPort}`]),
    );
  }
  candidates(): Array<{ npub: string; url: string }> { /* upload targets */ }
  resolve(npub: string): string | undefined { /* stored-replica lookup */ }
}
```

`uploadBlob` records `successfulReplicas` as **npubs**; `downloadBlob` and
`deleteBlob` take npubs and `resolve()` each one, skipping (and logging, at
`warn`) any that no longer resolves — the one case where a blob really has
lost a replica, now distinguishable from "the address moved". `proxy/relay`
does the same for `RelayPool`.

Two things `RelayPool` needs beyond the analogous change, which "same, for
`BACKEND_RELAYS`/`RelayPool`" understated:

- Its relay list is `private readonly relays: string[]`, captured once in the
  constructor (`proxy/relay/src/relay.ts:37,41-43`) and used as the default
  `targetRelays` for `publish`/`query`/`health`. Swapping a module-level const
  does nothing; the pool has to take a live provider (`() => string[]`, or the
  registry itself) instead of an array.
- It holds long-lived WebSockets in `connections`, keyed by URL, cleaned up
  only on socket `close` (`:157-179`). When a relay leaves the active set
  nothing closes its socket, so the pool keeps a connection — and keeps
  publishing to it via the default `targetRelays` — to a backend the roster
  has already dropped. `refresh()` must close and delete connections for URLs
  no longer active.

Poll every 15s (`setInterval`); keep the existing per-request live `/health`
check (`getServerStatus`) unchanged — this only fixes *which backends are
candidates*, not liveness. Keep `BLOSSOM_SERVERS`/`BACKEND_RELAYS` as a
**dev-only seed**: if set and the DB has no active storages yet (fresh local
dev, `docker-smoke-test.sh`), fall back to the env list so nothing currently
working breaks. Log a warning when the fallback is used in a build with
`NODE_ENV=production`. Note that both files currently `throw` at module import
when their env var is empty (`servers.ts:14-16`, `relay.ts:32-34`); that guard
has to become "no env seed *and* no active storages" so a production host with
a healthy DB roster and no env vars set can still boot.

**Replica starvation becomes a normal operating state.** `uploadBlob` throws
`"Failed to satisfy replica count"` and `selectHealthyRelays` throws
`"Insufficient healthy relays"` when fewer backends are healthy than the
caller's plan requires (`servers.ts:79-83`, `relay.ts:130-132`). With a static
env list that only happens on operator error. With a DB-driven roster it
happens routinely — a member is revoked, two storages stop pinging, a
client edits a cap. This plan does not change the throwing behaviour (failing
an upload beats silently under-replicating it), but it does mean:
`GET /v1/roster` must surface `activeStorages` against the largest
`replicaCount` in `PLAN_CONFIG` and flag the shortfall, and the background
freshness window quietly dropping a storage out of `/storages/active` is a
user-visible availability event, not just bookkeeping.

## `storage-agent` (new Rust crate, `storage-client/storage-agent/`)

A new, small, focused binary — the vendored `storage-client/blossom` fork
stays untouched. Runs alongside `blossom`/`relay` in the storage-client
Compose stack, sharing the `nvpn` sidecar's network namespace
(`network_mode: "service:nvpn"`) and mounting the data volumes read-only.

```
storage-agent/src/
  main.rs       # tokio runtime, interval loop, wires the pieces below
  config.rs     # env: CONTROL_PLANE_HOST_NPUB, STORAGE_NCRYPTSEC,
                #      STORAGE_NSEC_PASSPHRASE, BLOSSOM_DATA_PATH,
                #      RELAY_DATA_PATH, BLOSSOM_PORT, NOSTR_PORT,
                #      NVPN_TUN_IFACE, AGENT_HEALTH_PORT,
                #      PING_INTERVAL_SECS (default 300)
                #   NB: NOSTR_PORT, not RELAY_PORT — that is what
                #   storage-client/.env.example actually calls strfry's port
                #   (RELAY_PORT is the *host* proxy's public port, a different
                #   thing in a different .env)
  capacity.rs   # statvfs (via `nix::sys::statvfs`) on the mounted data dirs,
                #   reporting total AND free separately (decision 5)
  identity.rs   # NIP-98 signing using this storage's OWN key
                #   — never the client's own operator credential (decision 3)
  mesh.rs       # resolves the host's tunnel IP. Needs only ONE address (the
                #   host's), because the agent no longer reports its own —
                #   decision 9 has the host resolve that itself. See below for
                #   why this does not shell out to `nvpn`.
  report.rs     # builds the /v1/storage/ping body, sends it to the host's
                #   tunnel IP over plain HTTP inside the mesh, NIP-98 signed
                #   with this storage's own identity
  health.rs      # tiny axum listener on AGENT_HEALTH_PORT (default 3010 —
                #   3000/7777 are already bound by blossom/strfry in this
                #   shared namespace), GET /health for the Docker healthcheck
```

### What running `nvpn` from this container would actually require

An earlier draft had `mesh.rs` shell out to `nvpn status --config ... --json`
"same subprocess pattern as control-plane-backend's `nvpn.rs`", with a Compose
service declaring only `network_mode`. That would not have worked, and the
reason is documented in this repo already. The host's `admin` service needs
**all** of the following to make one `nvpn status` call succeed
(`docker-compose.yml`, the `admin` service):

- `pid: "service:nvpn"` — and there is a long comment there explaining exactly
  why: `nvpn status --json` reports live `daemon.state` only when it can see
  the daemon's PID as alive. With the network namespace shared but not the PID
  namespace, the pid_file points at a PID with no matching process, and
  **status silently reports no `state` at all** — i.e. `parse_status`'s
  `daemon.state` is `None` and every call fails. A `mesh.rs` built as
  originally specified would have returned nothing, forever, with no obvious
  cause.
- `volumes: [nvpn_data:/data]` — without the shared state volume there is no
  `config.toml` to point `--config` at.
- `HOME=/data/home`, `XDG_CONFIG_HOME=/data/config`,
  `NVPN_CONFIG=/data/config/nvpn/config.toml` — nVPN resolves identity files
  relative to these.
- an image that vendors the pinned nvpn 4.0.87 binary (`admin-backend/`'s
  Dockerfile does this in a dedicated build stage).

**So `storage-agent` deliberately does not run `nvpn` at all.** Everything it
needs is available more cheaply and more reliably:

- **The host's tunnel IP.** The client's own `config.toml` roster already
  contains the inviting proxy (`bootstrap_client()` runs
  `nvpn set --device <inviter>` during join, `nvpn/entrypoint.sh`), and in a
  two-peer client mesh the host is the only peer. Read it from the tunnel
  interface's peer route, or — simplest and stable — accept it as
  `CONTROL_PLANE_HOST_TUNNEL_IP` alongside `CONTROL_PLANE_HOST_NPUB`, both
  handed out with the invite by the host operator's `scripts/nvpn-whoami.sh`
  (decision 2). One env var beats a subprocess, a PID namespace and a state
  volume mount.
- **Its own npub** (needed to log which identity it is signing as, and for the
  operator to correlate with what they linked): `/data/.sidecar-complete`, the
  schema-versioned marker `commit_state()` writes —
  `{role, schemaVersion, npub, listenPort}` — validated on every sidecar boot
  by `validate_existing_state()`. This is a documented, versioned contract in
  this repo, not a field reverse-engineered out of a CLI's JSON.
- **Its own tunnel IP**: not needed any more (decision 9).

This deletes the plan's former top open risk ("`nvpn status --json`
self-identity field... needs confirming against a live 4.0.87 daemon") rather
than scheduling an investigation for it. `nvpn/firewall.sh:8-11` had in fact
already answered the underlying question: *"`nvpn status --json` has no
tunnel-interface field (verified against v4.0.87)."*

**Where the storage's own key comes from — decide this before writing any
code.** The key is generated fresh at bootstrap time (decision 3), not copied
from the client's own operator key. Beyond that, both candidate designs hinge
on one unknown that has to be resolved first, against a live container:
**what nVPN 4.0.87 actually writes as its identity file, and whether it can be
exported.** What the repo establishes today:

- `bootstrap_client()` emits **only** the npub on stdout, and the invite is
  read from stdin and `unset` immediately. No key material ever leaves the
  container.
- `nvpn init` writes its own secret file into `${XDG_CONFIG_HOME}/nvpn/`;
  `commit_state()` then `chmod -R go-rwx`es it and `chmod 0700`s the
  directory. `validate_existing_state()` asserts on every boot that "no Nostr
  secret file found beside `config.toml`" is fatal — so a secret file
  reliably exists at a known location, inside the `nvpn_data` volume.
- No documented `nvpn` subcommand exports that secret in any form.

That makes the original plan (extend `nvpn-join.sh` to capture the key and
write `STORAGE_NCRYPTSEC` + a generated `STORAGE_NSEC_PASSPHRASE` into
`storage-client/.env`) the *more* speculative of the two options, not the safer
one: it needs an export path that may not exist, and if it does exist it leaves
a second live copy of the signing key sitting in a plaintext-adjacent `.env`
forever. The alternative an earlier draft dismissed as a "future
simplification" — mount `nvpn_data` read-only and sign with the identity
already persisted there — needs the *same* unknown resolved (the file's
format) and creates no second copy.

**Recommended order of work:** spend the ten minutes to look at
`/data/config/nvpn/` in a live client container first. If the identity is in a
readable, stable format, read it (`nvpn_data:/data:ro`, no new secret, no
script change). Only if it isn't, fall back to the `.env` capture path — and
then treat the `nvpn-join.sh` change as its own reviewed commit, because that
script deliberately goes out of its way today to expose nothing but a public
identifier (README: "send only that public identifier back to the proxy
operator").

Env additions to `storage-client/.env.example`:

```bash
# --- storage-agent -----------------------------------------------------
# The host's mesh identity and tunnel address, both shown by the host
# operator's scripts/nvpn-whoami.sh and handed over with the invite.
# The npub identifies which peer this agent reports to; the tunnel IP is
# where it sends the ping. See decision 2 — storage-agent deliberately
# does not run `nvpn` to discover these.
CONTROL_PLANE_HOST_NPUB=npub1...
CONTROL_PLANE_HOST_TUNNEL_IP=10.44.0.1
# Port storage-agent's own /health listener binds inside the shared nvpn
# namespace. Must not collide with BLOSSOM_PORT (3000) or NOSTR_PORT (7777);
# only loopback reaches it, which firewall.sh already ACCEPTs unconditionally.
AGENT_HEALTH_PORT=3010
# This storage's own identity. Populated only if the nvpn_data-read path
# above proves unworkable. Never the client's own operator key (decision 3).
STORAGE_NCRYPTSEC=
STORAGE_NSEC_PASSPHRASE=
PING_INTERVAL_SECS=300
```

Compose addition to `storage-client/docker-compose.yml`, mirroring the
existing `blossom` service's `network_mode`/`depends_on` shape and the host
`admin` service's hardening:

```yaml
  storage-agent:
    build: ./storage-agent
    restart: unless-stopped
    network_mode: "service:nvpn"
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    depends_on:
      nvpn:
        condition: service_healthy
        restart: true
    volumes:
      - ${BLOSSOM_DATA_PATH}:/app/data/blossom:ro
      - ${RELAY_DATA_PATH}:/app/data/strfry:ro
      # Read-only: the marker file for this storage's own npub, and (if the
      # investigation above lands that way) the nvpn-persisted identity.
      # NOT for running `nvpn` — see "What running nvpn would actually
      # require" above; there is deliberately no `pid: service:nvpn` here.
      - nvpn_data:/data:ro
```

Note `${BLOSSOM_DATA_PATH}`/`${RELAY_DATA_PATH}` are bind mounts of host
directories, so `statvfs` on them reports the *host filesystem's* totals —
which is what "how much storage is this machine offering" means in the common
case, but means two storages on one physical host will each report the same
underlying disk. Worth a line in the client-facing docs; the control plane
cannot detect it.

## `admin-app` changes

No new build targets, no new transport (decision 2) — this is UI/state work
on top of the existing `admin-core` / `#platform` split.

### Exactly two views, cleanly separated by capability, not by role

Kept deliberately simple: there are two *views*, **Admin** and **Client**,
each showing only the capabilities that belong to it — not one dashboard
that grows admin controls conditionally. Which views a session can reach is
what depends on role:

- `role === "none"`: neither view. A dedicated empty state, replacing
  today's assumption that every unlocked key is fully privileged.
- `role === "client"`: **Client view only.** No admin controls exist
  anywhere in this session's UI, not even hidden — there's nothing to
  switch to.
- `role === "admin"`: **both views**, reachable via a small segmented
  switcher in the `TopBar` (`Admin` / `My storage`). This is decision 8 made
  visible in the UI: an admin managing the roster and an admin enrolling
  their own storage are the same person doing two different jobs, so they
  get two distinct screens instead of one screen with everything on it.

### Client view (`role` is `client` or `admin`)

Only self-service storage capabilities — nothing about other members. Two
distinct, explicit actions, matching decision 7's two real steps (neither one
collapses into the other, and nothing happens automatically in between):

- **"Request invite"** — step 1, self-service `POST /v1/invites`. Copy makes
  clear this only produces the bootstrap credential; it does not by itself
  add anything to the roster.
- **"Link a storage"** — step 2, a form where the client pastes the npub
  their storage machine printed after running `bootstrap-client` with that
  invite. Submits `POST /v1/storage {npub}`. Copy is explicit that this is
  the action that actually approves the device and brings it onto the
  roster — there is no automatic step after this one.
- "My storage" list — one row per linked `Storage` (`ownerNpub == caller`),
  reusing the existing `PeerList`/`PeerRow` visual pattern: status chip
  (pending verification / active / unreachable), tunnel IP, last ping.
  **Capacity is edited inline, per row** (`POST /v1/storage/:npub/capacity`,
  decision 11) — not a single form assuming one storage, since a client can
  own more than one node. Each row shows the declared cap it is editing and
  the last reported free/total beside it, which are three distinct numbers
  (decision 5) and must not be collapsed into one bar.

### Admin view (`role === "admin"` only)

Only roster-management capabilities — nothing about the admin's own storage,
which lives in the Client view like anyone else's:

- `RosterSummary` card, a sibling of the existing `.summary` card (same
  Georgia-serif big-number treatment) — member counts by role, storage
  counts by liveness, total/free bytes, and the replica-shortfall flag from
  "Replica starvation" above, all from `GET /v1/roster`.
- "Authorize a client" form (reuses the existing operation-card pattern
  from "Add a device") — `POST /v1/members`. This grants membership only;
  it does not touch storage or the mesh — the newly authorized client does
  the rest themselves from their own Client view.
- **`MemberList` — the roster itself.** An earlier draft of this plan (and
  the design mockup built from it) specified `GET /v1/members` and `POST
  /v1/members/remove` in the route table but gave neither a screen, which
  left the source doc's headline admin capability — *"They can remove any
  client... They can also remove any client and its storage from the
  roster"* — with no UI at all. One row per `Member`: npub, role chip
  (Client / Admin), status chip (Active / Revoked), how many storages they
  own, and a **Revoke** text-button opening the "Revoke this client?"
  `Dialog` (which must spell out the cascade: their storages go `REMOVED`
  and each is removed from the mesh). Promotion to Admin lives here too,
  since it operates on an existing member rather than adding one.
- `StorageList` across *all* members — owner npub, status, declared cap and
  last reported free/total (read-only here; editing stays in the owner's
  Client view), Remove action (`POST /v1/storage/:npub/remove`).
- The existing Peers list (raw NVPN mesh view, `GET /v1/status`) stays, but
  loses its per-peer "Remove" button — that called `POST /v1/devices/remove`,
  which no longer exists (see decision 7). It becomes a read-only
  observability view; removal always goes through `StorageList` above now.
  A raw mesh peer with no matching `Storage` row (leftover state, or
  something added directly via host CLI) can still only be removed at the
  host, outside the app — a rare enough case that it doesn't need its own
  API surface. **Peers carry no role and no "(you)" marker.** A peer's npub
  is `fips_endpoint_npub` — a *storage machine's* mesh identity, which by
  decision 3 has no `Member` row and therefore no role, and is never the
  operator's own key. The only annotation this list can honestly show is
  whether the peer resolves to a known `Storage` row and who owns it; a role
  chip here would be inventing data. (The design mockup got this wrong in its
  first pass — it printed the same npub as both the admin's operator identity
  and their storage, with an "Admin" role chip on the peer row, which is
  precisely the conflation decision 3 exists to prevent.)

Every new screen reuses existing tokens/components: `--danger` for
destructive text-buttons, `Georgia` display headings, the `.card` gradient
background, `controls.eyebrow` micro-labels, and the `Dialog`/`ProfileDialog`
modal shell for the confirmation flows ("Revoke this client?", "Remove this
storage?"). See `docs/admin-client-apps-design.html` for exact layouts — a
standalone page, openable directly in a browser, with a review switcher for the
three session states (admin / client-only / not-authorized).

Four things are genuinely **new** styling and should be added deliberately
rather than assumed to exist:

- **Primary buttons become white-on-deep-fill.** `controls.module.css:25-26`
  currently ships `color: #092019; background: var(--green)` — near-black ink
  on bright mint. The mockup proposes white labels instead, which forces the
  fill to move with them: white on `--green` (`#70e1b2`) is about 1.4:1 and
  illegible, so two new tokens carry the deeper fills —
  `--green-fill: #1a7c55` (~5.2:1 against white) and `--warm-fill: #a86520`
  (~4.6:1), both clearing WCAG AA for the 13px/750-weight label. `--green`
  and `--warm` are unchanged and stay in use for chips, status dots,
  eyebrows and focus rings. This is a visual change to every existing button
  too, not only the new ones — worth a deliberate yes/no rather than
  discovering it in a diff.

- A `.chip` status pill in `controls.module.css`, built from the three
  semantic colours already in use (`--green` good, `--warm` pending,
  `--danger` offline/destructive) — no new accent.
- `--serif` and `--mono` custom properties in `theme.css`. Today `Georgia`
  and `ui-monospace` are repeated inline per rule
  (`Dashboard.module.css:37,113,133,156`); the new screens multiply those
  repetitions enough to justify tokens.
- `.statusDot` gains `warn`/`off` variants. `controls.module.css` currently
  ships only the base dot and `.online`, with `.offline` living privately in
  `Dashboard.module.css:185`; three states shared across four lists belong in
  one place.

And every new action needs the busy/error affordances the existing dashboard
already has and the mockup omits: `controls.spinner` plus a present-tense
label (the pattern in `Dashboard.tsx:132-138`), because Authorize, Link,
Revoke and Remove all shell out to `nvpn` behind the backend's 45-second
`COMMAND_TIMEOUT` (`lib.rs:45`) — several seconds of dead UI otherwise — and a
toast on failure, since `useSession.ts` turns every rejection into one. `Link
a storage` in particular should stay disabled until its npub parses, because
the server-side canonical-npub check (`parse_device_npub`) rejects hex and
truncated keys and a round-trip to learn that is a poor experience. Extend
`BusyKind` (`platform/types.ts:68-74`) with the new operations rather than
reusing `"device"`.

## Testing

- **`control-plane-backend`**: unit tests per new module (mirrors the
  existing ~290 lines of tests already in `lib.rs`, split alongside the code
  they cover); NIP-98 auth tests extend the existing pattern
  (`verify_auth_header` against exact URL/body/timestamp). New integration
  tests for `members`/`storage` routes against a real `db-api` + test
  Postgres (docker-compose based, matching how `packages/smoke-test`
  already stands up a real stack rather than mocking), including the
  `POST /v1/storage` ownership-conflict rejection (decision 7, step 2).
- **e2e**: new `scripts/control-plane-e2e.sh`, built on top of the existing
  `scripts/nvpn-mesh-e2e.sh` harness — brings up host + client, has an admin
  authorize the client's `Member` row, then drives the *client's own* two
  self-service calls (`POST /v1/invites`, then — after a real
  `bootstrap-client` run — `POST /v1/storage`), starts `storage-agent`,
  asserts the `Storage` row goes `ACTIVE` from a real ping over the mesh
  tunnel, asserts `proxy/blossom`'s dynamic list picks up the new backend
  within one poll interval, then runs the existing 24
  `packages/smoke-test` checks against it end-to-end.
- **`admin-app`**: extend `admin-core`'s existing Rust unit tests (13 of them,
  `crates/admin-core/src/lib.rs:445+` — NIP-49/NIP-98 round trips, status
  parsing, npub canonicalization) to cover `/v1/me` role parsing and the new
  request builders. Then an e2e suite driving the app against a small mocked
  control-plane backend (a lightweight Axum server standing in for the real
  one) covering both role paths, including the two-step "request invite" then
  "link a storage" flow as two distinct, separately-asserted actions.

  **Size this honestly: it is net-new infrastructure, not an extension.**
  `admin-app` is its own pnpm workspace (own `pnpm-workspace.yaml` and
  lockfile; the root workspace covers only `packages/*` and `proxy/*`) and has
  **no JS test tooling whatsoever** — no vitest, no Playwright, no `test`
  script in `package.json`. "Matching the approach already used in
  `nostr-calendar`" means porting a harness across repos. Because of that,
  this is the last item in the rollout, and if it slips, the Rust-side tests
  above plus `control-plane-e2e.sh` are the ones that must not.

- **Regression coverage for decision 10.** The npub-keyed replica change is
  the one edit in this plan that can silently corrupt existing data, so it
  needs a test nothing else covers: upload a blob, then change the storage's
  address in the DB, then download it again and assert it still resolves.
  That test would fail today and is the whole reason the decision exists.

## Rollout

0. **Investigate nVPN's persisted identity file** in a live client container
   (see "Where the storage's own key comes from"). Cheap, and it decides the
   shape of step 3 — doing it after writing `storage-agent` risks rewriting
   `identity.rs` and changing `.env.example` twice.
1. `packages/db` migration: additive models, **plus** the URL→npub replica
   backfill (decision 10). Safe to deploy independent of everything else, but
   note this step is no longer purely additive — it rewrites two existing
   columns' contents, so it is the one step that wants a backup taken first.
2. `control-plane-backend`: module split + new routes, `ADMIN_ALLOWED_PUBKEYS`
   becomes bootstrap-seed-only. `scripts/nvpn-whoami.sh` lands here too, since
   step 3 can't be configured without it.
3. `storage-agent`: new crate, wired into `storage-client/docker-compose.yml`
   (opt-in — existing storage-clients without it keep working exactly as
   today, just without reported capacity, and their npub stays unlinked to any
   `Storage` row until someone runs `POST /v1/storage` for it).
4. `proxy/blossom`/`proxy/relay`: npub-keyed registry, polling `db-api`, env
   vars demoted to dev-only fallback. Must land **after** step 1's backfill —
   the code reads npub-shaped replicas.
5. `admin-app`: two-view UI, including the two-step client enrollment flow and
   `MemberList`/revoke.
6. `admin-app` e2e harness (net-new tooling — see Testing).
7. Docs: update root `README.md`'s "Quick start" once the self-service flow
   removes the current manual host-side steps for the common case (existing
   scripts stay for the manual/override path).

Steps are otherwise independently deployable and backward compatible — a host
can run steps 1–2 with zero storage-clients migrated yet, and old-style manual
`BLOSSOM_SERVERS`/`nvpn-approve.sh` operation keeps working throughout via the
fallback paths noted above. The two real ordering constraints are 0 → 3 and
1 → 4.

## Open risks / follow-ups

**Resolved since the first draft** — recorded here because they were listed as
risks and should not be re-investigated:

- ~~`nvpn status --json` self-identity field.~~ Not needed at all:
  `storage-agent` no longer reports its own tunnel IP (decision 9), gets its
  own npub from the `/data/.sidecar-complete` marker, and takes the host's
  address from config (decision 2 / "What running `nvpn` would actually
  require"). `nvpn/firewall.sh:8-11` had already recorded, verified against
  4.0.87, that the JSON carries no tunnel-interface field.

Still open:

- **What nVPN persists as its identity file, and whether it can be exported.**
  This gates the `storage-agent` signing-key decision and nothing else; see
  "Where the storage's own key comes from" for the recommended order (look
  first, then choose). It is the one thing worth checking against a live
  container before any `storage-agent` code is written.
- **No real capacity verification in v1** (decision 5). Requirement 2 asks the
  control plane to verify a claimed amount is actually present; it currently
  takes the storage's word for it. Follow-up: host-side probe writes through
  the mesh, measured against `reportedTotalBytes`.
- **A client can link a storage npub that never actually pings** (typo,
  abandoned setup, or someone testing). Harmless by design — it just sits
  pending (`lastPingAt IS NULL`) until the background sweep reaps it (see the
  route table above) — but worth surfacing in the UI (e.g. "linked 3 days ago,
  never reported in") so it doesn't read as a silent failure.
- **Storage identity is bearer authority.** Whoever holds a storage's key can
  ping as that storage. Decision 9 removes the ability to *redirect* the
  proxies with it, but a stolen key can still report false capacity numbers,
  and the plan has no revocation path for a storage key other than the owner
  removing the storage. Acceptable for v1 (the same is true of the mesh device
  identity itself), but it means capacity numbers are advisory, which
  reinforces decision 5's naming.
- **Two storages on one physical host** both report that host's disk (see the
  `statvfs`/bind-mount note above). Undetectable control-plane-side; document
  it for client operators rather than pretending to a guarantee.
- **`GET /v1/status` cost per ping.** Decision 9 puts an `nvpn` subprocess in
  the ping path. Mitigated by the ~15s peers-list cache described there, but
  it is a new coupling between ping throughput and `nvpn` CLI latency worth
  watching once there are more than a handful of storages.
- **CORS**: `control-plane-backend` already answers preflights from any
  origin (unauthenticated probing is possible but not exploitable, per
  existing `admin-backend/README.md`). The new routes inherit this
  unchanged — no new exposure, since authority is still 100% in the NIP-98
  signature, never an ambient cookie. Keeping every mutation a POST
  (decision 11) also keeps the existing `[GET, POST]` method list correct.

## Files to change

| File                                                    | Change                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/db/prisma/schema.prisma`                        | Add `Member`, `Storage` models + enums                            |
| `packages/db/prisma/migrations/*`                          | Additive migration, **plus** the URL→npub backfill for `Blob.replicas`/`RelayEvent.replicas` (decision 10) |
| `packages/db/src/routes/members.ts`, `routes/storages.ts`  | New CRUD + `/storages/active`                                     |
| `packages/db-client/src/*`                                 | New typed methods/types for the above                              |
| `admin-backend/` → `control-plane-backend/`                | Rename + module split per the layout above                          |
| `proxy/blossom/src/servers.ts`                              | Static `BLOSSOM_SERVERS` const → npub-keyed polling `ServerRegistry`; `upload/download/deleteBlob` take npubs; drop the import-time `throw` |
| `proxy/blossom/src/index.ts`                                 | Persist/read `replicas` as npubs (`:240`, `:315`, `:355`)              |
| `proxy/relay/src/relay.ts`                                  | Same registry change; `RelayPool` takes a live provider instead of a captured array, and closes sockets for backends that leave the roster |
| `proxy/relay/src/index.ts`                                   | Persist/read `replicas` as npubs (`:149`, `:174`)                      |
| `storage-client/storage-agent/`                             | New Rust crate (layout above) — **no `nvpn` binary, no `pid: service:nvpn`** |
| `storage-client/docker-compose.yml`                          | Add `storage-agent` service (read-only `nvpn_data`, hardened like host `admin`) |
| `storage-client/scripts/nvpn-join.sh`                        | Only if the `nvpn_data`-read path fails: capture `STORAGE_NCRYPTSEC`/passphrase at bootstrap. Separate reviewed commit either way |
| `storage-client/.env.example`                                | Add `CONTROL_PLANE_HOST_NPUB`, `CONTROL_PLANE_HOST_TUNNEL_IP`, `AGENT_HEALTH_PORT`, etc. |
| `scripts/nvpn-whoami.sh`                                     | New — host npub + tunnel IP for handing out with invites (requirement 9) |
| `admin-app/src/hooks/useSession.ts`                          | Fetch and store `role` from `/v1/me`; new busy kinds for the new ops     |
| `admin-app/src/styles/theme.css`, `controls.module.css`       | Add `--green-fill`/`--warm-fill` + white primary labels, `--serif`/`--mono`, `.chip`, `.statusDot` warn/off variants |
| `admin-app/src/components/RosterSummary.*`, `MemberList.*`, `StorageList.*` | New (admin view) — `MemberList` is what makes revoke reachable |
| `admin-app/src/components/ClientStorage.*`                    | New (client view): request invite, link storage, per-node capacity        |
| `admin-app/src-tauri/src/lib.rs`, `admin-core/src/lib.rs`, `admin-wasm/src/lib.rs`, `platform/*.ts` | Remove the `add_device`/`remove_device` commands and platform methods entirely (backed `/v1/devices`, now gone); add `link_storage`/`remove_storage` wired to `/v1/storage` |
| `scripts/control-plane-e2e.sh`                                | New, built on `nvpn-mesh-e2e.sh`                                           |
| `docker-compose.yml`, `.env.example`                          | `ADMIN_ALLOWED_PUBKEYS` becomes bootstrap-only                              |
| `docs/admin-client-apps-design.html`                           | Design mockup for the screens above (already written; keep in sync with the published artifact) |
| `README.md`, `admin-backend/README.md`, `admin-app/README.md` | Reflect renamed crate, new routes, self-service two-step flow               |

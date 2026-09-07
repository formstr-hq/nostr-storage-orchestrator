// NIP-98 auth proxy for the mesh-PG explorer.
//
//   pg.stg.formstr.app → this proxy → pgweb (127.0.0.1:8081, --readonly)
//
// Auth: the sign-in page produces a NIP-98 event (kind 27235) via
//   - NIP-07 (window.nostr), @formstr/signer, or NIP-46 bunker on the client
//   - ncryptsec + passphrase (NIP-49 unlock, memory-only) in-page
// The signed event is POSTed to /auth here. We verify it (sig, kind, u-tag,
// method, created_at window, optional allowed-npubs) and mint an HttpOnly
// session cookie. All /pg/* paths require the cookie; the session key is a
// random 32-byte token. Sessions expire after 12h.
//
// Read-only is enforced three layers deep: pgweb --readonly, the proxy only
// ever forwards to pgweb, and the gateway user is orchestrator (writes are
// possible at the SQL layer, so pgweb's readonly flag is the real guard).

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyEvent } from 'nostr-tools/pure'
import * as nip19 from 'nostr-tools/nip19'

const PORT = Number(process.env.PROXY_PORT || 8090)
const PGWEB_URL = process.env.PGWEB_URL ?? 'http://127.0.0.1:8081'
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 8) * 3600_000
const MAX_WINDOW_S = Number(process.env.NIP98_WINDOW_SECONDS ?? 300)

/**
 * Admin allowlist from ALLOWED_NPUBS (env, comma/space separated) and/or
 * ALLOWED_NPUBS_FILE (one npub per line). Fail closed: with no allowlist and
 * without an explicit ALLOW_ALL=1, every login is denied — this proxy exists to
 * gate the DB to authorized admins only, so "no list" must not mean "everyone".
 */
const allowAll = process.env.ALLOW_ALL === '1'
const allowList = (() => {
  const set = new Set()
  for (const entry of (process.env.ALLOWED_NPUBS ?? '').split(/[,\s]+/)) {
    const t = entry.trim().toLowerCase()
    if (t) set.add(t)
  }
  const p = process.env.ALLOWED_NPUBS_FILE
  if (p) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim().toLowerCase()
      if (t && !t.startsWith('#')) set.add(t)
    }
  }
  return set
})()
if (allowList.size === 0 && !allowAll) {
  console.warn('WARNING: no ALLOWED_NPUBS/ALLOWED_NPUBS_FILE set and ALLOW_ALL != 1 — all logins are denied')
}

const COOKIE_NAME = 'pgx_session'

// ── session store: token → { npub, expiresAt } (in-memory; restarts re-auth) ──
/** @type {Map<string, {npub: string, expires: number}>} */
const sessions = new Map()

function pruneSessions() {
  const now = Date.now()
  for (const [token, s] of sessions) if (s.expires < Date.now()) sessions.delete(token)
}

setInterval(pruneSessions, 60_000).unref()

function parseCookies(header) {
  const out = {}
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

function safeEqual(a, b) {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

// ── NIP-98 verification ──────────────────────────────────────────────────────

/**
 * Verify a NIP-98 authorization event against an expected method+url.
 * Returns { ok: true, npub } or { ok: false, reason }.
 */
export async function verifyNip98(authHeader, method, url) {
  if (!authHeader?.startsWith('Nostr ')) return { ok: false, reason: 'missing Nostr authorization' }
  let event
  try {
    event = JSON.parse(Buffer.from(authHeader.slice(6), 'base64').toString('utf8'))
  } catch {
    return { ok: false, reason: 'malformed base64 payload' }
  }
  if (event.kind !== 27235) return { ok: false, reason: 'kind is not 27235' }
  const tags = new Map(event.tags?.map((t) => [t[0], t[1]]) ?? [])
  const u = tags.get('u')
  const m = tags.get('method')
  if (u !== url) return { ok: false, reason: `u tag mismatch: ${u}` }
  if (m?.toUpperCase() !== method.toUpperCase()) return { ok: false, reason: 'method mismatch' }
  const now = Math.floor(Date.now() / 1000)
  const created = Number(event.created_at ?? 0)
  if (!Number.isFinite(created) || Math.abs(now - created) > MAX_WINDOW_S) {
    return { ok: false, reason: 'created_at outside allowed window' }
  }
  let valid = false
  try { valid = verifyEvent(event) } catch { valid = false }
  if (!valid) return { ok: false, reason: 'signature invalid' }
  const npub = nip19.npubEncode(event.pubkey)
  if (!allowAll && !allowList.has(npub)) return { ok: false, reason: 'npub not allowed' }
  return { ok: true, npub }
}

/** NIP-98 events are single-use in spirit; remember recent ids to block replay. */
const seenAuthIds = new Map() // id → expiry
function isReplay(eventId) {
  const now = Date.now()
  for (const [id, exp] of seenAuthIds) if (exp < now) seenAuthIds.delete(id)
  if (seenAuthIds.has(eventId)) return true
  seenAuthIds.set(eventId, now + MAX_WINDOW_S * 2000)
  return false
}

// ── static files ─────────────────────────────────────────────────────────────

const INDEX_HTML = readFileSync(new URL('./index.html', import.meta.url))
const FAVICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

// ── read-only guard ──────────────────────────────────────────────────────────

const READ_FIRST_KEYWORDS = new Set(['select', 'with', 'explain', 'show', 'table', 'values'])

/** Conservative read-only check for the SQL pgweb sends to its execute API. */
function isReadOnly(sql) {
  const s = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/--[^\n]*/g, ' ') // line comments
    .trim()
    .replace(/;\s*$/, '') // a single trailing semicolon is fine
  if (!s) return true
  if (s.includes(';')) return false // no multi-statement batches
  const first = (s.match(/^\(*\s*([a-zA-Z]+)/)?.[1] ?? '').toLowerCase()
  if (!READ_FIRST_KEYWORDS.has(first)) return false
  // WITH can hide a data-modifying CTE; reject writes buried in a compound read.
  if (first === 'with' && /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge)\b/i.test(s)) return false
  return true
}

// ── server ───────────────────────────────────────────────────────────────────

/** @type {import('node:http').RequestListener} */
const server = createServer(async (req, res) => {
  try {
  const cookies = parseCookies(req.headers.cookie)
  const session = cookies[COOKIE_NAME]
    ? sessions.get(cookies[COOKIE_NAME])
    : undefined
  const authed = session && session.expires > Date.now()

  if (req.url === '/favicon.ico') {
    res.writeHead(200, { 'content-type': 'image/png' })
    return res.end(FAVICON)
  }

  if (req.url === '/auth' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      const { authorization } = JSON.parse(body)
      // Accept `Nostr <b64>` or raw b64; normalize once, decode once.
      const normalized = authorization?.startsWith('Nostr ')
        ? authorization
        : `Nostr ${authorization ?? ''}`
      const event = JSON.parse(Buffer.from(normalized.slice(6), 'base64').toString('utf8'))
      const expected = process.env.EXPLORER_URL ?? 'https://pg.stg.formstr.app/'
      const result = await verifyNip98(normalized, 'GET', expected)
      if (!result.ok) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: result.reason }))
      }
      if (isReplay(event.id)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: 'replayed authorization' }))
      }
      const token = randomBytes(32).toString('hex')
      sessions.set(token, {
        npub: nip19.npubEncode(event.pubkey),
        expires: Date.now() + SESSION_TTL_MS,
      })
      res.setHeader('set-cookie', `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: String(error) }))
    }
  }

  if (!authed) {
    // Everything except /auth is the auth page itself.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(INDEX_HTML)
  }

  // Read-only guard. pgweb's own --readonly crashes against the gateway, so we
  // enforce it here: inspect the SQL sent to pgweb's execute endpoints and
  // reject anything that isn't a read. A write to meshdb would replicate out to
  // the providers, so this must never be bypassable.
  let bufferedBody
  if (req.method === 'POST' && /^\/api\/(query|explain|analyze)(\?|$)/.test(req.url)) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const q = new URLSearchParams(raw).get('query') ?? ''
    if (!isReadOnly(q)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'read-only explorer: only SELECT / WITH / EXPLAIN / SHOW queries are allowed' }))
    }
    bufferedBody = raw
  }

  // Authenticated → reverse-proxy to pgweb.
  const target = new URL(PGWEB_URL + req.url)
  const headers = { ...req.headers }
  delete headers.cookie
  delete headers.authorization
  headers.host = new URL(PGWEB_URL).host
  let proxyReq
  try {
    proxyReq = await fetch(target, {
      method: req.method,
      headers,
      body: bufferedBody !== undefined
        ? bufferedBody
        : (['GET', 'HEAD'].includes(req.method) ? undefined : req),
      duplex: 'half',
      redirect: 'manual',
    })
  } catch (error) {
    // pgweb down/crashed: surface 502, never crash the proxy.
    res.writeHead(502, { 'content-type': 'text/plain' })
    return res.end(`explorer backend unavailable: ${error?.cause?.code ?? error}`)
  }
  const outHeaders = new Headers()
  proxyReq.headers.forEach((v, k) => {
    if (!['content-security-policy', 'x-frame-options'].includes(k.toLowerCase())) outHeaders.set(k, v)
  })
  res.writeHead(proxyReq.status, Object.fromEntries(outHeaders))
  if (proxyReq.body) {
    proxyReq.body.pipeTo(res).catch(() => {})
    return
  }
  return res.end()
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    try { console.error('proxy 500:', error); res.end(`proxy error: ${error?.message ?? error}\n${error?.stack ?? ''}`) } catch {}
  }
})

const BIND = process.env.PROXY_BIND ?? '127.0.0.1'
server.listen(PORT, BIND, () => {
  console.log(`pg-explorer proxy on 127.0.0.1:${PORT} → ${PGWEB_URL}`)
})
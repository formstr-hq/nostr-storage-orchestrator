import { useEffect, useState } from "react";
import { useSigner } from "../signer";
import {
  adminAudit,
  adminDeleteBlob,
  adminForceStatus,
  adminGrantPlan,
  adminListBlobs,
  adminListUsers,
  adminStats,
  formatBytes,
  getMe,
  listTiers,
  type AdminUser,
} from "../api";
import type { Blob, ModerationRecord, StorageStats, StorageTier, UserStatus } from "../types";
import { ErrorText, StatusPill, Toast, useToast } from "../ui";

export function AdminPage() {
  const { identities } = useSigner();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [blobs, setBlobs] = useState<Blob[]>([]);
  const [audit, setAudit] = useState<ModerationRecord[]>([]);
  const [tiers, setTiers] = useState<StorageTier[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [userQuery, setUserQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [moderation, setModeration] = useState<{ hash: string; npub: string } | null>(null);
  const [reason, setReason] = useState("");
  const [grantFor, setGrantFor] = useState<AdminUser | null>(null);
  const { message, show } = useToast();

  const refresh = async (status = statusFilter, query = userQuery) => {
    if (!identities) return;
    setError(null);
    try {
      const [statsResult, usersResult, blobsResult, auditResult, tierResult] = await Promise.all([
        adminStats(identities),
        adminListUsers(identities, { status: status || undefined, query: query || undefined }),
        adminListBlobs(identities),
        adminAudit(identities),
        listTiers(),
      ]);
      setStats(statsResult);
      setUsers(usersResult.items);
      setBlobs(blobsResult.items);
      setAudit(auditResult.items);
      setTiers(tierResult);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 403) setAllowed(false);
      else setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!identities) return;
    getMe(identities)
      .then((me) => {
        const isAdmin = me.role === "admin";
        setAllowed(isAdmin);
        if (isAdmin) void refresh();
      })
      .catch(() => setAllowed(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities]);

  const forceStatus = async (user: AdminUser, status: UserStatus) => {
    if (!identities) return;
    try {
      await adminForceStatus(identities, user.npub, status);
      show(`Status set to ${status}`);
      void refresh();
    } catch (err) {
      show((err as Error).message);
    }
  };

  const confirmModeration = async () => {
    if (!identities || !moderation || !reason.trim()) return;
    try {
      await adminDeleteBlob(identities, moderation.hash, reason.trim());
      setModeration(null);
      setReason("");
      show("Blob deleted on all replicas — owner notified");
      void refresh();
    } catch (err) {
      show((err as Error).message);
    }
  };

  if (allowed === null) return <div className="muted">Checking admin access…</div>;
  if (!allowed) {
    return (
      <div className="card" style={{ padding: 22 }}>
        <h1 className="heading">Admin</h1>
        <p className="sub">
          Your key is not an admin. Admin access comes from{" "}
          <span className="mono">formstr-backend.users.role</span>.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="section-head">
        <div className="eyebrow">Unified admin</div>
        <h1 className="heading">Admin console</h1>
        <p className="sub">
          All users, all blobs, lifecycle and moderation. Gated by{" "}
          <span className="mono">users.role = admin</span> in formstr-backend.
        </p>
      </div>
      <div className="admin-kicker">
        <span className="dot" />
        Signed in as admin · {identities?.npub.slice(0, 12)}…
      </div>

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
        <div className="card stat">
          <div className="label">Total users</div>
          <div className="value">{stats?.users ?? "—"}</div>
        </div>
        <div className="card stat">
          <div className="label">Storage in use</div>
          <div className="value">{stats ? formatBytes(stats.bytes) : "—"}</div>
          <div className="delta">{stats?.blobs ?? 0} blobs</div>
        </div>
        <div className="card stat">
          <div className="label">Lifecycle attention</div>
          <div className="value" style={{ color: "var(--warn)" }}>
            {stats
              ? (stats.byStatus["GRACE"] ?? 0) +
                (stats.byStatus["WRITE_BLOCKED"] ?? 0) +
                (stats.byStatus["READ_BLOCKED"] ?? 0)
              : "—"}
          </div>
          <div className="delta">
            {stats
              ? `${stats.byStatus["GRACE"] ?? 0} grace · ${
                  stats.byStatus["WRITE_BLOCKED"] ?? 0
                } write · ${stats.byStatus["READ_BLOCKED"] ?? 0} read`
              : ""}
          </div>
        </div>
      </div>

      <div className="section-title">Users</div>
      <div className="filter-row">
        <input
          type="text"
          placeholder="Search by npub…"
          value={userQuery}
          onChange={(event) => setUserQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void refresh(statusFilter, userQuery)}
        />
        <select
          value={statusFilter}
          onChange={(event) => {
            setStatusFilter(event.target.value);
            void refresh(event.target.value, userQuery);
          }}
        >
          <option value="">All statuses</option>
          {["UNPAID", "ACTIVE", "GRACE", "WRITE_BLOCKED", "READ_BLOCKED", "CLOSED"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn ghost small" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <div className="card table-wrap" style={{ marginBottom: 22 }}>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Plan</th>
              <th>Used / allowance</th>
              <th>Status</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.npub}>
                <td className="npub-chip">
                  {user.npub.slice(0, 10)}…{user.npub.slice(-5)}
                </td>
                <td>{user.plan ?? "—"}</td>
                <td className="mono">
                  {formatBytes(user.usedStorage)} / {formatBytes(user.storageBytes)}
                </td>
                <td>
                  <StatusPill status={user.status} />
                </td>
                <td>
                  {user.planExpiresAt ? new Date(user.planExpiresAt).toLocaleDateString() : "—"}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className="btn ghost small" onClick={() => setGrantFor(user)}>
                      Grant plan
                    </button>
                    <select
                      value=""
                      onChange={(event) =>
                        event.target.value && void forceStatus(user, event.target.value as UserStatus)
                      }
                      style={{ fontSize: "0.75rem" }}
                    >
                      <option value="">Force status…</option>
                      {["ACTIVE", "GRACE", "WRITE_BLOCKED", "READ_BLOCKED", "CLOSED"].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title">Blobs</div>
      <div className="card table-wrap" style={{ marginBottom: 22 }}>
        <table>
          <thead>
            <tr>
              <th>Hash</th>
              <th>Owner</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {blobs.map((blob) => (
              <tr key={blob.hash}>
                <td className="npub-chip">{blob.hash.slice(0, 14)}…</td>
                <td className="npub-chip">{blob.npub.slice(0, 10)}…</td>
                <td className="mono">{formatBytes(blob.size)}</td>
                <td>{new Date(blob.createdAt).toLocaleDateString()}</td>
                <td>
                  <button
                    className="btn small danger"
                    onClick={() => setModeration({ hash: blob.hash, npub: blob.npub })}
                  >
                    Delete &amp; notify
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title">Moderation audit log</div>
      <div className="card" style={{ padding: 18 }}>
        <div className="audit-log">
          {audit.map((action) => (
            <div className="audit-item" key={action.id}>
              <div className="audit-ico">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
                </svg>
              </div>
              <div>
                <div className="audit-title">
                  Deleted {action.hash.slice(0, 12)}… — {action.reason}
                </div>
                <div className="audit-meta">
                  {action.npub.slice(0, 10)}… · by admin {action.adminNpub.slice(0, 10)}… ·{" "}
                  {new Date(action.createdAt).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
          {audit.length === 0 && <div className="muted center">No moderation actions yet.</div>}
        </div>
      </div>

      <ErrorText>{error}</ErrorText>

      {moderation && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && setModeration(null)}>
          <div className="modal">
            <button className="close" onClick={() => setModeration(null)} aria-label="Close">
              ✕
            </button>
            <h3>Delete blob &amp; notify owner</h3>
            <div className="modal-sub">
              Deletes bytes on every replica, removes the row, and writes a moderation audit entry.
            </div>
            <div className="mod-hash" style={{ marginTop: 14 }}>
              <span>{moderation.hash.slice(0, 20)}…</span>
            </div>
            <div className="mod-field">
              <label>Reason (required, sent to owner)</label>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
            <button
              className="btn danger"
              style={{ width: "100%", justifyContent: "center", marginTop: 16 }}
              disabled={!reason.trim()}
              onClick={() => void confirmModeration()}
            >
              Confirm deletion
            </button>
          </div>
        </div>
      )}

      {grantFor && (
        <div className="modal-backdrop" onClick={(event) => event.target === event.currentTarget && setGrantFor(null)}>
          <div className="modal">
            <button className="close" onClick={() => setGrantFor(null)} aria-label="Close">
              ✕
            </button>
            <h3>Grant plan</h3>
            <div className="modal-sub">
              Admin grants are recorded with source=admin. Force applies the plan even while one is live.
            </div>
            <div className="mod-field">
              {tiers.map((tier) => (
                <button
                  key={tier.id}
                  className="btn ghost small"
                  style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}
                  onClick={async () => {
                    if (!identities) return;
                    try {
                      await adminGrantPlan(identities, grantFor.npub, {
                        plan: tier.id,
                        durationDays: tier.durationDays,
                        storageBytes: tier.storageBytes,
                        mode: "upgrade",
                        force: true,
                        termsVersion: "admin",
                      });
                      setGrantFor(null);
                      show(`Granted ${tier.name}`);
                      void refresh();
                    } catch (err) {
                      show((err as Error).message);
                    }
                  }}
                >
                  <span>{tier.name}</span>
                  <span className="muted small">
                    {formatBytes(tier.storageBytes)} · {tier.durationDays}d
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <Toast message={message} />
    </>
  );
}

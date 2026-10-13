import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSigner } from "../signer";
import {
  deleteBlob,
  formatBytes,
  getStorage,
  getStorageSubscription,
  listBlobs,
  listNotifications,
  myInvoices,
} from "../api";
import type {
  Account,
  Blob,
  InvoiceRecord,
  NotificationRecord,
  StorageSubscription,
} from "../types";
import { ErrorText, StatusPill, Toast, useToast } from "../ui";

type Tab = "blobs" | "billing" | "notifs";

function countdown(iso: string | null): { big: string; label: string } {
  if (!iso) return { big: "—", label: "no active plan" };
  const target = new Date(iso).getTime();
  const diff = target - Date.now();
  if (diff <= 0) return { big: "expired", label: new Date(iso).toUTCString() };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  return { big: `${days}d ${hours}h`, label: new Date(iso).toUTCString() };
}

export function DashboardPage() {
  const { identities } = useSigner();
  const [account, setAccount] = useState<Account | null>(null);
  const [subscription, setSubscription] = useState<StorageSubscription | null>(null);
  const [blobs, setBlobs] = useState<Blob[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [tab, setTab] = useState<Tab>("blobs");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { message, show } = useToast();

  const refresh = async () => {
    if (!identities) return;
    setLoading(true);
    setError(null);
    try {
      const [accountResult, blobResult] = await Promise.all([
        getStorage(identities),
        listBlobs(identities),
      ]);
      setAccount(accountResult);
      setBlobs(blobResult.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();

    if (!identities) return;
    getStorageSubscription(identities).then(setSubscription).catch(() => undefined);
    myInvoices(identities).then(setInvoices).catch(() => undefined);
    listNotifications(identities).then((page) => setNotifications(page.items)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identities]);

  const remove = async (hash: string) => {
    if (!identities) return;
    try {
      await deleteBlob(identities, hash);
      setBlobs((current) => current.filter((blob) => blob.hash !== hash));
      show("Blob deleted — allowance freed up");
      void refresh();
    } catch (err) {
      show((err as Error).message);
    }
  };

  if (!account) {
    return (
      <>
        <div className="section-head">
          <div className="eyebrow">Your account</div>
          <h1 className="heading">Dashboard</h1>
        </div>
        {loading ? <div className="muted">Loading your account…</div> : <ErrorText>{error}</ErrorText>}
      </>
    );
  }

  const used = Number(account.usedStorage);
  const allowance = account.storageBytes === null ? null : Number(account.storageBytes);
  const pct = allowance ? Math.round((used / allowance) * 100) : 0;
  const expiry = countdown(account.planExpiresAt);
  const overQuota = allowance !== null && used > allowance;
  const hasPlan = account.planExpiresAt !== null && new Date(account.planExpiresAt).getTime() > Date.now();

  return (
    <>
      <div className="section-head">
        <div className="eyebrow">Your account</div>
        <h1 className="heading">Dashboard</h1>
        <p className="sub">
          Everything you've stored on Blossom, how much room you have left, and
          when your plan renews.
        </p>
      </div>

      {account.status !== "ACTIVE" && (
        <div className="banner">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
          <div>
            <div className="btitle">
              {account.status === "UNPAID"
                ? "No active plan — uploads are disabled"
                : overQuota
                  ? "You're over your storage allowance"
                  : `Account status: ${account.status.replace("_", " ").toLowerCase()}`}
            </div>
            <div className="btext">
              {account.status === "UNPAID"
                ? "Purchase a plan to start storing."
                : overQuota
                  ? `Using ${formatBytes(account.usedStorage)} of ${formatBytes(account.storageBytes)}. Delete blobs below or upgrade.`
                  : `Reads: ${account.canRead ? "allowed" : "blocked"}. Uploads: ${
                      account.canUpload ? "allowed" : "blocked"
                    }.`}
              {account.purgeAt && ` Scheduled purge: ${new Date(account.purgeAt).toUTCString()}.`}
            </div>
          </div>
        </div>
      )}

      <div className="console-top">
        <div className="card plan-card">
          <div className="row1">
            <div>
              <div className="plan-name">{subscription?.plan ? `${subscription.plan.name} plan` : "No plan"}</div>
              <div className="plan-meta">Renew or change plans from Pricing</div>
            </div>
            <StatusPill status={account.status} />
          </div>
          <div className="storage-row">
            <div className="labels">
              <span>
                <strong style={{ color: "var(--ink)", fontFamily: "var(--font-mono)" }}>
                  {formatBytes(account.usedStorage)}
                </strong>{" "}
                used of {formatBytes(account.storageBytes)}
              </span>
              <span>{allowance ? `${pct}%` : ""}</span>
            </div>
            <div className="bar-track">
              <div
                className={`bar-fill${overQuota ? " over" : ""}`}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
          </div>
          <div className="actions">
            <Link className="btn primary" to="/pricing">
              {hasPlan ? "Renew or upgrade" : "Choose a plan"}
            </Link>
            <button className="btn ghost" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </div>
        <div className="card countdown-ring-card">
          <div className="eyebrow">Plan expires</div>
          <div className="n">{expiry.big}</div>
          <div className="l">{expiry.label}</div>
        </div>
      </div>

      <div className="tabs-inline">
        <button className={tab === "blobs" ? "active" : ""} onClick={() => setTab("blobs")}>
          Blobs
        </button>
        <button className={tab === "billing" ? "active" : ""} onClick={() => setTab("billing")}>
          Billing
        </button>
        <button className={tab === "notifs" ? "active" : ""} onClick={() => setTab("notifs")}>
          Notifications
        </button>
      </div>

      {tab === "blobs" && (
        <div className="card" style={{ padding: 18 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Blob</th>
                  <th>Size</th>
                  <th>Uploaded</th>
                  <th>Hash</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {blobs.map((blob) => (
                  <tr key={blob.hash}>
                    <td>
                      <div className="npub-chip">{blob.hash.slice(0, 12)}…</div>
                    </td>
                    <td className="mono">{formatBytes(blob.size)}</td>
                    <td>{new Date(blob.createdAt).toLocaleString()}</td>
                    <td className="npub-chip">{blob.hash.slice(0, 8)}…{blob.hash.slice(-4)}</td>
                    <td>
                      <button className="btn small danger" onClick={() => void remove(blob.hash)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {blobs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="muted center">
                      No blobs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "billing" && (
        <div className="card" style={{ padding: 18 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Product</th>
                  <th>Invoice</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{new Date(invoice.created_at).toLocaleDateString()}</td>
                    <td>{invoice.product}</td>
                    <td className="npub-chip">{invoice.paymentHash.slice(0, 12)}…</td>
                    <td>
                      <span className="pill good">
                        <span className="dot" />
                        Paid
                      </span>
                    </td>
                  </tr>
                ))}
                {invoices.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted center">
                      No invoices yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "notifs" && (
        <div className="card" style={{ padding: 18 }}>
          {notifications.map((notification) => (
            <div className="notif-item" key={notification.id}>
              <div className={`notif-ico ${notification.kind.startsWith("expiry") || notification.kind.includes("warning") ? "wn" : "ch"}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <div>
                <div className="ntitle">{notification.kind.replace(/_/g, " ")}</div>
                <div className="nmeta">
                  {new Date(notification.sentAt).toLocaleString()} · via {notification.channel}
                </div>
              </div>
            </div>
          ))}
          {notifications.length === 0 && <div className="muted center">No notifications yet.</div>}
        </div>
      )}

      <Toast message={message} />
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Link } from "react-router-dom";
import { useSigner } from "../signer";
import {
  BACKEND_URL,
  formatBytes,
  generateStorageInvoice,
  getStorage,
  getStorageSubscription,
  listTiers,
  watchInvoice,
} from "../api";
import { TERMS_VERSION } from "../legal";
import type { Account, StorageSubscription, StorageTier } from "../types";
import { ErrorText, Spinner, Toast, useToast } from "../ui";

type Mode = "extend" | "upgrade" | "downgrade";

// The current plan comes from formstr-backend's catalog; the live expiry and
// allowance come from the orchestrator's /storage view.
function modeFor(
  tier: StorageTier,
  account: Account | null,
  subscription: StorageSubscription | null,
): Mode {
  if (!account?.planExpiresAt || !subscription?.plan) return "extend";
  const live = new Date(account.planExpiresAt).getTime() > Date.now();
  if (!live) return "extend";
  return tier.rank > subscription.plan.rank ? "upgrade" : "extend";
}

export function PricingPage() {
  const { identities, connect } = useSigner();
  const [tiers, setTiers] = useState<StorageTier[]>([]);
  const [account, setAccount] = useState<Account | null>(null);
  const [subscription, setSubscription] = useState<StorageSubscription | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [terms, setTerms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<{
    invoice: string;
    paymentHash: string;
    amount: number;
  } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);
  const { message, show } = useToast();
  const stopWatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    listTiers()
      .then((result) => {
        setTiers(result);
        const firstPurchasable = result.find((tier) => !tier.comingSoon);
        if (firstPurchasable) setSelected(firstPurchasable.id);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    if (!identities) return;
    getStorage(identities)
      .then(setAccount)
      .catch(() => undefined);
    getStorageSubscription(identities)
      .then(setSubscription)
      .catch(() => undefined);
  }, [identities]);

  const currentRank = useMemo(() => {
    if (!account?.planExpiresAt || !subscription?.plan) return -1;
    const live = new Date(account.planExpiresAt).getTime() > Date.now();
    if (!live) return -1;
    return subscription.plan.rank;
  }, [account, subscription]);

  // Terms acceptance/versioning is owned by formstr-backend; the orchestrator
  // no longer stores it. Accept per session and let the backend record it.
  const acceptedAt = null;
  const accepted = acceptedAt !== null || terms;

  const chosen = tiers.find((t) => t.id === selected) ?? null;
  const mode: Mode | null = chosen && account ? modeFor(chosen, account, subscription) : null;
  const blockedDowngrade =
    chosen !== null &&
    account !== null &&
    currentRank >= 0 &&
    chosen.rank < currentRank;
  const wouldEnterGrace =
    chosen !== null &&
    account !== null &&
    account.usedStorage !== null &&
    chosen.storageBytes < Number(account.usedStorage);

  const purchasableTiers = useMemo(
    () => tiers.filter((tier) => !tier.comingSoon),
    [tiers],
  );
  const topPurchasableRank =
    purchasableTiers.length > 1
      ? Math.max(...purchasableTiers.map((tier) => tier.rank))
      : null;

  const buy = async () => {
    if (!identities || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const result = await generateStorageInvoice(identities, {
        plan: chosen.id,
        termsAccepted: accepted,
        termsVersion: TERMS_VERSION,
      });
      setInvoice(result);
      setPaid(false);
      const dataUrl = await QRCode.toDataURL(result.invoice.toUpperCase(), {
        margin: 1,
      });
      setQr(dataUrl);
      stopWatch.current?.();
      stopWatch.current = watchInvoice(
        BACKEND_URL,
        result.paymentHash,
        () => {
          setPaid(true);
          show("Payment received — your plan is active");
        },
        () => undefined,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const closeInvoice = () => {
    stopWatch.current?.();
    stopWatch.current = null;
    setInvoice(null);
    setQr(null);
    if (paid && identities)
      getStorage(identities)
        .then(setAccount)
        .catch(() => undefined);
  };

  return (
    <>
      <div className="section-head">
        <div className="eyebrow">Pricing</div>
        <h1 className="heading">Choose a plan</h1>
        <p className="sub">
          Storage allowance and plan time only — no per-file limits, no free
          tier. Renewing adds days; upgrading applies immediately and carries
          remaining days over.
        </p>
      </div>

      {!identities && (
        <div className="banner">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          </svg>
          <div>
            <div className="btitle">Connect a signer to purchase</div>
            <div className="btext">Plans are tied to your Nostr key.</div>
          </div>
        </div>
      )}

      <div className="plans-grid">
        {tiers.map((tier) => {
          const isBlocked =
            account !== null &&
            currentRank >= 0 &&
            tier.rank < currentRank;
          const isSelectable = !tier.comingSoon && !isBlocked;
          return (
            <div
              key={tier.id}
              className={`card plan-option${selected === tier.id ? " selected" : ""}${
                isSelectable ? "" : " disabled"
              }`}
              onClick={() => isSelectable && setSelected(tier.id)}
            >
              {tier.comingSoon ? (
                <div className="tier-tag">Coming soon</div>
              ) : (
                tier.rank === topPurchasableRank && (
                  <div className="tier-tag">Most storage</div>
                )
              )}
              <h3>{tier.name}</h3>
              <div className="price">
                {tier.priceSats.toLocaleString()}{" "}
                <span>sats / {tier.durationDays} days</span>
              </div>
              <ul>
                <li>
                  <Check /> {formatBytes(tier.storageBytes)} total storage
                </li>
                {tier.features.map((feature) => (
                  <li key={feature}>
                    <Check /> {feature}
                  </li>
                ))}
                {tier.comingSoon && <li>Not purchasable yet — coming soon</li>}
                {isBlocked && (
                  <li>Unavailable while your current plan is live</li>
                )}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="card purchase-flow">
        <div className="flow-steps">
          <div className={`flow-step${identities ? " done" : " current"}`}>
            <span className="num">{identities ? "✓" : "1"}</span>Connect signer
          </div>
          <div
            className={`flow-step${accepted ? " done" : identities ? " current" : ""}`}
          >
            <span className="num">{accepted ? "✓" : "2"}</span>Accept terms
          </div>
          <div
            className={`flow-step${paid ? " done" : accepted ? " current" : ""}`}
          >
            <span className="num">{paid ? "✓" : "3"}</span>Pay invoice
          </div>
        </div>

        <div className="connect-row">
          {identities ? (
            <div className="signer-chip">
              <Check /> Signer connected{" "}
              <span className="npub">{identities.npub.slice(0, 12)}…</span>
            </div>
          ) : (
            <button className="btn ghost" onClick={() => void connect()}>
              Connect signer
            </button>
          )}
          {chosen && mode && (
            <span className="small muted">
              Mode:{" "}
              <strong style={{ color: "var(--ink)" }}>
                {blockedDowngrade ? "Downgrade after expiry" : mode}
              </strong>
              {mode === "upgrade" &&
                " (immediate, remaining days carried over)"}
              {mode === "extend" && " (same tier, adds days)"}
            </span>
          )}
        </div>

        <div className="tnc-row">
          {acceptedAt ? (
            <label>
              You accepted the{" "}
              <Link to="/legal/terms">Terms &amp; Conditions</Link> and{" "}
              <Link to="/legal/privacy">Privacy Policy</Link> (version{" "}
              {TERMS_VERSION}) on {new Date(acceptedAt).toLocaleDateString()}.
            </label>
          ) : (
            <>
              <input
                type="checkbox"
                id="tnc"
                checked={terms}
                onChange={(event) => setTerms(event.target.checked)}
              />
              <label htmlFor="tnc">
                I accept the{" "}
                <Link to="/legal/terms">Terms &amp; Conditions</Link> and{" "}
                <Link to="/legal/privacy">Privacy Policy</Link> (version{" "}
                {TERMS_VERSION}). Required before any purchase.
              </label>
            </>
          )}
        </div>
        {wouldEnterGrace && (
          <div className="banner" style={{ marginTop: 14, marginBottom: 0 }}>
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
            <div>
              <div className="btitle">
                This plan is smaller than your current usage
              </div>
              <div className="btext">
                You are using {formatBytes(account?.usedStorage)}. Purchasing
                this plan starts a grace period; you will need to delete blobs
                down to {formatBytes(chosen?.storageBytes)} or upgrade before
                uploads are blocked.
              </div>
            </div>
          </div>
        )}

        <div className="checkout-summary">
          <div className="total">
            {chosen ? `${chosen.priceSats.toLocaleString()} sats` : "—"}{" "}
            <span>
              {chosen
                ? `${chosen.name} · ${chosen.durationDays} days${
                    mode === "upgrade"
                      ? " · upgrade, remaining days carried over"
                      : ""
                  }`
                : "Select a plan"}
            </span>
          </div>
          <button
            className="btn primary"
            disabled={!identities || !chosen || !accepted || busy}
            onClick={() => void buy()}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
            </svg>
            {busy ? "Generating…" : "Generate invoice"}
          </button>
        </div>
        <ErrorText>{error}</ErrorText>
      </div>

      {invoice && (
        <div
          className="modal-backdrop"
          onClick={(event) =>
            event.target === event.currentTarget && closeInvoice()
          }
        >
          <div className="modal">
            <button className="close" onClick={closeInvoice} aria-label="Close">
              ✕
            </button>
            {paid ? (
              <div className="center">
                <div className="paid-check">
                  <svg
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                </div>
                <h3>Payment received</h3>
                <div className="modal-sub">
                  {chosen?.name} is active immediately. Your dashboard now shows{" "}
                  {formatBytes(chosen?.storageBytes)}.
                </div>
                <Link
                  className="btn primary"
                  style={{
                    width: "100%",
                    justifyContent: "center",
                    marginTop: 18,
                  }}
                  to="/dashboard"
                  onClick={closeInvoice}
                >
                  Go to dashboard
                </Link>
              </div>
            ) : (
              <>
                <h3>Pay with Lightning</h3>
                <div className="modal-sub">
                  {invoice.amount.toLocaleString()} sats · {chosen?.name} plan
                </div>
                {qr && (
                  <img className="qr-box" src={qr} alt="Lightning invoice QR" />
                )}
                <div className="invoice-string">{invoice.invoice}</div>
                <div className="copy-row">
                  <button
                    className="btn ghost small"
                    style={{ flex: 1 }}
                    onClick={() => {
                      void navigator.clipboard.writeText(invoice.invoice);
                      show("Invoice copied");
                    }}
                  >
                    Copy invoice
                  </button>
                  <a
                    className="btn ghost small"
                    style={{ flex: 1, justifyContent: "center" }}
                    href={`lightning:${invoice.invoice}`}
                  >
                    Open in wallet
                  </a>
                </div>
                <Spinner label="Waiting for payment…" />
              </>
            )}
          </div>
        </div>
      )}

      <Toast message={message} />
    </>
  );
}

function Check() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

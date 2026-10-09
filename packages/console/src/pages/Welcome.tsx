import { Link } from "react-router-dom";
import { useSigner } from "../signer";

const FAQ = [
  {
    q: "What is Blossom?",
    a: "Blossom is an HTTP storage protocol for Nostr. Your app stores blobs on this server, addressed by their sha256 hash, and anyone with the hash can fetch them.",
  },
  {
    q: "How is it paid for?",
    a: "Plans are sold in sats over Lightning. Each plan grants a total storage allowance and a duration. There is no free tier — purchase is required before any upload.",
  },
  {
    q: "What happens when my plan expires?",
    a: "You get a grace period, then uploads are blocked, then reads are blocked, and finally your blobs are purged. You are warned by DM and email at every step.",
  },
  {
    q: "Can I renew or upgrade?",
    a: "Renewing the same plan adds its days to your expiry. Upgrading applies the larger allowance immediately and carries your remaining days over.",
  },
  {
    q: "How do I connect?",
    a: "Use any NIP-07 browser extension (nos2x, Alby). The console signs every request locally; your key never leaves your browser.",
  },
];

export function WelcomePage() {
  const { identities, connect } = useSigner();
  return (
    <>
      <div className="section-head">
        <div className="eyebrow">Self-serve Nostr storage</div>
        <h1 className="heading">Store on Blossom, pay in sats</h1>
        <p className="sub">
          A paid Blossom server with a transparent storage allowance, an
          owner dashboard, and expiry reminders by DM and email.
        </p>
      </div>

      <div className="card feature-hero">
        <div className="grid cols-3">
          <div>
            <div className="eyebrow">Total allowance</div>
            <p className="mt muted small">
              Plans sell one thing: total storage and time. No per-file limits
              and no hidden replication tiers.
            </p>
          </div>
          <div>
            <div className="eyebrow">Your blobs</div>
            <p className="mt muted small">
              See every blob you own, when it was uploaded, its size, and how
              much room is left — and delete to free space instantly.
            </p>
          </div>
          <div>
            <div className="eyebrow">No surprises</div>
            <p className="mt muted small">
              Clear lifecycle: grace, uploads blocked, reads blocked, purge.
              Every stage is announced ahead of time.
            </p>
          </div>
        </div>
        <div className="checkout-summary">
          <div className="total">
            Plans from 5,000 sats <span>30-day plans · renewals add days</span>
          </div>
          {identities ? (
            <Link className="btn primary" to="/pricing">
              Choose a plan
            </Link>
          ) : (
            <button className="btn primary" onClick={() => void connect()}>
              Connect signer to start
            </button>
          )}
        </div>
      </div>

      <div className="card" style={{ padding: "10px 22px" }}>
        {FAQ.map((item) => (
          <div className="faq-item" key={item.q}>
            <h3>{item.q}</h3>
            <p>{item.a}</p>
          </div>
        ))}
      </div>

      <footer className="mt muted small">
        <Link to="/legal/terms">Terms &amp; Conditions</Link> ·{" "}
        <Link to="/legal/privacy">Privacy Policy</Link>
      </footer>
    </>
  );
}

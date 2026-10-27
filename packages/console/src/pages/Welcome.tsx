import { Link } from "react-router-dom";
import { useSigner } from "../signer";

const FAQ = [
  {
    q: "How does Formstr Storage work?",
    a: "Formstr Storage is based on the blossom protocol. This enables us to be compatible with a number of clients which implement the blossom protocol. It also means that Formstr Storage is api first. You can programmatically access your data through AI or apis.",
  },
  {
    q: "What is Blossom?",
    a: "Blossom is an HTTP storage protocol for Nostr. Your app stores blobs on this server, addressed by their sha256 hash, and anyone with the hash can fetch them. The spec of the protocol can be found here: <a target='_blank' href='https://github.com/hzrd149/blossom'>Blossom Protocol</a>",
  },
  {
    q: "How is it paid for?",
    a: "Plans are sold in Bitcoin Sats over Lightning. Each plan grants a total storage allowance and a duration. There is no free tier, meaning purchase is required before any upload.",
  },
  {
    q: "What happens when my plan expires?",
    a: "Your account will be gracefully degraded. You will get a grace period, then uploads are blocked, then reads are blocked, and finally your blobs are purged. Please contact us at hello@formstr.app if you are having any issues.",
  },
  {
    q: "Will I need to make an account for purchasing?",
    a: "We do not require your email, name or any KYC details. However, you will need your nostr identity for purchasing a storage plan. The identity can be generated instantaneously and we only store the public key on our side. Any future uploads which are signed by you are attributed to your storage quota. You can go to the Dashboard any time to see or delete your uploaded files",
  },
  {
    q: "Can I renew or upgrade?",
    a: "Renewing the same plan adds its days to your expiry. Upgrading applies the larger allowance immediately and carries your remaining days over.",
  },
  {
    q: "How do I sign in?",
    a: "Use any NIP-07 browser extension (nos2x, Alby).",
  },
];

export function WelcomePage() {
  const { identities, connect } = useSigner();
  return (
    <>
      <div className="section-head">
        <div className="eyebrow">Self-serve Blossom based storage</div>
        <h1 className="heading">Formstr Storage (Beta) </h1>
        <p className="sub">
          This is an experimental service. We are still working on making it stable. There may be outages or data loss. Please contact us if you have paid and are encountering any issues.
        </p>
      </div>

      <div className="card feature-hero">
        <div className="grid cols-3">
          <div>
            <div className="eyebrow">How does it work?</div>
            <p className="mt muted small">
              You can buy a plan. You will be granted a storage quota and a time. Files can be up to 500 MB each. Please note that this service is under rapid development and is in beta currently. There is a possibility of data loss or outages. Please use this keeping this in mind
            </p>
          </div>
          <div>
            <div className="eyebrow">Storage management</div>
            <p className="mt muted small">
              See every upload you own, when it was uploaded, its size, and how
              much room is left - and delete to free space instantly.
            </p>
          </div>
          <div>
            <div className="eyebrow">Drive</div>
            <p className="mt muted small">
              This is a console for buying storage plans and managing storage. You can use <a href="https://drive.formstr.app" target="_blank">Formstr Drive</a> to upload, and manage you files. You can choose this blossom server in drive to use this storage.
            </p>
          </div>
        </div>
        <div className="checkout-summary">
          <div className="total">
            Plans start from 20,000 sats <span>365-day plans</span>
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
            <p dangerouslySetInnerHTML={{__html:item.a}} />
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

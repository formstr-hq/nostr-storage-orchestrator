import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { connectSigner, shortNpub, type Identities } from "./nostr";

interface SignerContextValue {
  identities: Identities | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const SignerContext = createContext<SignerContextValue | null>(null);

export function SignerProvider({ children }: { children: ReactNode }) {
  const [identities, setIdentities] = useState<Identities | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("blossom-connected");
    if (stored === "1" && window.nostr) {
      void connectSigner().then(setIdentities).catch(() => undefined);
    }
  }, []);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const result = await connectSigner();
      setIdentities(result);
      localStorage.setItem("blossom-connected", "1");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setIdentities(null);
    localStorage.removeItem("blossom-connected");
  }, []);

  const value = useMemo(
    () => ({ identities, connecting, error, connect, disconnect }),
    [identities, connecting, error, connect, disconnect],
  );

  return <SignerContext.Provider value={value}>{children}</SignerContext.Provider>;
}

export function useSigner(): SignerContextValue {
  const context = useContext(SignerContext);
  if (!context) throw new Error("useSigner must be used inside SignerProvider");
  return context;
}

export function SignerChip() {
  const { identities, connecting, connect, disconnect } = useSigner();
  if (connecting) return <span className="muted small">Connecting…</span>;
  if (!identities) {
    return (
      <button className="btn ghost small" onClick={() => void connect()}>
        Connect signer
      </button>
    );
  }
  return (
    <button className="signer-chip" onClick={disconnect} title="Disconnect">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M20 6 9 17l-5-5" />
      </svg>
      {shortNpub(identities.npub)}
    </button>
  );
}

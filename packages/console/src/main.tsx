import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { SignerProvider, SignerChip, useSigner } from "./signer";
import { WelcomePage } from "./pages/Welcome";
import { PricingPage } from "./pages/Pricing";
import { DashboardPage } from "./pages/Dashboard";
import { LegalPage } from "./pages/Legal";
import "./styles.css";

function ThemeToggle() {
  useEffect(() => {
    const root = document.documentElement;
    const stored = localStorage.getItem("blossom-theme");
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", stored ?? (prefersDark ? "dark" : "light"));
  }, []);

  const toggle = () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("blossom-theme", next);
  };

  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Toggle dark mode" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </svg>
    </button>
  );
}

function Masthead() {
  return (
    <header className="masthead">
      <NavLink to="/" className="brand" style={{ textDecoration: "none" }}>
        <div className="mark">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M12 20V6" stroke="#F4F4F3" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M5 9.5 12 3l7 6.5" stroke="#F4F4F3" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8 13.5h8" stroke="#F4F4F3" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
        <div>
          <div className="name">Blossom</div>
          <div className="tag">storage.formstr.app</div>
        </div>
      </NavLink>
      <div className="masthead-right">
        <nav className="nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Home
          </NavLink>
          <NavLink to="/pricing" className={({ isActive }) => (isActive ? "active" : "")}>
            Pricing
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : "")}>
            Dashboard
          </NavLink>
        </nav>
        <SignerChip />
        <ThemeToggle />
      </div>
    </header>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { identities } = useSigner();
  if (!identities) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <StrictMode>
      <SignerProvider>
        <BrowserRouter>
          <div className="shell">
            <Masthead />
            <Routes>
              <Route path="/" element={<WelcomePage />} />
              <Route path="/pricing" element={<PricingPage />} />
              <Route
                path="/dashboard"
                element={
                  <Protected>
                    <DashboardPage />
                  </Protected>
                }
              />
              <Route path="/legal/:doc" element={<LegalPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </BrowserRouter>
      </SignerProvider>
    </StrictMode>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
createRoot(container).render(<App />);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/theme.css";

const mount = document.querySelector<HTMLDivElement>("#app");
if (!mount) throw new Error("Application mount point is missing");

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * One `src/` drives every target. `VITE_TARGET` selects which platform adapter
 * the `#platform` import resolves to, so the web bundle never pulls in
 * `@tauri-apps/api` and the Tauri bundle never pulls in the wasm module.
 *
 * - `web`   (default) — browser build, crypto via `crates/admin-wasm` in a worker
 * - `tauri`           — Linux / Android / Windows / macOS, crypto via Rust IPC
 */
const target = process.env.VITE_TARGET === "tauri" ? "tauri" : "web";
const isAndroid = process.env.TAURI_ENV_PLATFORM === "android";

const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The web build has no Tauri to supply a CSP header, so it carries its own.
 * Injected only for `web`: Tauri serves a stricter `connect-src ipc:` policy of
 * its own, and two policies intersect — a meta tag here would break IPC.
 *
 * `'wasm-unsafe-eval'` is what lets the worker instantiate `admin-wasm`;
 * `connect-src https:` covers arbitrary operator-chosen hosts, which
 * `normalize_url` already restricts to HTTPS.
 */
const webCsp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https:",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "web-csp",
      transformIndexHtml: (html: string) =>
        target === "web"
          ? html.replace(
              "<!--web-csp-->",
              `<meta http-equiv="Content-Security-Policy" content="${webCsp}" />`,
            )
          : html,
    },
  ],
  clearScreen: false,
  resolve: {
    alias: {
      "#platform": resolve(`./src/platform/${target}.ts`),
    },
  },
  define: {
    __TARGET__: JSON.stringify(target),
  },
  server: {
    host: isAndroid ? "0.0.0.0" : "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    outDir: target === "tauri" ? "dist" : "dist-web",
    emptyOutDir: true,
    // Tauri pins the WebView engine per platform; the web build targets
    // browsers that support WebAssembly and module workers.
    target:
      target === "tauri"
        ? process.env.TAURI_ENV_PLATFORM === "windows"
          ? "chrome105"
          : "safari13"
        : "es2022",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});

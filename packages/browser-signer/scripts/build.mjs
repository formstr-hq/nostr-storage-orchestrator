/**
 * Builds the extension into packages/browser-signer/extension/ — a plain
 * unpacked-extension directory loadable via chrome://extensions → Load
 * unpacked. No bundler magic: esbuild for the TS entry points, static
 * manifest/popup.html copied as-is.
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "extension");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  target: "chrome116",
  platform: "browser",
  minify: false,
  sourcemap: false,
  logLevel: "info",
};

// Service worker (module worker per manifest).
await build({
  ...common,
  entryPoints: [path.join(root, "src/background.ts")],
  outfile: path.join(out, "background.js"),
});

// Popup (the html references ./popup.js as a module).
await build({
  ...common,
  entryPoints: [path.join(root, "src/ui/popup.ts")],
  outfile: path.join(out, "popup.js"),
});

// MAIN-world inpage script — plain IIFE, no imports allowed in MAIN world.
await build({
  ...common,
  entryPoints: [path.join(root, "src/content/inpage.ts")],
  format: "iife",
  bundle: true,
  outfile: path.join(out, "inpage.js"),
});

// ISOLATED-world relay — IIFE too (content scripts must not be modules).
await build({
  ...common,
  entryPoints: [path.join(root, "src/content/relay.ts")],
  format: "iife",
  bundle: true,
  outfile: path.join(out, "content.js"),
});

// Static assets.
await cp(path.join(root, "static/manifest.json"), path.join(out, "manifest.json"));
await cp(path.join(root, "static/popup.html"), path.join(out, "popup.html"));

console.log(`built → ${out}`);
console.log(`load unpacked from chrome://extensions (developer mode)`);
#!/usr/bin/env node
// Wraps `tauri build`/`tauri dev` to work around two linuxdeploy issues that
// show up on distros with a newer toolchain (Arch, and increasingly others):
//
// 1. The cached linuxdeploy AppImage bundles its own `strip`, which is too
//    old to understand the `.relr.dyn` (RELR) section modern glibc/binutils
//    produce. It fails to strip every library and aborts the whole bundle.
//    Fix: NO_STRIP=1, which linuxdeploy honors to skip stripping entirely.
//    Bundled libraries end up unstripped (slightly larger AppImage), which
//    is harmless.
//
// 2. Arch's gdk-pixbuf2 package no longer ships a loaders/ directory (pixbuf
//    loaders are compiled into libgdk_pixbuf itself), but its .pc file still
//    advertises the old path. linuxdeploy-plugin-gtk copies from that path
//    unconditionally and aborts when it doesn't exist.
//    Fix: only when the advertised directory is actually missing, point
//    PKG_CONFIG_PATH at a local shim .pc file with an empty directory in its
//    place, so the copy is a no-op instead of a hard failure.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const env = { ...process.env };

if (process.platform === "linux") {
  env.NO_STRIP ??= "1";

  const binarydir = pkgConfigVar("gdk_pixbuf_binarydir");
  if (binarydir && !existsSync(binarydir)) {
    const shimPcDir = join(__dirname, "..", ".tauri-linux-shim");
    const shimModuleDir = join(shimPcDir, "gdk-pixbuf-2.0", "2.10.0");
    mkdirSync(join(shimModuleDir, "loaders"), { recursive: true });
    writeShimPc(shimPcDir, shimModuleDir);
    env.PKG_CONFIG_PATH = [shimPcDir, env.PKG_CONFIG_PATH].filter(Boolean).join(":");
    console.log(
      `tauri-build: gdk-pixbuf loaders dir ${binarydir} is missing (known Arch packaging gap); using empty shim at ${shimModuleDir}`,
    );
  }
}

const result = spawnSync("tauri", args, { stdio: "inherit", env });
process.exit(result.status ?? 1);

function pkgConfigVar(name) {
  try {
    return execFileSync("pkg-config", ["--variable=" + name, "gdk-pixbuf-2.0"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function writeShimPc(shimPcDir, shimModuleDir) {
  const original = execFileSync("pkg-config", ["--path", "gdk-pixbuf-2.0"], {
    encoding: "utf8",
  }).trim();
  const content = readFileSync(original, "utf8")
    .replace(/^gdk_pixbuf_binarydir=.*$/m, `gdk_pixbuf_binarydir=${shimModuleDir}`)
    .replace(/^gdk_pixbuf_moduledir=.*$/m, `gdk_pixbuf_moduledir=${shimModuleDir}/loaders`)
    .replace(/^gdk_pixbuf_cache_file=.*$/m, `gdk_pixbuf_cache_file=${shimModuleDir}/loaders.cache`);
  writeFileSync(join(shimPcDir, "gdk-pixbuf-2.0.pc"), content);
  writeFileSync(join(shimModuleDir, "loaders.cache"), "");
}

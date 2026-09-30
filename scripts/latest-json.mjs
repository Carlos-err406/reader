#!/usr/bin/env node
// Writes the Tauri updater manifest for a release. The universal macOS bundle serves both
// Apple Silicon and Intel. Usage: node scripts/latest-json.mjs <version> <dist dir> <out file>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, dist, out] = process.argv.slice(2);
if (!version || !dist || !out) throw new Error("usage: latest-json.mjs <version> <dist> <out>");
const bundle = `Reader-${version}-macos-universal.app.tar.gz`;
const signature = readFileSync(join(dist, `${bundle}.sig`), "utf8").trim();
const url = `https://github.com/Carlos-err406/reader/releases/download/v${version}/${bundle}`;
const notes = readFileSync(new URL(`../docs/releases/${version}.md`, import.meta.url), "utf8");
const manifest = {
  version,
  notes: notes.replace(/^# .*\n+/, "").trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature, url },
    "darwin-x86_64": { signature, url },
  },
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${out} for ${version}`);

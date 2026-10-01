#!/usr/bin/env node
// Writes the Tauri updater manifest for a release. The universal macOS bundle serves both
// Apple Silicon and Intel; on Windows the NSIS installer is also the update.
// Usage: node scripts/latest-json.mjs <version> <dist dir> <out file>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [version, dist, out] = process.argv.slice(2);
if (!version || !dist || !out) throw new Error("usage: latest-json.mjs <version> <dist> <out>");
const download = (file) => `https://github.com/Carlos-err406/reader/releases/download/v${version}/${file}`;
const entry = (file) => {
  const sig = join(dist, `${file}.sig`);
  if (!existsSync(sig)) throw new Error(`missing ${file}.sig`);
  return { signature: readFileSync(sig, "utf8").trim(), url: download(file) };
};
const mac = entry(`Reader-${version}-macos-universal.app.tar.gz`);
const windows = entry(`Reader-${version}-windows-x64-setup.exe`);
const notes = readFileSync(new URL(`../docs/releases/${version}.md`, import.meta.url), "utf8");
const manifest = {
  version,
  notes: notes.replace(/^# .*\n+/, "").trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": mac,
    "darwin-x86_64": mac,
    "windows-x86_64": windows,
  },
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${out} for ${version}`);

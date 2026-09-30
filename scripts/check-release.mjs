#!/usr/bin/env node
// Every place that states the version must agree, a tag must match it, and each version needs
// release notes. Usage: node scripts/check-release.mjs [vX.Y.Z]
import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const versions = {
  "package.json": JSON.parse(read("package.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1],
};
const problems = [];
const version = versions["package.json"];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) problems.push(`package.json version "${version}" is not X.Y.Z`);
for (const [file, found] of Object.entries(versions)) {
  if (found !== version) problems.push(`${file} says ${found}, package.json says ${version}`);
}
const tag = process.argv[2];
if (tag && tag !== `v${version}`) problems.push(`tag ${tag} doesn't match version ${version}`);
const notes = `docs/releases/${version}.md`;
if (!existsSync(new URL(`../${notes}`, import.meta.url))) problems.push(`missing release notes ${notes}`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ Reader ${version}${tag ? ` (${tag})` : ""}`);

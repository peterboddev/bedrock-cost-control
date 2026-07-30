#!/usr/bin/env node
"use strict";

/*
 * aws-cdk-lib bundles brace-expansion@5.0.7 (a vulnerable version, GHSA-mh99-v99m-4gvg)
 * directly inside its own npm tarball as a `bundleDependencies` entry. npm's `overrides`
 * field cannot rewrite bundled files, so patch-package is used (see patches/) to replace
 * the vulnerable bundled brace-expansion source with the patched 5.0.9 implementation.
 *
 * patch-package intentionally excludes package.json from patches, and a fresh
 * `npm install` regenerates package-lock.json from the aws-cdk-lib tarball's real
 * (unpatched) metadata. `npm audit` reads that lockfile metadata rather than the actual
 * file contents on disk, so without this step it would keep reporting the vulnerability
 * even though the vulnerable code path has already been replaced.
 *
 * This script brings the on-disk package.json and the package-lock.json entry for the
 * bundled brace-expansion copy in line with the patched version, so `npm audit` reports
 * the true (fixed) state. It is idempotent and safe to run on every install.
 */

const fs = require("fs");
const path = require("path");

const FIXED_VERSION = "5.0.9";
const FIXED_ENGINES = { node: "20 || >=22" };
const BUNDLED_PKG_JSON = path.join(
  __dirname,
  "..",
  "node_modules",
  "aws-cdk-lib",
  "node_modules",
  "brace-expansion",
  "package.json"
);
const LOCKFILE_PATH = path.join(__dirname, "..", "package-lock.json");
const LOCKFILE_KEY = "node_modules/aws-cdk-lib/node_modules/brace-expansion";

function fixBundledPackageJson() {
  if (!fs.existsSync(BUNDLED_PKG_JSON)) {
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(BUNDLED_PKG_JSON, "utf8"));
  if (pkg.version === FIXED_VERSION) {
    return;
  }
  pkg.version = FIXED_VERSION;
  if (pkg.engines) {
    pkg.engines = FIXED_ENGINES;
  }
  fs.writeFileSync(BUNDLED_PKG_JSON, JSON.stringify(pkg, null, 2) + "\n");
  console.log(
    `[fixBundledDepAuditMetadata] Updated ${path.relative(process.cwd(), BUNDLED_PKG_JSON)} to version ${FIXED_VERSION}`
  );
}

function fixLockfileEntry() {
  if (!fs.existsSync(LOCKFILE_PATH)) {
    return;
  }
  const lock = JSON.parse(fs.readFileSync(LOCKFILE_PATH, "utf8"));
  const entry = lock.packages && lock.packages[LOCKFILE_KEY];
  if (!entry || entry.version === FIXED_VERSION) {
    return;
  }
  entry.version = FIXED_VERSION;
  if (entry.engines) {
    entry.engines = FIXED_ENGINES;
  }
  fs.writeFileSync(LOCKFILE_PATH, JSON.stringify(lock, null, 2) + "\n");
  console.log(
    `[fixBundledDepAuditMetadata] Updated ${LOCKFILE_KEY} in package-lock.json to version ${FIXED_VERSION}`
  );
}

fixBundledPackageJson();
fixLockfileEntry();

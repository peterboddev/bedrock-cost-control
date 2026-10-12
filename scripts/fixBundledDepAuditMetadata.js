#!/usr/bin/env node
"use strict";

/*
 * aws-cdk-lib bundles a vulnerable brace-expansion (advisory range 4.0.0 - 5.0.11:
 * GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p) directly inside its
 * own npm tarball as a `bundleDependencies` entry. npm's `overrides` field can pin the
 * top-level brace-expansion to a fixed version, but it cannot rewrite files bundled
 * inside a tarball. AWS has not yet shipped an aws-cdk-lib with a fixed bundled copy, so
 * this postinstall step closes the gap by hand:
 *
 *   1. Copy the fixed brace-expansion that `overrides` pins at the top level
 *      (node_modules/brace-expansion) over the vulnerable copy bundled inside
 *      aws-cdk-lib. The fixed version is API-compatible with the bundled 5.0.x line, so
 *      aws-cdk-lib's bundled minimatch keeps working unchanged.
 *   2. Reconcile the package-lock.json entry that `npm audit` reads. npm regenerates that
 *      entry from the aws-cdk-lib tarball's (vulnerable) bundled metadata on every
 *      install, so without this it would keep reporting the advisory even though the
 *      vulnerable code on disk has already been replaced.
 *
 * This replaces an earlier patch-package-based approach; patch-package diffs a nested
 * dependency against its registry version, which cannot express a "bundled-native ->
 * fixed" transform. The copy below is deterministic and idempotent, and it lets the
 * project drop patch-package (and its own vulnerable transitive deps) entirely.
 */

const fs = require("fs");
const path = require("path");

// Keep in sync with the `brace-expansion` version pinned in package.json `overrides`.
const FIXED_VERSION = "5.0.12";
const FIXED_ENGINES = { node: "20 || >=22" };

const ROOT = path.join(__dirname, "..");
const SOURCE_DIR = path.join(ROOT, "node_modules", "brace-expansion");
const BUNDLED_DIR = path.join(
  ROOT,
  "node_modules",
  "aws-cdk-lib",
  "node_modules",
  "brace-expansion"
);
const LOCKFILE_PATH = path.join(ROOT, "package-lock.json");
const LOCKFILE_KEY = "node_modules/aws-cdk-lib/node_modules/brace-expansion";

function readVersion(pkgJsonPath) {
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")).version;
}

function copyFixedSourceIntoBundle() {
  // Nothing to do if either side is missing (e.g. a production-only install without
  // aws-cdk-lib, or before dependencies are present).
  if (!fs.existsSync(SOURCE_DIR) || !fs.existsSync(BUNDLED_DIR)) {
    return;
  }

  const srcVersion = readVersion(path.join(SOURCE_DIR, "package.json"));
  if (srcVersion !== FIXED_VERSION) {
    throw new Error(
      `[fixBundledDepAuditMetadata] expected node_modules/brace-expansion@${FIXED_VERSION} ` +
        `(pinned via package.json "overrides") but found ${srcVersion}. ` +
        `Update FIXED_VERSION and the override together.`
    );
  }

  const bundledPkgPath = path.join(BUNDLED_DIR, "package.json");
  if (readVersion(bundledPkgPath) === FIXED_VERSION) {
    return; // already replaced on a previous run; idempotent no-op
  }

  // Replace dist/, package.json, and README.md with the fixed copy. dist/ is removed
  // first so no stale files survive if the file set ever changes between versions.
  fs.rmSync(path.join(BUNDLED_DIR, "dist"), { recursive: true, force: true });
  fs.cpSync(path.join(SOURCE_DIR, "dist"), path.join(BUNDLED_DIR, "dist"), {
    recursive: true,
  });
  fs.copyFileSync(path.join(SOURCE_DIR, "package.json"), bundledPkgPath);
  const readmeSrc = path.join(SOURCE_DIR, "README.md");
  if (fs.existsSync(readmeSrc)) {
    fs.copyFileSync(readmeSrc, path.join(BUNDLED_DIR, "README.md"));
  }
  console.log(
    `[fixBundledDepAuditMetadata] Replaced bundled aws-cdk-lib brace-expansion with ${FIXED_VERSION}`
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

copyFixedSourceIntoBundle();
fixLockfileEntry();

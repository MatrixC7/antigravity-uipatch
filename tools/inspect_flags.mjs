#!/usr/bin/env node
/**
 * Read-only experiment flag auditor for Antigravity Desktop (`language_server`).
 *
 * Extracts `main.js` purely in memory from the embedded `agy_hub_web_bundle` ZIP
 * inside `/opt/Antigravity/resources/bin/language_server` (zero temporary files,
 * zero disk modifications) and inventories every frontend experiment gate:
 *   1. `FeatureManagerV2` `customFlag` gates (literal + parameter-passed) and
 *      direct `customFlags.includes(...)` checks, mapped to gated feature keys.
 *   2. Direct `MendelExperimentProvider` & secondary Mendel readers:
 *      - `kj(provider, flag)`     : reactive boolean providers (default false upstream)
 *      - `IX(flag)`               : `kj` reactive boolean hook wrapper
 *      - `jj(provider, flag)`     : synchronous boolean checks
 *      - `FS(flag)`               : secondary `getMendelFlags` boolean hook
 *      - `GS(flag, defaultInt)`   : secondary `getMendelFlags` integer payload hook
 *      - `mj(flag)`               : string payload providers
 *      - `.experiments["..."]`    : raw experiment map lookups
 *
 * Usage:
 *   node tools/inspect_flags.mjs [--binary <path>] [--filter <substr>] [--json]
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_INSTALL_DIR,
  findWebBundleZip,
  readZipEntry,
} from '../antigravity_uipatch.mjs';

const DEFAULT_BINARY = `${DEFAULT_INSTALL_DIR}/resources/bin/language_server`;

/**
 * Scan compiled `main.js` source and extract all experiment gates and their
 * associated feature keys.
 */
export function parseFrontendFlags(js) {
  const customMap = new Map();
  const addCustom = (flag, via, featureKey) => {
    if (!flag) return;
    if (!customMap.has(flag)) {
      customMap.set(flag, { flag, via: new Set(), features: new Set() });
    }
    const rec = customMap.get(flag);
    rec.via.add(via);
    if (featureKey) rec.features.add(featureKey);
  };

  // Resolve nearest enclosing feature key in FeatureManagerV2 registration tables.
  const inferFeatureKey = (pos) => {
    const windowStart = Math.max(0, pos - 480);
    const ctx = js.slice(windowStart, pos);
    const matches = [
      ...ctx.matchAll(/([A-Za-z0-9_$]+)\s*:\s*\{\s*(?:feature|applyFirst|applyAll|important)\s*:/g),
    ];
    if (matches.length > 0) {
      const candidate = matches[matches.length - 1][1];
      if (!['runtimeGating', 'features', 'platformComponents', 'skin'].includes(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  // 1a. Literal `customFlag:"..."`
  for (const m of js.matchAll(/customFlag\s*:\s*"([^"]+)"/g)) {
    addCustom(m[1], 'runtimeGating.customFlag', inferFeatureKey(m.index));
  }

  // 1b. Parameter-passed decorator flags (e.g. critiqueDecoratorFlag:"enable-...")
  for (let at = 0; ; ) {
    const idx = js.indexOf('DecoratorFlag', at);
    if (idx === -1) break;
    const snippet = js.slice(Math.max(0, idx - 32), idx + 80);
    const m = /([A-Za-z0-9_$]+DecoratorFlag)\s*:\s*"([^"]+)"/.exec(snippet);
    if (m) addCustom(m[2], `skinParam(${m[1]})`, 'decorators');
    at = idx + 13;
  }

  // 1c. Direct `customFlags.includes("...")` / `customFlags?.includes("...")`
  for (const m of js.matchAll(/customFlags(?:\?\.|\.)includes\(\s*"([^"]+)"\s*\)/g)) {
    addCustom(m[1], 'customFlags.includes', null);
  }

  // 2. Direct MendelExperimentProvider & secondary readers: kj / IX / jj / FS / GS / mj / experiments[]
  const mendel = [];
  const seenMendel = new Set();
  const pushMendel = (reader, flag) => {
    const key = `${reader}:${flag}`;
    if (seenMendel.has(key)) return;
    seenMendel.add(key);
    mendel.push({ reader, flag });
  };

  for (const m of js.matchAll(/\bkj\s*\(\s*[A-Za-z0-9_$]+\s*,\s*"([^"]+)"\s*\)/g)) {
    pushMendel('kj (reactive bool)', m[1]);
  }
  for (const m of js.matchAll(/\bIX\s*\(\s*"([^"]+)"\s*\)/g)) {
    pushMendel('IX (kj hook)', m[1]);
  }
  for (const m of js.matchAll(/\bjj\s*\(\s*[A-Za-z0-9_$]+\s*,\s*"([^"]+)"\s*\)/g)) {
    pushMendel('jj (sync bool)', m[1]);
  }
  for (const m of js.matchAll(/\bFS\s*\(\s*"([^"]+)"\s*\)/g)) {
    pushMendel('FS (rpc bool hook)', m[1]);
  }
  for (const m of js.matchAll(/\bGS\s*\(\s*"([^"]+)"\s*,/g)) {
    pushMendel('GS (rpc int hook)', m[1]);
  }
  for (const m of js.matchAll(/\bmj\s*\(\s*"([^"]+)"\s*\)/g)) {
    pushMendel('mj (string payload)', m[1]);
  }
  for (const m of js.matchAll(/\.experiments\[\s*"([^"]+)"\s*\]/g)) {
    pushMendel('experiments[] (raw)', m[1]);
  }

  const customFlags = [...customMap.values()]
    .map((r) => ({
      flag: r.flag,
      via: [...r.via].sort(),
      features: [...r.features].sort(),
    }))
    .sort((a, b) => a.flag.localeCompare(b.flag));

  mendel.sort((a, b) => a.reader.localeCompare(b.reader) || a.flag.localeCompare(b.flag));

  return { customFlags, mendel };
}

function parseCli(argv) {
  const opts = { binary: DEFAULT_BINARY, filter: '', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--binary') { i += 1; opts.binary = argv[i]; }
    else if (a.startsWith('--binary=')) opts.binary = a.slice('--binary='.length);
    else if (a === '--filter') { i += 1; opts.filter = (argv[i] || '').toLowerCase(); }
    else if (a.startsWith('--filter=')) opts.filter = a.slice('--filter='.length).toLowerCase();
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseCli(argv);
  if (opts.help) {
    console.log(
      'Usage: node tools/inspect_flags.mjs [--binary <language_server>] [--filter <substr>] [--json]'
    );
    return 0;
  }

  const binBuf = fs.readFileSync(opts.binary);
  const found = findWebBundleZip(binBuf);
  if (!found) {
    console.error(`error: no embedded Web UI ZIP found in ${opts.binary}`);
    return 1;
  }
  const mainEntry = found.entries.find((e) => e.name === 'main.js');
  const js = readZipEntry(found.zip, mainEntry).toString('utf8');
  let { customFlags, mendel } = parseFrontendFlags(js);

  if (opts.filter) {
    const q = opts.filter;
    customFlags = customFlags.filter(
      (r) =>
        r.flag.toLowerCase().includes(q) ||
        r.features.some((f) => f.toLowerCase().includes(q))
    );
    mendel = mendel.filter((m) => m.flag.toLowerCase().includes(q));
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          binary: opts.binary,
          zipOffset: found.offset,
          counts: { customFlags: customFlags.length, mendelDirect: mendel.length },
          mendelDirect: mendel,
          customFlags,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(`Binary : ${opts.binary} (Web UI ZIP @ 0x${found.offset.toString(16)})`);
  console.log(`Summary: ${customFlags.length} customFlag gate(s), ${mendel.length} direct Mendel reader(s)\n`);

  if (mendel.length > 0) {
    console.log('=== Direct Mendel & Secondary Readers (kj / IX / jj / FS / GS / mj / experiments[]) ===');
    for (const m of mendel) {
      console.log(`  ${m.reader.padEnd(22)} ${m.flag}`);
    }
    console.log('');
  }

  if (customFlags.length > 0) {
    console.log('=== FeatureManagerV2 customFlags (controlled via ela() / Developer Panel) ===');
    for (const r of customFlags) {
      const feats = r.features.length > 0 ? r.features.join(', ') : '(inline / multi-site)';
      console.log(`  ${r.flag.padEnd(46)} -> ${feats}`);
    }
  }
  return 0;
}

const isDirect = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirect) {
  process.exit(main());
}

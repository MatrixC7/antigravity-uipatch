#!/usr/bin/env node
/**
 * Read-only experiment flag auditor for Antigravity Desktop (`language_server`).
 *
 * Extracts `main.js` purely in memory from the embedded `agy_hub_web_bundle` ZIP
 * inside `/opt/Antigravity/resources/bin/language_server` (zero temporary files,
 * zero disk modifications) and inventories every frontend experiment gate:
 *   1. `FeatureManagerV2` `customFlag` gates (literal + parameter-passed) and
 *      direct `customFlags.includes(...)` checks, mapped to gated feature keys.
 *   2. Direct `MendelExperimentProvider` & secondary Mendel readers (resolved
 *      dynamically by structural signature; 2.31 symbols shown as examples):
 *      - `Ii(provider, flag)`     : reactive boolean providers (default false upstream)
 *      - `CKc(flag)`              : `Ii` reactive boolean hook wrapper
 *      - `Hi(provider, flag)`     : synchronous boolean checks
 *      - `IT(flag)`               : secondary `getMendelFlags` boolean hook
 *      - `JT(flag, defaultInt)`   : secondary `getMendelFlags` integer payload hook
 *      - `Ji(flag)`               : string payload providers
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

  // 2. Direct MendelExperimentProvider & secondary readers (resolved dynamically
  //    from their structural definitions in `main.js`, with legacy symbol fallbacks
  //    for minimal synthetic test snippets).
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const syncSym =
    /function ([A-Za-z0-9_$]+)\(a,b\)\{return\(a=a\.experiments\[b\]\)\?!a\.disabled:!1\}/.exec(js)?.[1] ??
    'jj';
  const reactSym =
    /function ([A-Za-z0-9_$]+)\(a,b\)\{var c=a\.experimentEnabledProviders\.get\(b\);/.exec(js)?.[1] ??
    'kj';
  const strSym =
    /function ([A-Za-z0-9_$]+)\(a\)\{var b=[A-Za-z0-9_$]+\(\),c=b\.experimentStringProviders\.get\(a\);/.exec(
      js
    )?.[1] ?? 'mj';
  const hookSym =
    new RegExp(`(?:var|const|let)\\s+([A-Za-z0-9_$]+)=a=>\\{var b=${escapeRe(reactSym)}\\(`).exec(js)?.[1] ??
    'IX';
  const secMatch =
    /var ([A-Za-z0-9_$]+)=a=>\(a=([A-Za-z0-9_$]+)\(a\)\)\?!a\.disabled:!1,([A-Za-z0-9_$]+)=\(a,b\)=>\{var c=\2\(a\)/.exec(
      js
    );
  const secBoolSym = secMatch?.[1] ?? 'FS';
  const secIntSym = secMatch?.[3] ?? 'GS';

  const mendel = [];
  const seenMendel = new Set();
  const pushMendel = (reader, flag) => {
    const key = `${reader}:${flag}`;
    if (seenMendel.has(key)) return;
    seenMendel.add(key);
    mendel.push({ reader, flag });
  };

  for (const m of js.matchAll(
    new RegExp(`\\b${escapeRe(reactSym)}\\s*\\(\\s*[A-Za-z0-9_$]+(?:\\(\\))?\\s*,\\s*"([^"]+)"\\s*\\)`, 'g')
  )) {
    pushMendel(`${reactSym} (reactive bool)`, m[1]);
  }
  for (const m of js.matchAll(new RegExp(`\\b${escapeRe(hookSym)}\\s*\\(\\s*"([^"]+)"\\s*\\)`, 'g'))) {
    pushMendel(`${hookSym} (reactive hook)`, m[1]);
  }
  for (const m of js.matchAll(
    new RegExp(`\\b${escapeRe(syncSym)}\\s*\\(\\s*[A-Za-z0-9_$]+(?:\\(\\))?\\s*,\\s*"([^"]+)"\\s*\\)`, 'g')
  )) {
    pushMendel(`${syncSym} (sync bool)`, m[1]);
  }
  for (const m of js.matchAll(new RegExp(`\\b${escapeRe(secBoolSym)}\\s*\\(\\s*"([^"]+)"\\s*\\)`, 'g'))) {
    pushMendel(`${secBoolSym} (rpc bool hook)`, m[1]);
  }
  for (const m of js.matchAll(new RegExp(`\\b${escapeRe(secIntSym)}\\s*\\(\\s*"([^"]+)"\\s*,`, 'g'))) {
    pushMendel(`${secIntSym} (rpc int hook)`, m[1]);
  }
  for (const m of js.matchAll(new RegExp(`\\b${escapeRe(strSym)}\\s*\\(\\s*"([^"]+)"\\s*\\)`, 'g'))) {
    pushMendel(`${strSym} (string payload)`, m[1]);
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

  return {
    customFlags,
    mendel,
    symbols: { reactSym, hookSym, syncSym, secBoolSym, secIntSym, strSym },
  };
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
  let { customFlags, mendel, symbols } = parseFrontendFlags(js);

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
    const hdr = `${symbols.reactSym} / ${symbols.hookSym} / ${symbols.syncSym} / ${symbols.secBoolSym} / ${symbols.secIntSym} / ${symbols.strSym} / experiments[]`;
    console.log(`=== Direct Mendel & Secondary Readers (${hdr}) ===`);
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

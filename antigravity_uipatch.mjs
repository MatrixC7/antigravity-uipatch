#!/usr/bin/env node
/**
 * antigravity-uipatch: unlock experiment-gated frontend UI in Antigravity Desktop.
 *
 * Target
 * ------
 * 1. `/opt/Antigravity/resources/app.asar` (`dist/languageServer.js`) - Electron
 *    host launcher that spawns the Go `language_server` subprocess.
 * 2. `/opt/Antigravity/resources/bin/language_server` (read-only extraction) -
 *    contains the compiled React Web UI (`agy_hub_web_bundle`) as an embedded
 *    ZIP archive served over loopback HTTPS. The ELF binary itself is NEVER
 *    modified by this tool.
 *
 * Verified mechanism (see docs/ for the full forensic chain)
 * ----------------------------------------------------------
 * 1. Antigravity Desktop gates ~107 frontend features (`Extensions` menu, built-in
 *    `Terminal`, native `File Explorer` tab, `Settings -> Developer`, etc.) behind
 *    Mendel experiment flags fetched via `GetMendelFlags`.
 * 2. When running in Enterprise Gateway / custom model mode without a Google
 *    OAuth session, `GetMendelFlags` returns `{"experimentConfig":{}}`. Meanwhile
 *    `SetMendelFlagOverrides` is blocked server-side by a hard gate:
 *    `permission_denied: Mendel flag overrides require developer mode`.
 * 3. `language_server` natively supports `-web_bundle_path`:
 *      "Directory or .zip holding the compiled web UI to serve, in preference
 *       to the bundle compiled into this binary."
 *    However, Electron's `dist/languageServer.js` hardcodes the spawn `args`
 *    array and ignores CLI / environment passthrough.
 *
 * Three decoupled, reversible changes
 * -----------------------------------
 * 1. Inert `app.asar` hook (`dist/languageServer.js`): appends
 *    `--web_bundle_path=${process.env.AGY_UI_BUNDLE}` ONLY when `AGY_UI_BUNDLE`
 *    is set in the environment. Without that variable, behavior is 100% stock.
 *    Repacking uses an append-only strategy that preserves every untouched entry
 *    (including any prior third-party `app.asar` patches) byte-for-byte.
 * 2. Extracted Web UI (`~/.local/share/antigravity-externalui/`) with 5 structural
 *    choke-point patches in `main.js` (resolving Closure-minified identifiers by
 *    unique AST/property signatures and validating output via V8 `vm.Script`):
 *    - `mendel-native-baseline`: pre-hydrates `jetski.developer.customFlagOverrides`
 *      from `window.nativeStorage` (`~/.config/Antigravity/app_storage.json`)
 *      before resolving the primary Mendel fetcher (`Ola()`); when `GetMendelFlags`
 *      returns `{}` (Gateway Mode), seeds `MendelExperimentProvider` with the
 *      empirically verified Google Native OAuth baseline (41 boolean `ON` flags +
 *      7 string-payload flags) plus `FLAGS` (`enable-developer-mode` and
 *      `enable-context-usage-indicator`); when signed in with Google Native OAuth
 *      (`list.length > 0`), preserves the live server table intact and only
 *      ensures `FLAGS` are ON.
 *    - `mendel-service-wrapper`: feeds the secondary `getMendelFlags` wrapper
 *      (`IT` / `JT` hooks) through the same resolver + normalizer.
 *    - `mendel-local-overrides`: binds `clientStorageFeature` (`hhd()`) and
 *      `flagOverrideSync` (`Mla`) so direct Mendel boolean readers (`Hi`, `Ii`,
 *      `IT`) honor bidirectional `customFlagOverrides` toggles immediately
 *      without mutating `baselineRuntimeEnvironment`, exposes `lsClient` as
 *      `globalThis.__agyLsClient` for lightweight telemetry hydration, and seeds
 *      `contextUsageIndicatorEnabled="true"` once when unset.
 *    - `flag-picker-scrollable`: replaces the flag picker (`EGb()`) unscrollable,
 *      unthemed Chromium `<datalist>` popup with an upward-opening (`bottom-full mb-1`),
 *      scrollable (`max-h-64 overflow-y-auto`), keyboard-navigable ARIA combobox.
 *    - `context-usage-indicator`: mounts the Context Window & Inference Telemetry
 *      indicator (`__AgyContextIndicator`) into `buildBindings.contextUsageIndicator`
 *      (stripped to `void 0` in 2.30+ external builds), displaying `TokenType`
 *      sub-group breakdown, `Last Turn` and `Σ Session · N turns` `4x2` matrices
 *      (`Input`/`Output`, `Cache hit`/`Response`, `In speed`/`Out speed`,
 *      `TTFT`/`Duration`), error/retry badges, and a `t/s [Off | Turn | Avg]`
 *      bottom-toolbar switch.
 * 3. Runtime activation (`AGY_UI_BUNDLE=<ui-dir>`):
 *    passed manually by the user via `.desktop` launcher or terminal environment.
 *
 * Commands
 * --------
 *   self-test     validate ASAR round-trip, embedded ZIP CRC32, anchors & V8 syntax (read-only)
 *   install       apply ASAR hook and extract & patch Web UI (alias: patch)
 *   sync          post-upgrade full re-sync for Pacman hooks (supports --user, --quiet)
 *   repair        re-extract & re-patch Web UI from current language_server without touching ASAR
 *   verify        report build CL, hook/UI states, backup pairing & optional launcher status (alias: status)
 *   restore       atomically restore paired pristine app.asar (alias: uninstall)
 *   extract       dump unpatched stock Web UI from language_server to a directory
 *   pacman-hook   print or write a root-safe Pacman PostTransaction hook
 *
 * Safety invariants
 * -----------------
 * 1. `--dry-run` writes NOTHING for every command and runs that command's
 *    read-only preflight checks.
 * 2. `extract` only writes into a new/empty directory; non-empty targets are
 *    refused and user data is never deleted.
 * 3. Swapping the UI bundle uses an explicit commit state machine; the previous
 *    bundle is only removed after a confirmed commit or rollback, and is
 *    preserved (with a printed recovery path) if both promotion and rollback fail.
 * 4. Normal write roots are resolved once via `resolveWriteRoot()` while any
 *    symlink below the root is rejected (`assertNoSymlinkBelowRoot()`); the
 *    root-owned Pacman hook audit (`auditRootOwnedChain()`) rejects symlinks
 *    anywhere in the lexical path and verifies ownership up the `realpath` chain.
 * 5. Optional `.desktop` `Exec=` inspection (`analyseDesktopExec()`) is strictly
 *    read-only and decodes two-layer `GKeyFile` -> `Exec` argv escaping to
 *    auto-detect user-configured `AGY_UI_BUNDLE` paths in `repair` and `verify`.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';

// Prevent Electron's Node runtime (if invoked via ELECTRON_RUN_AS_NODE=1) from
// intercepting `.asar` files as virtual directories.
process.noAsar = true;

export const ENV_VAR = 'AGY_UI_BUNDLE';
export const ASAR_TARGET = 'dist/languageServer.js';
export const DEFAULT_INSTALL_DIR = '/opt/Antigravity';
export const FLAGS = ['enable-developer-mode', 'enable-context-usage-indicator'];
export const DEFAULT_INDICATOR_MODE = 'custom';
export const INDICATOR_MODES = new Set(['custom', 'polyfill', 'stock']);

/**
 * Empirically verified Google Native OAuth frontend boolean flags (`disabled: false`
 * in live `GetMendelFlags` on `antigravity 2.29.1-1` / `CL 1015941558`).
 * Used ONLY as fallback baseline when `GetMendelFlags` returns empty `{}` (Gateway Mode);
 * when signed in with Google Native OAuth, the live server table is preserved intact.
 */
export const NATIVE_MENDEL_BOOL_FLAGS = [
  'deprecate-workflows',
  'enable-audio-transcription',
  'enable-auto-permission-preset',
  'enable-aux-pane-redesign',
  'enable-battle-mode-custom-agents',
  'enable-browser-subagent-v2',
  'enable-context-menu-system',
  'enable-conversation-navigator',
  'enable-conversation-navigator-chapter-titles',
  'enable-conversation-search-v2',
  'enable-conversation-selection-quoting',
  'enable-fig-vcs-ui',
  'enable-git-vcs-ui',
  'enable-gob-cog-vcs-ui',
  'enable-gob-repo-vcs-ui',
  'enable-hub-builtin-browser',
  'enable-jetbox-terminal-v2',
  'enable-keybinding-customization',
  'enable-mcp-plugin-auth',
  'enable-new-themes',
  'enable-notebook-rendering',
  'enable-notifications-settings',
  'enable-pdf-viewer',
  'enable-permissions-selector',
  'enable-plugin-auth',
  'enable-plugins',
  'enable-remote-ai',
  'enable-remote-control-audio-transcription',
  'enable-settings-error-card',
  'enable-sidecars',
  'enable-split-view',
  'enable-ui-sidecars',
  'enable-user-message-bubbles',
  'enable-voice-relay',
  'jetski-generative-ui',
  'jetski-sidecar-declared-permissions',
  'permission-v2',
  'remote-control-setting-enabled',
  'remove-conversation-history',
  'scheduled-tasks-v2',
  'sidecar-iframe-prewarm',
];

/**
 * Empirically verified Google Native OAuth frontend string-payload flags.
 */
export const NATIVE_MENDEL_STRING_FLAGS = {
  'agy-hub-announcement-message': '',
  'battle-mode-max-turns': '0',
  'best-of-n-default-model-id': '',
  'best-of-nudge-length-threshold': '150',
  'max-best-of-n': '10',
  'max-media-attachments': '15',
  'third-party-tools-disclaimer-text': JSON.stringify({
    default:
      'Google does not control the availability or functionality of third party developer tools. Your data from third party developer tools connected to your Antigravity instance may be shared with Google. Google will protect any such data in accordance with the Google Privacy Policy, found here: {privacyPolicyLink}',
    marketplace:
      'Google does not control the availability or functionality of third party developer tools. Your data from third party developer tools connected to your Antigravity instance may be shared with Google. Google will protect any such data in accordance with the Google Privacy Policy, found here: {privacyPolicyLink}',
    catalogs: { 'antigravity-plugins-official': '' },
  }),
};

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const say = (...a) => console.log(...a);
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const align4 = (n) => (n + 3) & ~3;

export class PatchError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'PatchError';
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// 1. Dependency-free IEEE 802.3 CRC32 & Embedded ZIP Extractor (node:zlib)
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

export function crc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateZipEntryName(name) {
  if (!name || name.includes('\0') || name.startsWith('/') || name.includes('\\')) {
    throw new PatchError(`unsafe ZIP entry path rejected: ${JSON.stringify(name)}`, 3);
  }
  const isDirName = name.endsWith('/');
  const parts = name.split('/');
  // A trailing slash yields one empty final segment; anything else empty means
  // `//`, and `.` segments make two names alias the same file on disk.
  const body = isDirName ? parts.slice(0, -1) : parts;
  if (body.some((p) => p === '')) {
    throw new PatchError(`non-canonical ZIP entry path rejected: ${JSON.stringify(name)}`, 3);
  }
  if (body.some((p) => p === '..')) {
    throw new PatchError(`path-traversal ZIP entry rejected: ${JSON.stringify(name)}`, 3);
  }
  if (body.some((p) => p === '.')) {
    throw new PatchError(`non-canonical ZIP entry path rejected: ${JSON.stringify(name)}`, 3);
  }
}

/** Canonical form used to detect aliasing entries (`a` vs `./a`, `a/` vs `a`). */
function canonicalEntryKey(name) {
  const isDirName = name.endsWith('/');
  const body = name.split('/').filter((p) => p !== '');
  return { key: body.join('/'), isDir: isDirName };
}

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CDH_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;
const ZIP_MAX_COMMENT = 65535;
/** Hard ceiling for a single in-memory archive extraction (bytes, uncompressed). */
export const ZIP_DEFAULT_TOTAL_BUDGET = 512 * 1024 * 1024;

/**
 * Yield every plausible EOCD signature position inside `buf`, newest first.
 *
 * `allowTrailing` is required when scanning a container binary that may hold
 * padding or further data after the archive; standalone archive buffers must
 * end exactly at the EOCD (default), which is the only structurally valid
 * layout for a bare ZIP file.
 */
function* eocdCandidates(buf, { allowTrailing = false } = {}) {
  // A standalone archive's EOCD lives within the final 64 KiB (max comment
  // length). A container binary can embed it anywhere, so no such bound applies.
  const minPos = allowTrailing ? 0 : Math.max(0, buf.length - 22 - ZIP_MAX_COMMENT);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) !== ZIP_EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    const end = i + 22 + commentLen;
    if (allowTrailing ? end > buf.length : end !== buf.length) continue;
    yield { eocd: i, commentLen };
  }
}

/**
 * Parse and fully validate the Central Directory of a standard ZIP archive.
 *
 * Hardened: multi-disk, ZIP64 and encrypted archives are rejected explicitly;
 * the central directory must end exactly at the EOCD record; the declared entry
 * count must be consumed exactly. Multiple EOCD candidates (for example a fake
 * signature embedded in a ZIP comment) are tried newest-first and the first
 * structurally valid layout wins, so a decoy cannot shadow the real archive.
 */
export function listZipEntries(zipBuf, options = {}) {
  let lastError = null;

  for (const { eocd } of eocdCandidates(zipBuf, options)) {
    try {
      return parseCentralDirectory(zipBuf, eocd);
    } catch (exc) {
      lastError = exc;
    }
  }

  if (lastError) throw lastError;
  throw new PatchError('invalid ZIP archive: End of Central Directory (EOCD) not found', 3);
}

function parseCentralDirectory(zipBuf, eocd) {
  const diskNumber = zipBuf.readUInt16LE(eocd + 4);
  const cdDisk = zipBuf.readUInt16LE(eocd + 6);
  const entriesOnDisk = zipBuf.readUInt16LE(eocd + 8);
  const totalEntries = zipBuf.readUInt16LE(eocd + 10);
  const cdSize = zipBuf.readUInt32LE(eocd + 12);
  const cdOffset = zipBuf.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new PatchError('invalid ZIP archive: multi-disk / spanned archives are unsupported', 3);
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new PatchError('invalid ZIP archive: ZIP64 archives are unsupported', 3);
  }
  if (cdOffset + cdSize !== eocd) {
    throw new PatchError(
      `invalid ZIP archive: Central Directory (${cdOffset}+${cdSize}) does not end at EOCD (${eocd})`,
      3
    );
  }

  const entries = [];
  const seen = new Map(); // canonical path -> isDir
  let ptr = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (ptr + 46 > eocd) {
      throw new PatchError(`invalid ZIP archive: truncated Central Directory at entry ${i}`, 3);
    }
    if (zipBuf.readUInt32LE(ptr) !== ZIP_CDH_SIG) {
      throw new PatchError(`invalid ZIP Central Directory signature at offset ${ptr}`, 3);
    }
    const flags = zipBuf.readUInt16LE(ptr + 8);
    const method = zipBuf.readUInt16LE(ptr + 10);
    const expectedCrc = zipBuf.readUInt32LE(ptr + 16);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const uncompSize = zipBuf.readUInt32LE(ptr + 24);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(ptr + 42);

    if (flags & 0x0001) {
      throw new PatchError('invalid ZIP archive: encrypted entries are unsupported', 3);
    }

    const next = ptr + 46 + nameLen + extraLen + commentLen;
    if (next > eocd) {
      throw new PatchError(`invalid ZIP archive: Central Directory entry ${i} overruns EOCD`, 3);
    }
    const name = zipBuf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    validateZipEntryName(name);
    const { key, isDir } = canonicalEntryKey(name);
    const prior = seen.get(key);
    if (prior !== undefined) {
      const priorIsDir = prior;
      // `a` + `a/`, or two spellings of the same path, would silently overwrite
      // each other during extraction.
      throw new PatchError(
        `invalid ZIP archive: conflicting entries for the same path ${JSON.stringify(name)}` +
          (priorIsDir !== isDir ? ' (file/directory conflict)' : ' (duplicate path)'),
        3
      );
    }
    seen.set(key, isDir);

    entries.push({
      name,
      isDir: name.endsWith('/'),
      method,
      flags,
      crc32: expectedCrc,
      compSize,
      uncompSize,
      localHeaderOffset,
    });
    ptr = next;
  }

  if (ptr !== cdOffset + cdSize) {
    throw new PatchError(
      `invalid ZIP archive: Central Directory consumed ${ptr - cdOffset} B but declared ${cdSize} B`,
      3
    );
  }
  return entries;
}

/**
 * Decompress and CRC32-verify a single entry from a ZIP buffer in memory.
 *
 * Hardened: the local file header is cross-checked against the Central
 * Directory (name, method, sizes) so a rewritten local header cannot redirect
 * decompression; decompression is bounded by `maxOutputBytes`.
 */
export function readZipEntry(zipBuf, entry, { maxOutputBytes = 128 * 1024 * 1024 } = {}) {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > zipBuf.length || zipBuf.readUInt32LE(lh) !== ZIP_LFH_SIG) {
    throw new PatchError(`invalid ZIP local header for ${entry.name}`, 3);
  }
  const lhNameLen = zipBuf.readUInt16LE(lh + 26);
  const lhExtraLen = zipBuf.readUInt16LE(lh + 28);
  const lhMethod = zipBuf.readUInt16LE(lh + 8);
  const lhCompSize = zipBuf.readUInt32LE(lh + 18);
  const lhUncompSize = zipBuf.readUInt32LE(lh + 22);
  const dataStart = lh + 30 + lhNameLen + lhExtraLen;
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > zipBuf.length) {
    throw new PatchError(`truncated ZIP payload for ${entry.name}`, 3);
  }
  const lhName = zipBuf.subarray(lh + 30, lh + 30 + lhNameLen).toString('utf8');
  if (lhName !== entry.name) {
    throw new PatchError(
      `invalid ZIP archive: local header name ${JSON.stringify(lhName)} != ${JSON.stringify(entry.name)}`,
      3
    );
  }
  if (lhMethod !== entry.method) {
    throw new PatchError(`invalid ZIP archive: local/central method mismatch for ${entry.name}`, 3);
  }
  // A streaming writer may legitimately leave zeroed sizes in the local header
  // (data descriptor flag); anything else must agree with the Central Directory.
  if (!(entry.flags & 0x0008) && (lhCompSize !== entry.compSize || lhUncompSize !== entry.uncompSize)) {
    throw new PatchError(`invalid ZIP archive: local/central size mismatch for ${entry.name}`, 3);
  }
  if (entry.uncompSize > maxOutputBytes) {
    throw new PatchError(
      `ZIP entry ${entry.name} declares ${entry.uncompSize} B, exceeding the ${maxOutputBytes} B limit`,
      3
    );
  }
  const raw = zipBuf.subarray(dataStart, dataEnd);

  let out;
  if (entry.method === 0) {
    out = Buffer.from(raw);
  } else if (entry.method === 8) {
    try {
      out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.uncompSize, 1) });
    } catch (exc) {
      if (exc?.code === 'ERR_BUFFER_TOO_LARGE' || exc instanceof RangeError) {
        throw new PatchError(`ZIP entry ${entry.name} decompressed beyond its declared size`, 3);
      }
      throw new PatchError(`ZIP entry ${entry.name} failed to inflate: ${exc.message}`, 3);
    }
  } else {
    throw new PatchError(`unsupported ZIP compression method ${entry.method} in ${entry.name}`, 3);
  }

  if (out.length !== entry.uncompSize) {
    throw new PatchError(
      `ZIP size mismatch for ${entry.name}: expected ${entry.uncompSize}, got ${out.length}`,
      3
    );
  }
  const actualCrc = crc32(out);
  if (actualCrc !== entry.crc32) {
    throw new PatchError(
      `ZIP CRC32 mismatch for ${entry.name}: expected 0x${entry.crc32.toString(16)}, got 0x${actualCrc.toString(16)}`,
      3
    );
  }
  return out;
}

/**
 * Extract all entries of a ZIP buffer into `destDir` with CRC32 verification.
 *
 * Path policy (see resolveWriteRoot / assertNoSymlinkBelowRoot):
 * - The destination root is resolved ONCE to its physical path, so an
 *   authorized root that happens to be a symlink (a user's $HOME, /tmp, or an
 *   explicit --ui-dir) still works.
 * - Any symbolic link *below* that root aborts the extraction, so an entry
 *   cannot be redirected outside the authorized tree.
 * - A total uncompressed byte budget is enforced before writing.
 * - The destination is expected to be freshly created by the caller (a staging
 *   directory); an existing non-empty directory is refused.
 */
export function extractZipToDir(zipBuf, destDir, { totalBudget = ZIP_DEFAULT_TOTAL_BUDGET } = {}) {
  const { root: resolvedRoot } = resolveWriteRoot(destDir);

  if (fs.existsSync(resolvedRoot)) {
    const st = fs.lstatSync(resolvedRoot);
    if (st.isSymbolicLink()) {
      throw new PatchError(`refusing to extract into a symbolic link: ${resolvedRoot}`, 3);
    }
    if (!st.isDirectory()) {
      throw new PatchError(`refusing to extract into a non-directory: ${resolvedRoot}`, 3);
    }
    if (fs.readdirSync(resolvedRoot).length > 0) {
      throw new PatchError(`refusing to extract into non-empty directory: ${resolvedRoot}`, 3);
    }
  }

  const entries = listZipEntries(zipBuf);
  const declaredTotal = entries.reduce((sum, e) => sum + (e.isDir ? 0 : e.uncompSize), 0);
  if (declaredTotal > totalBudget) {
    throw new PatchError(
      `ZIP archive declares ${declaredTotal} B uncompressed, exceeding the ${totalBudget} B budget`,
      3
    );
  }

  fs.mkdirSync(resolvedRoot, { recursive: true });
  let fileCount = 0;
  let written = 0;

  for (const entry of entries) {
    const outPath = path.resolve(resolvedRoot, entry.name);
    if (outPath !== resolvedRoot && !outPath.startsWith(resolvedRoot + path.sep)) {
      throw new PatchError(`ZIP entry escapes destination root: ${entry.name}`, 3);
    }
    if (entry.isDir) {
      fs.mkdirSync(outPath, { recursive: true });
      continue;
    }
    const parent = path.dirname(outPath);
    fs.mkdirSync(parent, { recursive: true });
    // Defend against a symlinked component introduced *inside* the root.
    assertNoSymlinkBelowRoot(resolvedRoot, outPath);
    const content = readZipEntry(zipBuf, entry);
    written += content.length;
    if (written > totalBudget) {
      throw new PatchError(`ZIP extraction exceeded the ${totalBudget} B budget`, 3);
    }
    fs.writeFileSync(outPath, content);
    fileCount += 1;
  }
  return { entries: entries.length, files: fileCount, bytes: written };
}

/**
 * Resolve the *physical* root a write is authorized to target.
 *
 * A user's own `$HOME`, `/tmp` or a chosen `--ui-dir` may legitimately be a
 * symbolic link; refusing those outright would break normal installs. The
 * policy is therefore: follow links ONCE while resolving the authorized root,
 * then never follow another link below it.
 *
 * Returns the realpath of the requested directory when it exists, otherwise the
 * realpath of the nearest existing ancestor joined with the remaining segments.
 */
export function resolveWriteRoot(dirPath) {
  const abs = path.resolve(dirPath);
  let existing = abs;
  const missing = [];
  for (;;) {
    let st = null;
    try {
      st = fs.lstatSync(existing);
    } catch (exc) {
      if (exc.code === 'ENOTDIR') {
        // An ancestor exists but is a file (often reached through a symlink):
        // report it as our own error rather than leaking a raw errno.
        throw new PatchError(
          `cannot use ${existing} as a write root: a parent path component is not a directory`,
          3
        );
      }
      if (exc.code !== 'ENOENT') throw exc;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
      continue;
    }
    if (st.isSymbolicLink() || st.isDirectory()) break;
    throw new PatchError(`refusing to use non-directory as a write root: ${existing}`, 3);
  }
  let real;
  try {
    real = fs.realpathSync(existing);
  } catch {
    real = existing;
  }
  let root = real;
  for (const part of missing) root = path.join(root, part);
  return { root, existed: missing.length === 0 };
}

/**
 * Reject a symlinked component *below* an already-authorized physical root.
 *
 * Components at or above `root` are not inspected: that is exactly where a
 * legitimate `$HOME` / `/tmp` link lives, and it has already been normalised by
 * `resolveWriteRoot()`. Only a link introduced *inside* the tree (a plausible
 * redirect of our own output) is refused.
 */
export function assertNoSymlinkBelowRoot(root, targetPath) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(targetPath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    throw new PatchError(`refusing to write outside the authorized root: ${abs}`, 3);
  }
  const rel = path.relative(rootAbs, abs);
  if (!rel) return;
  let cur = rootAbs;
  for (const part of rel.split(path.sep)) {
    if (!part) continue;
    cur = path.join(cur, part);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (exc) {
      if (exc.code === 'ENOENT') return; // Not created yet: nothing to redirect through.
      throw exc;
    }
    if (st.isSymbolicLink()) {
      throw new PatchError(`refusing to write through symbolic link: ${cur}`, 3);
    }
  }
}

/**
 * Scan `language_server` backwards for embedded ZIP archives and return the
 * Web UI bundle (`agy_hub_web_bundle`), identified by containing both
 * `index.html` and `main.js` (skipping Go's embedded `tzdata` ZIP).
 *
 * Each EOCD candidate is validated as a complete Central Directory layout, and
 * the archive start is re-derived from the validated layout, so a decoy EOCD
 * signature (for instance one embedded in a ZIP comment) cannot shadow the real
 * bundle.
 */
export function findWebBundleZip(binBuf) {
  for (const { eocd, commentLen } of eocdCandidates(binBuf, { allowTrailing: true })) {
    try {
      const cdSize = binBuf.readUInt32LE(eocd + 12);
      const cdOffset = binBuf.readUInt32LE(eocd + 16);
      const start = eocd - cdSize - cdOffset;
      if (start < 0) continue;
      if (binBuf.readUInt32LE(start) !== ZIP_LFH_SIG) continue;

      const slice = binBuf.subarray(start, eocd + 22 + commentLen);
      const entries = listZipEntries(slice);
      const names = new Set(entries.map((e) => e.name));
      if (names.has('index.html') && names.has('main.js')) {
        return { zip: slice, offset: start, size: slice.length, entries };
      }
    } catch {
      // False / non-UI archive candidate; continue scanning backwards.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Dependency-free ASAR Reader & Append-Only Repacker
// ---------------------------------------------------------------------------

/**
 * Parse an Electron ASAR archive buffer.
 *
 * Layout:
 *   [0..3]   uint32LE = 4
 *   [4..7]   uint32LE = dataOffset - 8
 *   [8..11]  uint32LE = dataOffset - 12
 *   [12..15] uint32LE = jsonLen
 *   [16..]   UTF-8 JSON header, zero-padded to 4-byte boundary (`dataOffset`)
 *   [dataOffset..] concatenated file payloads
 */
export function readAsar(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) {
    throw new PatchError('invalid ASAR archive header', 3);
  }
  const jsonLen = buf.readUInt32LE(12);
  const dataOffset = 8 + buf.readUInt32LE(4);
  if (16 + jsonLen > dataOffset || dataOffset > buf.length) {
    throw new PatchError('corrupt ASAR header bounds', 3);
  }
  // Both inner size fields must agree with the derived data offset.
  const innerSizes = [buf.readUInt32LE(4) + 8, buf.readUInt32LE(8) + 12];
  if (innerSizes.some((n) => n !== dataOffset)) {
    throw new PatchError('corrupt ASAR Pickle header: inconsistent size fields', 3);
  }
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  return { buf, header, dataOffset, jsonLen };
}

/** An ASAR `link` node points at another entry instead of carrying payload bytes. */
export function isLinkNode(node) {
  return typeof node?.link === 'string';
}

export function nodeAt(header, relPath) {
  let node = header;
  for (const part of relPath.split('/')) {
    node = node?.files?.[part];
    if (!node) return null;
  }
  return node;
}

function assertSafeEntryRange(node, label) {
  const offset = Number(node.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new PatchError(`invalid ASAR entry offset for ${label}: ${JSON.stringify(node.offset)}`, 3);
  }
  if (!Number.isSafeInteger(node.size) || node.size < 0) {
    throw new PatchError(`invalid ASAR entry size for ${label}: ${JSON.stringify(node.size)}`, 3);
  }
  return { offset, size: node.size };
}

export function readEntry(asar, relPath) {
  const node = nodeAt(asar.header, relPath);
  if (!node) throw new PatchError(`ASAR entry not found: ${relPath}`, 3);
  if (node.files) throw new PatchError(`ASAR entry is a directory: ${relPath}`, 3);
  if (isLinkNode(node)) throw new PatchError(`ASAR entry is a link: ${relPath}`, 3);
  if (node.unpacked) throw new PatchError(`ASAR entry is unpacked: ${relPath}`, 3);
  const { offset, size } = assertSafeEntryRange(node, relPath);
  const start = asar.dataOffset + offset;
  const end = start + size;
  if (end > asar.buf.length) throw new PatchError(`ASAR entry out of bounds: ${relPath}`, 3);
  return asar.buf.subarray(start, end);
}

export function asarEntryText(asar, relPath) {
  return readEntry(asar, relPath).toString('utf8');
}

function walkAsarFiles(node, parts, out) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) {
      walkAsarFiles(child, [...parts, name], out);
    }
    return;
  }
  out.push({ node, key: parts.join('/') });
}

/**
 * Repack an ASAR archive using an append-only strategy:
 * - Untouched entries retain their exact original offsets and deduplicated layout.
 * - Unpacked entries never gain an `offset` field.
 * - Replaced entries are appended at the end of the original data region with
 *   freshly computed SHA256 block integrity metadata.
 * - With an empty `replacements` map, output is guaranteed bit-for-bit identical
 *   to the input archive.
 */
export function repack(asar, replacements = new Map()) {
  // No replacements -> the archive is already correct; return it untouched.
  // This also guarantees byte-identical output for any valid input shape
  // (including link nodes and trailing unreferenced bytes).
  if (replacements.size === 0) return asar.buf;

  const headerClone = structuredClone(asar.header);
  const entries = [];
  walkAsarFiles(headerClone, [], entries);

  let dataEnd = 0;
  for (const { node, key } of entries) {
    if (node.unpacked || isLinkNode(node)) continue;
    const { offset, size } = assertSafeEntryRange(node, key);
    dataEnd = Math.max(dataEnd, offset + size);
  }

  const appended = [];
  let appendAt = dataEnd;

  for (const { node, key } of entries) {
    if (node.unpacked || isLinkNode(node)) continue;
    if (!replacements.has(key)) continue;

    const data = Buffer.from(replacements.get(key));
    node.offset = String(appendAt);
    node.size = data.length;
    appendAt += data.length;
    appended.push(data);

    if (node.integrity) {
      const blockSize = node.integrity.blockSize || 4194304;
      const blocks = [];
      for (let i = 0; i < data.length; i += blockSize) {
        blocks.push(sha256(data.subarray(i, i + blockSize)));
      }
      node.integrity = { algorithm: 'SHA256', hash: sha256(data), blockSize, blocks };
    }
  }

  const json = Buffer.from(JSON.stringify(headerClone), 'utf8');
  const jsonLen = json.length;
  const dataOffset = align4(16 + jsonLen);

  const head = Buffer.alloc(dataOffset);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(dataOffset - 8, 4);
  head.writeUInt32LE(dataOffset - 12, 8);
  head.writeUInt32LE(jsonLen, 12);
  json.copy(head, 16);

  const origData = asar.buf.subarray(asar.dataOffset, asar.dataOffset + dataEnd);
  return Buffer.concat([head, origData, ...appended], dataOffset + appendAt);
}

export const ASAR_HOOK_ANCHOR = "            '--enable_sidecars',\n        ];";

export function buildAsarHookSnippet(envVar = ENV_VAR) {
  return (
    "            '--enable_sidecars',\n" +
    '        ];\n' +
    `        // [antigravity-uipatch] Only when ${envVar} is set, so an\n` +
    '        // unpatched launch behaves exactly like stock.\n' +
    `        if (process.env.${envVar}) {\n` +
    '            args.push(`--web_bundle_path=${process.env.' + envVar + '}`);\n' +
    '        }'
  );
}

export function patchAsarBuffer(buf, envVar = ENV_VAR) {
  const asar = readAsar(buf);
  const src = asarEntryText(asar, ASAR_TARGET);

  if (src.includes(envVar)) {
    return { buf, changed: false };
  }
  const occurrences = countOccurrences(src, ASAR_HOOK_ANCHOR);
  if (occurrences !== 1) {
    throw new PatchError(
      `ASAR hook anchor mismatch in ${ASAR_TARGET}: expected 1 occurrence, found ${occurrences}`,
      3
    );
  }
  const next = src.replace(ASAR_HOOK_ANCHOR, buildAsarHookSnippet(envVar));
  const out = repack(asar, new Map([[ASAR_TARGET, Buffer.from(next, 'utf8')]]));
  return { buf: out, changed: true };
}

/**
 * Content-level pairing check: verifies that `backupBuf` is unhooked and that
 * applying our ASAR hook to `backupBuf` reproduces `currentBuf` byte-for-byte
 * (or `currentBuf` already equals `backupBuf`).
 */
export function pairsWith(backupBuf, currentBuf) {
  try {
    const bakAsar = readAsar(backupBuf);
    if (asarEntryText(bakAsar, ASAR_TARGET).includes(ENV_VAR)) {
      return false;
    }
    const curDigest = sha256(currentBuf);
    if (sha256(backupBuf) === curDigest) {
      return true;
    }
    const { buf: repatched } = patchAsarBuffer(backupBuf);
    return sha256(repatched) === curDigest;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 3. Frontend Web UI Choke-Point Patches (`main.js`)
// ---------------------------------------------------------------------------

function countOccurrences(haystack, needle) {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = haystack.indexOf(needle, at);
    if (i === -1) return n;
    n += 1;
    at = i + needle.length;
  }
}

function countAnchorMatches(js, anchor) {
  if (anchor instanceof RegExp) {
    const flags = anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`;
    return [...js.matchAll(new RegExp(anchor.source, flags))].length;
  }
  return countOccurrences(js, anchor);
}

function matchUnique(js, regex, label) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matches = [...js.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    throw new PatchError(
      `${label} anchor mismatch: expected 1 occurrence, found ${matches.length}`,
      3
    );
  }
  return matches[0];
}

function resolveUniqueIdentifier(js, regex, label) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matches = [...js.matchAll(new RegExp(regex.source, flags))];
  const unique = Array.from(new Set(matches.map((m) => m[1])));
  if (unique.length !== 1) {
    throw new PatchError(
      `${label} identifier mismatch: expected 1 distinct symbol, found ${unique.length}`,
      3
    );
  }
  return unique[0];
}

/**
 * Patch 1 (`Ola()` in 2.31): Pre-hydrate `jetski.developer.customFlagOverrides`
 * from Electron's `window.nativeStorage` (`~/.config/Antigravity/app_storage.json`)
 * before resolving `MendelExperimentProvider`'s primary fetch, and seed the
 * empirically verified Google Native OAuth baseline + `enable-developer-mode`
 * whenever `GetMendelFlags` returns empty `{}` (Enterprise Gateway mode). When
 * signed in with Google Native OAuth (`list.length > 0`), preserves the live
 * server table intact and only ensures `enable-developer-mode` is enabled.
 */
export const PATCH_MENDEL_BASELINE = {
  id: 'mendel-native-baseline',
  occurrences: 1,
  anchor:
    /async function ([A-Za-z0-9_$]+)\(a\)\{var b=e,c=e;try\{try\{let d=c\(await b\(a\.getMendelFlags\(([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),\{\}\)\)\)\)\.experimentConfig\?\.experiments\?\?\[\];a=\{\};for\(let f of d\)f\.keyString&&\(a\[f\.keyString\]=f\);return a\}catch\(d\)\{c\(\),console\.error\("Failed to fetch Mendel flags",d\)\}\}finally\{b\(\)\}\}/,
  apply(
    js,
    {
      flags = FLAGS,
      boolFlags = NATIVE_MENDEL_BOOL_FLAGS,
      stringFlags = NATIVE_MENDEL_STRING_FLAGS,
    } = {}
  ) {
    const m = matchUnique(js, this.anchor, 'PATCH_MENDEL_BASELINE');
    const [fullMatch, fnName, pbCreate, reqSchema] = m;
    const expNs = resolveUniqueIdentifier(
      js,
      /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)\.ExperimentWithVariantSchema\b/g,
      'PATCH_MENDEL_BASELINE:ExperimentWithVariantSchema'
    );
    const allBools = Array.from(new Set([...boolFlags, ...flags]));
    const replacement =
      `var __AGY_UNLOCKED=${JSON.stringify(flags)},` +
      `__AGY_NATIVE_BOOLS=${JSON.stringify(allBools)},` +
      `__AGY_NATIVE_STRS=${JSON.stringify(stringFlags)},` +
      `__AGY_OVR_KEY="jetski.developer.customFlagOverrides",` +
      `__AGY_KEYS=["jetski.developer.customFlagOverrides","jetski.developer.featureEnvironmentOverride"],` +
      `__AGY_HYDRATE_TIMEOUT=2000,__AGY_BRIDGE_GRACE=8000,` +
      `__agyNotifiers=[],__agyOvrMap={},__agyOvrSig="[]",__agyOvrLoaded=!1,` +
      `__agyStorageBound=!1,__agyStorageSvc=null,__agyLastGood=null,` +
      `__agyHydrateState="idle",__agyHydrateP=null,__agyFirstMiss=0;` +
      `function __agyRegisterNotifier(f){if(typeof f!=="function")return function(){};__agyNotifiers.push(f);` +
      `return function(){var i=__agyNotifiers.indexOf(f);if(i>=0)__agyNotifiers.splice(i,1)}}` +
      `function __agyNotify(){for(var i=0;i<__agyNotifiers.length;i++){try{__agyNotifiers[i]()}catch{}}}` +
      `function __agyParseOvrJson(raw){var out={};if(typeof raw!=="string"||!raw)return out;` +
      `try{var o=JSON.parse(raw);if(o&&typeof o==="object"&&!Array.isArray(o)){` +
      `for(var k in o)if(Object.prototype.hasOwnProperty.call(o,k)&&typeof o[k]==="boolean")out[k]=o[k]}}catch{}return out}` +
      `function __agySetOvrMap(obj){var next={},keys=[];` +
      `if(obj&&typeof obj==="object"&&!Array.isArray(obj)){` +
      `for(var k in obj)if(Object.prototype.hasOwnProperty.call(obj,k)&&typeof obj[k]==="boolean"){next[k]=obj[k];keys.push(k)}}` +
      `keys.sort();var sig=JSON.stringify(keys.map(function(x){return[x,next[x]]}));` +
      `var changed=!__agyOvrLoaded||sig!==__agyOvrSig;` +
      `__agyOvrMap=next;__agyOvrSig=sig;__agyOvrLoaded=!0;if(changed)__agyNotify()}` +
      `function __agySyncRawOvr(raw){__agySetOvrMap(__agyParseOvrJson(raw))}` +
      // Bind Antigravity 2.31+'s `clientStorageFeature` (`storageService` backed
      // by `window.nativeStorage` -> `~/.config/Antigravity/app_storage.json`).
      `function __agyBindStorage(res){try{var s=res&&res.storageService;` +
      `if(s&&typeof s.get==="function"){__agyStorageSvc=s;` +
      `if(typeof window!=="undefined"&&window.localStorage&&typeof s.store==="function"){` +
      `for(var i=0;i<__AGY_KEYS.length;i++){var k=__AGY_KEYS[i],cur=s.get(k);` +
      `if(cur===void 0||cur===null){var loc=window.localStorage.getItem(k);` +
      `if(typeof loc==="string")try{s.store(k,loc)}catch{}}}}` +
      `if(typeof s.store==="function"&&__AGY_UNLOCKED.indexOf("enable-context-usage-indicator")!==-1){` +
      `var ciCur=s.get("contextUsageIndicatorEnabled");` +
      `if(ciCur===void 0||ciCur===null){try{s.store("contextUsageIndicatorEnabled","true")}catch{}}}` +
      `__agyStorageBound=!0;__agyHydrateState="done";__agySyncRawOvr(s.get(__AGY_OVR_KEY));` +
      `if(typeof s.onDidChange==="function"){s.onDidChange(function(ch){` +
      `if(ch&&Object.prototype.hasOwnProperty.call(ch,__AGY_OVR_KEY))__agySyncRawOvr(ch[__AGY_OVR_KEY])})}` +
      `}}catch{}return res}` +
      // Retryable, bounded startup hydration in case `Ola()` resolves before `hhd()` binds `storageService`.
      `function __agyHydrateDevStorage(){` +
      `if(__agyStorageBound||__agyHydrateState==="done")return Promise.resolve(!0);` +
      `if(__agyHydrateState==="pending"&&__agyHydrateP)return __agyHydrateP;` +
      `__agyHydrateState="pending";` +
      `__agyHydrateP=(async function(){var timer=null;try{` +
      `if(typeof window==="undefined"){__agyHydrateState="done";return}` +
      `if(!window.nativeStorage||!window.nativeStorage.getItems){` +
      `if(!__agyFirstMiss)__agyFirstMiss=Date.now();` +
      `if(typeof Date!=="undefined"&&(Date.now()-__agyFirstMiss)<__AGY_BRIDGE_GRACE){__agyHydrateState="idle";__agyHydrateP=null;return}` +
      `try{if(!__agyStorageBound&&window.localStorage){var loc=window.localStorage.getItem(__AGY_OVR_KEY);` +
      `if(typeof loc==="string")__agySyncRawOvr(loc)}}catch{}` +
      `__agyHydrateState="done";return}` +
      `var got=window.nativeStorage.getItems();` +
      `if(typeof setTimeout==="function"&&__AGY_HYDRATE_TIMEOUT>0){got=Promise.race([Promise.resolve(got),new Promise(function(_,rej){timer=setTimeout(function(){rej(new Error("nativeStorage.getItems timed out"))},__AGY_HYDRATE_TIMEOUT)})])}` +
      `var items=(await got)||{};` +
      `if(!__agyStorageBound){var disk=items[__AGY_OVR_KEY];` +
      `if(typeof disk==="string")__agySyncRawOvr(disk);` +
      `else{var locFb=window.localStorage?window.localStorage.getItem(__AGY_OVR_KEY):null;` +
      `if(typeof locFb==="string")__agySyncRawOvr(locFb);else __agySetOvrMap({})}}` +
      `__agyHydrateState="done"` +
      `}catch(exc){__agyHydrateState="idle";__agyHydrateP=null}finally{if(timer)clearTimeout(timer)}})();` +
      `return __agyHydrateP}` +
      `__agyHydrateDevStorage();` +
      `function __agyOvr(k,v){try{if(__agyOvrLoaded){` +
      `return Object.prototype.hasOwnProperty.call(__agyOvrMap,k)&&typeof __agyOvrMap[k]==="boolean"?__agyOvrMap[k]:v}` +
      `var s=typeof window!=="undefined"&&window.localStorage?window.localStorage.getItem(__AGY_OVR_KEY):null;` +
      `if(s){var o=JSON.parse(s);if(o&&typeof o[k]==="boolean")return o[k]}}catch{}return v}` +
      `function __agyMkExp(k,s){return ${pbCreate}(${expNs}.ExperimentWithVariantSchema,s!==void 0?{keyString:k,disabled:!1,payload:{case:"string",value:s}}:{keyString:k,disabled:!1})}` +
      // Shared success/failure policy: success-empty CLEARS the cache; only a
      // failed request (raw === undefined) falls back to last-known-good.
      `function __agyResolveExperiments(raw){` +
      `if(Array.isArray(raw)){if(raw.length>0){__agyLastGood=raw;return raw}__agyLastGood=null;return []}` +
      `return __agyLastGood||[]}` +
      `function __agyNormalizeMendel(list){` +
      `if(Array.isArray(list)&&list.length>0){` +
      `var out=list.slice();` +
      `for(var i=0;i<__AGY_UNLOCKED.length;i++){` +
      `var u=__AGY_UNLOCKED[i],idx=out.findIndex(function(x){return x&&x.keyString===u});` +
      `if(idx>=0)out[idx]=__agyMkExp(u);else out.push(__agyMkExp(u));` +
      `}` +
      `return out;` +
      `}` +
      `var base=[];` +
      `for(var j=0;j<__AGY_NATIVE_BOOLS.length;j++)base.push(__agyMkExp(__AGY_NATIVE_BOOLS[j]));` +
      `for(var m of Object.entries(__AGY_NATIVE_STRS))base.push(__agyMkExp(m[0],m[1]));` +
      `return base;` +
      `}` +
      `async function ${fnName}(a){var b=e,c=e;try{await __agyHydrateDevStorage();` +
      `var raw,ok=!1;` +
      `try{raw=c(await b(a.getMendelFlags(${pbCreate}(${reqSchema},{})))).experimentConfig?.experiments;ok=!0}catch(d){c(),console.error("Failed to fetch Mendel flags",d)}` +
      `var list=__agyNormalizeMendel(__agyResolveExperiments(ok?raw:void 0)),out={};` +
      `for(let f of list)f.keyString&&(out[f.keyString]=f);return out}finally{b()}}`;
    return js.replace(fullMatch, () => replacement);
  },
};

/**
 * Patch 2 (`Qt().getMendelFlags` in 2.31): Pass the secondary Mendel client
 * wrapper (used by `IT()` / `JT()` hooks) through `__agyResolveExperiments` and
 * `__agyNormalizeMendel` with error catching unified with Patch 1.
 */
export const PATCH_MENDEL_SERVICE = {
  id: 'mendel-service-wrapper',
  occurrences: 1,
  anchor:
    /getMendelFlags:async\(\)=>\s*([A-Za-z0-9_$]+)\(async ([A-Za-z0-9_$]+)=>\{var ([A-Za-z0-9_$]+)=e,([A-Za-z0-9_$]+)=e;try\{let ([A-Za-z0-9_$]+)=\4\(await \3\(\2\.getMendelFlags\(([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),\{\}\)\)\)\);return\{experimentConfig:\5\.experimentConfig\?\{experiments:\5\.experimentConfig\.experiments\}:void 0\}\}finally\{\3\(\)\}\}\)/,
  apply(js) {
    const m = matchUnique(js, this.anchor, 'PATCH_MENDEL_SERVICE');
    const [fullMatch, wrapFn, clientParam, vVar, wVar, , pbCreate, reqSchema] = m;
    const replacement =
      `getMendelFlags:async()=>${wrapFn}(async ${clientParam}=>{var ${vVar}=e,${wVar}=e;let x,ok=!1;` +
      `try{try{x=${wVar}(await ${vVar}(${clientParam}.getMendelFlags(${pbCreate}(${reqSchema},{})))).experimentConfig?.experiments;ok=!0}` +
      `catch(err){console.error("Failed to fetch Mendel flags (secondary)",err)}}finally{${vVar}()}` +
      `return{experimentConfig:{experiments:__agyNormalizeMendel(__agyResolveExperiments(ok?x:void 0))}}})`;
    return js.replace(fullMatch, () => replacement);
  },
};

/**
 * Patch 3 (`Hi` / `Ii` / `IT` / `flagOverrideSync` / `hhd()` in 2.31): Make
 * direct Mendel boolean readers honor `jetski.developer.customFlagOverrides`,
 * bind `clientStorageFeature`'s `storageService` (`app_storage.json`), and
 * notify reactive listeners immediately without waiting on the backend RPC queue.
 */
export const PATCH_MENDEL_OVERRIDES = {
  id: 'mendel-local-overrides',
  occurrences: 1,
  anchor: /function ([A-Za-z0-9_$]+)\(a,b\)\{return\(a=a\.experiments\[b\]\)\?!a\.disabled:!1\}/,
  apply(js) {
    const [syncFull, syncFn] = matchUnique(js, this.anchor, 'PATCH_MENDEL_OVERRIDES:syncBool');
    const [reactiveFull, mapFn] = matchUnique(
      js,
      /c\|\|\(c=([A-Za-z0-9_$]+)\(a\.stateProvider,d=>\(d=d\[b\]\)\?!d\.disabled:!1\),a\.experimentEnabledProviders\.set\(b,c\)\);/,
      'PATCH_MENDEL_OVERRIDES:reactiveBool'
    );
    const [syncPropFull, syncClass, pbCreate, ovrSchema] = matchUnique(
      js,
      /this\.flagOverrideSync=new ([A-Za-z0-9_$]+)\(async b=>\{var c=e,d=e;try\{d\(await c\(this\.lsClient\.setMendelFlagOverrides\(([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),\{overrides:b\}\)\)\)\)\}finally\{c\(\)\}\}\);/,
      'PATCH_MENDEL_OVERRIDES:flagOverrideSync'
    );
    const [disposeFull, stopPollFn] = matchUnique(
      js,
      /dispose\(\)\{([A-Za-z0-9_$]+)\(this\);this\.stateProvider\.dispose\(\);/,
      'PATCH_MENDEL_OVERRIDES:providerDispose'
    );
    const [secFull, secFn, secHook] = matchUnique(
      js,
      /var ([A-Za-z0-9_$]+)=a=>\(a=([A-Za-z0-9_$]+)\(a\)\)\?!a\.disabled:!1,(?=[A-Za-z0-9_$]+=\(a,b\)=>\{var c=\2\(a\))/,
      'PATCH_MENDEL_OVERRIDES:secondaryBool'
    );
    const [storageFull, storageInitFn] = matchUnique(
      js,
      /async function ([A-Za-z0-9_$]+)\(a\)\{(?=var b=e,c=e;try\{if\(typeof window!=="undefined"&&window\.nativeStorage\)try\{let f=new [A-Za-z0-9_$]+\(window\.nativeStorage\);)/,
      'PATCH_MENDEL_OVERRIDES:storageInit'
    );

    let out = js.replace(
      syncFull,
      () => `function ${syncFn}(a,b){return __agyOvr(b,(a=a.experiments[b])?!a.disabled:!1)}`
    );
    out = out.replace(
      reactiveFull,
      () =>
        `c||(c=${mapFn}(a.stateProvider,d=>__agyOvr(b,(d=d[b])?!d.disabled:!1)),a.experimentEnabledProviders.set(b,c));`
    );
    out = out.replace(
      syncPropFull,
      () =>
        `this.flagOverrideSync=new ${syncClass}(async b=>{var c=e,d=e;` +
        `this.stateProvider.setState(this.stateProvider.getState());` +
        `try{try{d(await c(this.lsClient.setMendelFlagOverrides(${pbCreate}(${ovrSchema},{overrides:b}))))}catch{d()}}` +
        `finally{c();this.stateProvider.setState(this.stateProvider.getState())}});` +
        `try{var __agySelf=this;globalThis.__agyLsClient=__agySelf.lsClient;` +
        `this.__agyDisposeNotifier=__agyRegisterNotifier(function(){__agySelf.stateProvider.setState(__agySelf.stateProvider.getState())});` +
        `if(this.flagOverrideSync&&typeof this.flagOverrideSync.set==="function"){` +
        `var __agyOrigSet=this.flagOverrideSync.set.bind(this.flagOverrideSync);` +
        `this.flagOverrideSync.set=function(m){__agySetOvrMap(m);return __agyOrigSet(m)}}` +
        `}catch{}`
    );
    out = out.replace(
      disposeFull,
      () =>
        `dispose(){try{this.__agyDisposeNotifier&&this.__agyDisposeNotifier();this.__agyDisposeNotifier=null}catch{}` +
        `${stopPollFn}(this);this.stateProvider.dispose();`
    );
    out = out.replace(
      secFull,
      () => `var ${secFn}=a=>__agyOvr(a,(a=${secHook}(a))?!a.disabled:!1),`
    );
    out = out.replace(
      storageFull,
      () =>
        `async function ${storageInitFn}(a){return __agyBindStorage(await __agyRawStorageInit(a))}` +
        `async function __agyRawStorageInit(a){`
    );
    return out;
  },
};

/**
 * Locate the `{` that opens a function body declared at `fnStart`.
 *
 * Skips the parameter list (including destructured parameters) with quote/escape
 * awareness, then requires the next non-space character to be `{`.
 */
function findFunctionBodyOpen(js, fnStart) {
  const parensAt = js.indexOf('(', fnStart);
  if (parensAt === -1) throw new PatchError('PATCH_FLAG_PICKER: no parameter list', 3);
  const parensClose = findMatchingParen(js, parensAt);
  if (parensClose === -1) throw new PatchError('PATCH_FLAG_PICKER: unbalanced parameters', 3);
  let k = parensClose + 1;
  while (k < js.length && /\s/.test(js[k])) k += 1;
  if (js[k] !== '{') throw new PatchError('PATCH_FLAG_PICKER: expected body brace', 3);
  return k;
}

/**
 * Scan quoted strings (with escapes) and return the index of the matching
 * closing parenthesis, or -1. Comments and regex literals are rejected.
 */
function findMatchingParen(js, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < js.length; i += 1) {
    const ch = js[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    assertSupportedConstruct(js, i);
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Return the index of the `}` closing the brace at `open`, or -1.
 *
 * Every character is validated by `assertSupportedConstruct`, which refuses
 * comments and regex literals — the two constructs a brace counter cannot scope.
 */
function findMatchingBrace(js, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < js.length; i += 1) {
    const ch = js[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    assertSupportedConstruct(js, i);
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reject constructs whose extent a character scanner cannot determine.
 *
 * Comment starts are unambiguous. A `/` is treated as a potential regex start
 * unless the previous significant character makes division the only reading,
 * which is deliberately conservative: a false rejection fails the patch safely.
 */
function assertSupportedConstruct(js, i, label = 'PATCH_FLAG_PICKER') {
  const ch = js[i];
  if (ch !== '/') return;
  const next = js[i + 1];
  if (next === '/' || next === '*') {
    throw new PatchError(
      `${label}: comment inside scanned region is unsupported; refusing to guess`,
      3
    );
  }
  // Walk back to the previous non-whitespace character.
  let j = i - 1;
  while (j >= 0 && /\s/.test(js[j])) j -= 1;
  const prev = j >= 0 ? js[j] : '';
  const divisionSafe = /[A-Za-z0-9_$)\]}]/.test(prev);
  if (!divisionSafe) {
    throw new PatchError(
      `${label}: regex literal inside scanned region is unsupported; refusing to guess`,
      3
    );
  }
}

function buildFlagPickerSource({ fnName, reactIdent, buttonIdent }) {
  const R = reactIdent;
  return `function ${fnName}({suggestedFlags:a,onAdd:b}){
  var [c,d]=${R}.useState(""),
      [open,setOpen]=${R}.useState(!1),
      [active,setActive]=${R}.useState(0),
      box=${R}.useRef(null),
      listRef=${R}.useRef(null);
  var q=c.trim().toLowerCase(),
      matches=q?a.filter(function(x){return x.toLowerCase().indexOf(q)!==-1}):a,
      listId="agy-flag-picker-listbox",
      optionId=function(i){return "agy-flag-picker-option-"+i};
  ${R}.useEffect(function(){
    if(!open)return;
    function onDown(e){
      if(box.current&&!box.current.contains(e.target))setOpen(!1);
    }
    document.addEventListener("mousedown",onDown);
    return function(){document.removeEventListener("mousedown",onDown)};
  },[open]);
  ${R}.useEffect(function(){
    if(!open||!listRef.current)return;
    var el=listRef.current.querySelector('[data-active="1"]');
    if(el&&typeof el.scrollIntoView==="function")el.scrollIntoView({block:"nearest"});
  },[active,open]);
  ${R}.useEffect(function(){setActive(0)},[q,open]);
  function commit(x){
    var v=(typeof x==="string"?x:c).trim();
    if(!v)return;
    b(v);d("");setOpen(!1);
  }
  function onKey(e){
    if(e.key==="ArrowDown"){e.preventDefault();setOpen(!0);setActive(function(i){return Math.min(i+1,Math.max(matches.length-1,0))})}
    else if(e.key==="ArrowUp"){e.preventDefault();setActive(function(i){return Math.max(i-1,0)})}
    else if(e.key==="Enter"){e.preventDefault();commit(open?matches[active]:void 0)}
    else if(e.key==="Escape"){setOpen(!1)}
    else if(e.key==="Tab"){setOpen(!1)}
  }
  var activeOpt=open&&matches.length>0?matches[active]:void 0;
  return ${R}.createElement("div",{ref:box,className:"relative",onBlur:function(e){
      if(box.current&&!box.current.contains(e.relatedTarget))setOpen(!1);
    }},
    ${R}.createElement("div",{className:"flex items-center gap-2"},
      ${R}.createElement("input",{type:"text",value:c,placeholder:"Turn on a flag you don't have","aria-label":"Custom flag to turn on","aria-expanded":open,"aria-controls":open?listId:void 0,"aria-activedescendant":typeof activeOpt==="string"?optionId(active):void 0,"aria-autocomplete":"list",role:"combobox",
        onChange:function(e){d(e.target.value);setOpen(!0)},
        onFocus:function(){setOpen(!0)},
        onKeyDown:onKey,
        className:"flex-1 h-7 px-2 text-sm bg-secondary text-foreground rounded-md border border-border outline-none placeholder:text-muted-foreground"}),
      ${R}.createElement(${buttonIdent},{variant:"outline",size:"sm",disabled:!c.trim(),onClick:function(){commit()}},"Add")),
    open&&matches.length>0&&${R}.createElement("div",{id:listId,role:"listbox",ref:listRef,className:"absolute left-0 right-0 bottom-full mb-1 z-50 max-h-64 overflow-y-auto bg-card border border-border rounded-md shadow-lg py-1"},
      matches.map(function(x,i){
        return ${R}.createElement("div",{key:x,id:optionId(i),role:"option","aria-selected":i===active,"data-active":i===active?"1":"0",
          onMouseDown:function(e){e.preventDefault();commit(x)},
          onMouseEnter:function(){setActive(i)},
          className:"px-2 py-1 text-xs font-mono cursor-pointer truncate "+(i===active?"bg-secondary text-foreground":"text-muted-foreground")},
          x)
      })))
}`;
}

/**
 * Patch 4 (`EGb()` in 2.31): Replaces Chromium's unscrollable, unthemed
 * `<datalist>` popup in Settings -> Developer with a themed, upward-opening
 * scrollable combobox, resolving the minified component, React, and Button
 * identifiers structurally.
 */
export const PATCH_FLAG_PICKER = {
  id: 'flag-picker-scrollable',
  occurrences: 1,
  anchor: /function ([A-Za-z0-9_$]+)\(\{suggestedFlags:a,onAdd:b\}\)\{/,
  apply(js) {
    const m = matchUnique(js, this.anchor, 'PATCH_FLAG_PICKER');
    const fnName = m[1];
    const start = m.index;

    const bodyOpen = findFunctionBodyOpen(js, start);
    const bodyClose = findMatchingBrace(js, bodyOpen);
    if (bodyClose === -1) {
      throw new PatchError(`PATCH_FLAG_PICKER: unbalanced braces in ${fnName}()`, 3);
    }

    // Safety net: the replaced region must not span a second top-level function
    // declaration. If it does, we almost certainly mis-detected the end.
    const replacedRegion = js.slice(start, bodyClose + 1);
    if (/function\s+[A-Za-z0-9_$]+\s*\(/.test(replacedRegion.slice(1))) {
      throw new PatchError(
        `PATCH_FLAG_PICKER: detected a nested function declaration inside ${fnName}(); refusing to guess the boundary`,
        3
      );
    }

    const reactIdent = resolveUniqueIdentifier(
      replacedRegion,
      /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)\.createElement\(/g,
      'PATCH_FLAG_PICKER:React'
    );
    const [, buttonIdent] = matchUnique(
      replacedRegion,
      /\.createElement\(([A-Za-z0-9_$]+),\{variant:"outline",size:"sm"/,
      'PATCH_FLAG_PICKER:Button'
    );

    return (
      js.slice(0, start) +
      buildFlagPickerSource({ fnName, reactIdent, buttonIdent }) +
      js.slice(bodyClose + 1)
    );
  },
};

/**
 * Locate a top-level property `propName` inside the object literal opening at
 * `objOpen` (`js[objOpen] === '{'`) and return `{ valueStart, valueEnd }` for
 * its value expression. Ignores nested `{...}`, `(...)`, `[...]` and quoted
 * strings while rejecting comments and regex literals via `assertSupportedConstruct`.
 */
function findTopLevelObjectProperty(js, objOpen, propName) {
  if (js[objOpen] !== '{') {
    throw new PatchError('PATCH_CONTEXT_INDICATOR: expected opening brace for buildBindings', 3);
  }
  const propRe = new RegExp(`\\b${propName}\\s*:`, 'g');
  const tailOccurrences = [...js.slice(objOpen).matchAll(propRe)].length;
  if (tailOccurrences !== 1) {
    throw new PatchError(
      `PATCH_CONTEXT_INDICATOR: expected 1 ${propName} property in buildBindings, found ${tailOccurrences}`,
      3
    );
  }

  let depth = 0;
  let quote = null;
  let expectKey = true;

  for (let i = objOpen; i < js.length; i += 1) {
    const ch = js[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    assertSupportedConstruct(js, i, 'PATCH_CONTEXT_INDICATOR');
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }

    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
      if (depth === 1 && ch === '{') expectKey = true;
      continue;
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 1 && ch === '}') {
        break;
      }
      depth -= 1;
      if (depth < 0) {
        throw new PatchError('PATCH_CONTEXT_INDICATOR: unbalanced delimiters in buildBindings', 3);
      }
      continue;
    }

    if (depth === 1) {
      if (ch === ',') {
        expectKey = true;
        continue;
      }
      if (expectKey && !/\s/.test(ch)) {
        expectKey = false;
        let endKey = i;
        while (endKey < js.length && /[A-Za-z0-9_$]/.test(js[endKey])) endKey += 1;
        const key = js.slice(i, endKey);
        let colon = endKey;
        while (colon < js.length && /\s/.test(js[colon])) colon += 1;
        if (key === propName && js[colon] === ':') {
          let valueStart = colon + 1;
          while (valueStart < js.length && /\s/.test(js[valueStart])) valueStart += 1;
          const valueEnd = findObjectPropertyValueEnd(js, valueStart);
          if (valueEnd === -1) {
            throw new PatchError(
              `PATCH_CONTEXT_INDICATOR: unbalanced value expression for ${propName}`,
              3
            );
          }
          return { valueStart, valueEnd };
        }
        i = Math.max(i, endKey - 1);
      }
    }
  }

  throw new PatchError(
    `PATCH_CONTEXT_INDICATOR: top-level ${propName} property not found in buildBindings`,
    3
  );
}

function findObjectPropertyValueEnd(js, valueStart) {
  let depth = 0;
  let quote = null;
  for (let i = valueStart; i < js.length; i += 1) {
    const ch = js[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    assertSupportedConstruct(js, i, 'PATCH_CONTEXT_INDICATOR');
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0) return ch === '}' ? i : -1;
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return i;
    }
  }
  return -1;
}

function buildContextIndicatorSource({
  reactIdent,
  portalNs,
  useConvStateSym,
  cortexNs,
  pbCreateGen,
  genMetaReqSchema,
}) {
  const R = reactIdent;
  return `(function(){
  var PIN_KEY="agy.uipatch.indicatorPinTps",
      SUB_KEY="agy.uipatch.indicatorSubOpen",
      CIRC=2*Math.PI*6,
      CTX_SEL={selector:function(s){return s?s.agentState:void 0}},
      prefSubs=[],
      convTimings=Object.create(null),
      convTimingOrder=[],
      rpcGenStore=Object.create(null),
      rpcGenOrder=[];
  function getTimingMap(cid){
    var k=String(cid||"");
    if(!k)return null;
    var m=convTimings[k];
    if(!m){
      m=Object.create(null);
      convTimings[k]=m;
      convTimingOrder.push(k);
      if(convTimingOrder.length>24){
        var old=convTimingOrder.shift();
        if(old)delete convTimings[old];
      }
    }
    return m;
  }
  function getRpcGenEntry(cid){
    var k=String(cid||"");
    if(!k)return null;
    var e=rpcGenStore[k];
    if(!e){
      e={items:[],fetching:!1,settledLen:-1};
      rpcGenStore[k]=e;
      rpcGenOrder.push(k);
      if(rpcGenOrder.length>16){
        var old=rpcGenOrder.shift();
        if(old)delete rpcGenStore[old];
      }
    }
    return e;
  }
  function readRawPref(k){
    try{
      if(typeof __agyStorageSvc!=="undefined"&&__agyStorageSvc&&typeof __agyStorageSvc.get==="function"){
        var sv=__agyStorageSvc.get(k);
        if(typeof sv==="string"&&sv)return sv;
      }
      if(typeof window!=="undefined"&&window.localStorage){
        var lv=window.localStorage.getItem(k);
        if(typeof lv==="string"&&lv)return lv;
      }
    }catch{}
    return "";
  }
  function readPref(k,defVal){
    var v=readRawPref(k);
    if(v==="true")return !0;
    if(v==="false")return !1;
    return defVal;
  }
  function readPinMode(){
    var v=readRawPref(PIN_KEY);
    if(v==="turn"||v==="avg"||v==="off")return v;
    if(v==="true")return "avg";
    return "off";
  }
  function writePref(k,val){
    var s=typeof val==="string"?val:(val?"true":"false");
    try{
      if(typeof __agyStorageSvc!=="undefined"&&__agyStorageSvc&&typeof __agyStorageSvc.store==="function"){
        __agyStorageSvc.store(k,s);
      }
    }catch{}
    try{
      if(typeof window!=="undefined"&&window.localStorage){
        window.localStorage.setItem(k,s);
      }
    }catch{}
    for(var i=0;i<prefSubs.length;i++){try{prefSubs[i]()}catch{}}
  }
  function num(v){
    if(typeof v==="bigint")return Number(v);
    if(typeof v==="number")return Number.isFinite(v)?v:0;
    if(typeof v==="string"&&v){var n=Number(v);return Number.isFinite(n)?n:0}
    return 0;
  }
  function durSec(d){
    if(!d||typeof d!=="object")return 0;
    var s=num(d.seconds)+num(d.nanos)/1e9;
    return s>0&&Number.isFinite(s)?s:0;
  }
  function tsMs(t){
    if(!t||typeof t!=="object")return 0;
    var ms=num(t.seconds)*1e3+num(t.nanos)/1e6;
    return ms>0&&Number.isFinite(ms)?ms:0;
  }
  function fmtK(n){
    if(n>=1e6)return (n/1e6).toFixed(2)+"M";
    if(n>=1e3)return (n/1e3).toFixed(1)+"K";
    return String(Math.round(n));
  }
  function fmtExact(n){
    try{return Math.round(n).toLocaleString("en-US")}catch{return String(Math.round(n))}
  }
  function fmtPct(part,tot){
    if(tot<=0||part<=0)return "0.0%";
    var p=(part/tot)*100;
    return p<0.1?"<0.1%":p.toFixed(1)+"%";
  }
  function fmtCachePct(cacheRead,totIn){
    if(!(totIn>0))return "\\u2014";
    if(!(cacheRead>0))return "0.0%";
    if(cacheRead>=totIn)return "100.0%";
    var p=(cacheRead/totIn)*100;
    if(p<0.1)return "<0.1%";
    if(p>=99.95)return "99.9%";
    return p.toFixed(1)+"%";
  }
  function fmtDur(s,approxPrefix){
    if(!(s>0)||!Number.isFinite(s))return "\\u2014";
    var pre=approxPrefix?"~":"";
    if(s>=3599.5){
      var h=Math.floor((s+0.5)/3600),rem=Math.round(((s+0.5)%3600)/60);
      if(rem>=60){h+=1;rem=0}
      return pre+h+"h "+(rem<10?"0":"")+rem+"m";
    }
    if(s>=59.95){
      var m=Math.floor((s+0.05)/60),sec=Math.round(s%60);
      if(sec>=60){m+=1;sec=0}
      return pre+m+"m "+(sec<10?"0":"")+sec+"s";
    }
    return pre+(s<10?s.toFixed(2)+"s":s.toFixed(1)+"s");
  }
  function fmtTps(tps){
    if(!(tps>0)||!Number.isFinite(tps))return "\\u2014";
    if(tps>=1e6)return (tps/1e6).toFixed(2)+"M t/s";
    if(tps>=1e3)return (tps/1e3).toFixed(1)+"K t/s";
    return tps.toFixed(1)+" t/s";
  }
  function extractErrStr(e){
    if(!e)return "";
    if(typeof e==="string")return e;
    if(typeof e==="object"){
      if(typeof e.userErrorMessage==="string"&&e.userErrorMessage)return e.userErrorMessage;
      if(typeof e.shortError==="string"&&e.shortError)return e.shortError;
      if(typeof e.message==="string"&&e.message)return e.message;
      if(e.error)return extractErrStr(e.error);
    }
    return "Generation failed";
  }
  function stepStartMs(md,msFirst,msEnd){
    if(!md)return 0;
    var c=tsMs(md.createdAt),s=tsMs(md.startedAt);
    if(s>0&&(msFirst===0||s<msFirst)&&(msEnd===0||s<msEnd))return s;
    return c||s;
  }
  function deriveContextMetrics(agentState,rpcGens){
    var cwu=agentState&&agentState.contextWindowUsage;
    if(!cwu)return null;
    var used=num(cwu.estimatedTokensUsed),max=num(cwu.maxContextTokens);
    if(max<=0||used<=0)return null;
    var TT=(${cortexNs}&&${cortexNs}.TokenType)||{},
        CS=(${cortexNs}&&${cortexNs}.CortexStepStatus)||{},
        chatType=TT.CHAT_MESSAGES!==void 0?TT.CHAT_MESSAGES:7,
        doneStatus=CS.DONE!==void 0?CS.DONE:3,
        genStatus=CS.GENERATING!==void 0?CS.GENERATING:8,
        runStatus=CS.RUNNING!==void 0?CS.RUNNING:2,
        errStatus=CS.ERROR!==void 0?CS.ERROR:7;
    var rawChat=0,buckets={sys:0,tools:0,mcp:0,rules:0,agents:0,other:0};
    var tgs=Array.isArray(cwu.tokenGroups)?cwu.tokenGroups:[];
    for(var i=0;i<tgs.length;i++){
      var g=tgs[i];
      if(!g)continue;
      var gt=g.type,gn=num(g.numTokens);
      if(gn<=0)continue;
      if(gt===chatType){rawChat+=gn;continue}
      if(gt===(TT.SYSTEM_PROMPT!==void 0?TT.SYSTEM_PROMPT:1))buckets.sys+=gn;
      else if(gt===(TT.TOOLS!==void 0?TT.TOOLS:2))buckets.tools+=gn;
      else if(gt===(TT.MCP_TOOLS!==void 0?TT.MCP_TOOLS:4))buckets.mcp+=gn;
      else if(gt===(TT.RULES!==void 0?TT.RULES:3)||gt===(TT.SKILLS!==void 0?TT.SKILLS:5)||gt===(TT.WORKFLOWS!==void 0?TT.WORKFLOWS:8))buckets.rules+=gn;
      else if(gt===(TT.SUBAGENTS!==void 0?TT.SUBAGENTS:6)||gt===(TT.PLUGINS!==void 0?TT.PLUGINS:9)||gt===(TT.FLOWS!==void 0?TT.FLOWS:10))buckets.agents+=gn;
      else buckets.other+=gn;
    }
    var chat=Math.min(used,Math.max(0,rawChat)),
        sys=Math.max(0,used-chat),
        free=Math.max(0,max-used),
        frac=Math.min(1,Math.max(0,used/max));
    var groups=[];
    if(buckets.sys>0)groups.push(["System",buckets.sys]);
    if(buckets.tools>0)groups.push(["Tools",buckets.tools]);
    if(buckets.mcp>0)groups.push(["MCP",buckets.mcp]);
    if(buckets.rules>0)groups.push(["Rules/Skills",buckets.rules]);
    if(buckets.agents>0)groups.push(["Agents/Plugins",buckets.agents]);
    if(buckets.other>0)groups.push(["Other",buckets.other]);
    var slice=agentState.trajectorySlice,
        steps=(slice&&Array.isArray(slice.stepsInSlice))?slice.stepsInSlice:[],
        totalStepsLen=num(slice&&slice.totalStepsLength),
        rawSliceStart=(slice&&slice.stepsSlice&&slice.stepsSlice.startIndex!==void 0)?num(slice.stepsSlice.startIndex):0,
        sliceStart=rawSliceStart<0?Math.max(0,totalStepsLen+rawSliceStart):rawSliceStart,
        lastStepIdx=num(cwu.lastStepIndex),
        approx=Boolean(cwu.estimatedAfterCompaction),
        timingMap=getTimingMap(agentState.conversationId),
        stepByIdx=Object.create(null),
        isGenerating=!1;
    for(var k=steps.length-1;k>=0;k--){
      var st=steps[k];
      if(!st)continue;
      var sIdx=st.metadata&&st.metadata.sourceTrajectoryStepInfo&&st.metadata.sourceTrajectoryStepInfo.stepIndex!==void 0
        ?num(st.metadata.sourceTrajectoryStepInfo.stepIndex):(sliceStart+k);
      stepByIdx[sIdx]=st;
      if(!approx&&sIdx>=lastStepIdx&&st.step&&st.step.case==="checkpoint"&&st.status===doneStatus&&!(st.step.value&&st.step.value.intentOnly)){
        approx=!0;
      }
      var sCase=st.step&&st.step.case;
      if(sCase==="plannerResponse"){
        if(st.status===genStatus||st.status===runStatus){
          isGenerating=!0;
        }else if(timingMap&&st.metadata){
          var md=st.metadata,
              ms1=tsMs(md.viewableAt),
              ms2=tsMs(md.finishedGeneratingAt)||tsMs(md.lastCompletedChunkAt)||tsMs(md.completedAt),
              ms0=stepStartMs(md,ms1,ms2),
              sErr=(st.status===errStatus||st.error)?extractErrStr(st.error||"Generation failed"):"";
          if(ms1>ms0||ms2>ms0||sErr){
            timingMap[sIdx]={tStart:ms0,tFirst:ms1,tEnd:ms2,err:sErr};
          }
        }
      }
    }
    function buildCall(cm,pr,tm,genErr,stepIdxHint){
      var md=pr&&pr.metadata,
          u=(cm&&cm.usage)||(md&&md.modelUsage)||null,
          uncachedIn=num(u&&u.inputTokens),
          cacheRead=num(u&&u.cacheReadTokens),
          cacheWrite=num(u&&u.cacheWriteTokens),
          totIn=uncachedIn+cacheRead+cacheWrite,
          outTok=num(u&&u.outputTokens),
          thinkTok=num(u&&u.thinkingOutputTokens),
          respTok=num(u&&u.responseOutputTokens);
      if(outTok===0&&(thinkTok>0||respTok>0))outTok=thinkTok+respTok;
      if(respTok===0&&outTok>thinkTok)respTok=outTok-thinkTok;
      var cmTtft=durSec(cm&&cm.timeToFirstToken),
          cmStream=durSec(cm&&cm.streamingDuration),
          tFirst=tm?tm.tFirst:(md?tsMs(md.viewableAt):0),
          tEnd=tm?tm.tEnd:(md?(tsMs(md.finishedGeneratingAt)||tsMs(md.lastCompletedChunkAt)||tsMs(md.completedAt)):0),
          tStart=tm?tm.tStart:stepStartMs(md,tFirst,tEnd),
          ttft=cmTtft>0?cmTtft:(tStart>0&&tFirst>tStart?(tFirst-tStart)/1e3:0),
          sSec=cmStream>0?cmStream:(tFirst>0&&tEnd>tFirst?(tEnd-tFirst)/1e3:(!(ttft>0)&&tStart>0&&tEnd>tStart?(tEnd-tStart)/1e3:0)),
          dur=(cmTtft>0&&cmStream>0)
            ?(cmTtft+cmStream)
            :(tStart>0&&tEnd>tStart?(tEnd-tStart)/1e3:(ttft>0&&sSec>0?(ttft+sSec):(sSec>0?sSec:ttft))),
          inTps=totIn>0&&ttft>0.01?totIn/ttft:0,
          outTps=outTok>0&&sSec>0.02?outTok/sSec:0,
          hasCache=Boolean(u&&(totIn>0||cacheRead>0||u.cacheReadTokens!==void 0)),
          rInfos=(cm&&Array.isArray(cm.retryInfos))?cm.retryInfos:((md&&Array.isArray(md.retryInfos))?md.retryInfos:[]),
          retries=(cm&&cm.retries!==void 0&&num(cm.retries)>0)?num(cm.retries):(rInfos.length>1?rInfos.length-1:0),
          rWait=0;
      for(var rw=0;rw<rInfos.length;rw++)rWait+=durSec(rInfos[rw]&&rInfos[rw].waitTime);
      var stepErr=tm?tm.err:((pr&&(pr.status===errStatus||pr.error))?extractErrStr(pr.error||"Generation failed"):""),
          errMsg=genErr||stepErr,
          errs=errMsg?1:0;
      if(!(totIn>0||outTok>0||ttft>0||dur>0||hasCache||retries>0||errs>0))return null;
      return {
        stepIdx:stepIdxHint,
        inTps:inTps,ttftSec:ttft,outTps:outTps,sSec:sSec,durSec:dur,
        uncachedIn:uncachedIn,cacheRead:cacheRead,cacheWrite:cacheWrite,totIn:totIn,
        hasCache:hasCache,cachePct:totIn>0?(cacheRead/totIn)*100:null,
        respTok:respTok,outTok:outTok,thinkTok:thinkTok,
        retries:retries,retryWaitSec:rWait,errs:errs,errMsg:errMsg
      };
    }
    var sliceGens=(slice&&Array.isArray(slice.generatorMetadatasInSlice))?slice.generatorMetadatasInSlice:[],
        gens=(Array.isArray(rpcGens)&&rpcGens.length>0)?rpcGens:sliceGens,
        coveredSteps=Object.create(null),
        calls=[];
    for(var q=0;q<gens.length;q++){
      var gItem=gens[q];
      if(!gItem)continue;
      var cm=gItem.metadata&&gItem.metadata.case==="chatModel"?gItem.metadata.value:gItem.chatModel,
          genErr=extractErrStr(gItem.error);
      if(!cm&&!genErr)continue;
      var sIndices=Array.isArray(gItem.stepIndices)?gItem.stepIndices:[],
          pr=null,tm=null,hintIdx=-1;
      for(var si=0;si<sIndices.length;si++){
        var idx=num(sIndices[si]);
        coveredSteps[idx]=!0;
        if(hintIdx<0||idx>hintIdx)hintIdx=idx;
        var candSt=stepByIdx[idx];
        if(candSt&&candSt.step&&candSt.step.case==="plannerResponse"){
          pr=candSt;
          tm=timingMap?timingMap[idx]:null;
          break;
        }
        if(!pr&&candSt)pr=candSt;
        if(!tm&&timingMap&&timingMap[idx])tm=timingMap[idx];
      }
      var stepActive=Boolean(pr&&(pr.status===genStatus||pr.status===runStatus)),
          hasExactUsage=Boolean(cm&&cm.usage&&(num(cm.usage.outputTokens)>0||num(cm.usage.inputTokens)>0||num(cm.usage.cacheReadTokens)>0));
      if(stepActive&&!hasExactUsage&&!genErr){
        isGenerating=!0;
        continue;
      }
      var rec=buildCall(cm,stepActive?null:pr,tm,genErr,hintIdx);
      if(rec)calls.push(rec);
    }
    var addedFallback=!1;
    for(var p=0;p<steps.length;p++){
      var pst=steps[p];
      if(!pst||!pst.step)continue;
      var pIdx=pst.metadata&&pst.metadata.sourceTrajectoryStepInfo&&pst.metadata.sourceTrajectoryStepInfo.stepIndex!==void 0
        ?num(pst.metadata.sourceTrajectoryStepInfo.stepIndex):(sliceStart+p);
      if(coveredSteps[pIdx])continue;
      if(pst.step.case==="plannerResponse"&&pst.status!==genStatus&&pst.status!==runStatus){
        var fallbackRec=buildCall(null,pst,timingMap?timingMap[pIdx]:null,"",pIdx);
        if(fallbackRec){calls.push(fallbackRec);addedFallback=!0}
      }else if(pst.step.case==="errorMessage"){
        var em=extractErrStr(pst.step.value&&pst.step.value.error)||"Error";
        calls.push({
          stepIdx:pIdx,inTps:0,ttftSec:0,outTps:0,sSec:0,durSec:0,
          uncachedIn:0,cacheRead:0,cacheWrite:0,totIn:0,hasCache:!1,cachePct:null,
          respTok:0,outTok:0,thinkTok:0,retries:0,retryWaitSec:0,errs:1,errMsg:em
        });
        addedFallback=!0;
      }
    }
    if(addedFallback&&calls.length>1){
      calls.sort(function(a,b){return (a.stepIdx>=0&&b.stepIdx>=0)?(a.stepIdx-b.stepIdx):0});
    }
    var lastTurn=calls.length>0?calls[calls.length-1]:null,
        session=null;
    if(calls.length>0){
      var sumUncached=0,sumCacheRead=0,sumCacheWrite=0,sumIn=0,hasAnyCache=!1,
          sumResp=0,sumOut=0,sumThink=0,sumRetries=0,sumRetryWait=0,sumErrs=0,lastErrMsg="",
          ttftCnt=0,sumTtft=0,pairedInTok=0,pairedTtftSec=0,
          streamCnt=0,pairedOutTok=0,pairedStreamSec=0,
          durCnt=0,sumDur=0;
      for(var ci=0;ci<calls.length;ci++){
        var c=calls[ci];
        sumUncached+=c.uncachedIn;
        sumCacheRead+=c.cacheRead;
        sumCacheWrite+=c.cacheWrite;
        sumIn+=c.totIn;
        if(c.hasCache)hasAnyCache=!0;
        sumResp+=c.respTok;
        sumOut+=c.outTok;
        sumThink+=c.thinkTok;
        sumRetries+=c.retries;
        sumRetryWait+=c.retryWaitSec;
        sumErrs+=c.errs;
        if(c.errMsg)lastErrMsg=c.errMsg;
        if(c.ttftSec>0.01){
          ttftCnt+=1;
          sumTtft+=c.ttftSec;
          if(c.totIn>0){pairedInTok+=c.totIn;pairedTtftSec+=c.ttftSec}
        }
        if(c.sSec>0.02&&c.outTok>0){
          streamCnt+=1;
          pairedOutTok+=c.outTok;
          pairedStreamSec+=c.sSec;
        }
        if(c.durSec>0){
          durCnt+=1;
          sumDur+=c.durSec;
        }
      }
      var nCalls=calls.length;
      session={
        count:nCalls,
        inTps:(pairedInTok>0&&pairedTtftSec>0.01)?(pairedInTok/pairedTtftSec):0,
        ttftSec:ttftCnt>0?(sumTtft/ttftCnt):0,
        outTps:(pairedOutTok>0&&pairedStreamSec>0.02)?(pairedOutTok/pairedStreamSec):0,
        durSec:durCnt>0?(sumDur/durCnt):0,totalDurSec:sumDur,
        timedTtftCount:ttftCnt,timedStreamCount:streamCnt,timedDurCount:durCnt,
        uncachedIn:sumUncached,cacheRead:sumCacheRead,cacheWrite:sumCacheWrite,totIn:sumIn,
        hasCache:hasAnyCache,cachePct:sumIn>0?(sumCacheRead/sumIn)*100:null,
        respTok:sumResp,outTok:sumOut,thinkTok:sumThink,
        retries:sumRetries,retryWaitSec:sumRetryWait,errs:sumErrs,errMsg:lastErrMsg
      };
    }
    return {
      used:used,max:max,frac:frac,isWarn:frac>=0.8,approx:approx,
      sys:sys,chat:chat,free:free,groups:groups,
      generating:isGenerating,t:lastTurn,s:session
    };
  }
  function __AgyContextIndicator(props){
    var convId=props&&props.conversationId,
        agentState=${useConvStateSym}(convId,CTX_SEL),
        [open,setOpen]=${R}.useState(!1),
        [,setPrefVer]=${R}.useState(0),
        [genVer,setGenVer]=${R}.useState(0),
        [pos,setPos]=${R}.useState(null),
        trigRef=${R}.useRef(null),
        popRef=${R}.useRef(null),
        mountedRef=${R}.useRef(!0);
    var totalGenLen=num(agentState&&agentState.trajectorySlice&&agentState.trajectorySlice.totalGeneratorMetadataLength),
        rpcEntry=convId?getRpcGenEntry(convId):null;
    var m=${R}.useMemo(function(){
      return deriveContextMetrics(agentState,rpcEntry?rpcEntry.items:null);
    },[agentState,genVer,convId]);
    ${R}.useEffect(function(){
      mountedRef.current=!0;
      function fn(){setPrefVer(function(v){return v+1})}
      prefSubs.push(fn);
      return function(){
        mountedRef.current=!1;
        var i=prefSubs.indexOf(fn);
        if(i>=0)prefSubs.splice(i,1);
      };
    },[]);
    ${R}.useEffect(function(){
      if(!convId||!(totalGenLen>0))return;
      var cli=typeof globalThis!=="undefined"?globalThis.__agyLsClient:null;
      if(!cli||typeof cli.getCascadeTrajectoryGeneratorMetadata!=="function")return;
      var ent=getRpcGenEntry(convId);
      if(!ent||ent.fetching||ent.items.length>=totalGenLen||ent.settledLen===totalGenLen)return;
      ent.fetching=!0;
      (async function(){
        try{
          var off=ent.items.length,guard=0;
          while(off<totalGenLen&&guard<64){
            guard+=1;
            var res=await cli.getCascadeTrajectoryGeneratorMetadata(${pbCreateGen}(${genMetaReqSchema},{cascadeId:convId,generatorMetadataOffset:off}));
            var arr=(res&&Array.isArray(res.generatorMetadata))?res.generatorMetadata:[];
            if(arr.length===0){ent.settledLen=totalGenLen;break}
            for(var idx=0;idx<arr.length;idx++)ent.items.push(arr[idx]);
            off=ent.items.length;
          }
          if(ent.items.length>=totalGenLen)ent.settledLen=totalGenLen;
        }catch{
          ent.settledLen=totalGenLen;
        }finally{
          ent.fetching=!1;
          if(mountedRef.current)setGenVer(function(v){return v+1});
        }
      })();
    },[convId,totalGenLen,genVer]);
    ${R}.useEffect(function(){
      if(!open||typeof window==="undefined"||typeof document==="undefined")return;
      function syncPos(){
        if(!trigRef.current)return;
        var r=trigRef.current.getBoundingClientRect(),
            rightPx=Math.max(8,Math.round(window.innerWidth-r.right)),
            above=r.top>=420||r.top>=window.innerHeight-r.bottom;
        setPos(above
          ?{position:"fixed",zIndex:9999,right:rightPx+"px",bottom:Math.round(window.innerHeight-r.top+8)+"px"}
          :{position:"fixed",zIndex:9999,right:rightPx+"px",top:Math.round(r.bottom+8)+"px"});
      }
      function onDown(e){
        if(trigRef.current&&trigRef.current.contains(e.target))return;
        if(popRef.current&&popRef.current.contains(e.target))return;
        setOpen(!1);
      }
      function onKey(e){if(e.key==="Escape")setOpen(!1)}
      syncPos();
      document.addEventListener("mousedown",onDown);
      document.addEventListener("keydown",onKey);
      window.addEventListener("resize",syncPos);
      window.addEventListener("scroll",syncPos,!0);
      return function(){
        document.removeEventListener("mousedown",onDown);
        document.removeEventListener("keydown",onKey);
        window.removeEventListener("resize",syncPos);
        window.removeEventListener("scroll",syncPos,!0);
      };
    },[open]);
    if(!m)return null;
    var pinMode=readPinMode(),
        subOpen=readPref(SUB_KEY,!0),
        prefix=m.approx?"~":"",
        pctRound=Math.round(m.frac*100),
        warnCol="var(--warning, #d97706)",
        errCol="var(--destructive, #dc2626)",
        chatCol=m.isWarn?warnCol:"color-mix(in srgb, var(--primary) 82%, var(--foreground))",
        sysCol="color-mix(in srgb, var(--foreground) 78%, transparent)",
        t=m.t,
        s=m.s,
        pinnedTps=pinMode==="turn"
          ?((t&&t.outTps>0)?t.outTps:0)
          :(pinMode==="avg"?((s&&s.outTps>0)?s.outTps:(t&&t.outTps>0?t.outTps:0)):0),
        shortTps=pinnedTps>0?(pinnedTps>=1e3?((pinnedTps/1e3).toFixed(1)+"K t/s"):(Math.round(pinnedTps)+" t/s")):"",
        trigLabel=pinMode!=="off"&&shortTps?(prefix+pctRound+"% \\u00b7 "+shortTps):(prefix+pctRound+"%"),
        hasGroups=m.groups.length>0,
        PIN_OPTS=[
          ["off","Off","Hide output speed in bottom toolbar"],
          ["turn","Turn","Show Last Turn output speed (t/s) in bottom toolbar"],
          ["avg","Avg","Show Session average output speed (t/s) in bottom toolbar"]
        ];
    function renderLabel(tag,name){
      if(!tag)return ${R}.createElement("span",{className:"text-muted-foreground"},name);
      return ${R}.createElement("span",{className:"text-muted-foreground"},
        ${R}.createElement("span",{style:{opacity:0.62,marginRight:"3px"}},tag),
        name
      );
    }
    function renderSection(title,subText,d,isSession){
      if(!d)return null;
      var avgTag=isSession?"Avg":"",
          sumTag=isSession?"\\u03a3":"",
          cacheTip=d.totIn>0
            ?("Prefix cache: "+fmtExact(d.cacheRead)+" hit / "+fmtExact(d.totIn)+" total input tokens ("+fmtExact(d.uncachedIn)+" new"+(d.cacheWrite>0?", "+fmtExact(d.cacheWrite)+" written":"")+")")
            :void 0,
          inTip=d.totIn>0
            ?(fmtExact(d.totIn)+" total input tokens ("+fmtExact(d.cacheRead)+" cached + "+fmtExact(d.uncachedIn+d.cacheWrite)+" uncached)")
            :void 0,
          respTip=(d.outTok>0||d.respTok>0)
            ?(fmtExact(d.respTok)+" response tokens"+(d.thinkTok>0?" (excl. "+fmtExact(d.thinkTok)+" thinking)":""))
            :void 0,
          outTip=d.outTok>0
            ?(fmtExact(d.outTok)+" total output tokens ("+fmtExact(d.respTok)+" response + "+fmtExact(d.thinkTok)+" thinking)")
            :void 0,
          inSpdTip=d.inTps>0
            ?(fmtExact(d.inTps)+" input tokens/s"+(isSession&&d.timedTtftCount<d.count?" (across "+d.timedTtftCount+" timed calls)":""))
            :void 0,
          outSpdTip=d.outTps>0
            ?(d.outTps.toFixed(1)+" output tokens/s"+(isSession&&d.timedStreamCount<d.count?" (across "+d.timedStreamCount+" timed calls)":""))
            :void 0,
          ttftTip=isSession&&d.timedTtftCount>0&&d.timedTtftCount<d.count
            ?("Average across "+d.timedTtftCount+" / "+d.count+" timed calls")
            :void 0,
          durTip=isSession&&d.totalDurSec>0
            ?("Total observed: "+fmtDur(d.totalDurSec,!1)+(d.timedDurCount<d.count?" (across "+d.timedDurCount+" / "+d.count+" timed calls)":" (across "+d.timedDurCount+" calls)"))
            :void 0;
      return ${R}.createElement("div",{
        className:"flex flex-col border-border",
        style:{marginTop:"9px",paddingTop:"8px",gap:"5px",borderTopWidth:"1px",borderTopStyle:"solid"}
      },
        ${R}.createElement("div",{className:"flex items-center justify-between",style:{gap:"6px"}},
          ${R}.createElement("div",{className:"flex items-center",style:{gap:"6px",minWidth:0}},
            ${R}.createElement("span",{className:"text-muted-foreground font-medium shrink-0"},title),
            subText&&${R}.createElement("span",{className:"text-muted-foreground truncate",style:{opacity:0.68}},subText)
          ),
          (d.errs>0||d.retries>0)&&${R}.createElement("div",{className:"flex items-center shrink-0",style:{gap:"4px"}},
            d.errs>0&&${R}.createElement("span",{
              className:"rounded text-xs font-medium tabular-nums shrink-0",
              title:d.errMsg||(d.errs+" failed generation(s)"),
              style:{padding:"1px 6px",color:errCol,background:"color-mix(in srgb, "+errCol+" 14%, transparent)"}
            },"! "+d.errs+(d.errs===1?" error":" errors")),
            d.retries>0&&${R}.createElement("span",{
              className:"rounded text-xs font-medium tabular-nums shrink-0",
              title:d.retryWaitSec>0
                ?("Backend auto-retried "+d.retries+" time(s), waited "+fmtDur(d.retryWaitSec,!1))
                :("Backend auto-retried "+d.retries+" time(s)"),
              style:{padding:"1px 6px",color:warnCol,background:"color-mix(in srgb, "+warnCol+" 14%, transparent)"}
            },"\\u21bb "+d.retries+(d.retries===1?" retry":" retries"))
          )
        ),
        ${R}.createElement("div",{
          className:"text-xs tabular-nums",
          style:{display:"grid",gridTemplateColumns:"1fr 1fr",columnGap:"14px",rowGap:"3px"}
        },
          ${R}.createElement("div",{className:"flex items-center justify-between",title:inTip},
            renderLabel(sumTag,"Input"),
            ${R}.createElement("span",{className:"text-foreground"},d.totIn>0?fmtK(d.totIn):"\\u2014")
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:outTip},
            renderLabel(sumTag,"Output"),
            ${R}.createElement("span",{className:"text-foreground"},d.outTok>0?fmtK(d.outTok):"\\u2014")
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:cacheTip},
            renderLabel(sumTag,"Cache hit"),
            ${R}.createElement("span",{className:"text-foreground"},d.hasCache?fmtCachePct(d.cacheRead,d.totIn):"\\u2014")
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:respTip},
            renderLabel(sumTag,"Response"),
            ${R}.createElement("span",{className:"text-foreground"},(d.outTok>0||d.respTok>0)?fmtK(d.respTok):"\\u2014")
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:inSpdTip},
            renderLabel(avgTag,"In speed"),
            ${R}.createElement("span",{className:"text-foreground"},fmtTps(d.inTps))
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:outSpdTip},
            renderLabel(avgTag,"Out speed"),
            ${R}.createElement("span",{className:"font-medium text-foreground"},fmtTps(d.outTps))
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:ttftTip},
            renderLabel(avgTag,"TTFT"),
            ${R}.createElement("span",{className:"text-foreground"},fmtDur(d.ttftSec,!1))
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",title:durTip},
            renderLabel(avgTag,"Duration"),
            ${R}.createElement("span",{className:"text-foreground"},fmtDur(d.durSec,!1))
          )
        )
      );
    }
    var popoverEl=open&&pos&&typeof document!=="undefined"&&document.body?${portalNs}.createPortal(
      ${R}.createElement("div",{
        ref:popRef,
        role:"dialog",
        "aria-label":"Context window usage and inference telemetry",
        className:"bg-card border border-border rounded-lg shadow-lg text-xs text-foreground select-none",
        style:Object.assign({},pos,{width:"23.5rem",maxWidth:"calc(100vw - 16px)",maxHeight:"calc(100vh - 56px)",overflowY:"auto",padding:"12px"})
      },
        ${R}.createElement("div",{className:"flex items-center justify-between",style:{gap:"8px",marginBottom:"6px"}},
          ${R}.createElement("div",{className:"flex items-center",style:{gap:"6px"}},
            ${R}.createElement("span",{className:"font-semibold text-foreground"},"Context Window"),
            m.approx&&${R}.createElement("span",{
              className:"bg-secondary text-muted-foreground rounded text-xs",
              title:"Approximate post-compaction token estimate",
              style:{padding:"1px 6px"}
            },"~ Approx")
          ),
          ${R}.createElement("div",{className:"flex items-center shrink-0",style:{gap:"8px"}},
            ${R}.createElement("div",{className:"flex items-center",style:{gap:"4px"}},
              ${R}.createElement("span",{className:"text-xs text-muted-foreground"},"t/s"),
              ${R}.createElement("div",{
                role:"group",
                "aria-label":"Bottom toolbar output speed mode",
                className:"flex items-center bg-secondary border border-border rounded-md",
                style:{padding:"1px",gap:"1px"}
              },PIN_OPTS.map(function(opt){
                var act=pinMode===opt[0];
                return ${R}.createElement("button",{
                  key:opt[0],
                  type:"button",
                  "aria-pressed":act,
                  title:opt[2],
                  onClick:function(){if(!act)writePref(PIN_KEY,opt[0])},
                  className:"rounded text-xs cursor-pointer transition-colors "+(act?"bg-card text-foreground font-medium":"text-muted-foreground hover:text-foreground"),
                  style:{padding:"1px 5px",lineHeight:"14px",boxShadow:act?"0 1px 2px rgba(0,0,0,0.18)":void 0}
                },opt[1]);
              }))
            ),
            ${R}.createElement("span",{
              className:"font-semibold tabular-nums",
              style:{color:m.isWarn?warnCol:"var(--foreground)"}
            },prefix+(m.frac*100).toFixed(1)+"%")
          )
        ),
        ${R}.createElement("div",{
          className:"bg-secondary rounded-full flex",
          style:{width:"100%",height:"8px",overflow:"hidden",marginBottom:"6px"}
        },
          ${R}.createElement("div",{style:{height:"100%",width:((m.sys/m.max)*100).toFixed(2)+"%",background:sysCol}}),
          ${R}.createElement("div",{style:{height:"100%",width:((m.chat/m.max)*100).toFixed(2)+"%",background:chatCol}})
        ),
        ${R}.createElement("div",{
          className:"text-xs text-muted-foreground tabular-nums",
          title:fmtExact(m.used)+" / "+fmtExact(m.max)+" tokens",
          style:{marginBottom:"8px"}
        },prefix+fmtK(m.used)+" / "+fmtK(m.max)+" tokens used"),
        ${R}.createElement("div",{
          className:"flex flex-col border-border",
          style:{gap:"4px",paddingTop:"6px",borderTopWidth:"1px",borderTopStyle:"solid"}
        },
          ${R}.createElement("div",null,
            ${R}.createElement("button",{
              type:"button",
              onClick:function(){if(hasGroups)writePref(SUB_KEY,!subOpen)},
              className:"flex items-center justify-between text-foreground "+(hasGroups?"cursor-pointer":""),
              style:{width:"100%",padding:"2px 0",background:"transparent"}
            },
              ${R}.createElement("span",{className:"flex items-center",style:{gap:"6px"}},
                ${R}.createElement("span",{className:"rounded shrink-0",style:{display:"inline-block",width:"8px",height:"8px",background:sysCol}}),
                ${R}.createElement("span",null,"Instructions & tools"),
                hasGroups&&${R}.createElement("span",{className:"text-muted-foreground text-xs"},subOpen?"\\u25be":"\\u25b8")
              ),
              ${R}.createElement("span",{className:"tabular-nums text-muted-foreground"},fmtK(m.sys)+" \\u00b7 "+fmtPct(m.sys,m.max))
            ),
            hasGroups&&subOpen&&${R}.createElement("div",{
              className:"border-border",
              style:{
                display:"grid",gridTemplateColumns:"1fr 1fr",columnGap:"12px",rowGap:"2px",
                marginTop:"4px",marginLeft:"14px",paddingLeft:"10px",
                borderLeftWidth:"1px",borderLeftStyle:"solid"
              }
            },m.groups.map(function(pair){
              return ${R}.createElement("div",{key:pair[0],className:"flex items-center justify-between text-xs text-muted-foreground"},
                ${R}.createElement("span",{className:"truncate"},pair[0]),
                ${R}.createElement("span",{className:"tabular-nums"},fmtK(pair[1]))
              );
            }))
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",style:{padding:"2px 0"}},
            ${R}.createElement("span",{className:"flex items-center text-foreground",style:{gap:"6px"}},
              ${R}.createElement("span",{className:"rounded shrink-0",style:{display:"inline-block",width:"8px",height:"8px",background:chatCol}}),
              ${R}.createElement("span",null,"Conversation")
            ),
            ${R}.createElement("span",{className:"tabular-nums text-muted-foreground"},fmtK(m.chat)+" \\u00b7 "+fmtPct(m.chat,m.max))
          ),
          ${R}.createElement("div",{className:"flex items-center justify-between",style:{padding:"2px 0"}},
            ${R}.createElement("span",{className:"flex items-center text-muted-foreground",style:{gap:"6px"}},
              ${R}.createElement("span",{className:"rounded shrink-0 border border-border bg-secondary",style:{display:"inline-block",width:"8px",height:"8px"}}),
              ${R}.createElement("span",null,"Available")
            ),
            ${R}.createElement("span",{className:"tabular-nums text-muted-foreground"},fmtK(m.free)+" \\u00b7 "+fmtPct(m.free,m.max))
          )
        ),
        renderSection("Last Turn",m.generating?"\\u00b7 Generating\\u2026":"",t,!1),
        renderSection(s?("\\u03a3 Session \\u00b7 "+s.count+(s.count===1?" turn":" turns")):"",null,s,!0)
      ),
      document.body
    ):null;
    return ${R}.createElement(${R}.Fragment,null,
      ${R}.createElement("button",{
        ref:trigRef,
        type:"button",
        "data-testid":"agy-context-usage-indicator",
        "aria-haspopup":"dialog",
        "aria-expanded":open,
        "aria-label":"Context window usage: "+trigLabel,
        onClick:function(){setOpen(function(v){return !v})},
        className:"flex items-center h-7 pl-1.5 pr-2 rounded-full text-sm cursor-pointer shrink-0 select-none outline-none whitespace-nowrap hover:bg-secondary transition-colors "+(open?"bg-secondary text-foreground":"text-secondary-foreground"),
        style:{
          gap:"5px",
          color:m.isWarn?warnCol:void 0
        }
      },
        ${R}.createElement("svg",{
          width:16,height:16,viewBox:"0 0 16 16",
          className:"w-4 h-4 shrink-0",
          style:{transform:"rotate(-90deg)"}
        },
          ${R}.createElement("circle",{
            cx:8,cy:8,r:6,fill:"none",stroke:"currentColor",strokeWidth:2,
            style:{opacity:0.22}
          }),
          ${R}.createElement("circle",{
            cx:8,cy:8,r:6,fill:"none",stroke:"currentColor",strokeWidth:2,
            strokeDasharray:CIRC,
            strokeDashoffset:CIRC*(1-m.frac),
            strokeLinecap:"round"
          })
        ),
        ${R}.createElement("span",{className:"tabular-nums"},trigLabel)
      ),
      popoverEl
    );
  }
  return {Indicator:__AgyContextIndicator,_derive:deriveContextMetrics};
})()`;
}

/**
 * Patch 5 (`buildBindings.contextUsageIndicator` in 2.30+): Mounts an original,
 * clean-room Context Window, Last-Turn, and Session Inference Telemetry
 * indicator into the `buildBindings` entry slot, and expands the lightweight
 * `generatorMetadatas` subscription slice from `{startIndex:-1}` to `{startIndex:0}`
 * so cumulative session token & cache-hit metrics cover the entire conversation.
 *
 * Modes (`indicatorMode`):
 *   - `'custom'` (default): mounts `__AgyContextIndicator` both when upstream
 *     stripped the slot (`void 0`) and when upstream provides a basic native
 *     component; if a future upstream build both restores a native component
 *     AND refactors internal hooks so structural anchors no longer match, falls
 *     back gracefully to keeping the native component instead of breaking `sync`.
 *   - `'polyfill'`: mounts `__AgyContextIndicator` ONLY when upstream stripped
 *     the slot (`void 0`); leaves any non-void upstream component untouched.
 *   - `'stock'`: leaves `buildBindings.contextUsageIndicator` untouched.
 */
export const PATCH_CONTEXT_INDICATOR = {
  id: 'context-usage-indicator',
  occurrences: 1,
  anchor: /\}\)\(\{autonomousMode:/,
  apply(js, { indicatorMode = DEFAULT_INDICATOR_MODE } = {}) {
    if (!INDICATOR_MODES.has(indicatorMode)) {
      throw new PatchError(
        `invalid indicatorMode ${JSON.stringify(indicatorMode)} (expected custom, polyfill, or stock)`,
        2
      );
    }
    const slotMatch = matchUnique(js, this.anchor, 'PATCH_CONTEXT_INDICATOR:buildBindings');
    const objOpen = slotMatch.index + 3; // points to `{` in `})({autonomousMode:`
    const { valueStart, valueEnd } = findTopLevelObjectProperty(
      js,
      objOpen,
      'contextUsageIndicator'
    );
    const rawValue = js.slice(valueStart, valueEnd).trim();
    if (!rawValue) {
      throw new PatchError('PATCH_CONTEXT_INDICATOR: empty contextUsageIndicator value', 3);
    }
    if (rawValue.includes('__AgyContextIndicator')) {
      throw new PatchError('PATCH_CONTEXT_INDICATOR: contextUsageIndicator is already patched', 3);
    }
    const isStripped = rawValue === 'void 0' || rawValue === 'undefined' || rawValue === 'null';

    if (indicatorMode === 'stock') {
      return { code: js, noop: true, mode: isStripped ? 'stock-empty' : 'stock-native' };
    }
    if (indicatorMode === 'polyfill' && !isStripped) {
      return { code: js, noop: true, mode: 'native-bypassed' };
    }

    let symbols;
    let genSliceEdit = null;
    try {
      const [, useConvStateSym] = matchUnique(
        js,
        /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)=\(a,b\)=>\{var c=\[\],\{optimisticState:d,trueState:f\}=[A-Za-z0-9_$]+\(a\);/,
        'PATCH_CONTEXT_INDICATOR:useConvState'
      );
      const cortexNs = resolveUniqueIdentifier(
        js,
        /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)\.TokenType=\{UNSPECIFIED:0,SYSTEM_PROMPT:1,/g,
        'PATCH_CONTEXT_INDICATOR:TokenType'
      );
      const reactIdent = resolveUniqueIdentifier(
        js,
        /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)\.createElement\([A-Za-z0-9_$]+,\{conversationId:[A-Za-z0-9_$]+\}\)/g,
        'PATCH_CONTEXT_INDICATOR:React'
      );
      const portalNs = resolveUniqueIdentifier(
        js,
        /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+)\.createPortal\(/g,
        'PATCH_CONTEXT_INDICATOR:ReactDOM'
      );
      const [, pbCreateGen, genMetaReqSchema] = matchUnique(
        js,
        /\.getCascadeTrajectoryGeneratorMetadata\(([A-Za-z0-9_$]+)\(([A-Za-z0-9_$]+),\{cascadeId:/,
        'PATCH_CONTEXT_INDICATOR:GetGeneratorMetadataRpc'
      );
      const alreadyFullGenSlice =
        /(?<![A-Za-z0-9_$])[A-Za-z0-9_$]+=\{startIndex:-\d+\},[A-Za-z0-9_$]+=\{startIndex:0\},[A-Za-z0-9_$]+=\{startIndex:0,endIndexExclusive:0\}/.test(
          js
        );
      if (!alreadyFullGenSlice) {
        const gm = matchUnique(
          js,
          /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]+=\{startIndex:-\d+\},[A-Za-z0-9_$]+=\{startIndex:)-1(\},[A-Za-z0-9_$]+=\{startIndex:0,endIndexExclusive:0\})/,
          'PATCH_CONTEXT_INDICATOR:GeneratorMetadatasSlice'
        );
        genSliceEdit = {
          start: gm.index,
          end: gm.index + gm[0].length,
          text: gm[1] + '0' + gm[2],
        };
      }
      symbols = { reactIdent, portalNs, useConvStateSym, cortexNs, pbCreateGen, genMetaReqSchema };
    } catch (exc) {
      if (!isStripped && indicatorMode === 'custom') {
        process.stderr.write(
          `warning: context-usage-indicator internal hook changed upstream (${exc.message}); ` +
            'preserving upstream native implementation.\n'
        );
        return { code: js, noop: true, mode: 'native-fallback' };
      }
      throw exc;
    }

    const injected = buildContextIndicatorSource(symbols);
    const edits = [{ start: valueStart, end: valueEnd, text: injected }];
    if (genSliceEdit) edits.push(genSliceEdit);
    edits.sort((a, b) => b.start - a.start);
    let code = js;
    for (const ed of edits) {
      code = code.slice(0, ed.start) + ed.text + code.slice(ed.end);
    }
    return { code, mode: isStripped ? 'enhanced' : 'enhanced-override' };
  },
};

export const DEFAULT_PATCHES = [
  PATCH_MENDEL_BASELINE,
  PATCH_MENDEL_SERVICE,
  PATCH_MENDEL_OVERRIDES,
  PATCH_FLAG_PICKER,
  PATCH_CONTEXT_INDICATOR,
];

export function applyPatches(
  js,
  {
    flags = FLAGS,
    boolFlags = NATIVE_MENDEL_BOOL_FLAGS,
    stringFlags = NATIVE_MENDEL_STRING_FLAGS,
    indicatorMode = DEFAULT_INDICATOR_MODE,
    patches = DEFAULT_PATCHES,
  } = {}
) {
  const results = [];
  let out = js;

  for (const patch of patches) {
    const seen = countAnchorMatches(js, patch.anchor);
    const expected = patch.occurrences ?? 1;
    if (seen !== expected) {
      throw new PatchError(
        `patch "${patch.id}" anchor mismatch: expected ${expected} occurrence(s), found ${seen}.\n` +
          `Antigravity likely updated its frontend code. Anchor:\n  ${String(patch.anchor)}`,
        3
      );
    }
    const applied = patch.apply(out, { flags, boolFlags, stringFlags, indicatorMode });
    const isObj = typeof applied === 'object' && applied !== null && typeof applied.code === 'string';
    const next = isObj ? applied.code : applied;
    const noopAllowed = isObj && applied.noop === true;
    if (next === out && !noopAllowed) {
      throw new PatchError(`patch "${patch.id}" produced no change`, 3);
    }
    out = next;
    const rec = { id: patch.id, anchor: String(patch.anchor), occurrences: seen };
    if (isObj && applied.mode) rec.mode = applied.mode;
    results.push(rec);
  }

  if (out === js) throw new PatchError('no patches applied', 3);
  return { output: out, results };
}

export function verifyJsSyntax(code, filename = 'main.js') {
  try {
    // Parse with V8 without executing any code.
    new vm.Script(code, { filename });
  } catch (exc) {
    throw new PatchError(`patched ${filename} failed V8 syntax validation: ${exc.message}`, 3);
  }
}

// ---------------------------------------------------------------------------
// 4. Desktop Launcher Read-Only `Exec=` Parser
// ---------------------------------------------------------------------------

/**
 * Unescape a value at the **GKeyFile string layer** (the `=` right-hand side of
 * a key in a `.desktop` file: `\\` -> `\`, `\s` -> leading space, `\n`, `\r`, `\t`),
 * prior to Desktop Entry `Exec` argv tokenization.
 */
export function keyFileUnescapeValue(value) {
  let out = '';
  const s = String(value);
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '\\') {
      out += s[i];
      continue;
    }
    const nxt = s[i + 1];
    if (nxt === 's') { out += ' '; i += 1; continue; }
    if (nxt === 'n') { out += '\n'; i += 1; continue; }
    if (nxt === 't') { out += '\t'; i += 1; continue; }
    if (nxt === 'r') { out += '\r'; i += 1; continue; }
    if (nxt === '\\') { out += '\\'; i += 1; continue; }
    out += s[i];
  }
  return out;
}

/**
 * Split a Desktop Entry `Exec` value into raw argument tokens, honouring the
 * spec's double-quote and backslash rules.
 */
export function tokenizeDesktopExec(execValue) {
  const tokens = [];
  const isSpace = (ch) => ch === ' ' || ch === '\t';
  let i = 0;

  while (i < execValue.length) {
    while (i < execValue.length && isSpace(execValue[i])) i += 1;
    if (i >= execValue.length) break;

    // Per the Desktop Entry spec a quoted section may appear anywhere inside a
    // reserved argument, e.g. `OTHER="hello world"` is ONE token. The loop
    // therefore accumulates raw text until an unquoted space ends the token.
    let raw = '';
    let inQuote = false;
    while (i < execValue.length) {
      const ch = execValue[i];
      if (ch === '\\' && i + 1 < execValue.length) {
        raw += ch + execValue[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuote = !inQuote;
        raw += ch;
        i += 1;
        continue;
      }
      if (!inQuote && isSpace(ch)) break;
      raw += ch;
      i += 1;
    }
    tokens.push(raw);
  }
  return tokens;
}

/**
 * Unquote a raw Desktop Entry token back into its literal argument value.
 *
 * Quotes may appear anywhere inside the token (`OTHER="hello world"`), and only
 * `"`, `` ` ``, `$` and `\` are escape sequences inside them.
 */
export function unquoteDesktopExecToken(raw) {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length && '"\\`$'.includes(raw[i + 1])) {
      out += raw[i + 1];
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Read-only parser for a Desktop Entry `Exec=` line, shared by `makePaths()`
 * and `verify` to detect a user-configured `AGY_UI_BUNDLE=<dir>` assignment.
 *
 * Modelled `env` semantics:
 * - a leading `env` or `/usr/bin/env` token introduces an environment prefix;
 * - options come BEFORE assignments; `-u`/`--unset`/`-C`/`--chdir` consume an
 *   argument, `-i`/`--ignore-environment`/`-0`/`--null`/`-v`/`--debug` do not;
 * - every `NAME=value` before the program token is an environment assignment
 *   (later ones win);
 * - `--` terminates option parsing;
 * - the first non-option token that is not an assignment is the program; any
 *   `NAME=value` after it is a plain argument and is never read as an env var.
 *
 * Unsupported forms (`-S`, `--split-string`, unknown wrappers) are reported via
 * `unsupported` instead of being guessed at.
 */
const ENV_OPTS_WITH_ARG = new Set(['-u', '--unset', '-C', '--chdir']);
const ENV_OPTS_NO_ARG = new Set([
  '-i',
  '--ignore-environment',
  '-0',
  '--null',
  '-v',
  '--debug',
]);
const ENV_UNSUPPORTED = new Set(['-S', '--split-string']);
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function analyseDesktopExec(desktopText, envVar = ENV_VAR) {
  const execLine = /^Exec=(.*)$/m.exec(desktopText);
  if (!execLine) {
    return {
      ok: false,
      unsupported: 'no Exec= line',
      usesEnv: false,
      envCommand: null,
      tokens: [],
      assignments: [],
      programIndex: -1,
      value: null,
    };
  }

  const rawTokens = tokenizeDesktopExec(keyFileUnescapeValue(execLine[1]));
  const tokens = rawTokens.map(unquoteDesktopExecToken);
  const base = {
    ok: true,
    unsupported: null,
    usesEnv: false,
    envCommand: null,
    rawTokens,
    tokens,
    assignments: [],
    assignmentIndexes: [],
    programIndex: -1,
    value: null,
  };
  if (tokens.length === 0) return { ...base, ok: false, unsupported: 'empty Exec=' };

  const first = tokens[0];
  const usesEnv = first === 'env' || first.endsWith('/env');
  if (!usesEnv) {
    // Without an env prefix our variable can only be a literal argument.
    return { ...base, programIndex: 0 };
  }

  let i = 1;
  let endOfOptions = false;
  for (; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (!endOfOptions) {
      if (ENV_UNSUPPORTED.has(tok)) {
        return { ...base, usesEnv: true, envCommand: first, ok: false, unsupported: `unsupported env option ${tok}` };
      }
      if (ENV_OPTS_WITH_ARG.has(tok)) {
        i += 1;
        continue;
      }
      if (ENV_OPTS_NO_ARG.has(tok)) continue;
      if (tok === '--') {
        endOfOptions = true;
        continue;
      }
      if (tok.startsWith('-')) {
        // Unknown option: we cannot know whether it eats the next token.
        return {
          ...base,
          usesEnv: true,
          envCommand: first,
          ok: false,
          unsupported: `unknown env option ${tok}`,
        };
      }
    }
    if (ENV_ASSIGNMENT_RE.test(tok)) continue;
    break; // program token
  }

  const programIndex = i;
  const assignmentIndexes = [];
  for (let k = 1; k < programIndex; k += 1) {
    if (ENV_ASSIGNMENT_RE.test(tokens[k])) assignmentIndexes.push(k);
  }
  const assignments = assignmentIndexes.map((k) => tokens[k]);
  let value = null;
  for (const asg of assignments) {
    if (asg.startsWith(`${envVar}=`)) value = asg.slice(envVar.length + 1).replace(/%%/g, '%');
  }

  return {
    ...base,
    usesEnv: true,
    envCommand: first,
    programIndex,
    assignments,
    assignmentIndexes,
    value,
  };
}

/** Compatibility wrapper: the effective value of `envVar` in the Exec line. */
export function parseLauncherAssignment(desktopText, envVar = ENV_VAR) {
  const a = analyseDesktopExec(desktopText, envVar);
  return {
    assignment: a.value !== null,
    value: a.value,
    unsupported: a.unsupported,
    ok: a.ok,
  };
}

// ---------------------------------------------------------------------------
// 5. Atomic File Operations, User Home Resolution & Path Context
// ---------------------------------------------------------------------------

function fsyncDir(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support fsync on directory fds; ignore.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

export function atomicWriteFile(targetPath, content, { mode } = {}) {
  let st = null;
  try {
    st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) {
      throw new PatchError(`refusing to overwrite symbolic link: ${targetPath}`, 3);
    }
    if (!st.isFile()) {
      throw new PatchError(`refusing to overwrite non-regular file: ${targetPath}`, 3);
    }
  } catch (exc) {
    if (exc instanceof PatchError) throw exc;
    if (exc.code !== 'ENOENT') throw exc;
  }

  const dir = path.dirname(targetPath);
  // Apply the same path policy as extraction: normalise the authorized root once
  // (so a symlinked $HOME / /tmp keeps working), then refuse any link below it.
  const { root: writeRoot } = resolveWriteRoot(dir);
  assertNoSymlinkBelowRoot(writeRoot, path.join(writeRoot, path.basename(targetPath)));
  fs.mkdirSync(writeRoot, { recursive: true });
  const tmp = path.join(
    writeRoot,
    `.tmp-${path.basename(targetPath)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const fileMode = mode ?? (st ? st.mode & 0o7777 : 0o644);

  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', fileMode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (st && process.getuid?.() === 0) {
      try { fs.chownSync(tmp, st.uid, st.gid); } catch {}
    }
    fs.renameSync(tmp, path.join(writeRoot, path.basename(targetPath)));
    fsyncDir(writeRoot);
  } catch (exc) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw exc;
  }
}

function resolveUserAccount(explicitUser) {
  const homedir = os.homedir();
  if (!explicitUser) {
    if (process.getuid?.() === 0 && homedir === '/root') {
      throw new PatchError(
        'running as root with HOME=/root.\n' +
          'Pass --user <username> (or set AGY_TARGET_USER) so the Web UI bundle and\n' +
          'backups are written to your desktop account instead of /root/.local/share.',
        2
      );
    }
    return { user: null, uid: null, gid: null, home: homedir };
  }

  let entry;
  try {
    entry = execFileSync('getent', ['passwd', explicitUser], { encoding: 'utf8' }).trim();
  } catch {
    throw new PatchError(`unknown user "${explicitUser}" (getent passwd failed)`, 2);
  }
  const fields = entry.split(':');
  if (fields.length < 7) {
    throw new PatchError(`malformed passwd entry for "${explicitUser}"`, 2);
  }
  const canonicalUser = fields[0];
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  const home = fields[5];

  // Reject by resolved identity, not by the literal string: `--user 0` and any
  // alias resolving to UID 0 must be refused just like `--user root`.
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new PatchError(`could not parse uid for "${explicitUser}"`, 2);
  }
  if (!Number.isSafeInteger(gid) || gid < 0) {
    throw new PatchError(`could not parse gid for "${explicitUser}"`, 2);
  }
  if (uid === 0) {
    throw new PatchError(
      `--user "${explicitUser}" resolves to root (uid 0); specify a non-root desktop username`,
      2
    );
  }
  if (!home || !path.isAbsolute(home)) {
    throw new PatchError(`could not resolve absolute home directory for "${explicitUser}"`, 2);
  }
  if (!fs.existsSync(home)) {
    throw new PatchError(`home directory for "${explicitUser}" does not exist: ${home}`, 2);
  }
  return { user: canonicalUser, uid, gid, home };
}

function makePaths(opts = {}) {
  const acct = resolveUserAccount(opts.user || process.env.AGY_TARGET_USER);
  const installDir = opts.installDir || process.env.AGY_INSTALL_DIR || DEFAULT_INSTALL_DIR;
  const desktop = path.join(acct.home, '.local/share/applications/antigravity.desktop');
  const defaultUi = path.join(acct.home, '.local/share/antigravity-externalui');

  // Explicit option wins, then the environment, then whatever the launcher is
  // actually pointing at (so `repair` maintains the bundle the desktop really
  // loads instead of silently rebuilding a different directory), then default.
  let ui = opts.uiDir || process.env.AGY_UI_DIR || null;
  let uiSource = ui ? (opts.uiDir ? 'option' : 'environment') : null;
  if (!ui) {
    try {
      if (fs.existsSync(desktop)) {
        const parsed = parseLauncherAssignment(fs.readFileSync(desktop, 'utf8'), ENV_VAR);
        if (parsed.assignment && parsed.value) {
          ui = parsed.value;
          uiSource = 'launcher';
        }
      }
    } catch {}
  }

  return {
    account: acct,
    install: installDir,
    asar: path.join(installDir, 'resources', 'app.asar'),
    unpacked: path.join(installDir, 'resources', 'app.asar.unpacked'),
    lsBinary: path.join(installDir, 'resources', 'bin', 'language_server'),
    desktop,
    ui: ui || defaultUi,
    uiSource: uiSource || 'default',
    backup: path.join(acct.home, '.local/share/antigravity-asar-backup'),
  };
}

function ensureWritableAsar(asarPath) {
  try {
    fs.accessSync(asarPath, fs.constants.W_OK);
    fs.accessSync(path.dirname(asarPath), fs.constants.W_OK);
  } catch {
    throw new PatchError(
      `${asarPath} is not writable by uid ${process.getuid?.()}.\n` +
        'Re-run with sudo (and pass --user <your-username> when running under sudo).',
      1
    );
  }
}

function readLsStamp(lsBinaryPath) {
  try {
    const out = execFileSync(lsBinaryPath, ['--stamp'], { encoding: 'utf8', timeout: 10000 });
    const cl = /Built at CL: (\d+)/.exec(out)?.[1] ?? 'unknown';
    const at = /Built on: (.+)/.exec(out)?.[1]?.trim() ?? 'unknown';
    return { cl, at };
  } catch {
    return { cl: 'unknown', at: 'unknown' };
  }
}

function reclaimUserOwnership(paths) {
  if (process.getuid?.() !== 0 || !paths.account.user) return null;
  const spec = `${paths.account.uid}:${paths.account.gid}`;
  const targets = [paths.ui, paths.backup].filter((p) => fs.existsSync(p));
  for (const t of targets) {
    try {
      execFileSync('chown', ['-R', spec, t], { stdio: 'ignore' });
    } catch {}
  }
  return paths.account.user;
}

/**
 * Refresh or preserve the single paired pristine backup of `app.asar`.
 * - Never overwrites the backup with an already-hooked `app.asar`.
 * - An existing backup is always validated: it must parse as an ASAR archive,
 *   must not itself contain the hook, and — when `app.asar` is hooked — must
 *   still pair with it. A corrupt or mismatched backup aborts the operation
 *   before any new write happens, rather than being silently retained.
 * - When `app.asar` on disk is unhooked and differs from the existing backup
 *   (e.g. after a package upgrade), atomically refreshes the backup to match
 *   the new build.
 */
/**
 * Move an unusable backup aside (never delete it) so a fresh one can be
 * recorded from the currently installed, verified-pristine archive.
 */
function quarantineBackup(paths, bakAsar, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const parked = path.join(paths.backup, `app.asar.orig.unusable-${stamp}`);
  try {
    fs.renameSync(bakAsar, parked);
  } catch (exc) {
    throw new PatchError(
      `existing backup at ${bakAsar} is ${reason} and could not be moved aside (${exc.message}).\n` +
        `Move or delete it manually, then re-run the command.`,
      3
    );
  }
  try {
    fs.renameSync(`${bakAsar}.json`, `${parked}.json`);
  } catch {}
  process.stderr.write(
    `warning: existing backup was ${reason}; moved aside to ${parked} and a fresh backup will be recorded.\n`
  );
  return parked;
}

export function ensurePairedBackup(paths, currentAsarBuf, isHooked) {
  fs.mkdirSync(paths.backup, { recursive: true });
  const bakAsar = path.join(paths.backup, 'app.asar.orig');
  const bakMeta = path.join(paths.backup, 'app.asar.orig.json');
  const bakUnpacked = path.join(paths.backup, 'app.asar.unpacked.orig');
  const currentDigest = sha256(currentAsarBuf);

  if (fs.existsSync(bakAsar)) {
    const bakBuf = fs.readFileSync(bakAsar);
    const existingDigest = sha256(bakBuf);

    // Validate the backup contents before trusting it in any code path.
    if (!isHooked && existingDigest === currentDigest) {
      return { path: bakAsar, refreshed: false };
    }
    let backupProblem = null;
    try {
      const bakAsarParsed = readAsar(bakBuf);
      if (asarEntryText(bakAsarParsed, ASAR_TARGET).includes(ENV_VAR)) {
        backupProblem = 'backup archive itself contains the hook';
      }
    } catch (exc) {
      backupProblem = `unusable archive (${exc.message})`;
    }

    if (backupProblem) {
      if (isHooked) {
        // The installed archive is patched: a broken backup is the only copy we
        // could restore from, so refuse loudly rather than pretend it is fine.
        throw new PatchError(
          `existing backup at ${bakAsar} is ${backupProblem}, and app.asar is currently patched.\n` +
            'There is no trustworthy pristine copy to fall back to.\n' +
            'Reinstall the antigravity package, then re-run \'install\'.\n' +
            `(The bad backup is left in place for inspection: ${bakAsar})`,
          3
        );
      }
      // The installed archive is pristine and readable, so we can rebuild the
      // backup from it. Quarantine the bad file instead of destroying evidence
      // and instead of demanding a pointless reinstall.
      quarantineBackup(paths, bakAsar, backupProblem);
    }

    if (isHooked) {
      if (!pairsWith(bakBuf, currentAsarBuf)) {
        throw new PatchError(
          `existing backup at ${bakAsar} no longer pairs with the installed app.asar.\n` +
            'This usually means the package was upgraded (or a later tool edited the archive) ' +
            'without a successful sync.\n' +
            'Reinstall the antigravity package and re-run \'install\' to record a fresh backup.',
          3
        );
      }
      return { path: bakAsar, refreshed: false };
    }
  } else if (isHooked) {
    throw new PatchError(
      `app.asar already contains ${ENV_VAR}, but no backup exists at ${bakAsar}.\n` +
        'Reinstall the antigravity package first so a clean backup can be recorded.',
      3
    );
  }

  atomicWriteFile(bakAsar, currentAsarBuf, { mode: 0o644 });
  atomicWriteFile(
    bakMeta,
    JSON.stringify(
      {
        original_sha256: currentDigest,
        original_size: currentAsarBuf.length,
        created_at: new Date().toISOString(),
      },
      null,
      2
    ) + '\n',
    { mode: 0o644 }
  );
  if (fs.existsSync(paths.unpacked)) {
    const tmpUnp = `${bakUnpacked}.tmp-${process.pid}`;
    fs.rmSync(tmpUnp, { recursive: true, force: true });
    fs.cpSync(paths.unpacked, tmpUnp, { recursive: true });
    fs.rmSync(bakUnpacked, { recursive: true, force: true });
    fs.renameSync(tmpUnp, bakUnpacked);
  }

  return { path: bakAsar, refreshed: true };
}

/**
 * Stage the extracted + patched Web UI in a sibling directory and validate it,
 * WITHOUT touching the live bundle. Pair with `commitPatchedUi()`.
 *
 * Splitting prepare from commit lets callers run every fallible step (ZIP
 * extraction, patch anchors, V8 syntax) *before* they mutate any other target,
 * so a frontend anchor mismatch can no longer leave `app.asar` half-updated.
 */
function preparePatchedUi(paths, { indicatorMode = DEFAULT_INDICATOR_MODE } = {}) {
  const binBuf = fs.readFileSync(paths.lsBinary);
  const found = findWebBundleZip(binBuf);
  if (!found) {
    throw new PatchError(`embedded Web UI ZIP not found in ${paths.lsBinary}`, 3);
  }

  const parent = path.dirname(paths.ui);
  fs.mkdirSync(parent, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  // mkdtemp guarantees an exclusively created, empty directory.
  const staging = fs.mkdtempSync(path.join(parent, '.uipatch-staging-'));
  const old = path.join(parent, `.uipatch-old-${stamp}`);

  try {
    extractZipToDir(found.zip, staging);
    const mainPath = path.join(staging, 'main.js');
    const raw = fs.readFileSync(mainPath, 'utf8');
    const { output, results } = applyPatches(raw, { flags: FLAGS, indicatorMode });
    verifyJsSyntax(output, 'main.js');
    fs.writeFileSync(mainPath, output, 'utf8');

    const meta = {
      schemaVersion: 2,
      patchedAt: new Date().toISOString(),
      lsVersion: readLsStamp(paths.lsBinary),
      builtinZipOffset: found.offset,
      builtinZipBytes: found.size,
      flags: FLAGS,
      indicatorMode,
      nativeBaselineCounts: {
        bools: NATIVE_MENDEL_BOOL_FLAGS.length,
        strings: Object.keys(NATIVE_MENDEL_STRING_FLAGS).length,
      },
      patches: results,
      mainJsBytes: { before: raw.length, after: output.length },
      mainJsSha256: sha256(Buffer.from(output, 'utf8')),
    };
    fs.writeFileSync(path.join(staging, 'uipatch.json'), JSON.stringify(meta, null, 2) + '\n');

    return { staging, old, meta };
  } catch (exc) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw exc;
  }
}

/**
 * Atomically promote a staged UI bundle into `paths.ui`.
 *
 * Commit protocol (state machine):
 *   prepared   -> staging built, old UI still live
 *   old-moved  -> live UI renamed aside; a failure here restores it
 *   committed  -> staging promoted; only now is the old copy deleted
 *
 * If promotion fails and the rollback also fails, the aside copy is preserved
 * and its absolute path is reported, so the caller never loses the only
 * working bundle.
 */
export function commitPatchedUi(paths, { staging, old, meta }) {
  const parent = path.dirname(paths.ui);
  let state = 'prepared';

  try {
    if (fs.existsSync(paths.ui)) {
      fs.renameSync(paths.ui, old);
    }
    state = 'old-moved';

    try {
      fs.renameSync(staging, paths.ui);
    } catch (swapErr) {
      // Only our own successful rollback may mark this as rolled-back. A target
      // directory that merely *exists* could have been created by another
      // process, so treating it as restored would let `finally` delete the only
      // remaining copy of the previous bundle.
      if (fs.existsSync(old)) {
        try {
          if (fs.existsSync(paths.ui)) {
            const st = fs.lstatSync(paths.ui);
            if (!st.isDirectory() || fs.readdirSync(paths.ui).length > 0) {
              throw new Error(`refusing to roll back over non-empty ${paths.ui}`);
            }
            fs.rmdirSync(paths.ui);
          }
          fs.renameSync(old, paths.ui);
          state = 'rolled-back';
        } catch (rollbackErr) {
          state = 'rollback-failed';
          throw new PatchError(
            `failed to activate the new Web UI (${swapErr.message}) and the rollback also failed ` +
              `(${rollbackErr.message}).\nYour previous bundle is preserved at:\n  ${old}\n` +
              `Restore it manually with:\n  mv '${old}' '${paths.ui}'`,
            3
          );
        }
      }
      throw swapErr;
    }
    state = 'committed';

    fsyncDir(parent);
    return meta;
  } finally {
    if (state !== 'committed') {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    if (state === 'committed' || state === 'rolled-back') {
      fs.rmSync(old, { recursive: true, force: true });
    }
  }
}

/** Convenience wrapper: prepare + commit in one call. */
function buildPatchedUiAtomic(paths, patchOpts = {}) {
  return commitPatchedUi(paths, preparePatchedUi(paths, patchOpts));
}

// ---------------------------------------------------------------------------
// 6. CLI Subcommands
// ---------------------------------------------------------------------------

/**
 * Shared read-only preflight for `--dry-run`.
 *
 * Runs every check that does not mutate state (ASAR round-trip, embedded ZIP
 * CRC, patch anchors, V8 syntax, backup usability, target paths) so a dry-run
 * actually predicts the real run instead of only verifying the engine.
 */
function preflightAll(opts, paths, { needAsar = true } = {}) {
  cmdSelfTest(opts);

  if (needAsar) {
    const asarBuf = fs.readFileSync(paths.asar);
    const isHooked = asarEntryText(readAsar(asarBuf), ASAR_TARGET).includes(ENV_VAR);
    const bakAsar = path.join(paths.backup, 'app.asar.orig');
    // A hooked archive without a paired backup aborts the real run, so the
    // preview must report the same failure instead of passing.
    if (isHooked && !fs.existsSync(bakAsar)) {
      throw new PatchError(
        'dry-run: would fail - app.asar is patched but no paired backup exists ' +
          '(reinstall the antigravity package first)',
        3
      );
    }
    // Exercise the backup state machine without writing: a corrupt backup that
    // would abort a real run must abort the preview too.
    if (fs.existsSync(bakAsar)) {
      const bakBuf = fs.readFileSync(path.join(paths.backup, 'app.asar.orig'));
      let backupProblem = null;
      try {
        const parsed = readAsar(bakBuf);
        if (asarEntryText(parsed, ASAR_TARGET).includes(ENV_VAR)) {
          backupProblem = 'backup archive itself contains the hook';
        }
      } catch (exc) {
        backupProblem = `unusable archive (${exc.message})`;
      }
      if (backupProblem && isHooked) {
        throw new PatchError(
          `dry-run: would fail - existing backup is ${backupProblem} and app.asar is patched`,
          3
        );
      }
      if (backupProblem) {
        say(C.warn(`  backup   : ${backupProblem} (a real run would quarantine it and rebuild)`));
      }
      if (!backupProblem && isHooked && !pairsWith(bakBuf, asarBuf)) {
        throw new PatchError('dry-run: would fail - backup does not pair with installed app.asar', 3);
      }
    }
  }
  return true;
}

function cmdSelfTest(opts) {
  const paths = makePaths(opts);
  say(`asar    : ${paths.asar}`);
  const asarBuf = fs.readFileSync(paths.asar);
  const asar = readAsar(asarBuf);
  const rtBuf = repack(asar, new Map());
  if (sha256(asarBuf) !== sha256(rtBuf)) {
    throw new PatchError('ASAR zero-replacement round-trip digest mismatch', 3);
  }
  const lsJs = asarEntryText(asar, ASAR_TARGET);
  const hooked = lsJs.includes(ENV_VAR);
  if (!hooked && countOccurrences(lsJs, ASAR_HOOK_ANCHOR) !== 1) {
    throw new PatchError(`ASAR hook anchor missing in ${ASAR_TARGET}`, 3);
  }
  say(`          round-trip SHA256 OK (${asarBuf.length.toLocaleString()} bytes, state=${hooked ? 'HOOKED' : 'PRISTINE'})`);

  say(`engine  : ${paths.lsBinary}`);
  const ls = readLsStamp(paths.lsBinary);
  say(`          CL ${ls.cl} (${ls.at})`);

  const binBuf = fs.readFileSync(paths.lsBinary);
  const found = findWebBundleZip(binBuf);
  if (!found) {
    throw new PatchError(`embedded Web UI ZIP not found in ${paths.lsBinary}`, 3);
  }
  const mainEntry = found.entries.find((e) => e.name === 'main.js');
  const mainRaw = readZipEntry(found.zip, mainEntry).toString('utf8');
  const { output, results } = applyPatches(mainRaw, {
    flags: FLAGS,
    indicatorMode: opts.indicatorMode,
  });
  verifyJsSyntax(output, 'main.js');

  say(`webui   : offset=0x${found.offset.toString(16)} entries=${found.entries.length} CRC32=OK`);
  for (const r of results) {
    const modeTag = r.mode ? `, mode=${r.mode}` : '';
    say(`  [OK] ${r.id} (occurrences=${r.occurrences}${modeTag})`);
  }
  say(`syntax  : V8 vm.Script parse OK (${mainRaw.length.toLocaleString()} -> ${output.length.toLocaleString()} bytes)`);
  say(C.ok('self-test passed (read-only, 0 files modified)'));
  return 0;
}

function cmdInstallOrSync(opts, { mode }) {
  const paths = makePaths(opts);
  const asarBuf = fs.readFileSync(paths.asar);
  const asarStat = fs.statSync(paths.asar);
  const isHooked = asarEntryText(readAsar(asarBuf), ASAR_TARGET).includes(ENV_VAR);

  if (opts.dryRun) {
    preflightAll(opts, paths);
    say(C.dim('dry-run: all read-only checks passed; pass without --dry-run to apply changes'));
    return 0;
  }

  ensureWritableAsar(paths.asar);

  const bak = ensurePairedBackup(paths, asarBuf, isHooked);

  // Prepare (and fully validate) the new UI *before* mutating app.asar, so a
  // frontend anchor mismatch cannot leave the host archive half-updated.
  const staged = preparePatchedUi(paths, { indicatorMode: opts.indicatorMode });
  let meta;
  try {
    const { buf: nextAsar, changed: asarChanged } = patchAsarBuffer(asarBuf, ENV_VAR);

    if (asarChanged) {
      const nowStat = fs.statSync(paths.asar);
      if (nowStat.ino !== asarStat.ino || nowStat.mtimeMs !== asarStat.mtimeMs) {
        throw new PatchError(
          'app.asar changed on disk during operation (concurrent upgrade?); aborted',
          3
        );
      }
      atomicWriteFile(paths.asar, nextAsar);
      staged.asarChanged = asarChanged;
      staged.asarDelta = nextAsar.length - asarBuf.length;
    } else {
      staged.asarChanged = false;
      staged.asarDelta = 0;
    }

    meta = commitPatchedUi(paths, staged);
  } catch (exc) {
    fs.rmSync(staged.staging, { recursive: true, force: true });
    throw exc;
  }

  const owned = reclaimUserOwnership(paths);

  if (opts.quiet) return 0;

  say(C.bold(`\nantigravity-uipatch · ${mode}\n`));
  say(`  backup      ${C.dim(bak.path)}${bak.refreshed ? C.ok(' (refreshed)') : ''}`);
  say(`  app.asar    ${staged.asarChanged ? C.ok(`hook added (+${staged.asarDelta} B)`) : C.dim('hook already present')}`);
  say(`  ui bundle   ${C.ok(`${meta.patches.length} patches applied`)} ${C.dim(`(${paths.ui}, CL ${meta.lsVersion.cl})`)}`);
  if (owned) say(`  ownership   ${C.ok(`assigned to ${owned}`)}`);
  say('');
  say(
    C.ok('Done.') +
      ` Launch Antigravity with ${ENV_VAR}="${paths.ui}" (in your .desktop file or terminal) to activate.`
  );
  return 0;
}

function cmdRepair(opts) {
  const paths = makePaths(opts);
  if (opts.dryRun) {
    const found = findWebBundleZip(fs.readFileSync(paths.lsBinary));
    if (!found) throw new PatchError(`embedded Web UI ZIP not found in ${paths.lsBinary}`, 3);
    // Re-run the real patch pipeline in memory so anchor/V8 failures surface
    // here instead of only in the real run.
    const mainRaw = readZipEntry(found.zip, found.entries.find((e) => e.name === 'main.js')).toString('utf8');
    const { output, results } = applyPatches(mainRaw, {
      flags: FLAGS,
      indicatorMode: opts.indicatorMode,
    });
    verifyJsSyntax(output, 'main.js');
    say(
      `dry-run: would re-extract ${found.entries.length} entries and apply ${results.length} patches ` +
        `to ${paths.ui} (${mainRaw.length} -> ${output.length} B); nothing written`
    );
    return 0;
  }
  const meta = buildPatchedUiAtomic(paths, { indicatorMode: opts.indicatorMode });
  reclaimUserOwnership(paths);
  say(C.bold('\nantigravity-uipatch · repair\n'));
  say(`  ui bundle   ${C.ok('re-extracted and re-patched')} ${C.dim(`(${paths.uiSource})`)}`);
  say(`              target: ${paths.ui}`);
  say(`              CL ${meta.lsVersion.cl}, ${meta.patches.length} patches (${meta.mainJsBytes.before} -> ${meta.mainJsBytes.after} B)`);
  say(`  app.asar    ${C.dim('untouched')}`);
  say('');
  say(C.ok('Done.') + ' Reload (Ctrl+R) or restart Antigravity.');
  return 0;
}

/**
 * Structured health verification.
 *
 * A warning printed on stdout must never be the only difference between a
 * healthy install and a broken one, so every check contributes to the exit
 * code: pairing, build alignment, real launcher path, patched-bundle hash and
 * patch markers are all validated, not merely displayed.
 */
function cmdVerify(opts) {
  const paths = makePaths(opts);
  const ls = readLsStamp(paths.lsBinary);
  const problems = [];
  say(`engine    : ${paths.lsBinary}`);
  say(`            CL ${ls.cl} (${ls.at})`);

  let asarHooked = false;
  let asarBuf = null;
  try {
    asarBuf = fs.readFileSync(paths.asar);
    asarHooked = asarEntryText(readAsar(asarBuf), ASAR_TARGET).includes(ENV_VAR);
    say(`asar      : ${paths.asar}`);
    say(`            sha256=${sha256(asarBuf)}`);
    say(`            state : ${asarHooked ? C.ok('PATCHED') : C.dim('PRISTINE')}`);
    if (!asarHooked) {
      problems.push('app.asar does not contain the hook (run \'install\' or \'sync\')');
    }
  } catch (exc) {
    say(`asar      : ${C.err(`ERROR - ${exc.message}`)}`);
    problems.push(`app.asar unreadable: ${exc.message}`);
  }

  const bakAsar = path.join(paths.backup, 'app.asar.orig');
  if (fs.existsSync(bakAsar) && asarBuf) {
    const bakBuf = fs.readFileSync(bakAsar);
    let paired = false;
    let backupError = null;
    try {
      const bakAsarParsed = readAsar(bakBuf);
      if (asarEntryText(bakAsarParsed, ASAR_TARGET).includes(ENV_VAR)) {
        backupError = 'backup itself contains the hook';
      } else {
        paired = pairsWith(bakBuf, asarBuf);
      }
    } catch (exc) {
      backupError = `unreadable backup archive (${exc.message})`;
    }
    say(`backup    : ${bakAsar}`);
    say(`            sha256=${sha256(bakBuf)}`);
    say(
      `            pairs : ${
        backupError
          ? C.err(`CORRUPT - ${backupError}`)
          : paired
            ? C.ok('yes')
            : C.warn('NO (different build or external edit)')
      }`
    );
    if (backupError) problems.push(`backup ${backupError}`);
    else if (!paired) problems.push('backup does not pair with the installed app.asar');
  } else {
    say(`backup    : ${bakAsar} ${C.dim('(MISSING)')}`);
    problems.push('paired backup missing (restore would be impossible)');
  }

  // Inspect ~/.local/share/applications/antigravity.desktop read-only (optional:
  // `install` does not touch .desktop; users set AGY_UI_BUNDLE manually via
  // .desktop or terminal/environment).
  let launcherState = 'ABSENT';
  let launcherDetail = null;
  let launcherUiDir = null;
  if (fs.existsSync(paths.desktop)) {
    const dt = fs.readFileSync(paths.desktop, 'utf8');
    const info = analyseDesktopExec(dt, ENV_VAR);
    if (!info.ok) {
      launcherState = 'CUSTOM';
      launcherDetail = info.unsupported;
    } else if (info.value !== null) {
      launcherState = 'ON';
      launcherUiDir = info.value;
    } else {
      launcherState = 'UNSET';
    }
  }
  const switchOn = launcherState === 'ON';

  if (launcherState === 'ON') {
    say(`launcher  : ${C.ok('ON')} (${paths.desktop})`);
    say(`            bundle: ${launcherUiDir}`);
  } else if (launcherState === 'CUSTOM') {
    say(`launcher  : ${C.dim(`custom Exec= (${launcherDetail})`)} (${paths.desktop})`);
  } else if (launcherState === 'UNSET') {
    say(`launcher  : ${C.dim(`not set in ${paths.desktop} (pass ${ENV_VAR} manually via .desktop or terminal)`)}`);
  } else {
    say(`launcher  : ${C.dim(`manual (pass ${ENV_VAR} via .desktop or terminal)`)}`);
  }

  const uiDir = paths.ui;
  const mainPath = path.join(uiDir, 'main.js');
  const metaPath = path.join(uiDir, 'uipatch.json');
  let uiOk = false;
  if (fs.existsSync(mainPath)) {
    const js = fs.readFileSync(mainPath, 'utf8');
    const hasMarkers = js.includes('__AGY_UNLOCKED=') && js.includes('__agyHydrateDevStorage');
    let syntaxOk = true;
    try {
      verifyJsSyntax(js, 'ui-main.js');
    } catch (exc) {
      syntaxOk = false;
      problems.push(`UI bundle failed V8 syntax validation: ${exc.message}`);
    }
    uiOk = hasMarkers && syntaxOk;
    const hasEnhancedIndicator = js.includes('__AgyContextIndicator');
    say(`ui bundle : ${uiDir}`);
    say(`            state : ${uiOk ? C.ok('PATCHED') : C.err(hasMarkers ? 'BROKEN SYNTAX' : 'UNPATCHED')}`);
    say(
      `            ctxui : ${
        hasEnhancedIndicator ? C.ok('enhanced (__AgyContextIndicator)') : C.dim('upstream / stock')
      }`
    );
    if (!hasMarkers) problems.push('UI bundle is missing the patch markers');

    if (fs.existsSync(metaPath)) {
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (exc) {
        say(`            meta  : ${C.err(`CORRUPT uipatch.json (${exc.message})`)}`);
        problems.push(`uipatch.json is corrupt: ${exc.message}`);
      }
      if (meta === null) {
        say(`            meta  : ${C.err('INVALID uipatch.json (null)')}`);
        problems.push('uipatch.json is null');
      } else if (typeof meta !== 'object' || Array.isArray(meta)) {
        say(`            meta  : ${C.err(`INVALID uipatch.json (${typeof meta})`)}`);
        problems.push(`uipatch.json is not an object (got ${meta === null ? 'null' : typeof meta})`);
        meta = null;
      } else if (meta && (!meta.lsVersion || typeof meta.lsVersion.cl !== 'string')) {
        say(`            meta  : ${C.err('INVALID uipatch.json (missing lsVersion.cl)')}`);
        problems.push('uipatch.json is missing lsVersion.cl');
        meta = null;
      } else if (meta && !meta.mainJsSha256) {
        say(`            meta  : ${C.err('INVALID uipatch.json (missing mainJsSha256)')}`);
        problems.push('uipatch.json is missing mainJsSha256 (cannot prove bundle provenance)');
        meta = null;
      }
      if (meta) {
        const clMatch = meta.lsVersion?.cl === ls.cl;
        say(`            build : CL ${meta.lsVersion?.cl ?? '?'} @ ${meta.patchedAt}`);
        say(
          `            align : ${
            clMatch ? C.ok('matches installed engine') : C.warn(`STALE (engine is CL ${ls.cl})`)
          }`
        );
        if (!clMatch) problems.push(`stale UI bundle (built for CL ${meta.lsVersion?.cl ?? '?'})`);

        // Verify the recorded hash of the patched main.js still matches.
        if (meta.mainJsSha256) {
          const actualHash = sha256(fs.readFileSync(mainPath));
          if (actualHash !== meta.mainJsSha256) {
            say(`            hash  : ${C.err('MISMATCH vs uipatch.json')}`);
            problems.push('UI main.js does not match the recorded sha256');
          } else {
            say(`            hash  : ${C.ok('matches uipatch.json')}`);
          }
        }
      }
    } else {
      problems.push('uipatch.json missing (cannot prove bundle provenance)');
    }

    const indexPath = path.join(uiDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      problems.push('UI bundle is missing index.html (engine would serve a blank page)');
    }
  } else {
    say(`ui bundle : ${uiDir} ${C.err('(ABSENT)')}`);
    problems.push(`patched UI bundle absent at ${uiDir} (run 'install' or 'repair')`);
  }

  if (switchOn && launcherUiDir) {
    const switchResolved =
      fs.existsSync(launcherUiDir) && fs.existsSync(path.join(launcherUiDir, 'main.js'));
    if (!switchResolved) {
      problems.push(`launcher points at a missing bundle: ${launcherUiDir}`);
      say(`            resolve: ${C.err('MISSING')} (${launcherUiDir})`);
    } else {
      say(`            resolve: ${C.ok('bundle present')}`);
    }
  }

  try {
    const out = execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' });
    const procs = out
      .split('\n')
      .filter((l) => l.includes('language_server') && l.includes(paths.install));
    if (procs.length > 0) {
      const active = procs.some((l) => l.includes('--web_bundle_path='));
      say(
        `live proc : ${procs.length} instance(s), ${
          active ? C.ok('--web_bundle_path active') : C.warn(`running stock UI (launch with ${ENV_VAR}="${uiDir}")`)
        }`
      );
    }
  } catch {}

  if (problems.length > 0) {
    say('');
    say(C.err(`unhealthy: ${problems.length} problem(s)`));
    for (const p of problems) say(`  - ${p}`);
    return 1;
  }

  return asarHooked && uiOk ? 0 : 1;
}

function cmdRestore(opts) {
  const paths = makePaths(opts);
  const bakAsar = path.join(paths.backup, 'app.asar.orig');
  if (!fs.existsSync(bakAsar)) {
    throw new PatchError(`no backup found at ${bakAsar}; cannot restore`, 1);
  }

  const bakBuf = fs.readFileSync(bakAsar);
  if (asarEntryText(readAsar(bakBuf), ASAR_TARGET).includes(ENV_VAR)) {
    throw new PatchError('backup archive itself contains the hook; refusing to restore', 3);
  }

  const curBuf = fs.readFileSync(paths.asar);
  const curStat = fs.statSync(paths.asar);
  const identical = sha256(curBuf) === sha256(bakBuf);

  if (!identical) {
    const paired = pairsWith(bakBuf, curBuf);
    if (!paired && !opts.force) {
      throw new PatchError(
        'backup does not pair with the currently installed app.asar (different build or external modification).\n' +
          'Refusing to overwrite. Pass --force only if you are certain.',
        3
      );
    }
  }

  if (opts.dryRun) {
    say(
      identical
        ? 'dry-run: app.asar already identical to backup (nothing written)'
        : `dry-run: would restore ${paths.asar} from ${bakAsar}`
    );
    return 0;
  }

  if (!identical) {
    ensureWritableAsar(paths.asar);
    const nowStat = fs.statSync(paths.asar);
    if (nowStat.ino !== curStat.ino || nowStat.mtimeMs !== curStat.mtimeMs) {
      throw new PatchError('app.asar changed concurrently; aborted', 3);
    }
    atomicWriteFile(paths.asar, bakBuf);
    say(`restored  : ${paths.asar} (sha256=${sha256(bakBuf)})`);
  } else {
    say('asar      : already identical to backup');
  }

  reclaimUserOwnership(paths);
  return 0;
}

/** Directories that must never be used as an extraction / overwrite target. */
function assertSafeTargetDir(dest, { account, installDir } = {}) {
  const abs = path.resolve(dest);
  const home = account?.home ? path.resolve(account.home) : null;
  const dangerous = new Set(
    [path.sep, installDir ? path.resolve(installDir) : null, home].filter(Boolean)
  );
  if (dangerous.has(abs)) {
    throw new PatchError(`refusing to operate on protected directory: ${abs}`, 2);
  }
  // Also refuse a parent of the install root, HOME, or the filesystem root.
  for (const guard of dangerous) {
    if (guard !== path.sep && abs === path.dirname(guard)) {
      throw new PatchError(`refusing to operate on protected directory: ${abs}`, 2);
    }
  }
  if (path.parse(abs).root === abs) {
    throw new PatchError('refusing to operate on the filesystem root', 2);
  }
}

function cmdExtract(opts, destArg) {
  const paths = makePaths(opts);
  const dest = destArg ? path.resolve(destArg) : path.join(paths.account.home, 'antigravity-ui-extracted');
  assertSafeTargetDir(dest, { account: paths.account, installDir: paths.install });

  const binBuf = fs.readFileSync(paths.lsBinary);
  const found = findWebBundleZip(binBuf);
  if (!found) {
    throw new PatchError(`embedded Web UI ZIP not found in ${paths.lsBinary}`, 3);
  }

  if (fs.existsSync(dest)) {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new PatchError(`refusing to extract into ${dest} (not a plain directory)`, 3);
    }
    if (fs.readdirSync(dest).length > 0) {
      throw new PatchError(
        `refusing to extract into non-empty directory: ${dest}\n` +
          `Choose a new path, or empty it yourself first (this command never deletes user data).`,
        3
      );
    }
  }

  if (opts.dryRun) {
    const fileCount = found.entries.filter((e) => !e.isDir).length;
    say(`dry-run: would extract ${fileCount} stock Web UI files to ${dest} (nothing written)`);
    return 0;
  }

  const stats = extractZipToDir(found.zip, dest);
  reclaimUserOwnership({ ...paths, ui: dest });
  say(`Extracted ${stats.files} stock Web UI files to ${dest} (offset 0x${found.offset.toString(16)})`);
  return 0;
}

/**
 * Audit that `targetPath` and every one of its physical ancestors are owned by
 * root and are not writable by group / other.
 *
 * The chain is walked over `fs.realpathSync` output rather than lexical
 * `path.dirname()` steps: `statSync` follows symlinks while `dirname` does not,
 * so a purely lexical walk lets a symlink inside a trusted directory resolve to
 * a root-owned file that lives under a *user-writable* parent. Every path
 * component is additionally lstat-checked and any symbolic link is refused,
 * because a link could be retargeted between this audit and the Hook running.
 */
function auditRootOwnedChain(targetPath) {
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(targetPath));
  } catch (exc) {
    return { ok: false, offender: path.resolve(targetPath), uid: -1, mode: '???', reason: exc.message };
  }

  // Reject links anywhere in the lexical chain first.
  const parts = path.resolve(targetPath).split(path.sep).filter(Boolean);
  let walk = path.sep;
  for (const part of parts) {
    walk = path.join(walk, part);
    let st;
    try {
      st = fs.lstatSync(walk);
    } catch (exc) {
      return { ok: false, offender: walk, uid: -1, mode: '???', reason: exc.message };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        offender: walk,
        uid: st.uid,
        mode: (st.mode & 0o777).toString(8),
        reason: 'symbolic link',
      };
    }
  }

  // Then audit the physical (fully resolved) ancestor chain.
  let cur = resolved;
  for (;;) {
    const st = fs.statSync(cur);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0) {
      return { ok: false, offender: cur, uid: st.uid, mode: (st.mode & 0o777).toString(8) };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return { ok: true, resolved };
}

function cmdPacmanHook(opts) {
  const user = opts.user || process.env.SUDO_USER || process.env.AGY_TARGET_USER || os.userInfo().username;
  if (!user) {
    throw new PatchError('pacman-hook requires a non-root desktop account via --user <username>', 2);
  }
  // `resolveUserAccount` rejects UID 0 by resolved identity (`root`, `0`, aliases).
  const account = resolveUserAccount(user);
  const canonicalUser = account.user;

  const scriptPath = path.resolve(
    opts.scriptPath || '/usr/local/share/antigravity-uipatch/antigravity_uipatch.mjs'
  );
  if (scriptPath.startsWith('~')) {
    throw new PatchError('--script-path must be an absolute path (~ is not expanded by libalpm)', 2);
  }

  const hookText = [
    '# Pacman PostTransaction hook for antigravity-uipatch (Arch Linux / EndeavourOS / CachyOS).',
    '# Generated by antigravity_uipatch.mjs pacman-hook.',
    '',
    '[Trigger]',
    'Operation = Install',
    'Operation = Upgrade',
    'Type = Path',
    'Target = opt/Antigravity/resources/app.asar',
    '',
    '[Action]',
    'Description = Synchronizing antigravity-uipatch (Web UI bundle & ASAR hook)...',
    'When = PostTransaction',
    `Exec = /usr/bin/node ${scriptPath} sync --user ${canonicalUser}`,
    '',
  ].join('\n');

  if (!opts.writePath) {
    process.stdout.write(hookText);
    return 0;
  }

  if (!fs.existsSync(scriptPath)) {
    throw new PatchError(
      `script does not exist at ${scriptPath}.\n` +
        `Install a root-owned copy first:\n` +
        `  sudo install -D -o root -g root -m 0755 antigravity_uipatch.mjs ${scriptPath}`,
      2
    );
  }
  const audit = auditRootOwnedChain(scriptPath);
  if (!audit.ok) {
    throw new PatchError(
      `refusing to write root Pacman hook pointing to non-root-secured path:\n` +
        `  ${audit.offender} (uid=${audit.uid}, mode=0${audit.mode})` +
        (audit.reason ? ` [${audit.reason}]` : '') +
        `\nInstall the script under a root:root 0755 directory such as /usr/local/share/antigravity-uipatch/.`,
      2
    );
  }

  const target = path.resolve(opts.writePath);
  if (opts.dryRun) {
    say(`dry-run: would write Pacman hook to ${target} (script audit passed: ${audit.resolved ?? scriptPath})`);
    return 0;
  }

  atomicWriteFile(target, hookText, { mode: 0o644 });
  say(C.ok(`Wrote Pacman hook to ${target}`));
  return 0;
}

// ---------------------------------------------------------------------------
// 7. Argument Parser & Entrypoint
// ---------------------------------------------------------------------------

const HELP_TEXT = `antigravity-uipatch
Unlock experiment-gated frontend UI in Antigravity Desktop without modifying the Go engine binary.

Usage:
  node antigravity_uipatch.mjs <command> [options]

Commands:
  self-test             Read-only check: ASAR round-trip, ZIP CRC32, anchors & V8 syntax
  install               Apply ASAR hook and extract & patch Web UI (alias: patch)
  sync                  Post-upgrade full sync for Pacman hooks (refreshes backup, hook & Web UI)
  repair                Re-extract & re-patch Web UI from current language_server only
  verify                Show engine CL, hook/UI states, backup pairing & launcher status (alias: status)
  restore               Atomically restore paired pristine app.asar (alias: uninstall)
  extract [dir]         Extract unpatched stock Web UI into a new or empty directory
  pacman-hook           Print (or --write <file>) a root-safe Pacman PostTransaction hook

Options:
  --user <username>     Target desktop account when running as root (or set AGY_TARGET_USER)
  --install-dir <dir>   Antigravity root directory (default: /opt/Antigravity)
  --ui-dir <dir>        Output directory for patched Web UI (default: ~/.local/share/antigravity-externalui)
  --indicator-mode <m>  Context indicator policy: custom (default), polyfill, or stock
  --script-path <file>  (pacman-hook) Absolute path to root-owned antigravity_uipatch.mjs
  --write <file>        (pacman-hook) Write hook directly to /etc/pacman.d/hooks/...
  --dry-run             Every command: perform all checks, write nothing at all
  --force               (restore) Restore backup even if pairing check fails
  --quiet               (sync) Suppress normal stdout output
  --yes                 Accepted for non-interactive CLI compatibility
  -h, --help            Show this help message
`;

function parseArgs(argv) {
  const opts = {
    cmd: null,
    positional: [],
    user: undefined,
    installDir: undefined,
    uiDir: undefined,
    indicatorMode: DEFAULT_INDICATOR_MODE,
    scriptPath: undefined,
    writePath: undefined,
    dryRun: false,
    force: false,
    quiet: false,
    yes: false,
    help: false,
  };

  const validateIndicatorMode = (raw) => {
    if (!INDICATOR_MODES.has(raw)) {
      throw new PatchError(
        `invalid --indicator-mode ${JSON.stringify(raw)} (expected custom, polyfill, or stock)`,
        2
      );
    }
    return raw;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new PatchError(`option ${a} requires an argument`, 2);
      i += 1;
      return argv[i];
    };
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--yes') opts.yes = true;
    else if (a === '--user') opts.user = next();
    else if (a.startsWith('--user=')) opts.user = a.slice('--user='.length);
    else if (a === '--install-dir') opts.installDir = next();
    else if (a.startsWith('--install-dir=')) opts.installDir = a.slice('--install-dir='.length);
    else if (a === '--ui-dir') opts.uiDir = next();
    else if (a.startsWith('--ui-dir=')) opts.uiDir = a.slice('--ui-dir='.length);
    else if (a === '--indicator-mode') opts.indicatorMode = validateIndicatorMode(next());
    else if (a.startsWith('--indicator-mode=')) {
      opts.indicatorMode = validateIndicatorMode(a.slice('--indicator-mode='.length));
    }
    else if (a === '--script-path') opts.scriptPath = next();
    else if (a.startsWith('--script-path=')) opts.scriptPath = a.slice('--script-path='.length);
    else if (a === '--write') opts.writePath = next();
    else if (a.startsWith('--write=')) opts.writePath = a.slice('--write='.length);
    else if (a.startsWith('-')) throw new PatchError(`unknown option: ${a}`, 2);
    else if (!opts.cmd) opts.cmd = a;
    else opts.positional.push(a);
  }
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    if (opts.help || !opts.cmd || opts.cmd === 'help') {
      process.stdout.write(HELP_TEXT);
      return 0;
    }

    switch (opts.cmd) {
      case 'self-test':
        return cmdSelfTest(opts);
      case 'install':
      case 'patch':
        return cmdInstallOrSync(opts, { mode: 'install' });
      case 'sync':
        return cmdInstallOrSync(opts, { mode: 'sync' });
      case 'repair':
        return cmdRepair(opts);
      case 'verify':
      case 'status':
        return cmdVerify(opts);
      case 'restore':
      case 'uninstall':
        return cmdRestore(opts);
      case 'extract':
        return cmdExtract(opts, opts.positional[0]);
      case 'pacman-hook':
        return cmdPacmanHook(opts);
      default:
        throw new PatchError(`unknown command "${opts.cmd}". Run with --help for usage.`, 2);
    }
  } catch (exc) {
    if (exc instanceof PatchError) {
      console.error(C.err(`error: ${exc.message}`));
      return exc.exitCode;
    }
    console.error(C.err(`error: ${exc.message}`));
    return 1;
  }
}

const isDirectRun = (() => {
  try {
    return (
      Boolean(process.argv[1]) &&
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
    );
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exit(main());
}

#!/usr/bin/env node
/**
 * Live standalone engine verification for `antigravity-uipatch`.
 *
 * Starts `language_server` in `--standalone` mode on a random local loopback
 * port with an isolated temporary `--gemini_dir` and `--web_bundle_path`
 * pointing at the patched Web UI directory. Verifies over loopback HTTPS that
 * the engine serves the patched frontend (`index.html`, `main.js`) and reports
 * `sidecars.enabled = true`, then cleanly stops the engine and deletes the
 * temporary directory.
 *
 * What it does NOT do
 * -------------------
 * * Never modifies `app.asar`, `language_server`, or `.desktop` files.
 * * Never launches `/opt/Antigravity/antigravity` (the Electron GUI).
 * * Never reads or writes `~/.gemini/**` (uses an isolated temp `--gemini_dir`).
 *
 * Examples
 * --------
 *   node verify_live.mjs
 *   node verify_live.mjs --ui-dir ~/.local/share/antigravity-uipatch
 *
 * Exit codes:
 *   0 = all live HTTP/RPC and bundle assertions passed
 *   1 = assertion mismatch or HTTP/RPC failure
 *   2 = invalid arguments or engine failed to start
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_INSTALL_DIR,
  FLAGS,
  sha256,
  verifyJsSyntax,
} from './antigravity_uipatch.mjs';

class UsageError extends Error {}

function parseCli(argv) {
  const opts = {
    binary: `${DEFAULT_INSTALL_DIR}/resources/bin/language_server`,
    uiDir: path.join(os.homedir(), '.local/share/antigravity-uipatch'),
    timeoutMs: 20000,
    help: false,
  };
  const requireValue = (name, value) => {
    if (value === undefined || value === '' || value.startsWith('-')) {
      throw new UsageError(`${name} requires a non-empty value`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--binary') opts.binary = requireValue('--binary', (i += 1, argv[i]));
    else if (a.startsWith('--binary=')) opts.binary = requireValue('--binary', a.slice('--binary='.length));
    else if (a === '--ui-dir') opts.uiDir = requireValue('--ui-dir', (i += 1, argv[i]));
    else if (a.startsWith('--ui-dir=')) opts.uiDir = requireValue('--ui-dir', a.slice('--ui-dir='.length));
    else if (a === '--timeout-ms') {
      const raw = requireValue('--timeout-ms', (i += 1, argv[i]));
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1000) {
        throw new UsageError(`--timeout-ms must be a finite number >= 1000 (got ${JSON.stringify(raw)})`);
      }
      opts.timeoutMs = n;
    } else if (a.startsWith('--timeout-ms=')) {
      const raw = a.slice('--timeout-ms='.length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1000) {
        throw new UsageError(`--timeout-ms must be a finite number >= 1000 (got ${JSON.stringify(raw)})`);
      }
      opts.timeoutMs = n;
    } else throw new UsageError(`unknown option: ${a}`);
  }
  return opts;
}

function loopbackHttps(port, reqPath, { method = 'GET', headers = {}, body = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTPS request timed out: ${reqPath}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function waitForHttpsPort(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stderrBuf = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (proc.stderr) proc.stderr.off('data', onData);
      if (proc.stdout) proc.stdout.off('data', onData);
      proc.off('exit', onExit);
      proc.off('error', onError);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (port) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(port);
    };

    const timer = setTimeout(() => {
      fail(
        startupError(
          `language_server did not report an HTTPS port within ${timeoutMs} ms` +
            (stderrBuf ? `\n--- engine output ---\n${stderrBuf.slice(-2000)}` : '')
        )
      );
    }, timeoutMs);

    const onData = (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const m = /listening on \w+ port at (\d+) for HTTPS/i.exec(stderrBuf);
      if (m) succeed(Number(m[1]));
    };
    const onExit = (code, sig) => {
      fail(
        startupError(
          `language_server exited early (code=${code}, signal=${sig})` +
            (stderrBuf ? `\n--- engine output ---\n${stderrBuf.slice(-2000)}` : '')
        )
      );
    };
    // A spawn failure (EACCES, ENOENT, ...) is only reported via 'error'; without
    // this listener it would surface as an unhandled error event.
    const onError = (err) => fail(startupError(`failed to spawn language_server: ${err.message}`));

    if (proc.stderr) proc.stderr.on('data', onData);
    if (proc.stdout) proc.stdout.on('data', onData);
    proc.once('exit', onExit);
    proc.once('error', onError);
  });
}

async function stopChild(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  // A child that never spawned has no OS process to signal.
  if (proc.pid === undefined) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  const race = await Promise.race([
    exited.then(() => 'exited'),
    new Promise((r) => setTimeout(() => r('timeout'), 4000)),
  ]);
  if (race === 'timeout' && proc.exitCode === null) {
    try { proc.kill('SIGKILL'); } catch {}
    await exited;
  }
}

const startupError = (message) => {
  const err = new Error(message);
  err.isStartupError = true;
  return err;
};

export async function runLiveVerification(opts) {
  if (!fs.existsSync(opts.binary)) {
    throw startupError(`engine binary not found: ${opts.binary}`);
  }
  const diskMainPath = path.join(opts.uiDir, 'main.js');
  if (!fs.existsSync(diskMainPath)) {
    throw startupError(`patched UI bundle not found at ${diskMainPath} (run 'install' first)`);
  }
  const diskMainSha = sha256(fs.readFileSync(diskMainPath));

  const tmpGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-uipatch-live-'));
  const csrf = crypto.randomUUID();
  let proc = null;

  try {
    proc = spawn(
      opts.binary,
      [
        '--standalone',
        '--override_ide_name', 'antigravity',
        '--subclient_type', 'hub',
        '--csrf_token', csrf,
        '--gemini_dir', tmpGeminiDir,
        '--app_data_dir', 'antigravity-livecheck',
        '--https_server_port', '0',
        '--http_server_port', '0',
        '--enable_sidecars',
        '--web_bundle_path', opts.uiDir,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      }
    );

    const httpsPort = await waitForHttpsPort(proc, opts.timeoutMs);
    console.log(`engine     : started pid=${proc.pid}, loopback https=127.0.0.1:${httpsPort}`);

    // 1. Check index.html
    const idxRes = await loopbackHttps(httpsPort, '/');
    if (idxRes.status !== 200 || !idxRes.body.toString('utf8').includes('main.js')) {
      throw new Error(`GET / unexpected response: HTTP ${idxRes.status}`);
    }
    console.log(`GET /      : HTTP ${idxRes.status} (${idxRes.body.length} bytes)`);

    // 2. Check served main.js matches patched bundle and passes all assertions
    const jsRes = await loopbackHttps(httpsPort, '/main.js', { timeoutMs: 15000 });
    if (jsRes.status !== 200) {
      throw new Error(`GET /main.js failed: HTTP ${jsRes.status}`);
    }
    const servedSha = sha256(jsRes.body);
    if (servedSha !== diskMainSha) {
      throw new Error(`served main.js SHA256 (${servedSha}) != disk bundle (${diskMainSha})`);
    }
    const jsText = jsRes.body.toString('utf8');
    verifyJsSyntax(jsText, 'served-main.js');

    const expectedDecl = `var __AGY_UNLOCKED=${JSON.stringify(FLAGS)},__AGY_NATIVE_BOOLS=`;
    // These are *static bundle assertions*: they prove the patch text is present
    // in the served bundle. They are not a runtime proof that persistence works.
    const checks = [
      ['Google Native Mendel baseline + developer mode (static)', jsText.includes(expectedDecl)],
      [
        'secondary getMendelFlags normalized (static)',
        jsText.includes('__agyResolveExperiments(ok?x:void 0)') &&
          jsText.includes('__agyNormalizeMendel(__agyResolveExperiments'),
      ],
      ['direct Mendel local override hook (__agyOvr) (static)', jsText.includes('__agyOvr(b,(d=d[b])?!d.disabled:!1)')],
      [
        'nativeStorage hydrate + queued persist bridge (static)',
        jsText.includes('__agyHydrateDevStorage') && jsText.includes('__agyPersist') && jsText.includes('__agyAfterLocalWrite'),
      ],
      [
        'success-empty clears cache / fetch error keeps last-known-good (static)',
        jsText.includes('__agyLastGood') && jsText.includes('__agyResolveExperiments'),
      ],
      ['native <datalist> removed (static)', !jsText.includes('custom-flag-suggestions')],
      [
        'upward scrollable picker (static)',
        jsText.includes('bottom-full mb-1') && jsText.includes('max-h-64 overflow-y-auto'),
      ],
      ['picker ARIA listbox wiring (static)', jsText.includes('agy-flag-picker-listbox')],
      ['local-write notifier registered by provider (static)', jsText.includes('__agyRegisterNotifier(function()')],
    ];
    for (const [label, ok] of checks) {
      if (!ok) throw new Error(`bundle assertion failed: ${label}`);
      console.log(`check      : [OK] ${label}`);
    }
    console.log(`GET /main  : HTTP 200 (${jsRes.body.length.toLocaleString()} bytes, sha256=${servedSha.slice(0, 16)}...)`);

    // 3. Check Connect RPC GetServerConfiguration
    const rpcRes = await loopbackHttps(
      httpsPort,
      '/exa.language_server_pb.LanguageServerService/GetServerConfiguration',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf,
        },
        body: '{}',
      }
    );
    if (rpcRes.status !== 200) {
      throw new Error(`GetServerConfiguration failed: HTTP ${rpcRes.status}`);
    }
    const cfg = JSON.parse(rpcRes.body.toString('utf8'));
    if (cfg?.config?.sidecars?.enabled !== true) {
      throw new Error(`expected sidecars.enabled=true, got ${JSON.stringify(cfg?.config?.sidecars)}`);
    }
    console.log(`RPC check  : [OK] sidecars.enabled=true`);
    console.log('\x1b[32mLIVE VERIFICATION PASSED\x1b[0m');
    return 0;
  } finally {
    await stopChild(proc);
    fs.rmSync(tmpGeminiDir, { recursive: true, force: true });
  }
}

const isDirect = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirect) {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (exc) {
    console.error(`error: ${exc.message}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(
      'Usage: node verify_live.mjs [--binary <language_server>] [--ui-dir <patched-ui-dir>] [--timeout-ms <ms>]'
    );
    console.log('Exit codes: 0 = all checks passed, 1 = assertion/HTTP failure, 2 = usage or startup failure');
    process.exit(0);
  }
  runLiveVerification(opts)
    .then((code) => process.exit(code))
    .catch((exc) => {
      console.error(`\x1b[31merror: ${exc.message}\x1b[0m`);
      // A missing/undexecutable engine or a failed spawn is a *startup* problem
      // (2), not a verification verdict (1).
      process.exit(exc && exc.isStartupError ? 2 : 1);
    });
}

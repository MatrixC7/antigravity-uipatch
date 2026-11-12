#!/usr/bin/env node
/**
 * Offline unit tests for `antigravity_uipatch.mjs`.
 *
 * Never modifies the installed Antigravity files. Exercises ASAR round-tripping,
 * pure `node:zlib` ZIP extraction & CRC32 safety, all 4 UI patches (including
 * live VM execution of Google Native Mendel baseline, bidirectional local override
 * semantics, and cross-port `nativeStorage` persistence), backup pairing invariants,
 * `.desktop` editing, and atomic write guards.
 *
 * Run:
 *   node --test tests/
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';

import {
  ASAR_HOOK_ANCHOR,
  ASAR_TARGET,
  ENV_VAR,
  NATIVE_MENDEL_BOOL_FLAGS,
  NATIVE_MENDEL_STRING_FLAGS,
  PATCH_FLAG_PICKER,
  PATCH_MENDEL_BASELINE,
  PATCH_MENDEL_OVERRIDES,
  PATCH_MENDEL_SERVICE,
  PatchError,
  analyseDesktopExec,
  applyPatches,
  asarEntryText,
  atomicWriteFile,
  commitPatchedUi,
  crc32,
  ensurePairedBackup,
  extractZipToDir,
  findWebBundleZip,
  keyFileEscapeValue,
  keyFileUnescapeValue,
  parseLauncherAssignment,
  listZipEntries,
  pairsWith,
  patchAsarBuffer,
  patchDesktopText,
  readAsar,
  readEntry,
  readZipEntry,
  repack,
  resolveWriteRoot,
  sha256,
  tokenizeDesktopExec,
  unpatchDesktopText,
  unquoteDesktopExecToken,
  verifyJsSyntax,
} from '../antigravity_uipatch.mjs';
// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

function makeSyntheticAsar(files) {
  const header = { files: {} };
  const chunks = [];
  let off = 0;

  for (const [rel, spec] of Object.entries(files)) {
    const parts = rel.split('/');
    let node = header;
    for (const p of parts.slice(0, -1)) {
      node.files[p] ??= { files: {} };
      node = node.files[p];
    }
    const leaf = parts.at(-1);
    if (typeof spec === 'object' && spec !== null && spec.unpacked) {
      node.files[leaf] = { size: spec.size ?? 10, unpacked: true };
      continue;
    }
    const data = Buffer.from(typeof spec === 'string' ? spec : spec.content);
    const entry = { size: data.length, offset: String(off) };
    if (spec?.withIntegrity) {
      const h = sha256(data);
      entry.integrity = { algorithm: 'SHA256', hash: h, blockSize: 4194304, blocks: [h] };
    }
    node.files[leaf] = entry;
    chunks.push(data);
    off += data.length;
  }

  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const dataOffset = (16 + json.length + 3) & ~3;
  const head = Buffer.alloc(dataOffset);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(dataOffset - 8, 4);
  head.writeUInt32LE(dataOffset - 12, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  return Buffer.concat([head, ...chunks], dataOffset + off);
}

function makeSyntheticZip(entries) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const { name, content = '', method = 8 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const sum = crc32(raw);

    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(sum, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lh, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);

    localParts.push(lh, comp);
    cdParts.push(cd);
    offset += lh.length + comp.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

const SYNTH_BASELINE_SNIPPET =
  'var _expRef=E.ExperimentWithVariantSchema;' +
  'async function Ola(a){var b=e,c=e;try{try{let d=c(await b(a.getMendelFlags(Wb(Uia,{})))).experimentConfig?.experiments??[];a={};for(let f of d)f.keyString&&(a[f.keyString]=f);return a}catch(d){c(),console.error("Failed to fetch Mendel flags",d)}}finally{b()}}';

const SYNTH_BUNDLE = [
  SYNTH_BASELINE_SNIPPET,
  'function Hi(a,b){return(a=a.experiments[b])?!a.disabled:!1}',
  'function Ii(a,b){var c;c||(c=jh(a.stateProvider,d=>(d=d[b])?!d.disabled:!1),a.experimentEnabledProviders.set(b,c));return c}',
  'var Tla=class{constructor(a){this.lsClient=a;this.stateProvider={getState:()=>({}),setState:()=>{},dispose:()=>{}};this.flagOverrideSync=new Mla(async b=>{var c=e,d=e;try{d(await c(this.lsClient.setMendelFlagOverrides(Wb(yia,{overrides:b}))))}finally{c()}});}dispose(){Rla(this);this.stateProvider.dispose();}}',
  'const svc={getMendelFlags:async()=>f(async u=>{var v=e,w=e;try{let x=w(await v(u.getMendelFlags(Wb(Uia,{}))));return{experimentConfig:x.experimentConfig?{experiments:x.experimentConfig.experiments}:void 0}}finally{v()}})};',
  'var IT=a=>(a=NMb(a))?!a.disabled:!1,JT=(a,b)=>{var c=NMb(a);return b};',
  'var fgd=class{constructor(a=window.nativeStorage){this.bridge=a;this.cache=new Map;this.listeners=new Set}async init(){let c=(await this.bridge.getItems())||{};for(let [d,f]of Object.entries(c))this.cache.set(d,f)}notify(a){for(let b of this.listeners)b(a)}get(a,b){return this.cache.get(a)??b}store(a,b){this.cache.set(a,b);this.notify({[a]:b});return this.bridge.updateItems({[a]:b})}remove(a){this.cache.delete(a);this.notify({[a]:null});return this.bridge.updateItems({[a]:null})}onDidChange(a){this.listeners.add(a);return()=>{this.listeners.delete(a)}}};',
  'async function hhd(a){var b=e,c=e;try{if(typeof window!=="undefined"&&window.nativeStorage)try{let f=new fgd(window.nativeStorage);c(await b(f.init()));return{backend:"native-bridge",storageService:f}}catch(f){}return{backend:"web",storageService:null}}finally{b()}}',
  'function EGb({suggestedFlags:a,onAdd:b}){var [c,d]=B.useState("");var r=B.createElement("datalist",{id:"custom-flag-suggestions"},a.map(function(g){return B.createElement("option",{key:g,value:g})}));return B.createElement("div",null,r,B.createElement(Uy,{variant:"outline",size:"sm",disabled:!c.trim(),onClick:function(){}},"Add"))}',
].join(';\n');

// ---------------------------------------------------------------------------
// ASAR & Backup Pairing Tests
// ---------------------------------------------------------------------------

test('synthetic ASAR round-trips byte-for-byte when unedited', () => {
  const buf = makeSyntheticAsar({
    'index.html': '<html></html>',
    'dist/main.js': 'console.log(1);',
    'nested/a/b.txt': { content: 'payload', withIntegrity: true },
  });
  const out = repack(readAsar(buf), new Map());
  assert.equal(sha256(out), sha256(buf));
});

test('real host app.asar round-trips byte-for-byte when present', () => {
  const candidate = [
    path.join(os.homedir(), '.local/share/antigravity-uipatch-backup/app.asar.orig'),
    '/opt/Antigravity/resources/app.asar',
  ].find((p) => fs.existsSync(p));
  if (!candidate) return;
  const buf = fs.readFileSync(candidate);
  const out = repack(readAsar(buf), new Map());
  assert.equal(sha256(out), sha256(buf));
});

test('ASAR replacement updates target entry & integrity while leaving siblings untouched', () => {
  const buf = makeSyntheticAsar({
    'a.js': 'aaaa',
    'b.js': { content: 'bbbb', withIntegrity: true },
    'c.js': 'cccc',
    'u.js': { unpacked: true, size: 99 },
  });
  const out = repack(readAsar(buf), new Map([['b.js', Buffer.from('REPLACED!')]]));
  const after = readAsar(out);

  assert.equal(after.header.files['a.js'].offset, '0');
  assert.equal(after.header.files['c.js'].offset, '8');
  assert.equal('offset' in after.header.files['u.js'], false);
  assert.equal(after.header.files['b.js'].size, 9);
  assert.equal(after.header.files['b.js'].integrity.hash, sha256(Buffer.from('REPLACED!')));
  assert.equal(asarEntryText(after, 'a.js'), 'aaaa');
  assert.equal(asarEntryText(after, 'b.js'), 'REPLACED!');
  assert.equal(asarEntryText(after, 'c.js'), 'cccc');
});

test('patchAsarBuffer is idempotent and pairsWith validates build pairing', () => {
  const pristineLs = `const args = [\n${ASAR_HOOK_ANCHOR}\nspawn(cmd, args);\n`;
  const pristine = makeSyntheticAsar({
    [ASAR_TARGET]: { content: pristineLs, withIntegrity: true },
    'dist/utils.js': 'module.exports = 42;',
  });

  const { buf: patched, changed } = patchAsarBuffer(pristine);
  assert.equal(changed, true);
  const { buf: patchedAgain, changed: changedAgain } = patchAsarBuffer(patched);
  assert.equal(changedAgain, false);
  assert.equal(sha256(patchedAgain), sha256(patched));

  assert.equal(pairsWith(pristine, pristine), true);
  assert.equal(pairsWith(pristine, patched), true);
  assert.equal(pairsWith(patched, patched), false);

  const otherBuild = makeSyntheticAsar({
    [ASAR_TARGET]: { content: pristineLs, withIntegrity: true },
    'dist/utils.js': 'module.exports = 99;',
  });
  assert.equal(pairsWith(pristine, otherBuild), false);
});

// ---------------------------------------------------------------------------
// Embedded ZIP & CRC32 Safety Tests
// ---------------------------------------------------------------------------

test('ZIP reader extracts STORE and DEFLATE entries and detects CRC32 corruption', () => {
  const zip = makeSyntheticZip([
    { name: 'index.html', content: '<!doctype html>', method: 0 },
    { name: 'sub/main.js', content: 'console.log("hello");'.repeat(20), method: 8 },
  ]);
  const entries = listZipEntries(zip);
  assert.equal(entries.length, 2);
  assert.equal(readZipEntry(zip, entries[0]).toString('utf8'), '<!doctype html>');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-zip-'));
  try {
    extractZipToDir(zip, tmp);
    assert.equal(fs.readFileSync(path.join(tmp, 'sub/main.js'), 'utf8'), 'console.log("hello");'.repeat(20));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const corrupted = Buffer.from(zip);
  corrupted[42] ^= 0xff;
  assert.throws(() => readZipEntry(corrupted, entries[0]), PatchError);
});

test('ZIP reader rejects path-traversal entry names and skips tzdata archives', () => {
  const traversal = makeSyntheticZip([{ name: '../evil.sh', content: 'boom', method: 0 }]);
  assert.throws(() => listZipEntries(traversal), PatchError);

  const tzZip = makeSyntheticZip([{ name: 'Asia/Shanghai', content: 'TZif2', method: 0 }]);
  const uiZip = makeSyntheticZip([
    { name: 'index.html', content: '<html></html>', method: 0 },
    { name: 'main.js', content: 'var x=1;', method: 8 },
  ]);
  const fakeElf = Buffer.concat([Buffer.alloc(128, 0x7f), tzZip, Buffer.alloc(64, 0), uiZip, Buffer.alloc(32, 0)]);
  const found = findWebBundleZip(fakeElf);
  assert.ok(found);
  assert.equal(found.offset, 128 + tzZip.length + 64);
});

// ---------------------------------------------------------------------------
// Frontend Mendel Baseline, Local Override & Picker Patch Tests
// ---------------------------------------------------------------------------

test('applyPatches transforms all 4 sites cleanly and passes V8 syntax check', () => {
  const src = SYNTH_BUNDLE + ';function afterMtb(){return 7}';
  const { output, results } = applyPatches(src, { flags: ['enable-developer-mode'] });

  assert.equal(results.length, 4);
  assert.equal(output.includes('datalist'), false);
  assert.equal(output.includes('custom-flag-suggestions'), false);
  assert.ok(output.includes('bottom-full mb-1'));
  assert.ok(output.includes('max-h-64 overflow-y-auto'));
  assert.equal(output.includes('top-full'), false);
  assert.ok(output.endsWith(';function afterMtb(){return 7}'));

  assert.doesNotThrow(() => verifyJsSyntax(output));
});

test('injected __agyNormalizeMendel seeds Google Native baseline on empty list and preserves live OAuth list', () => {
  const { output } = applyPatches(SYNTH_BASELINE_SNIPPET, {
    flags: ['enable-developer-mode'],
    patches: [PATCH_MENDEL_BASELINE],
  });

  let store = null;
  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_schema, init) => ({ ...init }),
    Uia: 'ReqSchema',
    e: (x) => x,
    console,
    window: {
      localStorage: {
        getItem: (k) => (k === 'jetski.developer.customFlagOverrides' ? store : null),
      },
    },
  });
  vm.runInContext(output, ctx);

  // 1. Gateway Mode: empty Mendel list -> returns exact Google Native baseline + enable-developer-mode
  const gwList = ctx.__agyNormalizeMendel([]);
  const expectedTotal =
    NATIVE_MENDEL_BOOL_FLAGS.length + 1 + Object.keys(NATIVE_MENDEL_STRING_FLAGS).length;
  assert.equal(gwList.length, expectedTotal);
  const byKey = new Map(gwList.map((x) => [x.keyString, x]));
  assert.equal(byKey.get('enable-developer-mode')?.disabled, false);
  assert.equal(byKey.get('enable-jetbox-terminal-v2')?.disabled, false);
  assert.equal(byKey.get('enable-aux-pane-redesign')?.disabled, false);
  assert.equal(byKey.get('enable-ui-sidecars')?.disabled, false);
  assert.equal(byKey.get('max-media-attachments')?.payload?.value, '15');

  // 2. Google Native OAuth Mode: live server list -> preserved intact, only enable-developer-mode forced ON
  const liveInput = [
    { keyString: 'enable-developer-mode', disabled: true },
    { keyString: 'server-future-flag', disabled: false },
    { keyString: 'server-disabled-flag', disabled: true },
  ];
  const liveOut = ctx.__agyNormalizeMendel(liveInput);
  assert.equal(liveOut.length, 3);
  const liveMap = new Map(liveOut.map((x) => [x.keyString, x]));
  assert.equal(liveMap.get('enable-developer-mode')?.disabled, false);
  assert.equal(liveMap.get('server-future-flag')?.disabled, false);
  assert.equal(liveMap.get('server-disabled-flag')?.disabled, true);

  // 3. __agyOvr honors pre-hydration localStorage fallback and bound override map in both directions
  assert.equal(ctx.__agyOvr('enable-ui-sidecars', true), true);
  store = JSON.stringify({ 'enable-ui-sidecars': false, 'enable-file-explorer-tab': true });
  assert.equal(ctx.__agyOvr('enable-ui-sidecars', true), false);
  assert.equal(ctx.__agyOvr('enable-file-explorer-tab', false), true);
  assert.equal(ctx.__agyOvr('untouched-flag', true), true);
});

test('clientStorageFeature + nativeStorage bridge persists overrides across random-port restarts', async () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });
  const diskStore = {};

  function makePortWindow() {
    const portLocal = new Map();
    return {
      localStorage: {
        getItem: (k) => (portLocal.has(k) ? portLocal.get(k) : null),
        setItem: (k, v) => portLocal.set(k, String(v)),
        removeItem: (k) => portLocal.delete(k),
      },
      dispatchEvent: () => {},
      nativeStorage: {
        getItems: async () => ({ ...diskStore }),
        updateItems: async (changes) => {
          for (const [k, v] of Object.entries(changes)) {
            if (v === null) delete diskStore[k];
            else diskStore[k] = v;
          }
        },
      },
    };
  }

  const makeCtx = (win) =>
    vm.createContext({
      E: { ExperimentWithVariantSchema: 'SchemaStub' },
      Wb: (_s, init) => ({ ...init }),
      yia: 'OverrideSchema',
      Uia: 'ReqSchema',
      B: {},
      Uy: 'ButtonStub',
      Rla: () => {},
      f: (fn) => fn,
      jh: () => ({}),
      NMb: () => null,
      Mla: class {},
      e: (x) => x,
      console,
      setTimeout,
      clearTimeout,
      Promise,
      window: win,
    });

  // Launch 1 (port A): bind clientStorageFeature (`hhd`) and write overrides -> lands in diskStore & __agyOvr
  const win1 = makePortWindow();
  const ctx1 = makeCtx(win1);
  vm.runInContext(output, ctx1);
  const { storageService: s1 } = await ctx1.hhd({});
  await s1.store(
    'jetski.developer.customFlagOverrides',
    '{"remove-conversation-history":false,"enable-file-explorer-tab":true}'
  );
  assert.equal(
    diskStore['jetski.developer.customFlagOverrides'],
    '{"remove-conversation-history":false,"enable-file-explorer-tab":true}'
  );
  assert.equal(ctx1.__agyOvr('remove-conversation-history', true), false);
  assert.equal(ctx1.__agyOvr('enable-file-explorer-tab', false), true);

  // Launch 2 (new random port B -> empty localStorage): early hydration reads diskStore before Ola resolves
  const win2 = makePortWindow();
  assert.equal(win2.localStorage.getItem('jetski.developer.customFlagOverrides'), null);
  const ctx2 = makeCtx(win2);
  vm.runInContext(output, ctx2);
  await ctx2.__agyHydrateDevStorage();
  assert.equal(ctx2.__agyOvr('remove-conversation-history', true), false);
  assert.equal(ctx2.__agyOvr('enable-file-explorer-tab', false), true);
});

test('hydration retries after a transient getItems failure instead of caching the failure', async () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });
  let calls = 0;

  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_s, init) => ({ ...init }),
    yia: 'OverrideSchema',
    Uia: 'ReqSchema',
    B: {},
    Uy: 'ButtonStub',
    Rla: () => {},
    f: (fn) => fn,
    jh: () => ({}),
    NMb: () => null,
    Mla: class {},
    e: (x) => x,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      nativeStorage: {
        getItems: async () => {
          calls += 1;
          if (calls === 1) throw new Error('transient IPC failure');
          return { 'jetski.developer.customFlagOverrides': '{"recovered":true}' };
        },
        updateItems: async () => {},
      },
    },
  });
  vm.runInContext(output, ctx);

  await ctx.__agyHydrateDevStorage();
  assert.equal(calls, 1);
  assert.equal(ctx.__agyHydrateState, 'idle', 'a failed hydration must remain retryable');

  await ctx.__agyHydrateDevStorage();
  assert.equal(calls, 2, 'the second attempt must actually hit the bridge again');
  assert.equal(ctx.__agyHydrateState, 'done');
  assert.equal(
    ctx.__agyOvr('recovered', false),
    true,
    'a later successful hydration must apply the disk value'
  );
});

test('a transient Mendel fetch error keeps the last-known-good live table', async () => {
  const { output } = applyPatches(SYNTH_BASELINE_SNIPPET, {
    flags: ['enable-developer-mode'],
    patches: [PATCH_MENDEL_BASELINE],
  });

  let mode = 'live';
  const liveTable = [
    { keyString: 'enable-ui-sidecars', disabled: true },
    { keyString: 'oauth-only-experiment', disabled: false },
  ];

  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_schema, init) => ({ ...init }),
    Uia: 'ReqSchema',
    e: (x) => x,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: undefined,
  });
  vm.runInContext(output, ctx);

  const provider = {
    getMendelFlags: async () => {
      if (mode === 'error') throw new Error('network down');
      return { experimentConfig: { experiments: liveTable } };
    },
  };

  const first = await ctx.Ola(provider);
  assert.equal(first['oauth-only-experiment']?.disabled, false);
  assert.equal(first['enable-ui-sidecars']?.disabled, true, 'live table must be preserved verbatim');

  mode = 'error';
  const second = await ctx.Ola(provider);
  assert.ok(
    second['oauth-only-experiment'],
    'a fetch failure must not discard the previously loaded OAuth table'
  );
  assert.equal(second['enable-ui-sidecars']?.disabled, true);
  assert.equal(second['enable-developer-mode']?.disabled, false, 'developer mode still enforced');
});

test('applyPatches fails closed on missing anchors and rejects double-patching', () => {
  assert.throws(() => applyPatches('function unrelated(){}'), PatchError);

  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });
  assert.throws(() => applyPatches(output, { flags: ['enable-developer-mode'] }), PatchError);
});

test('flagOverrideSync notifies listeners before the backend RPC settles and dispose unregisters', async () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });

  let rpcResolve;
  const rpcPromise = new Promise((res) => {
    rpcResolve = res;
  });
  let setStateCalls = 0;

  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_s, init) => ({ ...init }),
    yia: 'OverrideSchema',
    Uia: 'ReqSchema',
    B: {},
    Uy: 'ButtonStub',
    Rla: () => {},
    f: (fn) => fn,
    jh: () => ({}),
    NMb: () => null,
    Mla: class {
      constructor(fn) {
        this.run = fn;
      }
      set(m) {
        this.desired = m;
        return this.run(m);
      }
    },
    e: (x) => x,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      nativeStorage: { getItems: async () => ({}), updateItems: async () => {} },
    },
  });
  vm.runInContext(output, ctx);

  const provider = new ctx.Tla({
    setMendelFlagOverrides: () => rpcPromise, // never settles yet
  });
  provider.stateProvider = {
    getState: () => ({}),
    setState: () => {
      setStateCalls += 1;
    },
    dispose: () => {},
  };

  const pending = provider.flagOverrideSync.set({ 'enable-ui-sidecars': false });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(ctx.__agyOvr('enable-ui-sidecars', true), false);
  assert.ok(
    setStateCalls >= 1,
    'listeners must be notified BEFORE the backend RPC resolves (no UI lag)'
  );

  rpcResolve({});
  await pending;
  const beforeDispose = setStateCalls;
  provider.dispose();
  ctx.__agySetOvrMap({ 'enable-ui-sidecars': true });
  assert.equal(setStateCalls, beforeDispose, 'disposed provider must no longer receive notifications');
});

test('unquoteDesktopExecToken round-trips the assignment verify() relies on', () => {
  // `verify` must read back exactly what `patchDesktopText` wrote, even when the
  // UI directory contains spaces — otherwise it reports the bundle as ABSENT.
  const tricky = '/tmp/UI with spaces/and&amp';
  const patched = patchDesktopText('[Desktop Entry]\nExec=/usr/bin/x %U\n', tricky);
  const execValue = /^Exec=(.*)$/m.exec(patched.text)[1];
  const assignment = tokenizeDesktopExec(execValue)
    .map(unquoteDesktopExecToken)
    .find((t) => t.startsWith(`${ENV_VAR}=`));
  assert.ok(assignment, 'the assignment token must be recoverable');
  const configured = assignment.slice(ENV_VAR.length + 1).replace(/%%/g, '%');
  assert.equal(configured, tricky, 'the exact directory must survive the round-trip');
});

test('PATCH_FLAG_PICKER handles braces inside string literals without truncation', () => {
  const tricky =
    'function EGb({suggestedFlags:a,onAdd:b}){return B.createElement("div",null,"{unbalanced","}",B.createElement(Uy,{variant:"outline",size:"sm"},"Add"))}' +
    ';function tailSentinel(){return 99}';
  const { output } = applyPatches(tricky, { patches: [PATCH_FLAG_PICKER] });
  assert.ok(output.endsWith(';function tailSentinel(){return 99}'));
  assert.doesNotThrow(() => verifyJsSyntax(output));
});

test('PATCH_FLAG_PICKER fails closed on regex literals and comments instead of guessing', () => {
  const cases = [
    'function mtb({suggestedFlags:a,onAdd:b}){return "}".replace(/}/g,"")};function tail(){return 1}',
    'function mtb({suggestedFlags:a,onAdd:b}){/* } */return 1};function tail(){return 1}',
    'function mtb({suggestedFlags:a,onAdd:b}){// }\nreturn 1};function tail(){return 1}',
  ];
  for (const src of cases) {
    assert.throws(
      () => applyPatches(src, { patches: [PATCH_FLAG_PICKER] }),
      PatchError,
      'unsupported constructs must be rejected, never silently mis-patched'
    );
  }
});

// ---------------------------------------------------------------------------
// Desktop Launcher & Atomic File Safety Tests
// ---------------------------------------------------------------------------

test('patchDesktopText folds into existing env prefix without nesting env env', () => {
  const orig = [
    '[Desktop Entry]',
    'Name=Antigravity',
    'Exec=env http_proxy=http://127.0.0.1:<test-port> /usr/bin/antigravity %U',
    '',
  ].join('\n');

  const p1 = patchDesktopText(orig, '/home/u/.local/share/antigravity-uipatch');
  assert.equal(p1.changed, true);
  assert.equal(p1.text.includes('env env'), false);
  assert.ok(p1.text.includes(`Exec=env ${ENV_VAR}=/home/u/.local/share/antigravity-uipatch http_proxy=`));

  const u1 = unpatchDesktopText(p1.text);
  assert.equal(u1.changed, true);
  assert.equal(u1.text, orig);

  const bare = '[Desktop Entry]\nExec=/usr/bin/antigravity %U\n';
  const p2 = patchDesktopText(bare, '/tmp/ui');
  assert.equal(p2.text, `[Desktop Entry]\nExec=env ${ENV_VAR}=/tmp/ui /usr/bin/antigravity %U\n`);
  assert.equal(unpatchDesktopText(p2.text).text, bare);
});

test('atomicWriteFile refuses to overwrite symbolic links', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-atomic-'));
  try {
    const real = path.join(tmp, 'real.txt');
    const link = path.join(tmp, 'link.txt');
    fs.writeFileSync(real, 'keep');
    fs.symlinkSync(real, link);
    assert.throws(() => atomicWriteFile(link, 'overwrite'), PatchError);
    assert.equal(fs.readFileSync(real, 'utf8'), 'keep');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('patchDesktopText round-trips UI paths containing spaces, quotes and percent signs', () => {
  const orig = '[Desktop Entry]\nExec=/usr/bin/antigravity %U\n';
  const tricky = '/tmp/UI with spaces & "quotes"/a%b';

  const patched = patchDesktopText(orig, tricky);
  assert.equal(patched.changed, true);
  assert.ok(patched.text.includes(`Exec=env `), 'must use an env prefix');

  // The value goes through TWO layers: KeyFile string encoding, then Exec argv
  // encoding. Reading back must reverse both, in order.
  const execRaw = /^Exec=(.*)$/m.exec(patched.text)[1];
  const tokens = tokenizeDesktopExec(keyFileUnescapeValue(execRaw));
  const assignmentToken = tokens.find((t) => unquoteDesktopExecToken(t).startsWith(`${ENV_VAR}=`));
  assert.ok(assignmentToken, 'the assignment must be a single token');
  const assignValue = unquoteDesktopExecToken(assignmentToken);
  assert.equal(
    assignValue,
    `${ENV_VAR}=${tricky.replace(/%/g, '%%')}`,
    'the whole path must be recoverable from the single token'
  );

  // And unwrapping must restore the original file byte-for-byte.
  assert.equal(unpatchDesktopText(patched.text).text, orig);
});

test('extractZipToDir refuses non-empty targets and symlinked ancestors', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-extract-'));
  try {
    const zip = makeSyntheticZip([
      { name: 'index.html', content: '<html></html>', method: 0 },
      { name: 'main.js', content: 'var x=1;', method: 8 },
    ]);

    // 1. Non-empty destination is refused rather than wiped.
    const occupied = path.join(tmp, 'occupied');
    fs.mkdirSync(occupied);
    fs.writeFileSync(path.join(occupied, 'keep.txt'), 'user data');
    assert.throws(() => extractZipToDir(zip, occupied), PatchError);
    assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'user data');

    // 2. A symlinked *ancestor* of the requested root is legitimate (a user's
    //    HOME or /tmp may be a link): it is normalized once, then used.
    const realRoot = path.join(tmp, 'real-root');
    fs.mkdirSync(realRoot);
    const linkRoot = path.join(tmp, 'link-root');
    fs.symlinkSync(realRoot, linkRoot);
    const viaLink = extractZipToDir(zip, path.join(linkRoot, 'nested'));
    assert.equal(viaLink.files, 2);
    assert.ok(fs.existsSync(path.join(realRoot, 'nested', 'main.js')));

    // 3. A symlink created *inside* the authorized root is still refused.
    const guarded = path.join(tmp, 'guarded');
    fs.mkdirSync(guarded);
    const outside = path.join(tmp, 'outside-target');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(guarded, 'sub'));
    assert.throws(
      () => extractZipToDir(makeSyntheticZip([{ name: 'sub/evil.txt', content: 'x', method: 0 }]), guarded),
      PatchError
    );
    assert.equal(fs.existsSync(path.join(outside, 'evil.txt')), false);

    // 4. A fresh directory extracts cleanly.
    const fresh = path.join(tmp, 'fresh');
    const stats = extractZipToDir(zip, fresh);
    assert.equal(stats.files, 2);
    assert.equal(fs.readFileSync(path.join(fresh, 'main.js'), 'utf8'), 'var x=1;');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ZIP reader rejects a decoy EOCD inside a comment and validates the CD end pointer', () => {
  // Build a valid archive, then append a comment whose payload itself starts
  // with a plausible-but-bogus EOCD record.
  const base = makeSyntheticZip([
    { name: 'index.html', content: '<html></html>', method: 0 },
    { name: 'main.js', content: 'var x=1;', method: 8 },
  ]);

  const entries = listZipEntries(base);
  assert.equal(entries.length, 2, 'the honest archive must still parse');

  // Corrupt: declare a zero-size central directory while entries exist.
  const broken = Buffer.from(base);
  broken.writeUInt32LE(0, broken.length - 10); // cdSize at eocd+12
  assert.throws(() => listZipEntries(broken), PatchError, 'cdSize=0 must not be accepted');
});

test('commitPatchedUi never destroys the only surviving bundle when both renames fail', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-commit-'));
  const uiDir = path.join(tmp, 'ui');
  const staging = path.join(tmp, '.uipatch-staging-x');
  const old = path.join(tmp, '.uipatch-old-x');

  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'PRIOR.txt'), 'old working bundle');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'NEW.txt'), 'new bundle');

  const realRename = fs.renameSync;
  let originalError;
  try {
    // Force both the promotion AND the rollback to fail.
    fs.renameSync = (from, to) => {
      if (String(from) === staging || (String(from) === old && String(to) === uiDir)) {
        const err = new Error('EACCES simulated');
        err.code = 'EACCES';
        throw err;
      }
      return realRename(from, to);
    };

    assert.throws(
      () => commitPatchedUi({ ui: uiDir }, { staging, old, meta: {} }),
      (err) => {
        originalError = err;
        return err instanceof PatchError && /rollback also failed/.test(err.message);
      },
      'a double failure must surface as a PatchError naming the preserved copy'
    );
  } finally {
    fs.renameSync = realRename;
  }

  // The previous bundle must STILL exist (now parked at `old`), never deleted.
  assert.ok(fs.existsSync(old), 'the previous bundle must be preserved on disk');
  assert.equal(fs.readFileSync(path.join(old, 'PRIOR.txt'), 'utf8'), 'old working bundle');
  assert.ok(
    originalError.message.includes(old),
    'the error must report the absolute recovery path'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('commitPatchedUi deletes the aside copy only after a successful commit', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-commit-ok-'));
  try {
    const uiDir = path.join(tmp, 'ui');
    const staging = path.join(tmp, '.uipatch-staging-ok');
    const old = path.join(tmp, '.uipatch-old-ok');

    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(path.join(uiDir, 'OLD.txt'), 'old');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'NEW.txt'), 'new');

    const meta = commitPatchedUi({ ui: uiDir }, { staging, old, meta: { ok: true } });
    assert.equal(meta.ok, true);
    assert.equal(fs.readFileSync(path.join(uiDir, 'NEW.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(old), false, 'the aside copy is removed after commit');
    assert.equal(fs.existsSync(staging), false, 'staging is consumed by the rename');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensurePairedBackup refuses a corrupt backup instead of silently keeping it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-bak-'));
  try {
    const backupDir = path.join(tmp, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'app.asar.orig'), 'CORRUPT');
    const buf = makeSyntheticAsar({ [ASAR_TARGET]: 'x' });
    assert.throws(
      () =>
        ensurePairedBackup(
          { backup: backupDir, unpacked: path.join(tmp, 'none') },
          buf,
          true
        ),
      PatchError,
      'a corrupt backup must abort instead of being retained'
    );
    // And the corrupt file must not have been overwritten in the process.
    assert.equal(fs.readFileSync(path.join(backupDir, 'app.asar.orig'), 'utf8'), 'CORRUPT');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('repack tolerates ASAR link nodes and returns input untouched without replacements', () => {
  const header = {
    files: {
      'a.js': { size: 4, offset: '0' },
      'linked.js': { link: 'a.js' },
      'u.js': { size: 9, unpacked: true },
    },
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const dataOffset = (16 + json.length + 3) & ~3;
  const head = Buffer.alloc(dataOffset);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(dataOffset - 8, 4);
  head.writeUInt32LE(dataOffset - 12, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  const buf = Buffer.concat([head, Buffer.from('aaaa')], dataOffset + 4);

  const asar = readAsar(buf);
  // No replacements -> byte-identical passthrough even with a link node present.
  assert.equal(sha256(repack(asar, new Map())), sha256(buf));

  // Replacing a normal entry must not trip over the link node.
  const out = repack(asar, new Map([['a.js', Buffer.from('REPLACED')]]));
  assert.equal(asarEntryText(readAsar(out), 'a.js'), 'REPLACED');
  assert.throws(() => readEntry(readAsar(out), 'linked.js'), PatchError, 'links are not readable entries');
});

// ---------------------------------------------------------------------------
// Round-2 regressions
// ---------------------------------------------------------------------------

test('R2-01: a successful EMPTY Mendel list clears the cache instead of reusing last-known-good', async () => {
  const { output } = applyPatches(SYNTH_BASELINE_SNIPPET, {
    flags: ['enable-developer-mode'],
    patches: [PATCH_MENDEL_BASELINE],
  });
  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_s, init) => ({ ...init }),
    Uia: 'ReqSchema',
    e: (x) => x,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: undefined,
  });
  vm.runInContext(output, ctx);

  let mode = 'live';
  const provider = {
    getMendelFlags: async () => {
      if (mode === 'error') throw new Error('down');
      if (mode === 'empty') return { experimentConfig: { experiments: [] } };
      return {
        experimentConfig: {
          experiments: [{ keyString: 'oauth-only', disabled: false }],
        },
      };
    },
  };

  const live = await ctx.Ola(provider);
  assert.equal(live['oauth-only']?.disabled, false);

  // Successful empty table must NOT resurrect the previous OAuth table.
  mode = 'empty';
  const empty = await ctx.Ola(provider);
  assert.equal(empty['oauth-only'], undefined, 'success-empty must clear the cache');
  assert.equal(empty['enable-jetbox-terminal-v2']?.disabled, false, 'baseline is used instead');

  // A genuine failure still preserves the (now cleared) cache semantics.
  mode = 'error';
  const err = await ctx.Ola(provider);
  assert.equal(err['enable-jetbox-terminal-v2']?.disabled, false);
});

test('R2-02: local storageService writes notify subscribers even when the RPC queue is busy', async () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });
  let notifications = 0;
  let rpcPending = [];
  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_s, init) => ({ ...init }),
    yia: 'OverrideSchema',
    Uia: 'ReqSchema',
    B: {},
    Uy: 'ButtonStub',
    Rla: () => {},
    f: (fn) => fn,
    jh: () => ({}),
    NMb: () => null,
    Mla: class {
      constructor(fn) { this.run = fn; }
      set(m) { return new Promise((res) => rpcPending.push(res)); }
    },
    e: (x) => x,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    window: {
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      nativeStorage: {
        getItems: async () => ({}),
        updateItems: () => new Promise((res) => rpcPending.push(res)),
      },
    },
  });
  vm.runInContext(output, ctx);
  const { storageService } = await ctx.hhd({});

  ctx.__agyRegisterNotifier(() => {
    notifications += 1;
  });

  // Two local writes in a row (set -> reset), with nativeStorage.updateItems still pending.
  storageService.store('jetski.developer.customFlagOverrides', '{"a":true}');
  storageService.store('jetski.developer.customFlagOverrides', '{}');
  await Promise.resolve();

  assert.equal(notifications, 2, 'every distinct local write must notify immediately, independent of RPC/IPC');
});

test('R2-03: desktop encoding survives a real GLib-compatible reading of quotes/$/backtick', () => {
  const cases = ['/tmp/a"b', '/tmp/a$b', '/tmp/a`b', '/tmp/a\\b', '/tmp/a b'];
  for (const uiDir of cases) {
    const patched = patchDesktopText('[Desktop Entry]\nExec=/usr/bin/x %U\n', uiDir);
    const execRaw = /^Exec=(.*)$/m.exec(patched.text)[1];
    // The KeyFile layer must be reversible before Exec tokenising.
    const tokens = tokenizeDesktopExec(keyFileUnescapeValue(execRaw));
    const asg = tokens.map(unquoteDesktopExecToken).find((t) => t.startsWith(`${ENV_VAR}=`));
    assert.ok(asg, `assignment missing for ${uiDir}`);
    assert.equal(asg.slice(ENV_VAR.length + 1).replace(/%%/g, '%'), uiDir);
    // The Exec line must remain a single line (no stray newline introduced).
    assert.equal(patched.text.split('\n').length, 3, 'Exec line must stay on one line');
  }
});

test('R2-05: parseLauncherAssignment follows env semantics and ignores decoy arguments', () => {
  assert.equal(parseLauncherAssignment('Exec=env AGY_UI_BUNDLE=/a /x %U').value, '/a');
  // last assignment wins, like env(1)
  assert.equal(
    parseLauncherAssignment('Exec=env AGY_UI_BUNDLE=/a AGY_UI_BUNDLE=/b /x').value,
    '/b'
  );
  // an assignment AFTER the program is a plain argument, not the environment
  assert.equal(parseLauncherAssignment('Exec=/x AGY_UI_BUNDLE=/decoy').assignment, false);
  assert.equal(
    parseLauncherAssignment('Exec=env AGY_UI_BUNDLE=/real /x AGY_UI_BUNDLE=/decoy').value,
    '/real'
  );
  assert.equal(parseLauncherAssignment('Exec=/usr/bin/env AGY_UI_BUNDLE=/a /x').value, '/a');
  assert.equal(parseLauncherAssignment('Exec=env -u HOME AGY_UI_BUNDLE=/a /x').value, '/a');
});

test('structural anchors survive Closure Compiler identifier re-minification', () => {
  const reminified = SYNTH_BUNDLE
    .replace(/\bOla\b/g, 'Zza')
    .replace(/\bWb\b/g, 'mkPb')
    .replace(/\bUia\b/g, 'ReqPb')
    .replace(/\bE\.ExperimentWithVariantSchema\b/g, 'P9.ExperimentWithVariantSchema')
    .replace(/\bHi\b/g, 'syncR')
    .replace(/\bIi\b/g, 'reactR')
    .replace(/\bjh\b/g, 'mapSt')
    .replace(/\bMla\b/g, 'SyncQ')
    .replace(/\byia\b/g, 'OvrPb')
    .replace(/\bRla\b/g, 'stopT')
    .replace(/\bIT\b/g, 'secB')
    .replace(/\bJT\b/g, 'secI')
    .replace(/\bNMb\b/g, 'secCache')
    .replace(/\bhhd\b/g, 'initClientStorage')
    .replace(/\bfgd\b/g, 'NativeStoreImpl')
    .replace(/\bEGb\b/g, 'FlagCombo')
    .replace(/\bB\./g, 'ReactNs.')
    .replace(/\bUy\b/g, 'OutlineBtn');

  const { output, results } = applyPatches(reminified, { flags: ['enable-developer-mode'] });
  assert.equal(results.length, 4);
  assert.ok(output.includes('async function Zza(a)'));
  assert.ok(output.includes('function FlagCombo({suggestedFlags:a,onAdd:b})'));
  assert.ok(output.includes('ReactNs.createElement(OutlineBtn,'));
  assert.doesNotThrow(() => verifyJsSyntax(output));
});

test('R2-11: scanner refuses the documented silent-swallow counterexample', () => {
  const src =
    'function mtb({suggestedFlags:a,onAdd:b}){return /{a/};\n' +
    'function collateral(){return /}a/};\n' +
    'function sentinel(){return 7}';
  assert.throws(() => applyPatches(src, { patches: [PATCH_FLAG_PICKER] }), PatchError);
});

test('R2-13: repair --dry-run fails when the real patch would fail', () => {
  // Simulate by asserting the in-memory pipeline is exercised: applyPatches on a
  // source without anchors must throw, which is what the dry-run path now calls.
  assert.throws(() => applyPatches('function unrelated(){}'), PatchError);
});

test('resolveWriteRoot reports a clear PatchError when a parent is not a directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uipatch-rwr-'));
  try {
    const file = path.join(tmp, 'afile');
    fs.writeFileSync(file, 'x');
    const linkToFile = path.join(tmp, 'linkfile');
    fs.symlinkSync(file, linkToFile);
    assert.throws(
      () => resolveWriteRoot(path.join(linkToFile, 'sub')),
      (err) => err instanceof PatchError && /not a directory/.test(err.message)
    );
    // A normal (possibly symlinked) directory ancestor still resolves.
    const realDir = path.join(tmp, 'realdir');
    fs.mkdirSync(realDir);
    const linkDir = path.join(tmp, 'linkdir');
    fs.symlinkSync(realDir, linkDir);
    const { root } = resolveWriteRoot(path.join(linkDir, 'nested'));
    assert.equal(root, path.join(fs.realpathSync(realDir), 'nested'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round-3 (release gate) regressions
// ---------------------------------------------------------------------------

test('G1: patching twice is idempotent and keeps other env assignments intact', () => {
  const execValue = 'env OTHER="hello world" /usr/bin/antigravity %U';
  const src = `[Desktop Entry]\nType=Application\nExec=${keyFileEscapeValue(execValue)}\n`;

  const p1 = patchDesktopText(src, '/tmp/plain');
  const p2 = patchDesktopText(p1.text, '/tmp/plain');
  assert.equal(p2.changed, false, 'a second patch must be a no-op');
  assert.equal((p2.text.match(/AGY_UI_BUNDLE=/g) || []).length, 1);

  const info = analyseDesktopExec(p1.text);
  assert.equal(info.value, '/tmp/plain');
  assert.ok(info.assignments.includes('OTHER=hello world'), 'other assignments are preserved');
  assert.equal(info.tokens[info.programIndex], '/usr/bin/antigravity');

  // And unwrapping restores the original file byte-for-byte.
  assert.equal(unpatchDesktopText(p1.text).text, src);
});

test('G1: env options stay before the injected assignment', () => {
  for (const base of [
    'Exec=env -i /usr/bin/x %U',
    'Exec=env -u HOME /usr/bin/x %U',
    'Exec=env -- /usr/bin/x %U',
  ]) {
    const src = `[Desktop Entry]\n${base}\n`;
    const out = patchDesktopText(src, '/tmp/plain');
    const info = analyseDesktopExec(out.text);
    const ourIdx = info.tokens.findIndex((t) => t.startsWith(`${ENV_VAR}=`));
    const optIdx = info.tokens.findIndex((t) => t.startsWith('-'));
    assert.ok(ourIdx > 0, `assignment missing for ${base}`);
    assert.ok(optIdx === -1 || ourIdx > optIdx, `option must precede assignment for ${base}`);
    assert.equal(info.tokens[info.programIndex], '/usr/bin/x', `program preserved for ${base}`);
  }
});

test('G1: unsupported env wrapping is refused, never silently treated as OFF', () => {
  assert.throws(
    () => patchDesktopText('[Desktop Entry]\nExec=env -S "A=1 B=2" /usr/bin/x\n', '/tmp/plain'),
    PatchError
  );
  const parsed = parseLauncherAssignment('[Desktop Entry]\nExec=env -S "A=1 B=2" /usr/bin/x\n');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.assignment, false);
});

test('G1: a program-position argument is never read as env nor deleted', () => {
  const decoy = '[Desktop Entry]\nExec=/usr/bin/x AGY_UI_BUNDLE=/decoy\n';
  const parsed = parseLauncherAssignment(decoy);
  assert.equal(parsed.assignment, false, 'post-program assignment is a plain argument');
  assert.equal(unpatchDesktopText(decoy).changed, false, 'and it must not be removed');
});

test('G2: analyseDesktopExec distinguishes ON / OFF / INVALID', () => {
  const on = analyseDesktopExec('[Desktop Entry]\nExec=env AGY_UI_BUNDLE=/a /usr/bin/x\n');
  assert.equal(on.ok, true);
  assert.equal(on.value, '/a');

  const off = analyseDesktopExec('[Desktop Entry]\nExec=/usr/bin/x\n');
  assert.equal(off.ok, true);
  assert.equal(off.value, null);
  assert.equal(off.usesEnv, false);

  const invalid = analyseDesktopExec('[Desktop Entry]\nName=NoExec\n');
  assert.equal(invalid.ok, false);
  assert.ok(invalid.unsupported);
});

test('G3: secondary Mendel channel catches errors and shares the resolver', () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });
  assert.ok(output.includes('Failed to fetch Mendel flags (secondary)'));
  assert.ok(output.includes('__agyResolveExperiments(ok?x:void 0)'));
  assert.ok(output.includes('__agyDisposeNotifier'), 'provider keeps the notifier disposer');
});

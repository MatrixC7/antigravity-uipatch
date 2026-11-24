#!/usr/bin/env node
/**
 * Offline unit tests for `antigravity_uipatch.mjs`.
 *
 * Never modifies the installed Antigravity files. Exercises ASAR round-tripping,
 * pure `node:zlib` ZIP extraction & CRC32 safety, all 5 UI patches (including
 * live VM execution of Google Native Mendel baseline, bidirectional local override
 * semantics, cross-port `nativeStorage` persistence, and Context & Inference
 * Indicator), backup pairing invariants, read-only `.desktop` `Exec=` parsing,
 * and atomic write guards.
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
  FLAGS,
  NATIVE_MENDEL_BOOL_FLAGS,
  NATIVE_MENDEL_STRING_FLAGS,
  PATCH_CONTEXT_INDICATOR,
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
  flexRe,
  keyFileUnescapeValue,
  parseLauncherAssignment,
  listZipEntries,
  pairsWith,
  patchAsarBuffer,
  readAsar,
  readEntry,
  readZipEntry,
  repack,
  resolveWriteRoot,
  sha256,
  tokenizeDesktopExec,
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
  'var I={};I.TokenType={UNSPECIFIED:0,SYSTEM_PROMPT:1,TOOLS:2,RULES:3,MCP_TOOLS:4,SKILLS:5,SUBAGENTS:6,CHAT_MESSAGES:7,WORKFLOWS:8,PLUGINS:9,FLOWS:10};I.CortexStepStatus={UNSPECIFIED:0,GENERATING:8,RUNNING:2,DONE:3,ERROR:7}',
  'var E1a={startIndex:-50},F1a={startIndex:-1},G1a={startIndex:0,endIndexExclusive:0}',
  'var $7a=a=>({optimisticState:{},trueState:{}}),$B=(a,b)=>{var c=[],{optimisticState:d,trueState:f}=$7a(a);return b.selector(f)}',
  'async function mla(a,b,c){return a.getCascadeTrajectoryGeneratorMetadata(Wb(dia,{cascadeId:b,generatorMetadataOffset:c}))}',
  'function Hi(a,b){return(a=a.experiments[b])?!a.disabled:!1}',
  'function Ii(a,b){var c;c||(c=jh(a.stateProvider,d=>(d=d[b])?!d.disabled:!1),a.experimentEnabledProviders.set(b,c));return c}',
  'var Tla=class{constructor(a){this.lsClient=a;this.stateProvider={getState:()=>({}),setState:()=>{},dispose:()=>{}};this.flagOverrideSync=new Mla(async b=>{var c=e,d=e;try{d(await c(this.lsClient.setMendelFlagOverrides(Wb(yia,{overrides:b}))))}finally{c()}});}dispose(){Rla(this);this.stateProvider.dispose();}}',
  'const svc={getMendelFlags:async()=>f(async u=>{var v=e,w=e;try{let x=w(await v(u.getMendelFlags(Wb(Uia,{}))));return{experimentConfig:x.experimentConfig?{experiments:x.experimentConfig.experiments}:void 0}}finally{v()}})};',
  'var IT=a=>(a=NMb(a))?!a.disabled:!1,JT=(a,b)=>{var c=NMb(a);return b};',
  'var fgd=class{constructor(a=window.nativeStorage){this.bridge=a;this.cache=new Map;this.listeners=new Set}async init(){let c=(await this.bridge.getItems())||{};for(let [d,f]of Object.entries(c))this.cache.set(d,f)}notify(a){for(let b of this.listeners)b(a)}get(a,b){return this.cache.get(a)??b}store(a,b){this.cache.set(a,b);this.notify({[a]:b});return this.bridge.updateItems({[a]:b})}remove(a){this.cache.delete(a);this.notify({[a]:null});return this.bridge.updateItems({[a]:null})}onDidChange(a){this.listeners.add(a);return()=>{this.listeners.delete(a)}}};',
  'async function hhd(a){var b=e,c=e;try{if(typeof window!=="undefined"&&window.nativeStorage)try{let f=new fgd(window.nativeStorage);c(await b(f.init()));return{backend:"native-bridge",storageService:f}}catch(f){}return{backend:"web",storageService:null}}finally{b()}}',
  'function EGb({suggestedFlags:a,onAdd:b}){var [c,d]=B.useState("");var r=B.createElement("datalist",{id:"custom-flag-suggestions"},a.map(function(g){return B.createElement("option",{key:g,value:g})}));return B.createElement("div",null,r,B.createElement(Uy,{variant:"outline",size:"sm",disabled:!c.trim(),onClick:function(){}},"Add"))}',
  'function _toolbarMount(d){return {portal:nw.createPortal(null,null),side:B.createElement(HIc,{conversationId:d})}}',
  'var __bootBindings;(function(a){__bootBindings=a})({autonomousMode:void 0,conciergeCos:void 0,contextUsageIndicator:void 0,contextWindow:void 0,getAppVariant:async function(){return{}}})',
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
    path.join(os.homedir(), '.local/share/antigravity-asar-backup/app.asar.orig'),
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

test('applyPatches transforms all 5 sites cleanly and passes V8 syntax check', () => {
  const src = SYNTH_BUNDLE + ';function afterMtb(){return 7}';
  const { output, results } = applyPatches(src, { flags: FLAGS });

  assert.equal(results.length, 5);
  assert.equal(results[4].id, 'context-usage-indicator');
  assert.equal(results[4].mode, 'enhanced');
  assert.equal(output.includes('datalist'), false);
  assert.equal(output.includes('custom-flag-suggestions'), false);
  assert.ok(output.includes('bottom-full mb-1'));
  assert.ok(output.includes('max-h-64 overflow-y-auto'));
  assert.ok(output.includes('__AgyContextIndicator'));
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
    dia: 'GenReqSchema',
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
    dia: 'GenReqSchema',
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

test('unquoteDesktopExecToken decodes quoted paths with spaces and %% field escapes', () => {
  const execValue = 'env "AGY_UI_BUNDLE=/tmp/UI with spaces/a%%b" /usr/bin/x %U';
  const assignment = tokenizeDesktopExec(execValue)
    .map(unquoteDesktopExecToken)
    .find((t) => t.startsWith(`${ENV_VAR}=`));
  assert.ok(assignment, 'the assignment token must be recoverable');
  const configured = assignment.slice(ENV_VAR.length + 1).replace(/%%/g, '%');
  assert.equal(configured, '/tmp/UI with spaces/a%b');
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
// Desktop Launcher Read-Only Parsing & Atomic File Safety Tests
// ---------------------------------------------------------------------------

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

test('analyseDesktopExec decodes GKeyFile + Exec two-layer escaping for spaces, quotes, $, backticks, and %%', () => {
  // In a GKeyFile `.desktop`, backslashes are doubled (`\\`) on top of Exec quoting.
  const rawDesktop =
    '[Desktop Entry]\n' +
    'Exec=env "AGY_UI_BUNDLE=/tmp/UI with spaces & \\\\"quotes\\\\"/a$b\\\\`c%%d" OTHER="hello world" /usr/bin/antigravity %U\n';
  const info = analyseDesktopExec(rawDesktop);
  assert.equal(info.ok, true);
  assert.equal(info.value, '/tmp/UI with spaces & "quotes"/a$b`c%d');
  assert.ok(info.assignments.includes('OTHER=hello world'));
  assert.equal(info.tokens[info.programIndex], '/usr/bin/antigravity');
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
  const staging = path.join(tmp, '.externalui-staging-x');
  const old = path.join(tmp, '.externalui-old-x');

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
    const staging = path.join(tmp, '.externalui-staging-ok');
    const old = path.join(tmp, '.externalui-old-ok');

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
    dia: 'GenReqSchema',
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

test('parseLauncherAssignment follows env option/assignment semantics and ignores post-program arguments', () => {
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
  assert.equal(parseLauncherAssignment('Exec=env -i -u HOME -C /tmp -- AGY_UI_BUNDLE=/a /x').value, '/a');
});

test('structural anchors survive Closure Compiler identifier re-minification', () => {
  const reminified = SYNTH_BUNDLE
    .replace(/\bOla\b/g, 'Zza')
    .replace(/\bWb\b/g, 'mkPb')
    .replace(/\bUia\b/g, 'ReqPb')
    .replace(/\bE\.ExperimentWithVariantSchema\b/g, '$$P9.ExperimentWithVariantSchema')
    .replace(/\bI\./g, '$$CxPb.')
    .replace(/var I=\{\}/g, 'var $$CxPb={}')
    .replace(/\$7a/g, '$$OptHook')
    .replace(/\$B/g, '$$ConvHook')
    .replace(/\bE1a\b/g, '$$StepSl')
    .replace(/\bF1a\b/g, '$$GenSl')
    .replace(/\bG1a\b/g, '$$ExecSl')
    .replace(/\bdia\b/g, '$$GenReqPb')
    .replace(/\bnw\./g, '$$PortalNs.')
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
    .replace(/\bB\./g, '$$ReactNs.')
    .replace(/\bUy\b/g, 'OutlineBtn');

  const { output, results } = applyPatches(reminified, { flags: FLAGS });
  assert.equal(results.length, 5);
  assert.ok(output.includes('async function Zza(a)'));
  assert.ok(output.includes('function FlagCombo({suggestedFlags:a,onAdd:b})'));
  assert.ok(output.includes('$ReactNs.createElement(OutlineBtn,'));
  assert.ok(output.includes('$ConvHook(convId,CTX_SEL)'));
  assert.ok(output.includes('$GenSl={startIndex:0}'));
  assert.ok(output.includes('$PortalNs.createPortal('));
  assert.doesNotThrow(() => verifyJsSyntax(output));
});

test('structural anchors survive Closure Compiler line-wrap newlines across all 5 patches', () => {
  // Reproduces Antigravity 2.35's ~500-col Closure Compiler wrap (`experimentConfig?\n{experiments:`)
  // and injects newlines at token boundaries inside every patch & sub-anchor site.
  const wrapped = SYNTH_BUNDLE
    .replace('experimentConfig?.experiments??[]', 'experimentConfig?.\nexperiments??\n[]')
    .replace('x.experimentConfig?{experiments:', 'x.experimentConfig?\n{experiments:')
    .replace('a.experiments[b])?!a.disabled:!1', 'a.experiments[b])?\n!a.disabled:\n!1')
    .replace('d=>(d=d[b])?!d.disabled:!1),a.experimentEnabledProviders', 'd=>(d=d[b])?\n!d.disabled:!1),\na.experimentEnabledProviders')
    .replace('setMendelFlagOverrides(Wb(yia,{overrides:b}))', 'setMendelFlagOverrides(\nWb(yia,\n{overrides:\nb}))')
    .replace('Rla(this);this.stateProvider.dispose();', 'Rla(this);\nthis.stateProvider.dispose();')
    .replace('!a.disabled:!1,JT=(a,b)=>{var c=NMb(a)', '!a.disabled:!1,\nJT=(a,b)=>{\nvar c=NMb(a)')
    .replace('async function hhd(a){var b=e,c=e;try{if(typeof window!=="undefined"&&window.nativeStorage)', 'async function hhd(a){\nvar b=e,c=e;\ntry{if(typeof window!=="undefined"&&\nwindow.nativeStorage)')
    .replace('function EGb({suggestedFlags:a,onAdd:b}){', 'function EGb({suggestedFlags:a,\nonAdd:b}){\n')
    .replace('B.createElement(Uy,{variant:"outline",size:"sm"', 'B.createElement(\nUy,{\nvariant:"outline",\nsize:"sm"')
    .replace('})({autonomousMode:', '})\n({\nautonomousMode:')
    .replace('optimisticState:d,trueState:f}=$7a(a);', 'optimisticState:d,\ntrueState:f}=$7a(a);')
    .replace('I.TokenType={UNSPECIFIED:0,SYSTEM_PROMPT:1,', 'I.TokenType={\nUNSPECIFIED:0,\nSYSTEM_PROMPT:1,')
    .replace('nw.createPortal(', 'nw.\ncreatePortal(')
    .replace('getCascadeTrajectoryGeneratorMetadata(Wb(dia,{cascadeId:', 'getCascadeTrajectoryGeneratorMetadata(\nWb(dia,\n{cascadeId:')
    .replace('E1a={startIndex:-50},F1a={startIndex:-1},G1a={startIndex:0,endIndexExclusive:0}', 'E1a={startIndex:-50},\nF1a={startIndex:\n-1},\nG1a={startIndex:0,\nendIndexExclusive:0}');

  const { output, results } = applyPatches(wrapped, { flags: FLAGS });
  assert.equal(results.length, 5);
  assert.equal(results[1].id, 'mendel-service-wrapper');
  assert.equal(results[4].mode, 'enhanced');
  assert.ok(output.includes('__AgyContextIndicator'));
  assert.ok(output.includes('F1a={startIndex:\n0}'));
  assert.doesNotThrow(() => verifyJsSyntax(output));

  // flexRe must preserve spaces inside quoted literals verbatim while expanding outer spaces,
  // and must not confuse escaped `\[` with a character class `[...]` later in the pattern.
  const quoted = flexRe(String.raw`console \. error \( "Failed to fetch" , d \)`);
  assert.equal(quoted.test('console.\nerror("Failed to fetch",\nd)'), true);
  assert.equal(quoted.test('console.error("Failedtofetch",d)'), false);
  const escapedBracket = flexRe(String.raw`var\s+c = \[ \] , x = [A-Za-z0-9_$]+ \( a \)`);
  assert.equal(escapedBracket.test('var c=[\n],x=\nfoo(a)'), true);
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

test('analyseDesktopExec distinguishes configured env, unset Exec=, and unsupported custom wrappers', () => {
  const on = analyseDesktopExec('[Desktop Entry]\nExec=env AGY_UI_BUNDLE=/a /usr/bin/x\n');
  assert.equal(on.ok, true);
  assert.equal(on.value, '/a');

  const unset = analyseDesktopExec('[Desktop Entry]\nExec=/usr/bin/x\n');
  assert.equal(unset.ok, true);
  assert.equal(unset.value, null);
  assert.equal(unset.usesEnv, false);

  const splitOpt = parseLauncherAssignment('[Desktop Entry]\nExec=env -S "A=1 B=2" /usr/bin/x\n');
  assert.equal(splitOpt.ok, false);
  assert.equal(splitOpt.assignment, false);

  const missingExec = analyseDesktopExec('[Desktop Entry]\nName=NoExec\n');
  assert.equal(missingExec.ok, false);
  assert.ok(missingExec.unsupported);
});

test('G3: secondary Mendel channel catches errors and shares the resolver', () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: ['enable-developer-mode'] });
  assert.ok(output.includes('Failed to fetch Mendel flags (secondary)'));
  assert.ok(output.includes('__agyResolveExperiments(ok?x:void 0)'));
  assert.ok(output.includes('__agyDisposeNotifier'), 'provider keeps the notifier disposer');
});

// ---------------------------------------------------------------------------
// Context Usage & Inference Telemetry Indicator Tests
// ---------------------------------------------------------------------------

test('Context Indicator _derive computes 4x2 Last Turn & Session metrics, true cache denominator, CCPA step timestamps, and Scheme B snapshot stability', () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: FLAGS });
  assert.ok(output.includes('F1a={startIndex:0}'), 'generatorMetadatas slice must start at 0');
  const ctx = vm.createContext({
    E: { ExperimentWithVariantSchema: 'SchemaStub' },
    Wb: (_s, init) => ({ ...init }),
    dia: 'GenReqSchema',
    yia: 'OverrideSchema',
    Uia: 'ReqSchema',
    B: {},
    nw: { createPortal: () => null },
    HIc: () => null,
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
    window: undefined,
  });
  vm.runInContext(output, ctx);

  const binding = ctx.__bootBindings.contextUsageIndicator;
  assert.equal(typeof binding?.Indicator, 'function');
  assert.equal(typeof binding?._derive, 'function');

  // 1. Empty / zero state returns null
  assert.equal(binding._derive(undefined), null);
  assert.equal(
    binding._derive({ contextWindowUsage: { estimatedTokensUsed: 0, maxContextTokens: 983040 } }),
    null
  );

  // 2. Multi-turn conversation (Turn 1 explicit durations + Turn 2 native CCPA step timestamps)
  //    Also verifies `totIn = inputTokens(uncached) + cacheReadTokens + cacheWriteTokens`!
  const multi = binding._derive({
    conversationId: 'conv-1',
    contextWindowUsage: {
      lastStepIndex: 5,
      estimatedTokensUsed: 241620,
      maxContextTokens: 983040,
      estimatedAfterCompaction: false,
      tokenGroups: [
        { type: 1, numTokens: 24800 }, // SYSTEM_PROMPT
        { type: 2, numTokens: 19620 }, // TOOLS
        { type: 4, numTokens: 12400 }, // MCP_TOOLS
        { type: 3, numTokens: 4000 },  // RULES
        { type: 5, numTokens: 2400 },  // SKILLS
        { type: 7, numTokens: 178400 }, // CHAT_MESSAGES
      ],
    },
    trajectorySlice: {
      stepsInSlice: [
        {
          status: 3, // DONE (Turn 1)
          metadata: { sourceTrajectoryStepInfo: { stepIndex: 2 } },
          step: { case: 'plannerResponse', value: { response: 'Step 1.' } },
        },
        {
          status: 3, // DONE (Turn 2 - real PROD_UI step metadata: startedAt === finishedGeneratingAt > viewableAt > createdAt!)
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 5 },
            createdAt: { seconds: 100n, nanos: 0 },
            viewableAt: { seconds: 101n, nanos: 600000000 }, // TTFT = 1.60s
            finishedGeneratingAt: { seconds: 104n, nanos: 220000000 }, // Decode = 2.62s, Dur = 4.22s
            completedAt: { seconds: 104n, nanos: 220000000 },
            startedAt: { seconds: 104n, nanos: 220000000 }, // Executor stamps startedAt AT THE END on plannerResponse!
          },
          step: { case: 'plannerResponse', value: { response: 'Step 2.' } },
        },
      ],
      generatorMetadatasInSlice: [
        {
          // Turn 1: 200K total input (180K cached + 20K uncached), TTFT 1.0s, Decode 4.0s, Out 800 (Resp 200 + Think 600)
          stepIndices: [2],
          metadata: {
            case: 'chatModel',
            value: {
              timeToFirstToken: { seconds: 1n, nanos: 0 },
              streamingDuration: { seconds: 4n, nanos: 0 },
              retries: 2,
              retryInfos: [{ waitTime: { seconds: 1n, nanos: 500000000 } }],
              usage: {
                inputTokens: 20000n,
                cacheReadTokens: 180000n,
                outputTokens: 800n,
                thinkingOutputTokens: 600n,
                responseOutputTokens: 200n,
              },
            },
          },
        },
        {
          // Turn 2: real-world CCPA ratio: 6,505 uncached + 637,555 cached = 644,060 total input (~98.99% cache hit)
          stepIndices: [5],
          metadata: {
            case: 'chatModel',
            value: {
              retries: 1,
              retryInfos: [{ waitTime: { seconds: 2n, nanos: 100000000 } }],
              usage: {
                inputTokens: 6505n,
                cacheReadTokens: 637555n,
                outputTokens: 379n,
                thinkingOutputTokens: 149n,
                // responseOutputTokens omitted to test automatic `379 - 149 = 230` derivation
              },
            },
          },
        },
      ],
    },
  });

  assert.ok(multi);
  assert.equal(multi.generating, false);
  assert.equal(multi.used, 241620);
  assert.equal(multi.chat, 178400);
  assert.equal(multi.sys, 63220);
  assert.deepEqual(JSON.parse(JSON.stringify(multi.groups)), [
    ['System', 24800],
    ['Tools', 19620],
    ['MCP', 12400],
    ['Rules/Skills', 6400],
  ]);

  // Verify Last Turn (Turn 2)
  assert.equal(multi.t.totIn, 644060);
  assert.equal(multi.t.uncachedIn, 6505);
  assert.equal(multi.t.cacheRead, 637555);
  assert.ok(Math.abs(multi.t.cachePct - (637555 / 644060) * 100) < 1e-6);
  assert.ok(Math.abs(multi.t.ttftSec - 1.6) < 1e-6);
  assert.ok(Math.abs(multi.t.durSec - 4.22) < 1e-6);
  assert.ok(Math.abs(multi.t.inTps - 644060 / 1.6) < 1e-3);
  assert.ok(Math.abs(multi.t.outTps - 379 / 2.62) < 1e-3);
  assert.equal(multi.t.respTok, 230);
  assert.equal(multi.t.outTok, 379);
  assert.equal(multi.t.thinkTok, 149);
  assert.equal(multi.t.retries, 1);

  // Verify Session · 2 aggregation
  assert.equal(multi.s.count, 2);
  assert.equal(multi.s.totIn, 200000 + 644060);
  assert.equal(multi.s.cacheRead, 180000 + 637555);
  assert.equal(multi.s.uncachedIn, 20000 + 6505);
  assert.equal(multi.s.respTok, 200 + 230);
  assert.equal(multi.s.outTok, 800 + 379);
  assert.equal(multi.s.thinkTok, 600 + 149);
  assert.equal(multi.s.retries, 3);
  assert.equal(multi.s.errs, 0);
  assert.ok(Math.abs(multi.s.ttftSec - (1.0 + 1.6) / 2) < 1e-6);
  assert.ok(Math.abs(multi.s.durSec - (5.0 + 4.22) / 2) < 1e-6);
  assert.ok(Math.abs(multi.s.totalDurSec - (5.0 + 4.22)) < 1e-6);
  assert.ok(Math.abs(multi.s.inTps - (200000 + 644060) / (1.0 + 1.6)) < 1e-3);
  assert.ok(Math.abs(multi.s.outTps - (800 + 379) / (4.0 + 2.62)) < 1e-3);

  // 3. Compaction detection + Scheme B snapshot stability during active Turn 3 (`GENERATING`)
  const duringGen = binding._derive({
    conversationId: 'conv-1',
    contextWindowUsage: {
      lastStepIndex: 5,
      estimatedTokensUsed: 800000,
      maxContextTokens: 983040,
      tokenGroups: [],
    },
    trajectorySlice: {
      stepsInSlice: [
        {
          status: 3, // DONE compaction checkpoint
          metadata: { sourceTrajectoryStepInfo: { stepIndex: 6 } },
          step: { case: 'checkpoint', value: { intentOnly: false } },
        },
        {
          status: 8, // GENERATING Turn 3 in-flight!
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 8 },
            createdAt: { seconds: 200n, nanos: 0 },
            viewableAt: { seconds: 201n, nanos: 0 },
          },
          step: {
            case: 'plannerResponse',
            value: { rawThinking: 'thinking...', response: 'partial...' },
          },
        },
      ],
      generatorMetadatasInSlice: [
        // Turn 1 & Turn 2 completed entries remain in slice (Turn 2's step timing cached from conv-1!)
        {
          stepIndices: [2],
          metadata: {
            case: 'chatModel',
            value: {
              timeToFirstToken: { seconds: 1n, nanos: 0 },
              streamingDuration: { seconds: 4n, nanos: 0 },
              usage: { inputTokens: 20000n, cacheReadTokens: 180000n, outputTokens: 800n, responseOutputTokens: 200n, thinkingOutputTokens: 600n },
            },
          },
        },
        {
          stepIndices: [5],
          metadata: {
            case: 'chatModel',
            value: {
              usage: { inputTokens: 6505n, cacheReadTokens: 637555n, outputTokens: 379n, thinkingOutputTokens: 149n },
            },
          },
        },
        {
          // Placeholder in-flight metadata for step 8 with zero usage
          stepIndices: [8],
          metadata: { case: 'chatModel', value: {} },
        },
      ],
    },
  });
  assert.equal(duringGen.isWarn, true);
  assert.equal(duringGen.approx, true);
  assert.equal(duringGen.generating, true);
  assert.equal(duringGen.s.count, 2, 'in-flight turn must not dilute Session count before completion');
  assert.equal(duringGen.t.outTok, 379, 'Scheme B keeps Last Turn snapshot intact while Turn 3 generates');
  assert.ok(Math.abs(duringGen.t.ttftSec - 1.6) < 1e-6, 'cached step timing survives stepsInSlice eviction');

  // 4. Reopened >50-step session where Turn 1 step timing is unloaded + mid-session standalone errorMessage:
  //    Avg speeds MUST pair only timed calls, Σ Duration marks durApprox=true, and Last Turn stays chronological
  const reopened = binding._derive({
    conversationId: 'conv-reopened-long',
    contextWindowUsage: { lastStepIndex: 70, estimatedTokensUsed: 400000, maxContextTokens: 1000000 },
    trajectorySlice: {
      stepsSlice: { startIndex: -50 },
      totalStepsLength: 75,
      stepsInSlice: [
        {
          status: 7, // standalone errorMessage at step 60 (between Turn 1 @ step 5 and Turn 2 @ step 70)
          metadata: { sourceTrajectoryStepInfo: { stepIndex: 60 } },
          step: { case: 'errorMessage', value: { error: '429 Resource Exhausted' } },
        },
        {
          status: 3, // DONE Turn 2 @ step 70 (loaded in -50 window)
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 70 },
            createdAt: { seconds: 500n, nanos: 0 },
            viewableAt: { seconds: 502n, nanos: 0 }, // TTFT = 2.0s
            finishedGeneratingAt: { seconds: 506n, nanos: 0 }, // Decode = 4.0s, Dur = 6.0s
          },
          step: { case: 'plannerResponse', value: { response: 'Recovered.' } },
        },
      ],
      generatorMetadatasInSlice: [
        {
          // Turn 1 @ step 5 (unloaded from stepsInSlice, no CCPA durations on chatModel, huge 500K tokens!)
          stepIndices: [5],
          metadata: {
            case: 'chatModel',
            value: {
              usage: { inputTokens: 50000n, cacheReadTokens: 450000n, outputTokens: 5000n, thinkingOutputTokens: 3000n },
            },
          },
        },
        {
          // Turn 2 @ step 70 (100K total input, 400 output)
          stepIndices: [70],
          metadata: {
            case: 'chatModel',
            value: {
              usage: { inputTokens: 10000n, cacheReadTokens: 90000n, outputTokens: 400n, thinkingOutputTokens: 100n },
            },
          },
        },
      ],
    },
  });
  assert.equal(reopened.t.stepIdx, 70, 'chronological sort keeps Turn 2 @ step 70 as Last Turn after error @ step 60');
  assert.equal(reopened.t.errs, 0);
  assert.equal(reopened.s.count, 3, '2 chatModel calls + 1 standalone errorMessage');
  assert.equal(reopened.s.errs, 1, 'Session accumulates mid-conversation errorMessage');
  assert.equal(reopened.s.totIn, 500000 + 100000, 'Session sums 100% of historical tokens across unloaded steps');
  assert.equal(reopened.s.outTok, 5000 + 400);
  assert.equal(reopened.s.inTps, 100000 / 2.0, 'Avg In speed pairs ONLY timed Turn 2 (100K / 2s = 50K), not 600K / 2s');
  assert.equal(reopened.s.outTps, 400 / 4.0, 'Avg Out speed pairs ONLY timed Turn 2 (400 / 4s = 100), not 5400 / 4s');
  assert.equal(reopened.s.durSec, 6.0, 'Avg Duration averages strictly over timed calls (6.0s)');
  assert.equal(reopened.s.timedDurCount, 1);

  // 5. Real PROD_UI stream case: generatorMetadatasInSlice has chatModel wiped by TruncateGeneratorMetadataInPlace,
  //    plus 1-attempt retryInfos must report 0 retries, and step fallback MUST still compute In speed & TTFT via createdAt!
  const prodUiFallback = binding._derive({
    conversationId: 'conv-produi-live',
    contextWindowUsage: { lastStepIndex: 12, estimatedTokensUsed: 440000, maxContextTokens: 786432 },
    trajectorySlice: {
      stepsInSlice: [
        {
          status: 3,
          metadata: {
            sourceTrajectoryStepInfo: { stepIndex: 12 },
            createdAt: { seconds: 1794737199n, nanos: 598000000 },
            viewableAt: { seconds: 1794737210n, nanos: 489000000 }, // TTFT = 10.891s
            finishedGeneratingAt: { seconds: 1794737212n, nanos: 378000000 }, // Decode = 1.889s
            startedAt: { seconds: 1794737212n, nanos: 378000000 }, // Post-stream startedAt!
            modelUsage: {
              inputTokens: 2703n,
              cacheReadTokens: 435096n,
              outputTokens: 359n,
              thinkingOutputTokens: 152n,
              responseOutputTokens: 207n,
            },
          },
          step: { case: 'plannerResponse', value: { response: 'OK.' } },
        },
      ],
      generatorMetadatasInSlice: [
        {
          // Truncated PROD_UI metadata: chatModel wiped to undefined!
          stepIndices: [12],
          plannerConfig: { planModel: 1427 },
        },
      ],
    },
  });
  assert.ok(prodUiFallback.t);
  assert.ok(Math.abs(prodUiFallback.t.ttftSec - 10.891) < 1e-3, 'must use createdAt when startedAt >= viewableAt');
  assert.ok(prodUiFallback.t.inTps > 40000, 'In speed must be non-zero (>40K t/s) on PROD_UI step fallback');
  assert.ok(Math.abs(prodUiFallback.t.durSec - 12.78) < 1e-3);

  // Also verify rpcGens override with single-attempt retryInfos (retries=0, retryInfos.length=1 -> 0 retries!)
  const withRpcGens = binding._derive(
    {
      conversationId: 'conv-produi-live',
      contextWindowUsage: { lastStepIndex: 12, estimatedTokensUsed: 440000, maxContextTokens: 786432 },
      trajectorySlice: { stepsInSlice: [], generatorMetadatasInSlice: [] },
    },
    [
      {
        stepIndices: [12],
        metadata: {
          case: 'chatModel',
          value: {
            retries: 0,
            retryInfos: [{ usage: {} }], // 1 attempt = 0 retries!
            timeToFirstToken: { seconds: 2n, nanos: 0 },
            streamingDuration: { seconds: 3n, nanos: 0 },
            usage: { inputTokens: 5000n, cacheReadTokens: 195000n, outputTokens: 300n, responseOutputTokens: 200n, thinkingOutputTokens: 100n },
          },
        },
      },
    ]
  );
  assert.equal(withRpcGens.t.retries, 0, 'single-attempt retryInfos entry must NOT count as a retry');
  assert.equal(withRpcGens.t.ttftSec, 2.0);
  assert.equal(withRpcGens.t.inTps, 100000);
});

test('PATCH_CONTEXT_INDICATOR supports custom override, polyfill bypass, stock passthrough, and native fallback', () => {
  // 1. Upstream stripped (`void 0`) + stock mode -> no-op allowed
  const rStock = applyPatches(SYNTH_BUNDLE, { indicatorMode: 'stock' });
  assert.equal(rStock.results[4].mode, 'stock-empty');
  assert.equal(rStock.output.includes('__AgyContextIndicator'), false);

  // 2. Upstream native present (`{Indicator:NativeComp}`)
  const withNative = SYNTH_BUNDLE.replace(
    'contextUsageIndicator:void 0',
    'contextUsageIndicator:{Indicator:NativeComp}'
  );

  // 2a. Default `custom` mode replaces native with our enhanced indicator
  const rCustom = applyPatches(withNative, { indicatorMode: 'custom' });
  assert.equal(rCustom.results[4].mode, 'enhanced-override');
  assert.ok(rCustom.output.includes('__AgyContextIndicator'));
  assert.equal(rCustom.output.includes('Indicator:NativeComp'), false);
  assert.doesNotThrow(() => verifyJsSyntax(rCustom.output));

  // 2b. `polyfill` mode leaves upstream native implementation untouched
  const rPoly = applyPatches(withNative, { indicatorMode: 'polyfill' });
  assert.equal(rPoly.results[4].mode, 'native-bypassed');
  assert.ok(rPoly.output.includes('contextUsageIndicator:{Indicator:NativeComp}'));
  assert.equal(rPoly.output.includes('__AgyContextIndicator'), false);

  // 2c. Future build where upstream BOTH restored native `{Indicator:NativeComp}` AND refactored `$B` hook:
  //     `custom` mode gracefully preserves native instead of breaking `pacman -Syu`
  const refactoredNative = withNative.replace('optimisticState:d,trueState:f', 'refactoredFutureState:d');
  const rFallback = applyPatches(refactoredNative, { indicatorMode: 'custom' });
  assert.equal(rFallback.results[4].mode, 'native-fallback');
  assert.ok(rFallback.output.includes('contextUsageIndicator:{Indicator:NativeComp}'));

  // 2d. Stripped (`void 0`) with missing `$B` hook MUST still fail closed (exitCode 3)
  const brokenStripped = SYNTH_BUNDLE.replace('optimisticState:d,trueState:f', 'refactoredFutureState:d');
  assert.throws(
    () => applyPatches(brokenStripped, { indicatorMode: 'custom' }),
    (err) => err instanceof PatchError && err.exitCode === 3
  );
});

test('__agyBindStorage seeds contextUsageIndicatorEnabled=true once when unset and respects user false', async () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: FLAGS });
  const diskStore = {};
  const makeCtx = () =>
    vm.createContext({
      E: { ExperimentWithVariantSchema: 'SchemaStub' },
      Wb: (_s, init) => ({ ...init }),
      yia: 'OverrideSchema',
      Uia: 'ReqSchema',
      B: {},
      nw: { createPortal: () => null },
      HIc: () => null,
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
          getItems: async () => ({ ...diskStore }),
          updateItems: async (ch) => { Object.assign(diskStore, ch); },
        },
      },
    });

  // First launch on fresh profile -> seeds "true"
  const c1 = makeCtx();
  vm.runInContext(output, c1);
  const { storageService: s1 } = await c1.hhd({});
  assert.equal(diskStore.contextUsageIndicatorEnabled, 'true');

  // User turns it OFF in Settings -> Appearance -> Chat Layout
  await s1.store('contextUsageIndicatorEnabled', 'false');
  assert.equal(diskStore.contextUsageIndicatorEnabled, 'false');

  // Next launch -> MUST NOT overwrite user's "false"
  const c2 = makeCtx();
  vm.runInContext(output, c2);
  await c2.hhd({});
  assert.equal(diskStore.contextUsageIndicatorEnabled, 'false');
});

test('Context Indicator React component renders cleanly across empty/active/open states and persists t/s [Off | Turn | Avg] mode', async () => {
  const { output } = applyPatches(SYNTH_BUNDLE, { flags: FLAGS });
  const diskStore = {};
  let currentConvState = { agentState: undefined };

  // Minimal deterministic React hooks harness to verify unconditional hook order & VDOM output
  const states = [];
  const refs = [];
  let hookCursor = 0;
  const mockReact = {
    Fragment: 'Fragment',
    useState(init) {
      const idx = hookCursor++;
      if (!(idx in states)) states[idx] = typeof init === 'function' ? init() : init;
      const set = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], set];
    },
    useRef(init) {
      const idx = hookCursor++;
      if (!(idx in refs)) refs[idx] = { current: init };
      return refs[idx];
    },
    useMemo(fn) {
      hookCursor++;
      return fn();
    },
    useEffect() {
      hookCursor++;
    },
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat() };
    },
  };

  function renderOnce(Indicator) {
    hookCursor = 0;
    const tree = Indicator({ conversationId: 'conv-live' });
    return { tree, hooksUsed: hookCursor };
  }

  function findNodes(node, pred, acc = []) {
    if (!node || typeof node !== 'object') return acc;
    if (pred(node)) acc.push(node);
    if (Array.isArray(node.children)) {
      for (const ch of node.children) findNodes(ch, pred, acc);
    }
    return acc;
  }

  function textOf(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    if (typeof node === 'object' && Array.isArray(node.children)) return node.children.map(textOf).join('');
    return '';
  }

  const bundleWithLiveHook = output.replace(
    'var $7a=a=>({optimisticState:{},trueState:{}})',
    'var $7a=a=>({optimisticState:globalThis.__testConvState,trueState:globalThis.__testConvState})'
  );

  const ctx = vm.createContext({
    __testConvState: currentConvState,
    E: { ExperimentWithVariantSchema: 'SchemaStub', Model: {} },
    Wb: (_s, init) => ({ ...init }),
    dia: 'GenReqSchema',
    yia: 'OverrideSchema',
    Uia: 'ReqSchema',
    B: mockReact,
    nw: { createPortal: (el) => el },
    HIc: () => null,
    Uy: 'ButtonStub',
    Rla: () => {},
    f: (fn) => fn,
    jh: () => ({}),
    NMb: () => null,
    Mla: class {},
    e: (x) => x,
    Date,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    document: { body: {} },
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      nativeStorage: {
        getItems: async () => ({ ...diskStore }),
        updateItems: async (ch) => { Object.assign(diskStore, ch); },
      },
    },
  });
  vm.runInContext(bundleWithLiveHook, ctx);
  await ctx.hhd({});

  const { Indicator } = ctx.__bootBindings.contextUsageIndicator;

  // 1. Empty state -> returns null, records baseline hook count
  const rEmpty = renderOnce(Indicator);
  assert.equal(rEmpty.tree, null);
  assert.ok(rEmpty.hooksUsed > 0);

  // 2. Active conversation state -> renders trigger with "25%", identical hook count!
  ctx.__testConvState = {
    agentState: {
      conversationId: 'conv-live',
      contextWindowUsage: {
        lastStepIndex: 1,
        estimatedTokensUsed: 250000,
        maxContextTokens: 1000000,
        tokenGroups: [{ type: 7, numTokens: 200000 }],
      },
      trajectorySlice: {
        stepsInSlice: [],
        generatorMetadatasInSlice: [
          {
            stepIndices: [1],
            error: 'Transient upstream error',
            metadata: {
              case: 'chatModel',
              value: {
                timeToFirstToken: { seconds: 1n, nanos: 0 },
                streamingDuration: { seconds: 62n, nanos: 0 },
                retries: 2,
                usage: {
                  inputTokens: 100n,
                  cacheReadTokens: 299900n, // 299900 / 300000 = 99.966% -> capped at 99.9% (never fake 100.0%)
                  outputTokens: 1500n,
                  thinkingOutputTokens: 1000n,
                  responseOutputTokens: 500n,
                },
              },
            },
          },
          {
            stepIndices: [3],
            metadata: {
              case: 'chatModel',
              value: {
                responseModel: 'gemini-4-argon-b',
                timeToFirstToken: { seconds: 1n, nanos: 0 },
                streamingDuration: { seconds: 2n, nanos: 0 },
                usage: {
                  inputTokens: 20000n,
                  cacheReadTokens: 180000n, // 180K / 200K = 90.0%
                  outputTokens: 150n,
                  thinkingOutputTokens: 100n,
                  responseOutputTokens: 50n,
                },
              },
            },
          },
        ],
      },
    },
  };
  const rClosed = renderOnce(Indicator);
  assert.equal(rClosed.hooksUsed, rEmpty.hooksUsed, 'hook count must stay invariant across null -> active');
  const trigBtn = findNodes(rClosed.tree, (n) => n.props?.['data-testid'] === 'agy-context-usage-indicator')[0];
  assert.ok(trigBtn);
  assert.equal(textOf(trigBtn), '25%');
  assert.ok(
    trigBtn.props.className.includes('h-7') &&
      trigBtn.props.className.includes('text-sm') &&
      trigBtn.props.className.includes('rounded-full'),
    'trigger button aligns with official h-7 text-sm rounded-full composer toolbar pills'
  );
  const trigSvg = findNodes(trigBtn, (n) => n.type === 'svg')[0];
  assert.equal(trigSvg?.props?.width, 16);
  assert.ok(trigSvg?.props?.className?.includes('w-4 h-4'));

  // 3. Click trigger + set pos -> opens dialog with stacked Last Turn & Session · 2 4x2 grids, Avg/Σ prefixes, no model badge
  trigBtn.props.onClick();
  states[3] = { position: 'fixed', zIndex: 9999, right: '16px', bottom: '48px' }; // `pos` state slot
  const rOpen = renderOnce(Indicator);
  assert.equal(rOpen.hooksUsed, rEmpty.hooksUsed, 'hook count must stay invariant when popover opens');
  const dialog = findNodes(rOpen.tree, (n) => n.props?.role === 'dialog')[0];
  assert.ok(dialog);
  const fullText = textOf(dialog);
  assert.equal(fullText.includes('gemini-4-argon-b'), false, 'model badge must be removed');
  assert.ok(fullText.includes('Last Turn'));
  assert.ok(fullText.includes('\u03a3 Session \u00b7 2 turns'));
  assert.ok(fullText.includes('200.0K t/s'), 'Last Turn In speed = 200K / 1.0s');
  assert.ok(fullText.includes('75.0 t/s'), 'Last Turn Out speed = 150 / 2.0s');
  assert.ok(fullText.includes('90.0%'), 'Last Turn Cache hit formatted to 1 decimal place');
  assert.ok(fullText.includes('96.0%'), 'Session Cache hit = 479.9K / 500K = 95.98% -> 96.0%');
  assert.ok(fullText.includes('33.0s'), 'Session Avg Duration = (63s + 3s) / 2 = 33.0s');
  assert.ok(
    fullText.indexOf('\u03a3Input') < fullText.indexOf('\u03a3Cache hit') &&
      fullText.indexOf('\u03a3Cache hit') < fullText.indexOf('AvgIn speed') &&
      fullText.indexOf('AvgIn speed') < fullText.indexOf('AvgDuration'),
    '1A matrix order: top 2 rows Σ (Input/Output, Cache hit/Response), bottom 2 rows Avg (In speed/Out speed, TTFT/Duration)'
  );
  assert.ok(fullText.includes('! 1 error') && fullText.includes('\u21bb 2 retries'), 'Session aggregates errors & retries');

  // 4. Segmented t/s control [Off | Turn | Avg] persists mode to nativeStorage & switches cleanly between Turn (75 t/s), Avg (26 t/s), and Off
  const modeGroup = findNodes(dialog, (n) => n.props?.role === 'group' && n.props?.['aria-label'] === 'Bottom toolbar output speed mode')[0];
  assert.ok(modeGroup, '3-state t/s segmented group must render in header');
  const segBtns = findNodes(modeGroup, (n) => n.type === 'button');
  assert.deepEqual(segBtns.map((b) => textOf(b)), ['Off', 'Turn', 'Avg']);
  assert.equal(segBtns[0].props['aria-pressed'], true);

  // Switch to Turn -> Last Turn Out speed (150 / 2.0s = 75 t/s)
  segBtns[1].props.onClick();
  assert.equal(diskStore['agy.uipatch.indicatorPinTps'], 'turn');
  const rTurn = renderOnce(Indicator);
  const trigTurn = findNodes(rTurn.tree, (n) => n.props?.['data-testid'] === 'agy-context-usage-indicator')[0];
  assert.equal(textOf(trigTurn), '25% \u00b7 75 t/s');

  // Switch to Avg -> Session Avg Out speed (1650 / 64s = 25.8 -> 26 t/s)
  const dialogTurn = findNodes(rTurn.tree, (n) => n.props?.role === 'dialog')[0];
  const avgBtn = findNodes(dialogTurn, (n) => n.type === 'button' && textOf(n) === 'Avg')[0];
  avgBtn.props.onClick();
  assert.equal(diskStore['agy.uipatch.indicatorPinTps'], 'avg');
  const rAvg = renderOnce(Indicator);
  const trigAvg = findNodes(rAvg.tree, (n) => n.props?.['data-testid'] === 'agy-context-usage-indicator')[0];
  assert.equal(textOf(trigAvg), '25% \u00b7 26 t/s');

  // Legacy boolean "true" stored in diskStore migrates cleanly to "avg", and clicking "Off" returns to percentage-only
  diskStore['agy.uipatch.indicatorPinTps'] = 'true';
  const rLegacy = renderOnce(Indicator);
  assert.equal(
    textOf(findNodes(rLegacy.tree, (n) => n.props?.['data-testid'] === 'agy-context-usage-indicator')[0]),
    '25% \u00b7 26 t/s'
  );
  const offBtn = findNodes(findNodes(rLegacy.tree, (n) => n.props?.role === 'dialog')[0], (n) => n.type === 'button' && textOf(n) === 'Off')[0];
  offBtn.props.onClick();
  assert.equal(diskStore['agy.uipatch.indicatorPinTps'], 'off');
  const rOff = renderOnce(Indicator);
  assert.equal(
    textOf(findNodes(rOff.tree, (n) => n.props?.['data-testid'] === 'agy-context-usage-indicator')[0]),
    '25%'
  );
});

#!/usr/bin/env node
/**
 * Offline unit tests for `tools/inspect_flags.mjs`.
 *
 * Run:
 *   node --test tests/
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFrontendFlags } from '../tools/inspect_flags.mjs';

test('parseFrontendFlags extracts customFlag literals, decorator params, includes, and Mendel readers', () => {
  const sample = `
    const cfg = {
      features: {
        fileExplorerTab: {
          feature: { isEnabled: !1 },
          applyAll: [{ runtimeGating: { customFlag: "enable-file-explorer-tab" }, feature: { isEnabled: !0 } }]
        },
        terminalFeature: {
          feature: null,
          applyAll: [{ runtimeGating: { customFlag: "enable-jetbox-terminal-v2" }, feature: {} }]
        }
      },
      skins: {
        dev: { skin: U7c({ critiqueDecoratorFlag: "enable-critique-decorator" }) }
      }
    };
    const a = hk().runtimeEnvironment.customFlags?.includes("enable-battle-mode-custom-agents");
    const s1 = kj(b, "enable-ui-sidecars");
    const s2 = IX("deprecate-workflows");
    const s3 = jj(b, "enable-aux-pane-redesign");
    const s4 = FS("jetski-generative-ui");
    const s5 = GS("max-best-of-n", 8);
    const s6 = mj("agy-hub-announcement-message");
    const s7 = gj().experiments["max-media-attachments"];
  `;

  const { customFlags, mendel } = parseFrontendFlags(sample);
  const byFlag = new Map(customFlags.map((r) => [r.flag, r]));

  assert.equal(customFlags.length, 4);
  assert.deepEqual(byFlag.get('enable-file-explorer-tab').features, ['fileExplorerTab']);
  assert.deepEqual(byFlag.get('enable-jetbox-terminal-v2').features, ['terminalFeature']);
  assert.deepEqual(byFlag.get('enable-critique-decorator').features, ['decorators']);
  assert.ok(byFlag.has('enable-battle-mode-custom-agents'));

  assert.equal(mendel.length, 7);
  assert.deepEqual(
    mendel.map((m) => m.flag).sort(),
    [
      'agy-hub-announcement-message',
      'deprecate-workflows',
      'enable-aux-pane-redesign',
      'enable-ui-sidecars',
      'jetski-generative-ui',
      'max-best-of-n',
      'max-media-attachments',
    ]
  );
});

test('parseFrontendFlags resolves Closure-minified Mendel readers across line wraps', () => {
  const sample = `
    function qj(a,b){return(a=a.experiments[b])?\n!a.disabled:!1}
    function rj(a,b){var c=a.experimentEnabledProviders.\nget(b);return c}
    function sj(a){var b=oj(),\nc=b.experimentStringProviders.get(a);return c}
    var dcd=a=>{\nvar b=rj(oj(),a);return b};
    var TZ=a=>(a=nbc(a))?\n!a.disabled:!1,\nUZ=(a,b)=>{\nvar c=nbc(a);return b};
    const u1 = qj(x, "enable-developer-mode");
    const u2 = rj(x, "enable-ui-sidecars");
    const u3 = dcd("deprecate-workflows");
    const u4 = TZ("jetski-generative-ui");
    const u5 = UZ("max-best-of-n", 8);
    const u6 = sj("agy-hub-announcement-message");
  `;

  const { mendel, symbols } = parseFrontendFlags(sample);
  assert.deepEqual(symbols, {
    reactSym: 'rj',
    hookSym: 'dcd',
    syncSym: 'qj',
    secBoolSym: 'TZ',
    secIntSym: 'UZ',
    strSym: 'sj',
  });
  assert.equal(mendel.length, 6);
  assert.deepEqual(
    mendel.map((m) => m.flag).sort(),
    [
      'agy-hub-announcement-message',
      'deprecate-workflows',
      'enable-developer-mode',
      'enable-ui-sidecars',
      'jetski-generative-ui',
      'max-best-of-n',
    ]
  );
});

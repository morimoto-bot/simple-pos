'use strict';
// 画面ロジック（index.html の <logic> 区間）の確認。お金の計算は、GASの calcCart_ と同じ答えになることを確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createEnv, withCheck } = require('./gas-fake');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/\/\* <logic> \*\/([\s\S]*?)\/\* <\/logic> \*\//);
assert.ok(m, 'logic区間が見つからない');
const Logic = new Function(m[1] + '; return Logic;')();

test('index.html の全スクリプトが構文として正しい。WMS用の名前や機能が残っていない', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((x) => x[1]);
  assert.ok(scripts.length >= 1);
  for (const s of scripts) new vm.Script(s);
  assert.ok(!/wms\.|slipImport|出荷伝票|入荷予定|簡易WMS/.test(html.replace(/簡易WMSの派生/g, '')), 'WMS用の記述が残っていない');
  assert.match(html, /<title>簡易POS<\/title>/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.ok(!/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/.test(html), 'GASのURLを直書きしていない');
  assert.match(html, /integrity="sha384-/);
});

test('印刷: レシートだけを印刷する（@media print）。印刷用の領域がある', () => {
  assert.match(html, /@media print/);
  assert.match(html, /id="printArea"/);
  assert.match(html, /body>\*:not\(#printArea\)\{display:none!important\}/);
});

// ---- 計算が、GASの calcCart_ と一致する ----
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('お金の計算: 画面（calcCart）とGAS（calcCart_）が、ランダムな500カートで完全に一致する（税率・値引・小計値引・端数処理）', () => {
  const env = createEnv();
  const r = rng(20261109);
  const modes = ['切り捨て', '切り上げ', '四捨五入'];
  for (let n = 0; n < 500; n++) {
    const lines = [];
    const k = 1 + Math.floor(r() * 6);
    for (let i = 0; i < k; i++) {
      const gross = r() < 0.2;
      lines.push({
        price: 1 + Math.floor(r() * (gross ? 99999 : 2000)), qty: 1 + Math.floor(r() * 5), rate: r() < 0.5 ? 8 : 10,
        disc: r() < 0.3 ? { type: r() < 0.5 ? 'yen' : 'pct', value: r() < 0.5 ? Math.floor(r() * 100) : Math.floor(r() * 101) } : null
      });
    }
    const sub = r() < 0.4 ? { type: r() < 0.5 ? 'yen' : 'pct', value: Math.floor(r() * (r() < 0.5 ? 500 : 101)) } : null;
    const mode = modes[Math.floor(r() * 3)];
    const a = JSON.parse(JSON.stringify(Logic.calcCart(lines, sub, mode)));
    const b = JSON.parse(JSON.stringify(env.run(`calcCart_(${JSON.stringify(lines)}, ${JSON.stringify(sub)}, ${JSON.stringify(mode)})`)));
    assert.deepEqual(a, b, JSON.stringify({ lines, sub, mode }));
  }
});

test('お金の計算の性質: 按分の合計は値引額と等しい／行の合計は合計と等しい／税率別の合計は合計と等しい／合計は0以上', () => {
  const r = rng(77);
  for (let n = 0; n < 300; n++) {
    const lines = Array.from({ length: 1 + Math.floor(r() * 5) }, () => ({ price: 1 + Math.floor(r() * 3000), qty: 1 + Math.floor(r() * 4), rate: r() < 0.5 ? 8 : 10, disc: r() < 0.3 ? { type: 'pct', value: Math.floor(r() * 101) } : null }));
    const sub = r() < 0.6 ? { type: r() < 0.5 ? 'yen' : 'pct', value: Math.floor(r() * 400) % (r() < 0.5 ? 101 : 400) } : null;
    const c = Logic.calcCart(lines, sub, '切り捨て');
    assert.equal(c.lines.reduce((a, l) => a + l.alloc, 0), c.subDisc);
    assert.equal(c.lines.reduce((a, l) => a + l.amount, 0), c.total);
    assert.equal(c.byRate[8] + c.byRate[10], c.total);
    assert.ok(c.total >= 0 && c.lines.every((l) => l.amount >= 0));
    assert.ok(c.tax[8] <= c.byRate[8] && c.tax[10] <= c.byRate[10]);
  }
});

test('国税庁Q&Aの例: 10%対象60,000円→5,454円、8%対象40,000円→2,962円（税率ごとに1回の端数処理）', () => {
  const c = Logic.calcCart([{ price: 60000, qty: 1, rate: 10, disc: null }, { price: 40000, qty: 1, rate: 8, disc: null }], null, '切り捨て');
  assert.equal(c.tax[10], 5454); assert.equal(c.tax[8], 2962);
});

test('fmtYen / byRateOf / normRegNo / newTxKey / changeOf', () => {
  assert.equal(Logic.fmtYen(1234567), '¥1,234,567'); assert.equal(Logic.fmtYen(-1000), '-¥1,000'); assert.equal(Logic.fmtYen(0), '¥0'); assert.equal(Logic.fmtYen(null), '');
  assert.deepEqual(Logic.byRateOf([{ rate: 8, amount: 100 }, { rate: 10, amount: 300 }, { rate: 8, amount: -20 }]), { 8: 80, 10: 300 });
  assert.equal(Logic.normRegNo('ｔ１２３４－５６７８９０１２３'), 'T1234567890123');
  assert.equal(Logic.normRegNo(''), ''); assert.equal(Logic.normRegNo('12345'), null); assert.equal(Logic.normRegNo('T123'), null);
  const k = Logic.newTxKey(Date.now(), Math.random());
  assert.ok(k.length >= 8 && k.length <= 64);
  assert.notEqual(Logic.newTxKey(1, 0.123456), Logic.newTxKey(1, 0.654321));
  assert.equal(Logic.changeOf(1000, 1500), 500); assert.equal(Logic.changeOf(1000, 900), -100);
  assert.equal(Logic.toNum('¥1,200'), 1200); assert.ok(isNaN(Logic.toNum('abc')));
});

test('validateJan: 桁数・チェックデジット', () => {
  assert.equal(Logic.validateJan('4901777300446').ok, true);
  assert.equal(Logic.validateJan('4901777300447').ok, false);
  assert.equal(Logic.validateJan(withCheck('490123456789')).ok, true);
  assert.equal(Logic.validateJan('12').ok, false);
});

test('画面の送信内容が、GASの会計と整合する: 同じカートをGASへ送ると、画面の合計・内税と一致する', () => {
  const env = createEnv();
  const J1 = '4901777300446', J2 = withCheck('490123456789');
  env.post('masterUpsert', { jan: J1, name: 'A', price: 330, rate: '10%', stock: 50 });
  env.post('masterUpsert', { jan: J2, name: 'B', price: 162, rate: '8%', stock: 50 });
  const lines = [{ jan: J1, qty: 3, rate: 10, price: 330, disc: { type: 'pct', value: 10 } }, { jan: J2, qty: 4, rate: 8, price: 162, disc: null }];
  const sub = { type: 'yen', value: 55 };
  const ui = Logic.calcCart(lines.map((l) => ({ price: l.price, qty: l.qty, rate: l.rate, disc: l.disc })), sub, '切り捨て');
  const r = env.post('saleCreate', { txKey: 'parity-key-12345', lines: lines.map((l) => ({ jan: l.jan, qty: l.qty, disc: l.disc || undefined })), method: 'カード', subDisc: sub });
  assert.equal(r.tx.total, ui.total); assert.equal(r.tx.tax10, ui.tax[10]); assert.equal(r.tx.tax8, ui.tax[8]);
});

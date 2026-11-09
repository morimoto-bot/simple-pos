'use strict';
// 簡易POS v0.3: 会計ソフト向けの日別の売上集計（dailyReport）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446';                 // 税込 1,000円・10%
const J2 = withCheck('490123456789');       // 税込   108円・8%
const TX = '取引', SALES = '売上明細';
let seq = 0;
const key = () => 'rep-key-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);

function setup() {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '商品A', price: 1000, rate: '10%', stock: 100 });
  env.post('masterUpsert', { jan: J2, name: '軽減品B', price: 108, rate: '8%', stock: 100 });
  env.post('settingsSave', { values: { 事業者名: 'サンプル商店', 登録番号: 'T1234567890123' } });
  return env;
}
const sale = (env, lines, extra = {}) => env.post('saleCreate', Object.assign({ txKey: key(), lines: lines || [{ jan: J1, qty: 2 }, { jan: J2, qty: 1 }], method: '現金' }, extra));
function partsAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { y: p.year, m: p.month, d: p.day, date: `${p.year}/${p.month}/${p.day}`, ts: `${p.year}/${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}` };
}
/** 取引を n日前のものに書き換える（取引ID・日時・売上明細・返品元を新しい日付に合わせる）。新しいIDを返す */
function backdate(env, id, days, serial = 1) {
  const p = partsAgo(days);
  const nid = `T-${p.y}${p.m}${p.d}-${String(serial).padStart(4, '0')}`;
  const tx = env.sheet(TX), sa = env.sheet(SALES);
  tx.dump().forEach((r, i) => {
    if (i === 0) return;
    if (r[0] === id) tx.getRange(i + 1, 1, 1, 2).setValues([[nid, p.ts]]);
    if (r[8] === id) tx.getRange(i + 1, 9, 1, 1).setValues([[nid]]);
  });
  sa.dump().forEach((r, i) => { if (i > 0 && r[0] === id) sa.getRange(i + 1, 1, 1, 3).setValues([[nid, r[1], p.ts]]); });
  return nid;
}
const col = (res, name) => res.header.indexOf(name);
const rowOf = (res, date) => res.rows.find((r) => r[0] === date);
const dash = (d) => d.replace(/\//g, '-');

test('日別の集計: 件数・客数・税率別・支払方法別。返品はマイナスで、純額になる', () => {
  const env = setup();
  const a = sale(env);                                   // 2,108円（10%: 2,000 / 8%: 108）現金
  const b = sale(env, [{ jan: J1, qty: 1 }], { method: 'カード' });   // 1,000円 カード
  backdate(env, a.tx.id, 2, 1); const bId = backdate(env, b.tx.id, 2, 2);
  const c = sale(env, [{ jan: J1, qty: 1 }]);            // 今日 1,000円 現金
  assert.equal(env.post('saleReturn', { id: bId, items: [{ line: 1, qty: 1 }] }).ok, true);   // 今日付けの返品（-1,000円 カード）

  const d2 = partsAgo(2).date, d0 = partsAgo(0).date;
  const r = env.get('dailyReport', { from: dash(d2), to: dash(d0) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.header.slice(0, 3), ['日付', '取引件数', '客数']);
  assert.equal(r.rows.length, 2); assert.equal(r.days, 2);
  const x = rowOf(r, d2), y = rowOf(r, d0);
  assert.ok(x && y);
  const g = (row, name) => row[col(r, name)];
  // 2日前: 2件。売上3,108円。10%対象3,000円、軽減8%対象108円。現金2,108・カード1,000
  assert.equal(g(x, '取引件数'), 2); assert.equal(g(x, '客数'), 2);
  assert.equal(g(x, '売上（通常・税込）'), 3108); assert.equal(g(x, '返品・取消（税込）'), 0); assert.equal(g(x, '純売上（税込）'), 3108);
  assert.equal(g(x, '10%対象（税込）'), 3000); assert.equal(g(x, '軽減8%対象（税込）'), 108);
  assert.equal(g(x, '10%対象（税込）') - g(x, '10%内消費税等'), g(x, '10%対象（税抜）'));
  assert.equal(g(x, '軽減8%対象（税込）') - g(x, '軽減8%内消費税等'), g(x, '軽減8%対象（税抜）'));
  assert.equal(g(x, '現金'), 2108); assert.equal(g(x, 'カード'), 1000);
  // 今日: 通常1件（1,000円）と返品1件（-1,000円）→ 純売上0。支払方法別も純額（現金+1,000、カード-1,000）
  assert.equal(g(y, '取引件数'), 1); assert.equal(g(y, '売上（通常・税込）'), 1000);
  assert.equal(g(y, '返品・取消（税込）'), -1000); assert.equal(g(y, '純売上（税込）'), 0);
  assert.equal(g(y, '10%対象（税込）'), 0, '返品の行が引かれて、対象額も純額');
  assert.equal(g(y, '現金'), 1000); assert.equal(g(y, 'カード'), -1000);
  assert.equal(g(y, '返品件数'), 1); assert.equal(g(y, '取消件数'), 0);
  // 税額は、取引シートの内税の合計と一致する（精算と同じ数え方）
  const txRows = env.sheet(TX).dump().slice(1);
  const sumTx = (day, i) => txRows.filter((t) => String(t[1]).startsWith(day)).reduce((s, t) => s + Number(t[i]), 0);
  assert.equal(g(x, '10%内消費税等'), sumTx(d2, 4)); assert.equal(g(x, '軽減8%内消費税等'), sumTx(d2, 3));
  assert.equal(g(y, '10%内消費税等'), sumTx(d0, 4));
  // 合計行
  assert.equal(r.total[0], '合計');
  assert.equal(r.total[col(r, '純売上（税込）')], 3108);
  assert.equal(r.total[col(r, '取引件数')], 3);
  // 精算（1日分）と同じ数字になる
  const st = env.get('settlement', { date: dash(d2) });
  assert.equal(st.net, g(x, '純売上（税込）')); assert.equal(st.byRate[10], g(x, '10%対象（税込）')); assert.equal(st.tax[10], g(x, '10%内消費税等'));
  assert.equal(c.ok, true);
});

test('取消: 件数は元のまま、返品・取消の欄にマイナスで入る。純売上は0になる', () => {
  const env = setup();
  const a = sale(env, [{ jan: J1, qty: 1 }]);
  assert.equal(env.post('saleVoid', { id: a.tx.id }).ok, true);
  const d0 = dash(partsAgo(0).date);
  const r = env.get('dailyReport', { from: d0, to: d0 });
  const row = r.rows[0];
  assert.equal(row[col(r, '取引件数')], 1); assert.equal(row[col(r, '売上（通常・税込）')], 1000);
  assert.equal(row[col(r, '返品・取消（税込）')], -1000); assert.equal(row[col(r, '純売上（税込）')], 0);
  assert.equal(row[col(r, '取消件数')], 1);
});

test('期間: 取引のない日は行を作らない。期間の外は入らない。from省略は月初、to省略は今日', () => {
  const env = setup();
  const a = sale(env); backdate(env, a.tx.id, 10, 1);
  const b = sale(env); backdate(env, b.tx.id, 5, 1);
  const d10 = partsAgo(10).date, d5 = partsAgo(5).date;
  const all = env.get('dailyReport', { from: dash(d10), to: dash(d5) });
  assert.deepEqual(all.rows.map((r) => r[0]), [d10, d5], '日付の昇順。間の日（取引なし）は出ない');
  const only = env.get('dailyReport', { from: dash(d10), to: dash(partsAgo(8).date) });
  assert.deepEqual(only.rows.map((r) => r[0]), [d10]);
  assert.equal(env.get('dailyReport', { from: dash(partsAgo(3).date), to: dash(partsAgo(1).date) }).rows.length, 0);
  assert.equal(env.get('dailyReport', {}).ok, true, '引数なしは、今月の月初から今日まで');
  // スラッシュ区切りでもよい
  assert.equal(env.get('dailyReport', { from: d10, to: d5 }).rows.length, 2);
});

test('入力のチェック: 日付の形・順序・期間の上限。合言葉なしは拒否', () => {
  const env = setup();
  assert.equal(env.get('dailyReport', { from: '2026-13-1', to: '2026-11-09' }).error, 'bad_request');
  assert.equal(env.get('dailyReport', { from: '2026-11-09', to: '2026-11-01' }).error, 'bad_request');
  assert.equal(env.get('dailyReport', { from: '2025-01-01', to: '2026-11-09' }).error, 'bad_request', '366日を超える');
  assert.equal(env.get('dailyReport', { from: '2025-11-10', to: '2026-11-09' }).ok, true, '366日ちょうどは通る');
  assert.equal(env.raw('GET', { action: 'dailyReport', from: '2026-11-01', to: '2026-11-09' }).error, 'unauthorized');
});

test('アーカイブへ移した日付も合算される。移す前と後で、同じ数字になる', () => {
  const env = setup();
  const a = sale(env), b = sale(env, [{ jan: J1, qty: 3 }], { method: 'カード' }), c = sale(env);
  backdate(env, a.tx.id, 130, 1); backdate(env, b.tx.id, 100, 1); backdate(env, c.tx.id, 3, 1);
  const q = { from: dash(partsAgo(140).date), to: dash(partsAgo(0).date) };
  const before = env.get('dailyReport', q);
  assert.equal(before.rows.length, 3);
  const mv = env.post('archiveRun', {});
  assert.equal(mv.moved.tx, 2);
  const after = env.get('dailyReport', q);
  assert.equal(after.ok, true); assert.equal(after.archiveError, '');
  assert.deepEqual(after.rows, before.rows); assert.deepEqual(after.total, before.total);
  assert.equal(env.sheet(TX).dump().length - 1, 1, '通常のシートには、新しい1件だけ');
});

test('アーカイブを開けない時は、通常のシートの分だけで答え、archiveErrorで知らせる', () => {
  const env = setup();
  const a = sale(env), c = sale(env);
  backdate(env, a.tx.id, 100, 1); backdate(env, c.tx.id, 3, 1);
  env.post('archiveRun', {});
  env.state.archiveFail = true;
  const r = env.get('dailyReport', { from: dash(partsAgo(110).date), to: dash(partsAgo(0).date) });
  assert.equal(r.ok, true); assert.equal(r.rows.length, 1);
  assert.ok(r.archiveError.length > 0);
});

test('取引が窓（TX_WINDOW）に収まらない時は truncated で知らせる。アーカイブで補える日付は別', () => {
  const env = setup();
  env.run('CONFIG.TX_WINDOW = 3');
  [8, 7, 6, 5, 4].forEach((d, i) => { const s = sale(env, [{ jan: J1, qty: 1 }]); backdate(env, s.tx.id, d, i + 1); });
  const r = env.get('dailyReport', { from: dash(partsAgo(10).date), to: dash(partsAgo(0).date) });
  assert.equal(r.truncated, true, '直近3件しか見ていない');
  assert.equal(r.rows.length, 3);
  const ok = env.get('dailyReport', { from: dash(partsAgo(6).date), to: dash(partsAgo(0).date) });
  assert.equal(ok.truncated, false, '期間の先頭が窓の中なら、取りこぼしはない');
});

test('金額の列に文字列が混ざらない（会計ソフト・表計算で数値として読める）', () => {
  const env = setup();
  sale(env, [{ jan: J1, qty: 1 }]);
  const r = env.get('dailyReport', { from: dash(partsAgo(0).date), to: dash(partsAgo(0).date) });
  r.rows.concat([r.total]).forEach((row) => row.slice(1).forEach((v) => assert.equal(typeof v, 'number')));
  assert.equal(r.header.length, r.rows[0].length);
});

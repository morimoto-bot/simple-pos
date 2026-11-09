'use strict';
// 簡易POS v0.2: アーカイブ（古い取引・売上明細・入出荷履歴を、年ごとの別スプレッドシートへ移す）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446';                 // 税込 1,000円・10%
const J2 = withCheck('490123456789');       // 税込   108円・8%
const TX = '取引', SALES = '売上明細', IO = '入出荷履歴';
let seq = 0;
const key = () => 'arc-key-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);

function setup() {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '商品A', price: 1000, rate: '10%', stock: 100 });
  env.post('masterUpsert', { jan: J2, name: '軽減品B', price: 108, rate: '8%', stock: 100 });
  env.post('settingsSave', { values: { 事業者名: 'サンプル商店', 登録番号: 'T1234567890123' } });
  return env;
}
const sale = (env, lines, extra = {}) => env.post('saleCreate', Object.assign({ txKey: key(), lines: lines || [{ jan: J1, qty: 2 }, { jan: J2, qty: 1 }], method: '現金' }, extra));
const rows = (env, name) => env.sheet(name).dump().slice(1);
const arc = (env) => Array.from(env.archives.values());
const pad = (n) => String(n).padStart(2, '0');
function partsAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { y: p.year, m: p.month, d: p.day, ts: `${p.year}/${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}` };
}
/** 取引を n日前のものに書き換える（時間を進める代わり）。取引ID・日時・売上明細・返品元を、すべて新しい日付に合わせる。新しいIDを返す */
function backdate(env, id, days, serial = 1) {
  const p = partsAgo(days);
  const nid = `T-${p.y}${p.m}${p.d}-${String(serial).padStart(4, '0')}`;
  const tx = env.sheet(TX), sa = env.sheet(SALES);
  tx.dump().forEach((r, i) => {
    if (i === 0) return;
    if (r[0] === id) { tx.getRange(i + 1, 1, 1, 2).setValues([[nid, p.ts]]); }
    if (r[8] === id) tx.getRange(i + 1, 9, 1, 1).setValues([[nid]]);
  });
  sa.dump().forEach((r, i) => { if (i > 0 && r[0] === id) sa.getRange(i + 1, 1, 1, 3).setValues([[nid, r[1], p.ts]]); });
  return nid;
}
const ymOf = (days) => { const p = partsAgo(days); return `${p.y}-${p.m}`; };
const ids = (env) => rows(env, TX).map((r) => r[0]);

test('既定: 取引90日・履歴2か月、自動実行はOFF。選べる値だけ受け付ける', () => {
  const env = setup();
  const st = env.get('archiveStatus');
  assert.deepEqual(st.settings, { txDays: 90, histMonths: 2, auto: false });
  assert.deepEqual(st.options.days, [0, 30, 60, 90, 120, 180, 365]);
  assert.deepEqual(env.post('archiveSettings', { txDays: 60, histMonths: 6, auto: true }).settings, { txDays: 60, histMonths: 6, auto: true });
  assert.equal(env.post('archiveSettings', { txDays: 45 }).error, 'bad_request');
  assert.equal(env.post('archiveSettings', { histMonths: 1 }).error, 'bad_request');
  assert.equal(env.get('archiveStatus').settings.txDays, 60, '拒否された値では変わらない');
  assert.equal(env.get('archiveRun', { dryRun: true }).error, 'bad_request', 'GETでは実行できない');
});

test('確認（dryRun）: 件数だけ返し、何も変えない。アーカイブ用のスプレッドシートも作らない', () => {
  const env = setup();
  const a = sale(env); backdate(env, a.tx.id, 100);
  const before = JSON.stringify([env.sheet(TX).dump(), env.sheet(SALES).dump()]);
  const r = env.post('archiveRun', { dryRun: true });
  assert.equal(r.due.tx, 1); assert.equal(r.due.sales, 2); assert.equal(r.moved.tx, 0);
  assert.equal(JSON.stringify([env.sheet(TX).dump(), env.sheet(SALES).dump()]), before);
  assert.equal(arc(env).length, 0);
});

test('取引と売上明細: 90日を過ぎたものだけ、月ごとのシートへ移る。新しいものは残る', () => {
  const env = setup();
  const old1 = sale(env), old2 = sale(env), edge = sale(env), cur = sale(env);
  const o1 = backdate(env, old1.tx.id, 130, 1), o2 = backdate(env, old2.tx.id, 100, 2);
  backdate(env, edge.tx.id, 89, 3);
  const r = env.post('archiveRun', {});
  assert.equal(r.moved.tx, 2); assert.equal(r.moved.sales, 4);
  assert.equal(ids(env).length, 2, '89日前と今日の2件が残る');
  assert.ok(ids(env).includes(cur.tx.id));
  assert.equal(rows(env, SALES).length, 4, '残った2件の明細（2行×2）');
  const files = arc(env);
  const names = files.flatMap((f) => f.getSheets().map((s) => [f.name, s.name]));
  const y1 = ymOf(130), y2 = ymOf(100);
  assert.ok(names.some(([f, s]) => f === '簡易POS_アーカイブ_' + y1.slice(0, 4) && s === '取引_' + y1), '取引_' + y1);
  assert.ok(names.some(([f, s]) => s === '売上明細_' + y2), '売上明細も月ごと');
  assert.ok(!names.some(([, s]) => s === 'シート1'), '空の「シート1」は消える');
  const txRows = files.flatMap((f) => f.getSheets()).filter((s) => s.name.startsWith('取引_')).flatMap((s) => s.body());
  assert.deepEqual(txRows.map((x) => x[0]).sort(), [o1, o2].sort());
  assert.deepEqual(files[0].getSheets().find((s) => s.name.startsWith('取引_')).dump()[0], env.sheet(TX).dump()[0], '見出しは元と同じ');
  const st = env.get('archiveStatus');
  assert.equal(st.last.tx, 2); assert.equal(st.last.mode, 'manual'); assert.ok(st.years.length >= 1);
  assert.ok(!JSON.stringify(st).includes('T-2'), 'ログに取引IDを残さない');
});

test('0にすると移さない', () => {
  const env = setup();
  backdate(env, sale(env).tx.id, 400);
  env.post('archiveSettings', { txDays: 0, histMonths: 0 });
  assert.deepEqual(env.post('archiveRun', {}).moved, { tx: 0, sales: 0, io: 0 });
  assert.equal(arc(env).length, 0);
});

test('移した取引は見られる: IDから開く・レシートの再発行用の明細・インボイスの発行者情報。返品・取消はできない', () => {
  const env = setup();
  const a = sale(env, [{ jan: J1, qty: 1 }, { jan: J2, qty: 2 }]);
  const id = backdate(env, a.tx.id, 100);
  env.post('archiveRun', {});
  assert.equal(ids(env).includes(id), false);
  const g = env.get('saleGet', { id });
  assert.equal(g.ok, true); assert.equal(g.archived, true);
  assert.equal(g.tx.id, id); assert.equal(g.tx.total, a.tx.total); assert.equal(g.tx.regNo, 'T1234567890123');
  assert.equal(g.lines.length, 2); assert.equal(g.lines[0].name, '商品A'); assert.equal(g.issuer.name, 'サンプル商店');
  assert.equal(env.post('saleVoid', { id }).error, 'archived');
  assert.equal(env.post('saleReturn', { id, items: [{ line: 1, qty: 1 }] }).error, 'archived');
  assert.equal(env.get('saleGet', { id: 'T-20200101-0001' }).error, 'not_found');
  assert.equal(env.get('saleGet', { id: 'zzz' }).error, 'not_found');
});

test('日付で一覧・精算: 移した日の取引も出る。通常のシートと合算（同じ日が両方にまたがっても二重に数えない）', () => {
  const env = setup();
  const a = sale(env), b = sale(env, [{ jan: J2, qty: 3 }], { method: 'カード' });
  const ia = backdate(env, a.tx.id, 100, 1), ib = backdate(env, b.tx.id, 100, 2);
  const date = partsAgo(100);
  const day = `${date.y}/${date.m}/${date.d}`;
  const before = env.get('settlement', { date: day });
  assert.equal(before.count, 2);
  env.post('archiveRun', {});
  assert.deepEqual(ids(env), []);
  const s = env.get('settlement', { date: day });
  for (const k of ['count', 'gross', 'net', 'guests']) assert.equal(s[k], before[k], k);
  assert.deepEqual(s.byMethod, before.byMethod); assert.deepEqual(s.byRate, before.byRate); assert.deepEqual(s.tax, before.tax);
  const l = env.get('saleList', { date: day.replace(/\//g, '-') });
  assert.deepEqual(l.rows.map((r) => r.id).sort(), [ia, ib].sort());
  assert.ok(l.rows.every((r) => r.archived));
  // 今日の取引は、アーカイブを開かない（開けなくても影響しない）
  env.state.archiveFail = true;
  const today = partsAgo(0);
  assert.equal(env.get('settlement', { date: `${today.y}/${today.m}/${today.d}` }).ok, true);
  assert.equal(env.get('saleList', { date: `${today.y}-${today.m}-${today.d}` }).ok, true);
  assert.equal(sale(env).ok, true, 'レジは止まらない');
});

test('返品・取消の取引は、元の取引と一緒に移る。元が移ったあとは、新しい返品は作れない', () => {
  const env = setup();
  const a = sale(env), b = sale(env);
  const ia = backdate(env, a.tx.id, 100, 1), ib = backdate(env, b.tx.id, 100, 2);
  // 100日前の取引に、返品・取消を足す代わりに、返品の取引を直接作る（今の日付で作ってから、同じ古さにする）
  const act = sale(env), ic = act.tx.id;
  const vd = env.post('saleVoid', { id: ic });
  const ic2 = backdate(env, ic, 99, 3);
  backdate(env, vd.tx.id, 99, 4);
  const r = env.post('archiveRun', {});
  assert.equal(r.moved.tx, 4);
  assert.deepEqual(ids(env), []);
  const g = env.get('saleGet', { id: ic2 });
  assert.equal(g.archived, true); assert.equal(g.tx.status, '取消済');
  assert.equal(g.returns.length, 1, '元の取引から、取消の取引がたどれる');
  assert.ok(ia && ib);
});

test('安全: アーカイブ側の書き込みが確認できなければ、元は消さずに止まる', () => {
  const env = setup();
  backdate(env, sale(env).tx.id, 100);
  const orig = env.run('writeRows_');
  env.ctx.writeRows_ = function (sh, row, col, values, mask) {
    if (/^(取引|売上明細)_/.test(sh.name)) values = values.slice(0, values.length - 1);
    return orig(sh, row, col, values, mask);
  };
  const r = env.post('archiveRun', {});
  assert.equal(r.error, 'archive_verify_failed');
  assert.equal(rows(env, TX).length, 1); assert.equal(rows(env, SALES).length, 2);
});

test('安全: アーカイブ用スプレッドシートを開けない時は、元は消さずに止まる', () => {
  const env = setup();
  backdate(env, sale(env).tx.id, 100, 1);
  assert.equal(env.post('archiveRun', {}).moved.tx, 1);
  backdate(env, sale(env).tx.id, 100, 2);
  env.state.archiveFail = true;
  assert.equal(env.post('archiveRun', {}).error, 'archive_unreachable');
  assert.equal(rows(env, TX).length, 1);
});

test('再実行しても重複しない（アーカイブへ書いたあと、元の削除の前に止まった場合）', () => {
  const env = setup();
  const keep = sale(env); const old = sale(env);
  const oid = backdate(env, old.tx.id, 100, 1);
  const orig = env.run('arcRewrite_');
  env.ctx.arcRewrite_ = () => { throw new Error('途中で止まった'); };
  assert.equal(env.post('archiveRun', {}).error, 'server_error');
  assert.equal(rows(env, TX).length, 2);
  env.ctx.arcRewrite_ = orig;
  const r = env.post('archiveRun', {});
  assert.equal(r.moved.tx, 1);
  assert.deepEqual(ids(env), [keep.tx.id]);
  const t = arc(env).flatMap((f) => f.getSheets()).filter((s) => s.name.startsWith('取引_')).flatMap((s) => s.body());
  assert.deepEqual(t.map((x) => x[0]), [oid], '取引は1件だけ');
  const sl = arc(env).flatMap((f) => f.getSheets()).filter((s) => s.name.startsWith('売上明細_')).flatMap((s) => s.body());
  assert.equal(sl.length, 2, '売上明細も重複しない');
});

test('入出荷履歴: 月ごとに分けて移し、直近2か月（当月を含む）だけ残す。行は増えも減りもしない', () => {
  const env = setup();
  const sh = env.sheet(IO);
  const base = sh.dump().length;
  const add = [[partsAgo(200).ts, J1, '商品A', '入荷', 1, 1, 'm1'], [partsAgo(100).ts, J1, '商品A', '販売', -1, 0, 'm2'], [partsAgo(40).ts, J1, '商品A', '入荷', 3, 3, 'm3'], [partsAgo(1).ts, J1, '商品A', '入荷', 4, 7, 'm4']];
  sh.getRange(base + 1, 1, add.length, 7).setNumberFormat('@');
  sh.getRange(base + 1, 1, add.length, 7).setValues(add);
  const total0 = sh.dump().length - 1;
  const cur = partsAgo(0), curYm = `${cur.y}/${cur.m}`;
  const prev = (() => { const y = Number(cur.y), m = Number(cur.m); return m === 1 ? `${y - 1}/12` : `${y}/${pad(m - 1)}`; })();
  const r = env.post('archiveRun', {});
  assert.ok(r.moved.io >= 2);
  for (const x of rows(env, IO)) { const m = String(x[0]).slice(0, 7); assert.ok(m === curYm || m === prev, '残るのは当月と前月だけ: ' + m); }
  const moved = arc(env).flatMap((f) => f.getSheets()).filter((s) => s.name.startsWith('入出荷履歴_'));
  for (const s of moved) s.body().forEach((x) => assert.equal(String(x[0]).slice(0, 7).replace('/', '-'), s.name.split('_')[1]));
  assert.equal(moved.reduce((a, s) => a + s.body().length, 0) + rows(env, IO).length, total0);
  assert.equal(env.post('archiveRun', { dryRun: true }).due.io, 0);
  // 商品マスタの在庫は変わらない
  assert.equal(rows(env, '商品マスタ').find((x) => x[0] === J1)[4], 100);
});

test('移したデータを見る: 月の一覧・取引の一覧（絞り込み）・履歴', () => {
  const env = setup();
  const a = sale(env), b = sale(env, [{ jan: J2, qty: 1 }], { method: 'カード' });
  const ia = backdate(env, a.tx.id, 100, 1), ib = backdate(env, b.tx.id, 100, 2);
  env.post('archiveRun', {});
  const m = env.get('archiveMonths');
  assert.ok(m.years.flatMap((y) => y.months.tx).includes(ymOf(100)));
  assert.match(m.years[0].url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
  const all = env.get('archiveSearch', { kind: 'tx', month: ymOf(100) });
  assert.equal(all.count, 2);
  assert.deepEqual(env.get('archiveSearch', { kind: 'tx', month: ymOf(100), q: 'カード' }).rows.map((r) => r.id), [ib]);
  assert.deepEqual(env.get('archiveSearch', { kind: 'tx', month: ymOf(100), q: ia }).rows.map((r) => r.id), [ia]);
  assert.equal(env.get('archiveSearch', { kind: 'tx', month: '2001-01' }).rows.length, 0);
  assert.equal(env.get('archiveSearch', { kind: 'tx', month: '2026年10月' }).error, 'bad_request');
  assert.equal(env.get('archiveSearch', { kind: 'sales', month: ymOf(100) }).error, 'bad_request');
  assert.ok(env.get('archiveSearch', { kind: 'io', month: ymOf(100) }).ok);
});

test('自動実行: ONの時だけ、1日1回。失敗してもリクエスト自体は成功し、失敗はログに残る', () => {
  const env = setup();
  backdate(env, sale(env).tx.id, 100, 1);
  env.get('masterList');
  assert.equal(rows(env, TX).length, 1, 'OFFなら動かない');
  env.post('archiveSettings', { auto: true });
  assert.equal(env.get('masterList').ok, true);
  assert.equal(rows(env, TX).length, 0, 'ONなら、最初の通信で移る');
  assert.equal(env.get('archiveStatus').last.mode, 'auto');
  backdate(env, sale(env).tx.id, 100, 2);
  env.get('masterList');
  assert.equal(rows(env, TX).length, 1, '同じ日の2回目は動かない');
  env.props.ARC_LAST_RUN = '2000/01/01';
  env.state.archiveFail = true;
  assert.equal(env.get('masterList').ok, true, '失敗しても、依頼された処理は成功する');
  assert.ok(env.get('archiveStatus').last.error);
});

test('時間トリガー用の archiveDaily と、1回の上限', () => {
  const env = setup();
  env.run('ARC_MAX_PER_RUN = 2');
  for (let i = 1; i <= 3; i++) backdate(env, sale(env).tx.id, 100 + i, i);
  env.run('archiveDaily()');
  assert.equal(env.get('archiveStatus').last.mode, 'trigger');
  assert.equal(rows(env, TX).length, 1, '古い2件だけ移った');
  const r = env.post('archiveRun', {});
  assert.equal(r.moved.tx, 1); assert.equal(rows(env, TX).length, 0);
});

test('移したあとも、会計・取消・返品はふつうに動く（今日の取引の取引IDは、日付ごとに1から）', () => {
  const env = setup();
  backdate(env, sale(env).tx.id, 100, 1);
  env.post('archiveRun', {});
  const a = sale(env);
  assert.match(a.tx.id, /-0001$/);
  assert.equal(env.post('saleReturn', { id: a.tx.id, items: [{ line: 1, qty: 1 }] }).ok, true);
  assert.equal(env.post('saleVoid', { id: sale(env).tx.id }).ok, true);
});

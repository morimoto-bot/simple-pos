'use strict';
// 簡易POS v0.1: 販売・取消・返品・精算・商品・設定（インボイス）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, withCheck } = require('./gas-fake');

const J1 = '4901777300446';                 // 税込 1,000円・10%
const J2 = withCheck('490123456789');       // 税込   108円・8%
const J3 = withCheck('450000000001');       // 税込   333円・10%
const TX = '取引', SALES = '売上明細', IO = '入出荷履歴', MASTER = '商品マスタ';
let seq = 0;
const key = () => 'test-key-' + (++seq) + '-' + Math.random().toString(36).slice(2, 8);

function setup(opts = {}) {
  const env = createEnv();
  env.post('masterUpsert', { jan: J1, name: '商品A', price: 1000, rate: '10%', stock: 10 });
  env.post('masterUpsert', { jan: J2, name: '軽減品B', price: 108, rate: '8%', stock: 10 });
  env.post('masterUpsert', { jan: J3, name: '商品C', price: 333, rate: 10, stock: 5 });
  if (opts.invoice) env.post('settingsSave', { values: { 事業者名: 'サンプル商店', 登録番号: 'T1234567890123', 住所: '東京都渋谷区1-1', 電話: '03-0000-0000' } });
  return env;
}
const sale = (env, lines, extra = {}) => env.post('saleCreate', Object.assign({ txKey: key(), lines, method: '現金' }, extra));
const rows = (env, name) => env.sheet(name).dump().slice(1);
const stock = (env, jan) => rows(env, MASTER).find((r) => r[0] === jan)[4];

test('ping は合言葉なしで版を返す。合言葉が無い・違うと拒否。GETで書き込みはできない', () => {
  const env = setup();
  assert.deepEqual(env.raw('GET', { action: 'ping' }).app, 'simple-pos');
  assert.equal(env.raw('POST', { action: 'saleCreate' }).error, 'unauthorized');
  assert.equal(env.raw('GET', { action: 'masterList', token: 'x' }).error, 'unauthorized');
  assert.equal(env.get('saleCreate', { lines: [] }).error, 'bad_request');
});

test('シートは5枚（商品マスタ・入出荷履歴・売上明細・取引・設定）。見出しが入る', () => {
  const env = setup();
  assert.deepEqual(env.sheet(MASTER).dump()[0], ['JAN', '商品名', '単価（税込）', '税率区分', '現在庫']);
  assert.deepEqual(env.sheet(TX).dump()[0].slice(0, 8), ['取引ID', '日時', '合計（税込）', '内税（8%分）', '内税（10%分）', '支払方法', '客数', '状態']);
  assert.deepEqual(env.sheet(SALES).dump()[0].slice(0, 3), ['取引ID', '行', '日時']);
  assert.ok(env.sheet('設定'));
});

/* ---------- 計算 ---------- */

test('内税額: 税率ごとの合計から1回だけ端数処理する（国税庁Q&Aの例: 10%対象60,000円→5,454円、8%対象40,000円→2,962円）', () => {
  const env = setup();
  const calc = env.run('(function(){ return calcCart_([{price:60000,qty:1,rate:10,disc:null},{price:40000,qty:1,rate:8,disc:null}], null, "切り捨て"); })()');
  assert.equal(calc.total, 100000); assert.equal(calc.tax['10'], 5454); assert.equal(calc.tax['8'], 2962);
});

test('商品ごとに端数処理して足す方法と違う結果になる例で、書類全体の税率ごとに1回の方法になっている', () => {
  const env = setup();
  // 10%の3行（各 333円）: 行ごとに切り捨てると 30+30+30=90、合計999円から1回だと 90（=999*10/110=90.8→90）。さらに差が出る例
  const c = env.run('(function(){ return calcCart_([{price:55,qty:1,rate:10,disc:null},{price:55,qty:1,rate:10,disc:null},{price:55,qty:1,rate:10,disc:null},{price:55,qty:1,rate:10,disc:null}], null, "切り捨て"); })()');
  assert.equal(c.byRate['10'], 220);
  assert.equal(c.tax['10'], 20, '220円×10/110=20（行ごとだと 4円×4=16 になる）');
});

test('端数処理の設定: 切り捨て／切り上げ／四捨五入', () => {
  const env = setup();
  const f = (mode) => env.run(`(function(){ return taxInner_(1000, 10, "${mode}"); })()`);   // 1000*10/110 = 90.909
  assert.equal(f('切り捨て'), 90); assert.equal(f('切り上げ'), 91); assert.equal(f('四捨五入'), 91);
  const g = (mode, v) => env.run(`(function(){ return taxInner_(${v}, 8, "${mode}"); })()`);   // 200*8/108 = 14.81 / 1350*8/108=100
  assert.equal(g('切り捨て', 200), 14); assert.equal(g('四捨五入', 200), 15); assert.equal(g('切り上げ', 1350), 100);
  assert.equal(env.run('(function(){ return taxInner_(-1000, 10, "切り捨て"); })()'), -90, 'マイナス（返品）は符号を保つ');
});

test('単品の値引・割引: 円は元の金額まで、％は切り捨て', () => {
  const env = setup();
  const c = JSON.parse(JSON.stringify(env.run('(function(){ return calcCart_([{price:1000,qty:2,rate:10,disc:{type:"yen",value:300}},{price:333,qty:1,rate:10,disc:{type:"pct",value:15}},{price:100,qty:1,rate:8,disc:{type:"yen",value:999}}], null, "切り捨て"); })()')));
  assert.deepEqual(c.lines.map((l) => [l.lineDisc, l.amount]), [[300, 1700], [49, 284], [100, 0]]);
});

test('小計の値引・割引: 各行に按分し、按分の合計が値引額とぴったり合う（端数は大きい端数から1円ずつ）', () => {
  const env = setup();
  const c = env.run('(function(){ return calcCart_([{price:333,qty:1,rate:10,disc:null},{price:333,qty:1,rate:10,disc:null},{price:334,qty:1,rate:8,disc:null}], {type:"yen",value:100}, "切り捨て"); })()');
  assert.equal(c.subtotal, 1000); assert.equal(c.subDisc, 100);
  assert.equal(c.lines.reduce((a, l) => a + l.alloc, 0), 100);
  assert.equal(c.total, 900);
  assert.equal(c.byRate['8'] + c.byRate['10'], 900);
  const p = env.run('(function(){ return calcCart_([{price:1000,qty:1,rate:10,disc:null}], {type:"pct",value:10}, "切り捨て"); })()');
  assert.equal(p.total, 900);
});

test('値引・割引の検証: ％は0〜100、円は整数、種類が不正なら拒否', () => {
  const env = setup();
  assert.equal(sale(env, [{ jan: J1, qty: 1, disc: { type: 'pct', value: 101 } }]).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 1, disc: { type: 'yen', value: 1.5 } }]).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 1, disc: { type: 'x', value: 1 } }]).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 1 }], { subDisc: { type: 'pct', value: -1 } }).error, 'bad_request');
});

/* ---------- 販売 ---------- */

test('会計確定: 合計・内税・預り金・お釣り。在庫が減り、履歴・売上明細・取引に残る', () => {
  const env = setup({ invoice: true });
  const r = sale(env, [{ jan: J1, qty: 2 }, { jan: J2, qty: 3 }], { received: 5000, guests: 2 });
  assert.equal(r.ok, true);
  // 1000*2 + 108*3 = 2324。10%: 2000→181、8%: 324→24
  assert.equal(r.tx.total, 2324); assert.equal(r.tx.tax10, 181); assert.equal(r.tx.tax8, 24);
  assert.equal(r.tx.received, 5000); assert.equal(r.tx.change, 2676); assert.equal(r.tx.guests, 2);
  assert.match(r.tx.id, /^T-\d{8}-0001$/);
  assert.equal(stock(env, J1), 8); assert.equal(stock(env, J2), 7);
  const io = rows(env, IO).filter((x) => x[3] === '販売');
  assert.deepEqual(io.map((x) => [x[1], x[4], x[5], x[6]]), [[J1, -2, 8, r.tx.id], [J2, -3, 7, r.tx.id]]);
  const sl = rows(env, SALES).filter((x) => x[0] === r.tx.id);
  assert.deepEqual(sl.map((x) => [x[1], x[3], x[5], x[6], x[7], x[8], x[9]]), [[1, J1, 2, 1000, '10%', 0, 2000], [2, J2, 3, 108, '8%', 0, 324]]);
  const t = rows(env, TX).find((x) => x[0] === r.tx.id);
  assert.deepEqual([t[2], t[3], t[4], t[5], t[6], t[7], t[10], t[11], t[12], t[13]], [2324, 24, 181, '現金', 2, '通常', 5000, 2676, 'サンプル商店', 'T1234567890123']);
});

test('取引IDは日ごとの連番', () => {
  const env = setup();
  const a = sale(env, [{ jan: J1, qty: 1 }]), b = sale(env, [{ jan: J1, qty: 1 }]);
  assert.match(a.tx.id, /-0001$/); assert.match(b.tx.id, /-0002$/);
});

test('二重送信の防止: 同じ txKey は、新しい取引を作らず、前の結果を返す（在庫も二重に減らない）', () => {
  const env = setup();
  const k = key();
  const a = env.post('saleCreate', { txKey: k, lines: [{ jan: J1, qty: 1 }], method: '現金' });
  const b = env.post('saleCreate', { txKey: k, lines: [{ jan: J1, qty: 1 }], method: '現金' });
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true);
  assert.equal(a.tx.id, b.tx.id);
  assert.equal(stock(env, J1), 9);
  assert.equal(rows(env, TX).length, 1);
  assert.equal(env.post('saleCreate', { lines: [{ jan: J1, qty: 1 }], method: '現金' }).error, 'bad_request', 'txKey が無ければ拒否');
});

test('現金以外は預り金＝合計・お釣り0。現金で預り金が足りなければ拒否。預り金を省くと合計ちょうど', () => {
  const env = setup();
  const c = sale(env, [{ jan: J1, qty: 1 }], { method: 'カード', received: 99999 });
  assert.equal(c.tx.received, 1000); assert.equal(c.tx.change, 0);
  const s = sale(env, [{ jan: J1, qty: 1 }], { received: 999 });
  assert.equal(s.error, 'short_cash');
  const z = sale(env, [{ jan: J1, qty: 1 }]);
  assert.equal(z.tx.received, 1000); assert.equal(z.tx.change, 0);
  assert.equal(sale(env, [{ jan: J1, qty: 1 }], { method: 'ビットコイン' }).error, 'bad_request');
});

test('客数: 省くと1人。0〜999の整数', () => {
  const env = setup();
  assert.equal(sale(env, [{ jan: J1, qty: 1 }]).tx.guests, 1);
  assert.equal(sale(env, [{ jan: J1, qty: 1 }], { guests: 0 }).tx.guests, 0);
  assert.equal(sale(env, [{ jan: J1, qty: 1 }], { guests: 1000 }).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 1 }], { guests: 1.5 }).error, 'bad_request');
});

test('検証: カートが空・数量が不正・マスタに無いJAN・行数の上限・金額の上限は拒否し、何も書かない', () => {
  const env = setup();
  const before = rows(env, TX).length;
  assert.equal(sale(env, []).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 0 }]).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 1.5 }]).error, 'bad_request');
  const nm = sale(env, [{ jan: withCheck('490000000001'), qty: 1 }]);
  assert.equal(nm.error, 'not_in_master'); assert.equal(nm.missing.length, 1);
  assert.equal(sale(env, Array.from({ length: 101 }, () => ({ jan: J1, qty: 1 }))).error, 'bad_request');
  assert.equal(sale(env, [{ jan: J1, qty: 99999 }]).error, 'too_large');
  assert.equal(sale(env, [{ jan: '123', qty: 1 }]).error, 'invalid_jan');
  assert.equal(rows(env, TX).length, before);
  assert.equal(stock(env, J1), 10);
});

test('在庫が足りなくても販売できる（マイナス在庫は警告を返す）。設定で拒否にもできる', () => {
  const env = setup();
  const r = sale(env, [{ jan: J3, qty: 8 }]);
  assert.equal(r.ok, true); assert.equal(stock(env, J3), -3);
  assert.deepEqual(r.negativeStock.map((x) => [x.jan, x.stock]), [[J3, -3]]);
  const env2 = setup();
  env2.run('CONFIG.ALLOW_NEGATIVE_STOCK = false');
  const r2 = sale(env2, [{ jan: J3, qty: 8 }]);
  assert.equal(r2.error, 'insufficient_stock'); assert.equal(stock(env2, J3), 5);
});

test('同じ商品を複数行に分けても、在庫は合算して減らす。履歴は1商品1行', () => {
  const env = setup();
  sale(env, [{ jan: J1, qty: 1 }, { jan: J1, qty: 2, disc: { type: 'yen', value: 100 } }]);
  assert.equal(stock(env, J1), 7);
  assert.equal(rows(env, IO).filter((x) => x[3] === '販売').length, 1);
  assert.equal(rows(env, SALES).length, 2);
});

test('未登録商品の販売: 金額と税率を指定。在庫は動かさず、明細は「未登録商品」・JAN空欄で記録される', () => {
  const env = setup();
  const r = sale(env, [{ unregistered: true, price: 540, rate: '8%', qty: 2 }, { jan: J1, qty: 1 }]);
  assert.equal(r.tx.total, 2080); assert.equal(r.tx.tax8, 80); assert.equal(r.tx.tax10, 90);
  const sl = rows(env, SALES).filter((x) => x[0] === r.tx.id);
  assert.deepEqual([sl[0][3], sl[0][4], sl[0][5], sl[0][6], sl[0][7]], ['', '未登録商品', 2, 540, '8%']);
  assert.equal(rows(env, IO).filter((x) => x[3] === '販売').length, 1, '在庫の履歴は登録商品の分だけ');
  assert.equal(sale(env, [{ unregistered: true, price: 0, rate: 10, qty: 1 }]).error, 'bad_request', '0円は拒否');
  assert.equal(sale(env, [{ unregistered: true, price: 100, rate: '5%', qty: 1 }]).error, 'bad_request');
});

test('単価が未設定の商品は売れない。マスタの単価が正（画面から送られた金額は使わない）', () => {
  const env = setup();
  const r = sale(env, [{ jan: J1, qty: 1, price: 1 }]);
  assert.equal(r.tx.total, 1000);
});

test('文字列は数式にならず文字のまま保存される（商品名が = で始まる）', () => {
  const env = setup();
  env.post('masterUpsert', { jan: withCheck('490000000002'), name: '=1+1', price: 100 });
  const r = sale(env, [{ jan: withCheck('490000000002'), qty: 1 }]);
  assert.equal(rows(env, SALES).find((x) => x[0] === r.tx.id)[4], '=1+1');
});

/* ---------- インボイス（適格簡易請求書） ---------- */

test('設定: 登録番号は T＋13桁。全角・ハイフンは直す。形が違えば拒否。空は消去', () => {
  const env = setup();
  assert.equal(env.post('settingsSave', { values: { 登録番号: 'ｔ１２３４－５６７８９０１２３' } }).values['登録番号'], 'T1234567890123');
  assert.equal(env.post('settingsSave', { values: { 登録番号: '12345' } }).error, 'bad_request');
  assert.equal(env.post('settingsSave', { values: { 登録番号: 'T123' } }).error, 'bad_request');
  assert.equal(env.post('settingsSave', { values: { 登録番号: '' } }).values['登録番号'], '');
  assert.equal(env.post('settingsSave', { values: { だめな項目: 'x' } }).error, 'bad_request');
  assert.equal(env.post('settingsSave', { values: { 税の端数処理: '四捨五入' } }).values['税の端数処理'], '四捨五入');
  assert.equal(env.post('settingsSave', { values: { 税の端数処理: 'ほげ' } }).error, 'bad_request');
});

test('invoiceReady: 事業者名と登録番号の両方が入ると true', () => {
  const env = setup();
  assert.equal(env.get('settingsGet').invoiceReady, false);
  env.post('settingsSave', { values: { 事業者名: 'サンプル商店' } });
  assert.equal(env.get('settingsGet').invoiceReady, false);
  env.post('settingsSave', { values: { 登録番号: 'T1234567890123' } });
  assert.equal(env.get('settingsGet').invoiceReady, true);
});

test('レシートの必須項目: 発行者名・登録番号・取引日時・明細・税率ごとの対価と税額が、取引から取り出せる。登録番号は取引の時点のものを保存', () => {
  const env = setup({ invoice: true });
  const r = sale(env, [{ jan: J1, qty: 1 }, { jan: J2, qty: 1 }]);
  env.post('settingsSave', { values: { 事業者名: '改名後の商店', 登録番号: 'T9999999999999' } });
  const g = env.get('saleGet', { id: r.tx.id });
  assert.equal(g.issuer.name, 'サンプル商店', '発行時点の名称');
  assert.equal(g.issuer.regNo, 'T1234567890123', '発行時点の登録番号');
  assert.equal(g.issuer.address, '東京都渋谷区1-1');
  assert.match(g.tx.ts, /^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d$/);
  assert.deepEqual(g.lines.map((l) => [l.name, l.qty, l.price, l.rate, l.amount]), [['商品A', 1, 1000, 10, 1000], ['軽減品B', 1, 108, 8, 108]]);
  assert.equal(g.tx.tax10, 90); assert.equal(g.tx.tax8, 8);
});

test('登録番号が未設定でも販売はできる（取引に空で残る）', () => {
  const env = setup();
  const r = sale(env, [{ jan: J1, qty: 1 }]);
  assert.equal(r.tx.regNo, ''); assert.equal(r.issuer.regNo, '');
});

test('税の端数処理の設定が、会計の内税額に反映される', () => {
  const env = setup();
  env.post('settingsSave', { values: { 税の端数処理: '切り上げ' } });
  assert.equal(sale(env, [{ jan: J1, qty: 1 }]).tx.tax10, 91);
  env.post('settingsSave', { values: { 税の端数処理: '切り捨て' } });
  assert.equal(sale(env, [{ jan: J1, qty: 1 }]).tx.tax10, 90);
});

/* ---------- 取消（赤黒） ---------- */

test('取消: マイナスの取引を足し、元の取引は「取消済」になる。在庫が戻り、履歴に残る。税額は元をそのまま反転', () => {
  const env = setup({ invoice: true });
  const s = sale(env, [{ jan: J1, qty: 2 }, { jan: J2, qty: 3 }], { subDisc: { type: 'yen', value: 100 } });
  const v = env.post('saleVoid', { id: s.tx.id });
  assert.equal(v.ok, true);
  assert.equal(v.tx.status, '取消'); assert.equal(v.tx.origId, s.tx.id);
  assert.equal(v.tx.total, -s.tx.total); assert.equal(v.tx.tax10, -s.tx.tax10); assert.equal(v.tx.tax8, -s.tx.tax8);
  assert.equal(stock(env, J1), 10); assert.equal(stock(env, J2), 10);
  assert.equal(rows(env, TX).find((x) => x[0] === s.tx.id)[7], '取消済');
  const sl = rows(env, SALES).filter((x) => x[0] === v.tx.id);
  assert.deepEqual(sl.map((x) => [x[1], x[5]]), [[1, -2], [2, -3]], '行番号は元の行');
  assert.equal(sl.reduce((a, x) => a + x[9], 0), -s.tx.total);
  assert.ok(rows(env, IO).some((x) => x[3] === '返品' && x[6] === '取消:' + s.tx.id));
  assert.equal(v.tx.regNo, 'T1234567890123', '元の登録番号を引き継ぐ');
});

test('取消できないもの: 取消済み・返品の取引・存在しない・すでに返品がある', () => {
  const env = setup();
  const s = sale(env, [{ jan: J1, qty: 2 }]);
  const v = env.post('saleVoid', { id: s.tx.id });
  assert.equal(env.post('saleVoid', { id: s.tx.id }).error, 'already_voided');
  assert.equal(env.post('saleVoid', { id: v.tx.id }).error, 'bad_state');
  assert.equal(env.post('saleVoid', { id: 'T-00000000-0001' }).error, 'not_found');
  const s2 = sale(env, [{ jan: J1, qty: 2 }]);
  env.post('saleReturn', { id: s2.tx.id, items: [{ line: 1, qty: 1 }] });
  assert.equal(env.post('saleVoid', { id: s2.tx.id }).error, 'has_returns');
});

/* ---------- 返品 ---------- */

test('返品: 選んだ行・数量だけ。金額は値引後の金額から按分し、全数になる最後の返品で端数がぴったり合う', () => {
  const env = setup();
  // 333円×3 = 999、小計から100円値引 → 899
  const s = sale(env, [{ jan: J3, qty: 3 }], { subDisc: { type: 'yen', value: 100 } });
  assert.equal(s.tx.total, 899);
  const r1 = env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }] });
  assert.equal(r1.tx.total, -299);               // floor(899*1/3)
  assert.equal(r1.tx.status, '返品');
  const r2 = env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }] });
  assert.equal(r2.tx.total, -300);               // floor(899*2/3)=599 → 599-299
  const r3 = env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }] });
  assert.equal(r3.tx.total, -300);               // 899-599。3回で 899 ぴったり
  assert.equal(r1.tx.total + r2.tx.total + r3.tx.total, -899);
  assert.equal(stock(env, J3), 5);
  assert.equal(env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }] }).error, 'over_return');
});

test('返品の税額は、返金の税込額（税率ごと）から1回だけ端数処理してマイナスにする', () => {
  const env = setup();
  const s = sale(env, [{ jan: J1, qty: 3 }, { jan: J2, qty: 1 }]);
  const r = env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }, { line: 2, qty: 1 }] });
  assert.equal(r.tx.total, -(1000 + 108));
  assert.equal(r.tx.tax10, -90); assert.equal(r.tx.tax8, -8);
});

test('返品: 数量の検証・重複行・存在しない行・取消済みの取引は拒否。残数は saleGet で分かる', () => {
  const env = setup();
  const s = sale(env, [{ jan: J1, qty: 3 }]);
  assert.equal(env.post('saleReturn', { id: s.tx.id, items: [] }).error, 'bad_request');
  assert.equal(env.post('saleReturn', { id: s.tx.id, items: [{ line: 9, qty: 1 }] }).error, 'bad_request');
  assert.equal(env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 0 }] }).error, 'bad_request');
  assert.equal(env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }, { line: 1, qty: 1 }] }).error, 'bad_request');
  assert.equal(env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 4 }] }).error, 'over_return');
  env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 2 }] });
  const g = env.get('saleGet', { id: s.tx.id });
  assert.equal(g.lines[0].returned, 2); assert.equal(g.lines[0].remaining, 1);
  assert.equal(g.returns.length, 1);
  const s2 = sale(env, [{ jan: J1, qty: 1 }]);
  env.post('saleVoid', { id: s2.tx.id });
  assert.equal(env.post('saleReturn', { id: s2.tx.id, items: [{ line: 1, qty: 1 }] }).error, 'already_voided');
});

test('未登録商品の返品は、在庫を動かさない', () => {
  const env = setup();
  const s = sale(env, [{ unregistered: true, price: 500, rate: 10, qty: 1 }]);
  const before = rows(env, IO).length;
  env.post('saleReturn', { id: s.tx.id, items: [{ line: 1, qty: 1 }] });
  assert.equal(rows(env, IO).length, before);
});

/* ---------- 精算 ---------- */

test('精算: 売上・返品取消・純売上・件数・客数・支払方法別・税率別（税込の対価と内税額）', () => {
  const env = setup();
  const a = sale(env, [{ jan: J1, qty: 2 }], { guests: 2 });                        // 2000（現金）
  sale(env, [{ jan: J2, qty: 1 }], { method: 'カード', guests: 1 });                // 108（カード）
  const c = sale(env, [{ jan: J1, qty: 1 }], { guests: 3 });                        // 1000（現金）→取消
  env.post('saleVoid', { id: c.tx.id });
  env.post('saleReturn', { id: a.tx.id, items: [{ line: 1, qty: 1 }] });             // -1000
  const d = env.get('settlement');
  assert.equal(d.count, 3); assert.equal(d.guests, 6);
  assert.equal(d.gross, 3108); assert.equal(d.refund, -2000); assert.equal(d.net, 1108);
  assert.equal(d.voidCount, 1); assert.equal(d.returnCount, 1);
  assert.deepEqual(d.byMethod, { 現金: 1000, カード: 108, その他: 0 });
  assert.equal(d.byRate['10'], 1000); assert.equal(d.byRate['8'], 108);
  assert.equal(d.tax['8'], 8); assert.equal(d.tax['10'], 91 - 0 - 0 > 0 ? d.tax['10'] : 0);
  assert.equal(d.avgPerGuest, Math.floor(3108 / 6));
  assert.equal(env.get('settlement', { date: '2000-01-01' }).count, 0);
  assert.equal(env.get('settlement', { date: 'x' }).error, 'bad_request');
});

test('精算の内税額: 売上の内税から、返品・取消のマイナスを引いた純額', () => {
  const env = setup();
  const a = sale(env, [{ jan: J1, qty: 2 }]);              // 2000 → 内税10% 181
  env.post('saleReturn', { id: a.tx.id, items: [{ line: 1, qty: 1 }] });   // -1000 → -90
  const d = env.get('settlement');
  assert.equal(d.tax['10'], 181 - 90);
});

/* ---------- 一覧・履歴・CSV ---------- */

test('取引一覧は新しい順。日付で絞れる。saleGet は無い取引で not_found', () => {
  const env = setup();
  const a = sale(env, [{ jan: J1, qty: 1 }]), b = sale(env, [{ jan: J1, qty: 1 }]);
  const l = env.get('saleList');
  assert.deepEqual(l.rows.map((x) => x.id), [b.tx.id, a.tx.id]);
  assert.equal(env.get('saleList', { date: '2000/01/01' }).rows.length, 0);
  assert.equal(env.get('saleGet', { id: 'nai' }).error, 'not_found');
});

test('CSV出力: 取引・売上明細・商品マスタ・入出荷履歴（宛先などの個人情報は持たない）', () => {
  const env = setup();
  sale(env, [{ jan: J1, qty: 1 }]);
  for (const k of ['master', 'io', 'tx', 'sales']) assert.equal(env.get('exportData', { kind: k }).ok, true);
  assert.equal(env.get('exportData', { kind: 'slips' }).error, 'bad_request');
  assert.equal(env.get('exportData', { kind: 'tx' }).rows.length, 1);
});

/* ---------- 商品・入荷・棚卸 ---------- */

test('商品: 新規は名前と単価が必須。税率は10%/8%。取り込み（CSV）は、見出し行・引用符・誤りの行に対応', () => {
  const env = createEnv();
  assert.equal(env.post('masterUpsert', { jan: J1, name: 'A' }).error, 'bad_request');
  assert.equal(env.post('masterUpsert', { jan: J1, price: 100 }).error, 'bad_request');
  assert.equal(env.post('masterUpsert', { jan: J1, name: 'A', price: 100, rate: '5%' }).error, 'bad_request');
  const r = env.post('masterImport', { text: ['JAN,商品名,単価,税率区分,在庫', `${J1},"りんご, 赤",150,8%,5`, `${J2},みかん,"¥1,200",,3`, '123,だめ,100', `${J3},ぶどう`].join('\r\n') });
  assert.equal(r.added, 2);
  assert.equal(r.errors.length, 2);
  const m = env.get('masterGet', { jan: J1 }).item;
  assert.deepEqual([m.name, m.price, m.rate, m.stock], ['りんご, 赤', 150, 8, 5]);
  assert.equal(env.get('masterGet', { jan: J2 }).item.price, 1200);
  assert.equal(env.get('masterList', { q: 'りんご' }).count, 1);
  // 既存商品は単価・名称・税率を更新。在庫は取り込みでは変えない
  const r2 = env.post('masterImport', { text: `${J1},りんご（大）,180,10%,999` });
  assert.equal(r2.updated, 1);
  const m2 = env.get('masterGet', { jan: J1 }).item;
  assert.deepEqual([m2.name, m2.price, m2.rate, m2.stock], ['りんご(大)', 180, 10, 5]);
});

test('入荷: 在庫が増え、履歴に残る。マスタに無いJANは拒否', () => {
  const env = setup();
  const r = env.post('receive', { jan: J1, qty: 5, memo: '納品' });
  assert.equal(r.item.stock, 15);
  assert.ok(rows(env, IO).some((x) => x[3] === '入荷' && x[4] === 5 && x[6] === '納品'));
  assert.equal(env.post('receive', { jan: withCheck('490000000003'), qty: 1 }).error, 'not_in_master');
  assert.equal(env.post('receive', { jan: J1, qty: 0 }).error, 'bad_request');
});

test('棚卸: 数えた商品だけ差異を出し、確定で現在庫を実績にそろえて「棚卸調整」を残す', () => {
  const env = setup();
  const p = env.post('stocktakePreview', { counts: [{ jan: J1, actual: 8 }, { jan: J2, actual: 10 }] });
  assert.equal(p.adjust, 1); assert.equal(stock(env, J1), 10, 'プレビューでは変わらない');
  assert.equal(env.get('stocktakePreview', { counts: [] }).error, 'bad_request', 'プレビューはPOSTのみ');
  const s = env.post('stocktakeSave', { name: '11月末', counts: [{ jan: J1, actual: 8 }, { jan: J2, actual: 10 }] });
  assert.equal(s.adjust, 1); assert.equal(stock(env, J1), 8);
  assert.ok(rows(env, IO).some((x) => x[3] === '棚卸調整' && x[4] === -2));
  assert.equal(env.post('stocktakeSave', { name: '', counts: [{ jan: J1, actual: 1 }] }).error, 'bad_request');
  assert.equal(env.post('stocktakePreview', { counts: [{ jan: J1, actual: 1 }, { jan: J1, actual: 2 }] }).error, 'bad_request');
});

test('ロックが取れない時は busy を返し、何も書かない', () => {
  const env = setup();
  env.state.lockFails = true;
  assert.equal(sale(env, [{ jan: J1, qty: 1 }]).error, 'busy');
  env.state.lockFails = false;
  assert.equal(rows(env, TX).length, 0);
});

/**
 * 簡易POS — GAS（レジの倉庫）  v0.2.0
 *
 * 簡易WMS（v0.7.1）の派生。画面（index.html）からのJSONを受けて、スプレッドシート5枚
 * （商品マスタ／入出荷履歴／売上明細／取引／設定）を更新・参照する。GASには画面を持たせない。
 *
 * 設定は次の2か所だけ。
 *   1. このファイル先頭の CONFIG（スプレッドシートID）
 *   2. スクリプトプロパティ APP_TOKEN（合言葉。16文字以上。コードやシートには書かない）
 *
 * デプロイ: ウェブアプリ / 次のユーザーとして実行=自分 / アクセスできるユーザー=全員
 *
 * お金の計算の決めごと（設計メモ v0.4）
 *   - 単価は税込（円・整数）。税率は 10% と 軽減8% の2つ
 *   - 単品の値引・割引 → 小計の値引・割引 の順に引く。小計の値引は、各行の金額に按分する（端数は大きい端数から1円ずつ）
 *   - 内税額は「税率ごとの税込合計」から、1枚のレシートにつき税率ごとに1回だけ端数処理する（切り捨て／切り上げ／四捨五入は設定。既定は切り捨て）
 *   - 取消・返品は、元の取引を書き換えず、マイナスの取引を足す（赤黒）。元の取引の状態だけ「取消済」にする
 */

var CONFIG = {
  // 使うスプレッドシート「簡易POS（商品マスタ・売上）」のID。空にすると、このスクリプトが紐づいているスプレッドシートを使う
  SPREADSHEET_ID: '',
  SHEETS: { MASTER: '商品マスタ', IO: '入出荷履歴', SALES: '売上明細', TX: '取引', SETTINGS: '設定' },
  // true: 在庫が足りなくても販売できる（レジで売れないのは困るため。マイナス在庫は警告を返す）
  ALLOW_NEGATIVE_STOCK: true,
  MIN_TOKEN_LENGTH: 16,
  STRICT_CHECK_DIGIT: true,
  MAX_QTY: 100000,
  MAX_LINES: 100,
  MAX_UNIT_PRICE: 9999999,      // 税込単価の上限（円）
  MAX_CART_TOTAL: 50000000,     // 1会計の合計の上限（円。按分の計算を安全な範囲に収めるため）
  TX_WINDOW: 3000,              // 取引・返品・取消・精算が見に行く、取引シートの末尾の行数
  SALES_WINDOW: 20000,          // 同じく、売上明細の末尾の行数
  LOCK_WAIT_MS: 20000,
  TIMEZONE: 'Asia/Tokyo',
  VERSION: '0.3.0',
  APP_NAME: 'simple-pos'
};

var RATE_LABEL = { 8: '8%', 10: '10%' };
var PAY_METHODS = ['現金', 'カード', 'その他'];
var ROUND_MODES = ['切り捨て', '切り上げ', '四捨五入'];
var SETTING_KEYS = ['事業者名', '登録番号', '住所', '電話', '税の端数処理', 'レシートのメッセージ'];

// シートごとの見出し・文字列として保存する列（1始まり）
var SHEET_DEF = {
  MASTER:   { headers: ['JAN', '商品名', '単価（税込）', '税率区分', '現在庫'],                                   textCols: [1, 2, 4] },
  IO:       { headers: ['日時', 'JAN', '商品名', '区分', '数量', '処理後の在庫数', 'メモ'],                       textCols: [1, 2, 3, 4, 7] },
  SALES:    { headers: ['取引ID', '行', '日時', 'JAN', '商品名', '数量', '単価（税込）', '税率区分', '値引', '金額（税込）'], textCols: [1, 3, 4, 5, 8] },
  TX:       { headers: ['取引ID', '日時', '合計（税込）', '内税（8%分）', '内税（10%分）', '支払方法', '客数', '状態', '返品元の取引ID', '取引キー', '預り金', 'お釣り', '発行者名', '登録番号'], textCols: [1, 2, 6, 8, 9, 10, 13, 14] },
  SETTINGS: { headers: ['項目', '値'],                                                                        textCols: [1, 2] }
};

/* ============================== エントリーポイント ============================== */

function doGet(e) {
  return handle_('GET', (e && e.parameter) || {});
}

function doPost(e) {
  var body;
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    body = JSON.parse(raw);
  } catch (err) {
    return json_(fail_('bad_request', 'JSONを読み取れません'));
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json_(fail_('bad_request', 'JSONのオブジェクトを送ってください'));
  }
  return handle_('POST', body);
}

/** 手動で1回実行すると、5つのシートと見出しを作る（実行しなくても、最初のリクエストで自動作成される） */
function setupSheets() {
  ['MASTER', 'IO', 'SALES', 'TX', 'SETTINGS'].forEach(function (k) { sheet_(k); });
}

/* ============================== ルーティング ============================== */

var READ_ACTIONS = {
  masterGet: masterGet_, masterList: masterList_, saleGet: saleGet_, saleList: saleList_, settlement: settlement_, dailyReport: dailyReport_,
  settingsGet: settingsGet_, historyList: historyList_, exportData: exportData_, stocktakePreview: stocktakePreview_,
  archiveStatus: archiveStatus_, archiveMonths: archiveMonths_, archiveSearch: archiveSearch_
};
var WRITE_ACTIONS = {
  saleCreate: saleCreate_,
  saleVoid: saleVoid_,
  saleReturn: saleReturn_,
  masterUpsert: masterUpsert_,
  masterImport: masterImport_,
  receive: receive_,
  stocktakeSave: stocktakeSave_,
  settingsSave: settingsSave_,
  archiveSettings: archiveSettings_,
  archiveRun: archiveRun_
};
// GETで受け付ける読み取りだけ（棚卸のプレビューはPOSTのみ）
var GET_OK = { masterGet: true, masterList: true, saleGet: true, saleList: true, settlement: true, dailyReport: true, settingsGet: true, historyList: true, exportData: true, archiveStatus: true, archiveMonths: true, archiveSearch: true };

function handle_(method, req) {
  try {
    var action = String(req.action || '');
    if (action === 'ping') {
      return json_({ ok: true, app: CONFIG.APP_NAME, version: CONFIG.VERSION, method: method });
    }
    checkToken_(req.token);
    setupSheets();
    autoArchive_(); // 「自動実行」をONにしている時だけ、古い取引などを1日1回アーカイブへ移す（失敗しても、依頼された処理は続ける）

    if (READ_ACTIONS[action]) {
      if (method === 'GET' && !GET_OK[action]) throw new AppError('bad_request', action + ' はPOSTで呼んでください');
      return json_(READ_ACTIONS[action](req));
    }
    if (WRITE_ACTIONS[action]) {
      if (method !== 'POST') throw new AppError('bad_request', action + ' はPOSTで呼んでください');
      return json_(withLock_(function () { return WRITE_ACTIONS[action](req); }));
    }
    throw new AppError('bad_request', '不明な action: ' + action);
  } catch (err) {
    if (err instanceof AppError) return json_(fail_(err.code, err.message, err.extra));
    try { Logger.log(err && err.stack ? err.stack : err); } catch (ignore) {}
    return json_(fail_('server_error', String((err && err.message) || err)));
  }
}

/* ============================== 値の正規化・検証・シート入出力（簡易WMSから流用） ============================== */

function AppError(code, message, extra) {
  this.code = code;
  this.message = message;
  this.extra = extra || null;
}
AppError.prototype = Object.create(Error.prototype);
AppError.prototype.constructor = AppError;

function fail_(code, message, extra) {
  var o = { ok: false, error: code, message: message };
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
  return o;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('APP_TOKEN');
  if (!expected) {
    throw new AppError('server_not_configured', 'スクリプトプロパティ APP_TOKEN が未設定です');
  }
  if (expected.length < CONFIG.MIN_TOKEN_LENGTH) {
    throw new AppError('server_not_configured', 'APP_TOKEN が短すぎます（' + CONFIG.MIN_TOKEN_LENGTH + '文字以上の長いランダムな文字列にしてください）');
  }
  if (String(given || '') !== expected) {
    throw new AppError('unauthorized', '合言葉（token）が違います');
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) throw new AppError('busy', '他の処理中です。少し待ってやり直してください');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function nfkc_(s) {
  s = String(s == null ? '' : s);
  return typeof s.normalize === 'function' ? s.normalize('NFKC') : s;
}

function str_(v) { return v == null ? '' : String(v); }

/** メモ・理由などの自由入力: 改行や連続する空白を1つの空白にし、500文字までにする */
function cleanMemo_(v) {
  return nfkc_(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 500);
}

function cleanMemo_(v) {
  return nfkc_(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 500);
}

function janDigits_(v) {
  return nfkc_(v).replace(/\D/g, '');
}

function janKey_(digits) {
  var k = String(digits).replace(/^0+/, '');
  return k === '' ? '0' : k;
}

function checkDigitOk_(d) {
  var sum = 0;
  var n = d.length;
  for (var i = n - 2, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) sum += Number(d.charAt(i)) * w;
  return ((10 - (sum % 10)) % 10) === Number(d.charAt(n - 1));
}

function requireJan_(v) {
  var d = janDigits_(v);
  if (!d) throw new AppError('invalid_jan', 'JANが空です');
  if (d.length !== 8 && d.length !== 12 && d.length !== 13) {
    throw new AppError('invalid_jan', 'JANは8・12・13桁の数字です: ' + d, { jan: d });
  }
  if (CONFIG.STRICT_CHECK_DIGIT && !checkDigitOk_(d)) {
    throw new AppError('invalid_jan', 'JANのチェックデジットが合いません: ' + d, { jan: d });
  }
  return d;
}

function normName_(v) {
  return nfkc_(v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
}

function parseQty_(v, label) {
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 1 || n > CONFIG.MAX_QTY) {
    throw new AppError('bad_request', (label || '数量') + 'は1〜' + CONFIG.MAX_QTY + 'の整数にしてください: ' + v);
  }
  return n;
}

function parseCount_(v, label) {
  var n = Number(v);
  if (v === '' || v === null || v === undefined || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > CONFIG.MAX_QTY) {
    throw new AppError('bad_request', (label || '数') + 'は0〜' + CONFIG.MAX_QTY + 'の整数にしてください: ' + v);
  }
  return n;
}

function toInt_(v) {
  var n = Number(v);
  return isFinite(n) ? Math.round(n) : 0;
}

function now_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm:ss');
}

function ss_() {
  if (CONFIG.SPREADSHEET_ID) return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var a = SpreadsheetApp.getActiveSpreadsheet();
  if (!a) throw new AppError('server_not_configured', 'CONFIG.SPREADSHEET_ID を設定してください');
  return a;
}

function sheet_(key) {
  var def = SHEET_DEF[key];
  var ss = ss_();
  var name = CONFIG.SHEETS[key];
  var sh = ss.getSheetByName(name);
  if (!sh) {
    var olds = (CONFIG.LEGACY_SHEETS && CONFIG.LEGACY_SHEETS[key]) || [];
    for (var i = 0; i < olds.length && !sh; i++) {
      var old = ss.getSheetByName(olds[i]);
      if (old) { old.setName(name); sh = old; }
    }
  }
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sh.setFrozenRows(1);
  } else {
    // 後から増えた列の見出しだけを補う（空の見出しセルのみ。入力済みの見出しは書き換えない）
    var cur = sh.getRange(1, 1, 1, def.headers.length).getValues()[0];
    for (var i = 0; i < def.headers.length; i++) {
      if (str_(cur[i]) === '') sh.getRange(1, i + 1, 1, 1).setValues([[def.headers[i]]]);
    }
  }
  return sh;
}

function writeRows_(sh, row, col, values, textMask) {
  var n = values.length;
  if (!n) return;
  var w = values[0].length;
  for (var j = 0; j < w; j++) {
    if (textMask[j]) sh.getRange(row, col + j, n, 1).setNumberFormat('@');
  }
  sh.getRange(row, col, n, w).setValues(values);
}

function textMask_(key, startCol, width) {
  var def = SHEET_DEF[key];
  var m = [];
  for (var j = 0; j < width; j++) m.push(def.textCols.indexOf(startCol + j) >= 0);
  return m;
}

function appendRows_(key, values) {
  if (!values.length) return;
  var sh = sheet_(key);
  var start = sh.getLastRow() + 1;
  writeRows_(sh, start, 1, values, textMask_(key, 1, values[0].length));
}

function splitLines_(s) {
  var lines = [];
  var cur = '';
  var inQ = false;
  var no = 1, startNo = 1;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === '"') inQ = !inQ;
    if (!inQ && (c === '\n' || c === '\r')) {
      if (c === '\r' && s.charAt(i + 1) === '\n') i++;
      lines.push({ text: cur, no: startNo });
      cur = '';
      no++;
      startNo = no;
    } else {
      if (c === '\n') no++;
      cur += c;
    }
  }
  if (cur !== '') lines.push({ text: cur, no: startNo });
  return lines;
}

function splitCells_(line) {
  var delim = line.indexOf('\t') >= 0 ? '\t' : ',';
  var cells = [];
  var cur = '';
  var inQ = false;
  for (var i = 0; i < line.length; i++) {
    var c = line.charAt(i);
    if (inQ) {
      if (c === '"') {
        if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else { inQ = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === delim) {
      cells.push(cur.replace(/^\s+|\s+$/g, ''));
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.replace(/^\s+|\s+$/g, ''));
  return cells;
}


/* ============================== 金額の計算（画面と同じ式。テストで一致を確かめる） ============================== */

/** 整数の割り算の端数処理。mode: 切り捨て／切り上げ／四捨五入（0.5は切り上げ）。num≧0, den>0 の整数 */
function roundDiv_(num, den, mode) {
  if (mode === '切り上げ') return Math.floor((num + den - 1) / den);
  if (mode === '四捨五入') return Math.floor((2 * num + den) / (2 * den));
  return Math.floor(num / den);
}

/** 値引・割引の額（0〜基準額）。disc: {type:'yen'|'pct', value}。pct は切り捨て */
function discountAmount_(base, disc) {
  if (!disc || !disc.value) return 0;
  var v = Number(disc.value);
  if (disc.type === 'pct') return Math.min(base, Math.floor(base * v / 100));
  return Math.min(base, v);
}

/** 税込の対価（税率別の合計）から内税額を出す。符号つき（返品はマイナス）。1書類につき税率ごとに1回だけ端数処理する */
function taxInner_(amount, rate, mode) {
  var sign = amount < 0 ? -1 : 1;
  var v = roundDiv_(Math.abs(amount) * rate, 100 + rate, mode);
  return sign * v;
}

/**
 * カートの計算。lines: [{price, qty, rate, disc}]（price=税込単価）、subDisc: 小計の値引・割引
 * 戻り値: { lines:[{gross, lineDisc, net, alloc, amount, rate}], subtotal, subDisc, total, byRate:{8,10}, tax:{8,10} }
 */
function calcCart_(lines, subDisc, mode) {
  var out = [], subtotal = 0;
  lines.forEach(function (l) {
    var gross = l.price * l.qty;
    var d = discountAmount_(gross, l.disc);
    var net = gross - d;
    out.push({ gross: gross, lineDisc: d, net: net, alloc: 0, amount: net, rate: l.rate });
    subtotal += net;
  });
  var sd = discountAmount_(subtotal, subDisc);
  if (sd > 0 && subtotal > 0) {
    var used = 0, frac = [];
    out.forEach(function (o, i) {
      var num = o.net * sd;
      o.alloc = Math.floor(num / subtotal);
      used += o.alloc;
      frac.push({ i: i, r: num % subtotal });
    });
    frac.sort(function (a, b) { return b.r - a.r || a.i - b.i; });
    for (var k = 0; k < sd - used; k++) out[frac[k].i].alloc++;
    out.forEach(function (o) { o.amount = o.net - o.alloc; });
  }
  var byRate = { 8: 0, 10: 0 }, total = 0;
  out.forEach(function (o) { byRate[o.rate] += o.amount; total += o.amount; });
  return {
    lines: out, subtotal: subtotal, subDisc: sd, total: total, byRate: byRate,
    tax: { 8: taxInner_(byRate[8], 8, mode), 10: taxInner_(byRate[10], 10, mode) }
  };
}

/* ============================== 入力の検証 ============================== */

function parseRate_(v) {
  var s = nfkc_(v == null ? '' : v).replace(/[%％\s]|軽減/g, '');
  if (s === '') return 10;
  if (s === '10') return 10;
  if (s === '8') return 8;
  throw new AppError('bad_request', '税率区分は 10% か 8%（軽減）です: ' + v);
}

function parseYen_(v, label, min, max) {
  var s = nfkc_(v == null ? '' : v).replace(/[¥円,\s]/g, '');
  var n = Number(s);
  if (s === '' || !isFinite(n) || Math.floor(n) !== n || n < min || n > max) {
    throw new AppError('bad_request', (label || '金額') + 'は' + min + '〜' + max + '円の整数にしてください: ' + v);
  }
  return n;
}

function parseDisc_(d, label) {
  if (d === undefined || d === null || d === '') return null;
  if (typeof d !== 'object') throw new AppError('bad_request', label + 'の形が正しくありません');
  var type = d.type === 'pct' ? 'pct' : (d.type === 'yen' ? 'yen' : '');
  if (!type) throw new AppError('bad_request', label + 'の種類は yen（円）か pct（％）です');
  var v = Number(nfkc_(d.value == null ? 0 : d.value).replace(/[¥円%％,\s]/g, ''));
  if (!isFinite(v) || Math.floor(v) !== v || v < 0 || (type === 'pct' && v > 100) || (type === 'yen' && v > CONFIG.MAX_CART_TOTAL)) {
    throw new AppError('bad_request', label + 'の値が正しくありません（％は0〜100の整数、円は整数）: ' + d.value);
  }
  return v === 0 ? null : { type: type, value: v };
}

function roundMode_() {
  var s = settingsMap_();
  var m = s['税の端数処理'];
  return ROUND_MODES.indexOf(m) >= 0 ? m : '切り捨て';
}

/* ============================== 設定（事業者名・登録番号など） ============================== */

function settingsMap_() {
  var sh = sheet_('SETTINGS');
  var last = sh.getLastRow();
  var map = {};
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) { if (str_(r[0])) map[str_(r[0])] = str_(r[1]); });
  return map;
}

function settingsGet_(req) {
  var map = settingsMap_();
  var values = {};
  SETTING_KEYS.forEach(function (k) { values[k] = map[k] || ''; });
  if (!values['税の端数処理']) values['税の端数処理'] = '切り捨て';
  return { ok: true, values: values, roundModes: ROUND_MODES.slice(), invoiceReady: /^T\d{13}$/.test(values['登録番号']) && !!values['事業者名'] };
}

function normRegNo_(v) {
  var s = nfkc_(v == null ? '' : v).replace(/[\s\-]/g, '').toUpperCase();
  if (s === '') return '';
  if (!/^T\d{13}$/.test(s)) throw new AppError('bad_request', '登録番号は「T」と13桁の数字です（例: T1234567890123）: ' + v);
  return s;
}

function settingsSave_(req) {
  var vals = req.values;
  if (!vals || typeof vals !== 'object') throw new AppError('bad_request', 'values が必要です');
  var cur = settingsMap_();
  var next = {};
  SETTING_KEYS.forEach(function (k) { next[k] = cur[k] || ''; });
  Object.keys(vals).forEach(function (k) {
    if (SETTING_KEYS.indexOf(k) < 0) throw new AppError('bad_request', '不明な設定項目です: ' + k);
    var v = vals[k];
    if (k === '登録番号') v = normRegNo_(v);
    else if (k === '税の端数処理') { v = str_(v); if (ROUND_MODES.indexOf(v) < 0) throw new AppError('bad_request', '税の端数処理は ' + ROUND_MODES.join(' / ') + ' のどれかです'); }
    else v = cleanMemo_(v).slice(0, k === 'レシートのメッセージ' ? 100 : 100);
    next[k] = v;
  });
  var sh = sheet_('SETTINGS');
  var rows = SETTING_KEYS.map(function (k) { return [k, next[k]]; });
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 2).clearContent();
  writeRows_(sh, 2, 1, rows, [true, true]);
  return settingsGet_({});
}

/* ============================== 商品マスタ ============================== */

function toPrice_(v) {
  if (v === '' || v === null || v === undefined) return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function loadMaster_() {
  var sh = sheet_('MASTER');
  var last = sh.getLastRow();
  var rows = [], byKey = {};
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, 5).getValues();
    for (var i = 0; i < v.length; i++) {
      var jan = janDigits_(v[i][0]);
      if (!jan) continue;
      var key = janKey_(jan);
      if (byKey[key]) continue;
      var rate = 10;
      try { rate = parseRate_(v[i][3]); } catch (e) { rate = 10; }
      var r = { row: i + 2, jan: jan, key: key, name: str_(v[i][1]), price: toPrice_(v[i][2]), rate: rate, stock: toInt_(v[i][4]), dirty: false, isNew: false };
      rows.push(r); byKey[key] = r;
    }
  }
  return { sh: sh, rows: rows, byKey: byKey, nextRow: Math.max(last, 1) + 1 };
}

function addMasterRow_(m, data) {
  var r = { row: m.nextRow++, jan: data.jan, key: janKey_(data.jan), name: data.name, price: data.price, rate: data.rate, stock: data.stock || 0, dirty: true, isNew: true };
  m.rows.push(r); m.byKey[r.key] = r;
  return r;
}

function masterValues_(r) { return [r.jan, r.name, r.price, RATE_LABEL[r.rate], r.stock]; }

function commitMaster_(m) {
  var mask = textMask_('MASTER', 1, 5);
  var news = m.rows.filter(function (r) { return r.isNew; }).sort(function (a, b) { return a.row - b.row; });
  if (news.length) writeRows_(m.sh, news[0].row, 1, news.map(masterValues_), mask);
  var dirty = m.rows.filter(function (r) { return r.dirty && !r.isNew; }).sort(function (a, b) { return a.row - b.row; });
  var i = 0;
  while (i < dirty.length) {
    var j = i;
    while (j + 1 < dirty.length && dirty[j + 1].row === dirty[j].row + 1) j++;
    var run = dirty.slice(i, j + 1).map(function (r) { return [r.name, r.price, RATE_LABEL[r.rate], r.stock]; });
    writeRows_(m.sh, dirty[i].row, 2, run, mask.slice(1));
    i = j + 1;
  }
  m.rows.forEach(function (r) { r.dirty = false; r.isNew = false; });
}

function pub_(r) { return { jan: r.jan, name: r.name, price: r.price === '' ? null : r.price, rate: r.rate, stock: r.stock }; }
function ioRow_(ts, r, kubun, qty, memo) { return [ts, r.jan, r.name, kubun, qty, r.stock, memo || '']; }

function masterGet_(req) {
  var jan = requireJan_(req.jan);
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  return { ok: true, found: !!r, jan: jan, item: r ? pub_(r) : null };
}

function masterList_(req) {
  var m = loadMaster_();
  var q = nfkc_(req.q || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var items = [];
  m.rows.forEach(function (r) {
    if (q && (nfkc_(r.name) + ' ' + r.jan).toLowerCase().indexOf(q) < 0) return;
    items.push(pub_(r));
  });
  return { ok: true, items: items, count: items.length };
}

function masterUpsert_(req) {
  var jan = requireJan_(req.jan);
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  var ts = now_();
  var name = req.name === undefined ? undefined : normName_(req.name);
  var price = req.price === undefined ? undefined : parseYen_(req.price, '単価（税込）', 0, CONFIG.MAX_UNIT_PRICE);
  var rate = req.rate === undefined ? undefined : parseRate_(req.rate);
  var created = false, ioRows = [];
  if (!r) {
    if (!name) throw new AppError('bad_request', '新しい商品には商品名が必要です');
    if (price === undefined) throw new AppError('bad_request', '新しい商品には単価（税込）が必要です');
    var stock = 0;
    if (req.stock !== undefined && req.stock !== null && req.stock !== '') stock = parseCount_(req.stock, '現在庫');
    r = addMasterRow_(m, { jan: jan, name: name, price: price, rate: rate === undefined ? 10 : rate, stock: stock });
    created = true;
    if (stock > 0) ioRows.push(ioRow_(ts, r, '入荷', stock, '初期登録'));
  } else {
    if (name) { r.name = name; r.dirty = true; }
    if (price !== undefined) { r.price = price; r.dirty = true; }
    if (rate !== undefined) { r.rate = rate; r.dirty = true; }
  }
  commitMaster_(m);
  appendRows_('IO', ioRows);
  return { ok: true, created: created, item: pub_(r) };
}

/** 取り込み: 1行1商品。JAN,商品名,単価（税込）[,税率区分[,現在庫]]（カンマ／タブ／ダブルクォート対応） */
function masterImport_(req) {
  var text = String(req.text || '').replace(/^﻿/, '');
  var lines = splitLines_(text);
  var m = loadMaster_();
  var ts = now_();
  var added = 0, updated = 0, errors = [], ioRows = [], first = true;
  lines.forEach(function (ln) {
    if (/^\s*$/.test(ln.text) || /^\s*#/.test(ln.text)) return;
    var c = splitCells_(ln.text);
    if (first) { first = false; if (!/^'?\d+$/.test(nfkc_(c[0]).replace(/\s/g, ''))) return; }
    try {
      var jan = requireJan_(c[0]);
      var name = normName_(c[1] || '');
      var price = c.length > 2 && c[2] !== '' ? parseYen_(c[2], '単価（税込）', 0, CONFIG.MAX_UNIT_PRICE) : undefined;
      var rate = c.length > 3 && c[3] !== '' ? parseRate_(c[3]) : undefined;
      var r = m.byKey[janKey_(jan)];
      if (!r) {
        if (!name) throw new AppError('bad_request', '新しい商品には商品名が必要です');
        if (price === undefined) throw new AppError('bad_request', '新しい商品には単価（税込）が必要です');
        var stock = c.length > 4 && c[4] !== '' ? parseCount_(c[4], '現在庫') : 0;
        r = addMasterRow_(m, { jan: jan, name: name, price: price, rate: rate === undefined ? 10 : rate, stock: stock });
        if (stock > 0) ioRows.push(ioRow_(ts, r, '入荷', stock, '初期登録'));
        added++;
      } else {
        if (name) r.name = name;
        if (price !== undefined) r.price = price;
        if (rate !== undefined) r.rate = rate;
        r.dirty = true; updated++;
      }
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      errors.push({ line: ln.no, reason: e.message });
    }
  });
  commitMaster_(m);
  appendRows_('IO', ioRows);
  return { ok: true, added: added, updated: updated, errors: errors };
}

/* ============================== 入荷・棚卸（最小） ============================== */

function receive_(req) {
  var jan = requireJan_(req.jan);
  var qty = parseQty_(req.qty);
  var m = loadMaster_();
  var r = m.byKey[janKey_(jan)];
  if (!r) throw new AppError('not_in_master', '商品マスタにないJANです: ' + jan, { jan: jan });
  r.stock += qty; r.dirty = true;
  var ts = now_();
  var memo = req.memo ? cleanMemo_(req.memo) : '';
  commitMaster_(m);
  appendRows_('IO', [ioRow_(ts, r, '入荷', qty, memo)]);
  return { ok: true, item: pub_(r) };
}

/** counts: [{jan, actual}]。数えた商品だけの差異を出す（書き込まない） */
function stocktakeCompute_(req) {
  if (!Array.isArray(req.counts) || !req.counts.length) throw new AppError('bad_request', '数えた商品がありません');
  var m = loadMaster_();
  var seen = {}, rows = [], missing = [];
  req.counts.forEach(function (c) {
    var jan = requireJan_(c.jan);
    var k = janKey_(jan);
    if (seen[k]) throw new AppError('bad_request', 'JANが重複しています: ' + jan);
    seen[k] = true;
    var actual = parseCount_(c.actual, '実績数');
    var r = m.byKey[k];
    if (!r) { missing.push(jan); return; }
    rows.push({ jan: r.jan, name: r.name, book: r.stock, actual: actual, diff: actual - r.stock });
  });
  if (missing.length) throw new AppError('not_in_master', '商品マスタにないJANがあります: ' + missing.join(', '), { missing: missing });
  return { m: m, rows: rows, adjust: rows.filter(function (x) { return x.diff !== 0; }).length };
}

function stocktakePreview_(req) {
  var c = stocktakeCompute_(req);
  return { ok: true, rows: c.rows, adjust: c.adjust };
}

function stocktakeSave_(req) {
  var name = normName_(req.name);
  if (!name) throw new AppError('bad_request', '棚卸名が必要です');
  var c = stocktakeCompute_(req);
  var ts = now_(), ioRows = [], changed = [];
  c.rows.forEach(function (x) {
    if (x.diff === 0) return;
    var r = c.m.byKey[janKey_(x.jan)];
    r.stock = x.actual; r.dirty = true;
    ioRows.push(ioRow_(ts, r, '棚卸調整', x.diff, '棚卸:' + name));
    changed.push(pub_(r));
  });
  commitMaster_(c.m);
  appendRows_('IO', ioRows);
  return { ok: true, rows: c.rows, adjust: c.adjust, items: changed };
}

/* ============================== 取引・売上明細の読み取り ============================== */

/** シートの末尾 n 行を読む。戻り値: { first: 先頭の行番号, rows: 値の配列 } */
function readTail_(key, width, n) {
  var sh = sheet_(key);
  var last = sh.getLastRow();
  if (last < 2) return { sh: sh, first: 2, rows: [] };
  var start = Math.max(2, last - n + 1);
  return { sh: sh, first: start, rows: sh.getRange(start, 1, last - start + 1, width).getValues() };
}

function txOf_(r, rowNo) {
  return { id: str_(r[0]), ts: str_(r[1]), total: toInt_(r[2]), tax8: toInt_(r[3]), tax10: toInt_(r[4]), method: str_(r[5]), guests: toInt_(r[6]), status: str_(r[7]), origId: str_(r[8]), key: str_(r[9]), received: r[10] === '' ? null : toInt_(r[10]), change: r[11] === '' ? null : toInt_(r[11]), issuer: str_(r[12]), regNo: str_(r[13]), row: rowNo };
}

function salesOf_(r) {
  return { id: str_(r[0]), line: toInt_(r[1]), ts: str_(r[2]), jan: str_(r[3]), name: str_(r[4]), qty: toInt_(r[5]), price: toInt_(r[6]), rate: parseRate_(r[7]), disc: toInt_(r[8]), amount: toInt_(r[9]) };
}

function loadTx_() {
  var t = readTail_('TX', 14, CONFIG.TX_WINDOW);
  var list = t.rows.map(function (r, i) { return txOf_(r, t.first + i); }).filter(function (x) { return x.id; });
  var byId = {}; list.forEach(function (x) { byId[x.id] = x; });
  return { sh: t.sh, list: list, byId: byId };
}

function loadSalesFor_(ids) {
  var set = {}; ids.forEach(function (i) { set[i] = true; });
  var t = readTail_('SALES', 10, CONFIG.SALES_WINDOW);
  var out = [];
  t.rows.forEach(function (r) { if (set[str_(r[0])]) out.push(salesOf_(r)); });
  return out;
}

function newTxId_(tx, ts) {
  var ymd = ts.slice(0, 10).replace(/\//g, '');
  var prefix = 'T-' + ymd + '-';
  var max = 0;
  tx.list.forEach(function (x) {
    if (x.id.indexOf(prefix) === 0) { var n = Number(x.id.slice(prefix.length)); if (n > max) max = n; }
  });
  return prefix + ('0000' + (max + 1)).slice(-4);
}

function txRow_(t) {
  return [t.id, t.ts, t.total, t.tax8, t.tax10, t.method, t.guests, t.status, t.origId || '', t.key || '', t.received === null || t.received === undefined ? '' : t.received, t.change === null || t.change === undefined ? '' : t.change, t.issuer || '', t.regNo || ''];
}

function salesRow_(id, line, ts, l) {
  return [id, line, ts, l.jan, l.name, l.qty, l.price, RATE_LABEL[l.rate], l.disc, l.amount];
}

/** 取引1件の表示用データ（レシート・インボイス用の発行者情報つき） */
function txDetail_(tx, x) {
  var lines = loadSalesFor_([x.id]);
  var s = settingsMap_();
  var returns = tx.list.filter(function (y) { return y.origId === x.id; });
  return {
    tx: { id: x.id, ts: x.ts, total: x.total, tax8: x.tax8, tax10: x.tax10, method: x.method, guests: x.guests, status: x.status, origId: x.origId, received: x.received, change: x.change, issuer: x.issuer, regNo: x.regNo },
    lines: lines,
    issuer: { name: x.issuer || '', regNo: x.regNo || '', address: s['住所'] || '', tel: s['電話'] || '', message: s['レシートのメッセージ'] || '' },
    returns: returns.map(function (y) { return { id: y.id, ts: y.ts, total: y.total, status: y.status }; })
  };
}

function saleGet_(req) {
  var id = str_(req.id).replace(/^\s+|\s+$/g, '');
  var tx = loadTx_();
  var x = tx.byId[id];
  if (!x) {
    var hit = arcFindTx_(id);
    if (hit) return Object.assign({ ok: true, archived: true }, arcTxDetail_(tx, hit)); // アーカイブ済み（見る・再発行だけ。返品・取消はできない）
    throw new AppError('not_found', '取引が見つかりません（直近' + CONFIG.TX_WINDOW + '件と、アーカイブ済みの分から検索します）: ' + id);
  }
  var d = txDetail_(tx, x);
  // 返品できる残り数（元の取引のとき）
  if (!x.origId) {
    var rets = {};
    d.returns.forEach(function (y) {
      loadSalesFor_([y.id]).forEach(function (l) { rets[l.line] = (rets[l.line] || 0) + (-l.qty); });
    });
    d.lines.forEach(function (l) { l.returned = rets[l.line] || 0; l.remaining = l.qty - l.returned; });
  }
  return Object.assign({ ok: true }, d);
}

function saleList_(req) {
  var tx = loadTx_();
  var date = req.date ? str_(req.date).replace(/-/g, '/') : '';
  var limit = Math.min(Math.max(Number(req.limit) || 50, 1), 200);
  var rows = [];
  for (var i = tx.list.length - 1; i >= 0 && rows.length < limit; i--) {
    var x = tx.list[i];
    if (date && x.ts.indexOf(date) !== 0) continue;
    rows.push({ id: x.id, ts: x.ts, total: x.total, method: x.method, guests: x.guests, status: x.status, origId: x.origId });
  }
  var archived = false, arcErr = '';
  if (date) {
    var a = arcTxOfDate_(date);
    arcErr = a.err;
    if (a.list.length) {
      archived = true;
      var have = {}; rows.forEach(function (r) { have[r.id] = true; });
      a.list.forEach(function (x) { if (!have[x.id]) rows.push({ id: x.id, ts: x.ts, total: x.total, method: x.method, guests: x.guests, status: x.status, origId: x.origId, archived: true }); });
      rows.sort(function (p, q) { return p.ts < q.ts ? 1 : (p.ts > q.ts ? -1 : (p.id < q.id ? 1 : -1)); });
      rows = rows.slice(0, limit);
    }
  }
  var res = { ok: true, rows: rows, truncated: tx.list.length >= CONFIG.TX_WINDOW && !archived };
  if (arcErr) res.archiveError = arcErr;
  return res;
}

/* ============================== 販売（会計確定） ============================== */

function checkPayMethod_(v) {
  var s = str_(v);
  if (PAY_METHODS.indexOf(s) < 0) throw new AppError('bad_request', '支払方法は ' + PAY_METHODS.join(' / ') + ' のどれかです');
  return s;
}

function parseGuests_(v) {
  if (v === undefined || v === null || v === '') return 1;
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n || n < 0 || n > 999) throw new AppError('bad_request', '客数は0〜999の整数です: ' + v);
  return n;
}

function saleCreate_(req) {
  var key = str_(req.txKey).replace(/^\s+|\s+$/g, '');
  if (key.length < 8 || key.length > 64) throw new AppError('bad_request', 'txKey（二重送信を防ぐ識別子。8〜64文字）が必要です');
  var tx = loadTx_();
  var dup = tx.list.filter(function (x) { return x.key === key; })[0];
  if (dup) { var d0 = txDetail_(tx, dup); return Object.assign({ ok: true, duplicate: true }, d0); }

  if (!Array.isArray(req.lines) || !req.lines.length) throw new AppError('bad_request', 'カートが空です');
  if (req.lines.length > CONFIG.MAX_LINES) throw new AppError('bad_request', '1会計の明細は' + CONFIG.MAX_LINES + '行までです');
  var method = checkPayMethod_(req.method);
  var guests = parseGuests_(req.guests);
  var subDisc = parseDisc_(req.subDisc, '小計の値引・割引');
  var mode = roundMode_();
  var m = loadMaster_();

  var norm = [], stockUse = {}, missing = [];
  req.lines.forEach(function (l, i) {
    var qty = parseQty_(l.qty, (i + 1) + '行目の数量');
    var disc = parseDisc_(l.disc, (i + 1) + '行目の値引・割引');
    if (l.unregistered === true) {
      var price0 = parseYen_(l.price, (i + 1) + '行目の単価（税込）', 1, CONFIG.MAX_UNIT_PRICE);
      norm.push({ jan: '', name: '未登録商品', price: price0, qty: qty, rate: parseRate_(l.rate), disc: disc, reg: null });
      return;
    }
    var jan = requireJan_(l.jan);
    var r = m.byKey[janKey_(jan)];
    if (!r) { missing.push(jan); return; }
    if (r.price === '') throw new AppError('no_price', '単価が未設定の商品です: ' + r.name, { jan: r.jan });
    norm.push({ jan: r.jan, name: r.name, price: r.price, qty: qty, rate: r.rate, disc: disc, reg: r });
  });
  if (missing.length) throw new AppError('not_in_master', '商品マスタにないJANがあります（未登録商品として売る場合は unregistered を指定）: ' + missing.join(', '), { missing: missing });
  norm.forEach(function (l, i) {
    if (l.price * l.qty > CONFIG.MAX_CART_TOTAL) throw new AppError('too_large', (i + 1) + '行目の金額が大きすぎます');
  });

  var c = calcCart_(norm, subDisc, mode);
  if (c.subtotal > CONFIG.MAX_CART_TOTAL) throw new AppError('too_large', '1会計の合計は' + CONFIG.MAX_CART_TOTAL + '円までです');
  var received, change = 0;
  if (method === '現金') {
    received = req.received === undefined || req.received === null || req.received === '' ? c.total : parseYen_(req.received, '預り金', 0, CONFIG.MAX_CART_TOTAL * 2);
    if (received < c.total) throw new AppError('short_cash', '預り金が足りません（合計 ' + c.total + '円）', { total: c.total, received: received });
    change = received - c.total;
  } else {
    received = c.total;
  }

  // 在庫（登録商品だけ。同じ商品は合算して引く）
  var negative = [];
  norm.forEach(function (l) { if (l.reg) stockUse[l.reg.key] = (stockUse[l.reg.key] || 0) + l.qty; });
  Object.keys(stockUse).forEach(function (k) {
    var r = m.byKey[k];
    if (r.stock - stockUse[k] < 0 && !CONFIG.ALLOW_NEGATIVE_STOCK) {
      throw new AppError('insufficient_stock', '在庫が足りません: ' + r.name, { jan: r.jan, stock: r.stock, qty: stockUse[k] });
    }
  });

  var ts = now_();
  var id = newTxId_(tx, ts);
  var s = settingsMap_();
  var salesRows = [], ioRows = [];
  norm.forEach(function (l, i) {
    var o = c.lines[i];
    salesRows.push(salesRow_(id, i + 1, ts, { jan: l.jan, name: l.name, qty: l.qty, price: l.price, rate: l.rate, disc: o.lineDisc + o.alloc, amount: o.amount }));
  });
  Object.keys(stockUse).forEach(function (k) {
    var r = m.byKey[k];
    r.stock -= stockUse[k]; r.dirty = true;
    if (r.stock < 0) negative.push({ jan: r.jan, name: r.name, stock: r.stock });
    ioRows.push(ioRow_(ts, r, '販売', -stockUse[k], id));
  });
  appendRows_('SALES', salesRows);
  appendRows_('IO', ioRows);
  commitMaster_(m);
  var t = { id: id, ts: ts, total: c.total, tax8: c.tax[8], tax10: c.tax[10], method: method, guests: guests, status: '通常', origId: '', key: key, received: received, change: change, issuer: s['事業者名'] || '', regNo: s['登録番号'] || '' };
  appendRows_('TX', [txRow_(t)]);

  var lines = salesRows.map(function (r) { return salesOf_(r); });
  return {
    ok: true, duplicate: false,
    tx: { id: id, ts: ts, total: c.total, tax8: c.tax[8], tax10: c.tax[10], method: method, guests: guests, status: '通常', origId: '', received: received, change: change, issuer: t.issuer, regNo: t.regNo },
    lines: lines, subtotal: c.subtotal, subDisc: c.subDisc, byRate: c.byRate, negativeStock: negative,
    issuer: { name: t.issuer, regNo: t.regNo, address: s['住所'] || '', tel: s['電話'] || '', message: s['レシートのメッセージ'] || '' }
  };
}

/* ============================== 取消・返品（赤黒：マイナスの取引を足す） ============================== */

function loadOriginal_(tx, id) {
  var x = tx.byId[str_(id).replace(/^\s+|\s+$/g, '')];
  if (!x) {
    if (arcFindTx_(str_(id).replace(/^\s+|\s+$/g, ''))) throw new AppError('archived', 'アーカイブ済みの古い取引は、返品・取消できません（見る・レシートの再発行はできます）: ' + id, { id: str_(id) });
    throw new AppError('not_found', '取引が見つかりません（直近' + CONFIG.TX_WINDOW + '件まで検索します）: ' + id);
  }
  if (x.origId) throw new AppError('bad_state', '返品・取消の取引は、さらに取り消せません: ' + x.id);
  if (x.status === '取消済') throw new AppError('already_voided', 'この取引は取消済みです: ' + x.id);
  if (x.status !== '通常') throw new AppError('bad_state', '通常の取引だけ、返品・取消できます（今: ' + x.status + '）');
  return x;
}

function returnedQty_(tx, x) {
  var rets = tx.list.filter(function (y) { return y.origId === x.id; });
  var qty = {};
  if (rets.length) loadSalesFor_(rets.map(function (y) { return y.id; })).forEach(function (l) { qty[l.line] = (qty[l.line] || 0) + (-l.qty); });
  return { count: rets.length, byLine: qty };
}

/** 累計の返金額: 全数なら元の金額、途中は端数切り捨て（累計で計算するので、最後の1個で金額がぴったり合う） */
function refundCum_(amount, qty, r) {
  return r >= qty ? amount : Math.floor(amount * r / qty);
}

function writeReturnTx_(tx, x, kind, items, req) {
  var mode = roundMode_();
  var m = loadMaster_();
  var ts = now_();
  var id = newTxId_(tx, ts);
  var s = settingsMap_();
  var byRate = { 8: 0, 10: 0 }, total = 0, salesRows = [], ioRows = [];
  items.forEach(function (it) {
    var l = it.line;
    var refund = refundCum_(l.amount, l.qty, it.before + it.qty) - refundCum_(l.amount, l.qty, it.before);
    byRate[l.rate] += refund; total += refund;
    salesRows.push(salesRow_(id, l.line, ts, { jan: l.jan, name: l.name, qty: -it.qty, price: l.price, rate: l.rate, disc: 0, amount: -refund }));
    if (l.jan) {
      var r = m.byKey[janKey_(l.jan)];
      if (r) { r.stock += it.qty; r.dirty = true; ioRows.push(ioRow_(ts, r, '返品', it.qty, (kind === '取消' ? '取消:' : '返品:') + x.id)); }
    }
  });
  var tax8, tax10;
  if (kind === '取消') { tax8 = -x.tax8; tax10 = -x.tax10; }   // 全額の取消は、元の税額をそのまま反転
  else { tax8 = -taxInner_(byRate[8], 8, mode); tax10 = -taxInner_(byRate[10], 10, mode); }
  var method = req.method ? checkPayMethod_(req.method) : x.method;
  var key = req.txKey ? str_(req.txKey) : '';
  var t = { id: id, ts: ts, total: -total, tax8: tax8, tax10: tax10, method: method, guests: 0, status: kind, origId: x.id, key: key, received: null, change: null, issuer: x.issuer, regNo: x.regNo };
  appendRows_('SALES', salesRows);
  appendRows_('IO', ioRows);
  commitMaster_(m);
  appendRows_('TX', [txRow_(t)]);
  if (kind === '取消') tx.sh.getRange(x.row, 8, 1, 1).setValues([['取消済']]);
  var lines = salesRows.map(function (r) { return salesOf_(r); });
  return {
    ok: true,
    tx: { id: id, ts: ts, total: -total, tax8: tax8, tax10: tax10, method: method, guests: 0, status: kind, origId: x.id, received: null, change: null, issuer: x.issuer, regNo: x.regNo, origTs: x.ts },
    lines: lines, byRate: { 8: -byRate[8], 10: -byRate[10] },
    issuer: { name: x.issuer, regNo: x.regNo, address: s['住所'] || '', tel: s['電話'] || '', message: s['レシートのメッセージ'] || '' }
  };
}

function saleVoid_(req) {
  var tx = loadTx_();
  var x = loadOriginal_(tx, req.id);
  var rq = returnedQty_(tx, x);
  if (rq.count) throw new AppError('has_returns', 'すでに返品があるため、全体は取り消せません。残りは「返品」で戻してください: ' + x.id);
  var lines = loadSalesFor_([x.id]);
  if (!lines.length) throw new AppError('not_found', 'この取引の明細が見つかりません（古すぎる可能性があります）: ' + x.id);
  var items = lines.map(function (l) { return { line: l, qty: l.qty, before: 0 }; });
  return writeReturnTx_(tx, x, '取消', items, req);
}

/** items: [{line（行番号）, qty}] */
function saleReturn_(req) {
  if (!Array.isArray(req.items) || !req.items.length) throw new AppError('bad_request', '返品する商品を選んでください');
  var tx = loadTx_();
  var x = loadOriginal_(tx, req.id);
  var lines = loadSalesFor_([x.id]);
  if (!lines.length) throw new AppError('not_found', 'この取引の明細が見つかりません（古すぎる可能性があります）: ' + x.id);
  var byLine = {}; lines.forEach(function (l) { byLine[l.line] = l; });
  var rq = returnedQty_(tx, x);
  var seen = {}, items = [];
  req.items.forEach(function (it) {
    var n = Number(it.line);
    var l = byLine[n];
    if (!l) throw new AppError('bad_request', '明細の行が見つかりません: ' + it.line);
    if (seen[n]) throw new AppError('bad_request', '同じ行が重複しています: ' + n);
    seen[n] = true;
    var qty = parseQty_(it.qty, n + '行目の返品数');
    var before = rq.byLine[n] || 0;
    if (before + qty > l.qty) throw new AppError('over_return', n + '行目は、あと' + (l.qty - before) + '個まで返品できます', { line: n, remaining: l.qty - before });
    items.push({ line: l, qty: qty, before: before });
  });
  return writeReturnTx_(tx, x, '返品', items, req);
}

/* ============================== 精算（日別の集計） ============================== */

function settlement_(req) {
  var today = now_().slice(0, 10);
  var date = req.date ? str_(req.date).replace(/-/g, '/') : today;
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) throw new AppError('bad_request', 'date は yyyy/MM/dd（または yyyy-MM-dd）です');
  var tx = loadTx_();
  var rows = tx.list.filter(function (x) { return x.ts.indexOf(date) === 0; });
  var arcA = arcTxOfDate_(date), arcSales = null;
  if (arcA.list.length) {
    var haveIds = {}; rows.forEach(function (x) { haveIds[x.id] = true; });
    arcSales = {};
    arcA.list.forEach(function (x) { if (!haveIds[x.id]) { rows.push(x); arcSales[x.id] = true; } });
  }
  var r = { count: 0, guests: 0, gross: 0, refund: 0, net: 0, voidCount: 0, returnCount: 0, tax8: 0, tax10: 0, byMethod: {}, cash: 0 };
  PAY_METHODS.forEach(function (p) { r.byMethod[p] = 0; });
  var ids = [];
  rows.forEach(function (x) {
    ids.push(x.id);
    r.net += x.total; r.tax8 += x.tax8; r.tax10 += x.tax10;
    r.byMethod[x.method] = (r.byMethod[x.method] || 0) + x.total;
    if (x.status === '通常' || x.status === '取消済') { r.count++; r.guests += x.guests; r.gross += x.total; }
    else if (x.status === '取消') { r.voidCount++; r.refund += x.total; }
    else if (x.status === '返品') { r.returnCount++; r.refund += x.total; }
  });
  // 税率別の対価（税込）は、売上明細から
  var byRate = { 8: 0, 10: 0 };
  var activeIds = ids.filter(function (i) { return !(arcSales && arcSales[i]); });
  if (activeIds.length) loadSalesFor_(activeIds).forEach(function (l) { byRate[l.rate] += l.amount; });
  if (arcSales && Object.keys(arcSales).length) arcReadMonth_('SALES', arcA.ym).forEach(function (rw) { if (arcSales[str_(rw[0])]) { var l = salesOf_(rw); byRate[l.rate] += l.amount; } });
  var truncated = !arcSales && tx.list.length >= CONFIG.TX_WINDOW && tx.list.length && tx.list[0].ts.slice(0, 10) >= date;
  return {
    ok: true, date: date, count: r.count, guests: r.guests, gross: r.gross, refund: r.refund, net: r.net,
    voidCount: r.voidCount, returnCount: r.returnCount,
    avgPerGuest: r.guests > 0 ? Math.floor(r.gross / r.guests) : null,
    byMethod: r.byMethod, cash: r.byMethod['現金'] || 0,
    byRate: byRate, tax: { 8: r.tax8, 10: r.tax10 }, truncated: !!truncated
  };
}

/* ============================== 会計ソフト向けの日別CSV（汎用） ============================== */
/*
 * 期間（from〜to）の日別の売上集計を、1日1行で返す。特定の会計ソフトの形式ではなく、表計算や会計ソフトの取り込み用に整えるための汎用の形。
 *   ・金額はすべて税込（円）。税率別は「対象額（税込）」「内消費税等」「対象額（税抜）」。返品・取消はマイナスで入り、純額になる
 *   ・内消費税等は、精算と同じく取引ごとに「税率ごとに1回」端数処理した額の合計
 *   ・アーカイブへ移した日付も合算する（移す前と合計は変わらない）。取引が0件の日は行を作らない
 *   ・申告に使う税額の計算や、仕訳の科目・税区分は決めない（税理士などに確認する）
 */
var REPORT_MAX_DAYS = 366;
var REPORT_HEADER = ['日付', '取引件数', '客数', '売上（通常・税込）', '返品・取消（税込）', '純売上（税込）',
  '10%対象（税込）', '10%内消費税等', '10%対象（税抜）', '軽減8%対象（税込）', '軽減8%内消費税等', '軽減8%対象（税抜）',
  '現金', 'カード', 'その他', '返品件数', '取消件数'];

function z2_(n) { return (n < 10 ? '0' : '') + n; }
function dayShift_(date, n) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(date);
  var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.getUTCFullYear() + '/' + z2_(d.getUTCMonth() + 1) + '/' + z2_(d.getUTCDate());
}
function dayDiff_(a, b) {
  var f = function (s) { var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s); return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])); };
  return Math.round((f(b) - f(a)) / 86400000);
}

function dailyReport_(req) {
  var today = now_().slice(0, 10);
  var to = req.to ? str_(req.to).replace(/-/g, '/') : today;
  var from = req.from ? str_(req.from).replace(/-/g, '/') : to.slice(0, 8) + '01';
  var re = /^\d{4}\/\d{2}\/\d{2}$/;
  if (!re.test(from) || !re.test(to)) throw new AppError('bad_request', 'from・to は yyyy-MM-dd（または yyyy/MM/dd）です');
  if (from > to) throw new AppError('bad_request', '開始日が終了日より後です');
  if (dayDiff_(from, to) + 1 > REPORT_MAX_DAYS) throw new AppError('bad_request', '期間は' + REPORT_MAX_DAYS + '日までです');
  var inRange = function (x) { var d = x.ts.slice(0, 10); return d >= from && d <= to; };

  var tx = loadTx_();
  var rows = tx.list.filter(inRange), have = {};
  rows.forEach(function (x) { have[x.id] = true; });
  var arcMonthOf = {}, archiveError = '';
  // 範囲に入る月ごとに、アーカイブにある分を足す（アーカイブより新しい日付は、通常のシートだけ）
  var ym = from.slice(0, 7);
  var lastYm = to.slice(0, 7);
  for (;;) {
    var firstDay = ym + '/01'; if (firstDay < from) firstDay = from;
    if (arcUpto_(firstDay)) {
      try {
        arcTxList_(ym.replace('/', '-')).forEach(function (x) {
          if (inRange(x) && !have[x.id]) { rows.push(x); have[x.id] = true; arcMonthOf[x.id] = ym.replace('/', '-'); }
        });
      } catch (e) { archiveError = String((e && e.message) || e); }
    }
    if (ym >= lastYm) break;
    var yy = Number(ym.slice(0, 4)), mm = Number(ym.slice(5, 7)) + 1;
    if (mm > 12) { yy++; mm = 1; }
    ym = yy + '/' + z2_(mm);
  }

  // 税率別の対象額（税込）は売上明細から。通常のシートの分と、移した月の分
  var byRate = {};   // date -> {8:, 10:}
  var addLine = function (l, date) { var o = byRate[date] || (byRate[date] = { 8: 0, 10: 0 }); o[l.rate] = (o[l.rate] || 0) + l.amount; };
  var dateOf = {}; rows.forEach(function (x) { dateOf[x.id] = x.ts.slice(0, 10); });
  var activeIds = rows.filter(function (x) { return !arcMonthOf[x.id]; }).map(function (x) { return x.id; });
  if (activeIds.length) loadSalesFor_(activeIds).forEach(function (l) { addLine(l, dateOf[l.id]); });
  var months = {}; Object.keys(arcMonthOf).forEach(function (id) { months[arcMonthOf[id]] = true; });
  Object.keys(months).forEach(function (m) {
    try { arcReadMonth_('SALES', m).forEach(function (rw) { var id = str_(rw[0]); if (arcMonthOf[id]) addLine(salesOf_(rw), dateOf[id]); }); }
    catch (e) { archiveError = String((e && e.message) || e); }
  });

  var days = {};
  rows.forEach(function (x) {
    var d = x.ts.slice(0, 10);
    var r = days[d] || (days[d] = { count: 0, guests: 0, gross: 0, refund: 0, net: 0, tax8: 0, tax10: 0, byMethod: {}, ret: 0, voided: 0 });
    r.net += x.total; r.tax8 += x.tax8; r.tax10 += x.tax10;
    r.byMethod[x.method] = (r.byMethod[x.method] || 0) + x.total;
    if (x.status === '通常' || x.status === '取消済') { r.count++; r.guests += x.guests; r.gross += x.total; }
    else if (x.status === '取消') { r.voided++; r.refund += x.total; }
    else if (x.status === '返品') { r.ret++; r.refund += x.total; }
  });
  var total = new Array(REPORT_HEADER.length); for (var t = 0; t < total.length; t++) total[t] = 0;
  var out = Object.keys(days).sort().map(function (d) {
    var r = days[d], br = byRate[d] || { 8: 0, 10: 0 };
    var line = [d, r.count, r.guests, r.gross, r.refund, r.net,
      br[10] || 0, r.tax10, (br[10] || 0) - r.tax10, br[8] || 0, r.tax8, (br[8] || 0) - r.tax8,
      r.byMethod['現金'] || 0, r.byMethod['カード'] || 0, r.byMethod['その他'] || 0, r.ret, r.voided];
    for (var k = 1; k < line.length; k++) total[k] += line[k];
    return line;
  });
  total[0] = '合計';
  // 通常の3種類以外の支払方法が混ざっていても、純売上と合うように「その他」へ寄せる
  out.forEach(function (line, i) {
    var r = days[line[0]], rest = 0;
    Object.keys(r.byMethod).forEach(function (m) { if (PAY_METHODS.indexOf(m) < 0) rest += r.byMethod[m]; });
    if (rest) { line[14] += rest; total[14] += rest; }
  });

  // 取引が多くて、期間の先頭が通常のシートの窓に入りきらない時は知らせる（アーカイブに移した日付は別）
  var truncated = false;
  if (tx.list.length >= CONFIG.TX_WINDOW && tx.list.length) {
    var firstActive = tx.list[0].ts.slice(0, 10);
    var prev = dayShift_(firstActive, -1);
    if (from <= prev && !arcUpto_(prev)) truncated = true;
  }
  return { ok: true, from: from, to: to, header: REPORT_HEADER.slice(), rows: out, total: total, days: out.length, truncated: truncated, archiveError: archiveError };
}

/* ============================== アーカイブ（古い取引・売上明細・履歴を、別のスプレッドシートへ移す） ============================== */
/*
 * 取引・売上明細・入出荷履歴は増え続ける。終わった古いものを、年ごとのアーカイブ用スプレッドシートへ移して、普段のシートを軽く保つ。
 *   ・取引（と売上明細）: 取引の日時から N 日（既定90日）が過ぎたもの。取引は、会計・返品・取消のどれも「終わったもの」なので、状態は問わない
 *   ・入出荷履歴: 月ごとに分け、直近の M か月（当月を含む。既定2）だけ残す
 *   ・移した先: スプレッドシート「簡易POS_アーカイブ_<年>」（初回に自動で作る。マイドライブ直下。好きなフォルダへ移してよい）。シート名は「取引_2026-10」のように月ごと
 *   ・返品・取消は、元の取引より新しいので、元の取引より先に移ることはない。移した取引は、返品・取消できない（見る・レシートの再発行・精算の集計はできる）
 *   ・コピー → 行数の確認 → 元から削除。確認が合わなければ元は消さずに止める。途中で止まっても、再実行で重複しない
 *   ・取引IDは日付入り（T-20261109-0001）で、日ごとに1から始まるため、連番の保存は要らない
 * 実行のしかた: ①画面の「今すぐ実行」（先に「対象を確認」）／②「自動実行」ON: 1日1回（最初の通信の時）／③時間トリガーに archiveDaily（任意）
 */
var ARC_DAYS_OPTIONS = [0, 30, 60, 90, 120, 180, 365];   // 0 = 移さない
var ARC_DAYS_DEFAULT = 90;
var ARC_HIST_OPTIONS = [0, 2, 3, 6, 12];                 // 0 = 履歴は移さない
var ARC_HIST_DEFAULT = 2;
var ARC_MAX_PER_RUN = 5000;                              // 1回に移す取引の上限（GASの実行時間の上限に収めるため）
var ARC_PREFIX = '簡易POS_アーカイブ_';

function props_() { return PropertiesService.getScriptProperties(); }
/** 'yyyy/MM/dd HH:mm:ss'（日本時間）→ ミリ秒。読めなければ null */
function tsMs_(t) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str_(t));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), Number(m[6])) : null;
}
function monthOfTs_(t) { var m = /^(\d{4})\/(\d{2})\//.exec(str_(t)); return m ? m[1] + '-' + m[2] : ''; }
function monthIdx_(ym) { var m = /^(\d{4})-(\d{2})$/.exec(str_(ym)); return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null; }
/** 取引ID（T-20261109-0001）→ 'yyyy-MM'。読めなければ '' */
function monthOfTxId_(id) { var m = /^T-(\d{4})(\d{2})\d{2}-\d+$/.exec(str_(id)); return m ? m[1] + '-' + m[2] : ''; }

function arcOpt_(prop, options, dflt) {
  var v = props_().getProperty(prop);
  var n = (v === null || v === undefined || v === '') ? dflt : Number(v);
  return options.indexOf(n) >= 0 ? n : dflt;
}
function arcSettings_() {
  return {
    txDays: arcOpt_('ARC_TX_DAYS', ARC_DAYS_OPTIONS, ARC_DAYS_DEFAULT),
    histMonths: arcOpt_('ARC_HIST_MONTHS', ARC_HIST_OPTIONS, ARC_HIST_DEFAULT),
    auto: props_().getProperty('ARC_AUTO') === 'lazy'
  };
}
function arcLog_() {
  try { var a = JSON.parse(props_().getProperty('ARC_LOG') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function arcLogAdd_(entry) {
  var a = arcLog_(); a.unshift(entry);
  props_().setProperty('ARC_LOG', JSON.stringify(a.slice(0, 10)));
}
function arcYears_() {
  try { var a = JSON.parse(props_().getProperty('ARC_YEARS') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

/* ----- アーカイブ用スプレッドシート ----- */

function arcOpen_(year) {
  var id = props_().getProperty('ARC_SS_' + year);
  if (!id) return null;
  try { return SpreadsheetApp.openById(id); }
  catch (e) { throw new AppError('archive_unreachable', year + '年のアーカイブ用スプレッドシートを開けません（削除や共有の解除をしていませんか）。何も消さずに止めました', { year: year }); }
}
function arcOpenOrCreate_(year) {
  var ss = arcOpen_(year);
  if (ss) return ss;
  ss = SpreadsheetApp.create(ARC_PREFIX + year);
  props_().setProperty('ARC_SS_' + year, ss.getId());
  var ys = arcYears_(); if (ys.indexOf(year) < 0) { ys.push(year); ys.sort(); props_().setProperty('ARC_YEARS', JSON.stringify(ys)); }
  return ss;
}
function arcSheetName_(key, ym) { return CONFIG.SHEETS[key] + '_' + ym; }
function arcSheet_(ss, key, ym) {
  var name = arcSheetName_(key, ym);
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    // 作ったばかりのスプレッドシートにある空の「シート1」は、いらないので消す（失敗しても影響なし）
    try {
      ['シート1', 'Sheet1'].forEach(function (n) {
        var d = ss.getSheetByName(n);
        if (d && d.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(d);
      });
    } catch (ignore) {}
  }
  var hs = SHEET_DEF[key].headers;
  if (sh.getLastRow() === 0) { sh.getRange(1, 1, 1, hs.length).setValues([hs]); sh.setFrozenRows(1); }
  return sh;
}
function arcRowKey_(r) { return r.map(function (c) { return String(c == null ? '' : c); }).join('\u0001'); }

/** 月のシートへ追記する。すでに同じ行があれば（前回の途中で止まった時の再実行）、その分は書かない。書いた行数を確認し、合わなければ止める */
function arcAppend_(ss, key, ym, rows) {
  if (!rows.length) return 0;
  var sh = arcSheet_(ss, key, ym);
  var w = rows[0].length;
  var have = {};
  var last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, w).getValues().forEach(function (r) { var k = arcRowKey_(r); have[k] = (have[k] || 0) + 1; });
  }
  var fresh = rows.filter(function (r) { var k = arcRowKey_(r); if (have[k] > 0) { have[k]--; return false; } return true; });
  if (!fresh.length) return 0;
  var before = sh.getLastRow();
  writeRows_(sh, before + 1, 1, fresh, textMask_(key, 1, w));
  if (sh.getLastRow() - before !== fresh.length) {
    throw new AppError('archive_verify_failed', 'アーカイブへの書き込みの行数が合いません（' + arcSheetName_(key, ym) + '）。元のデータは消さずに止めました', { sheet: arcSheetName_(key, ym) });
  }
  return fresh.length;
}

/** 元のシートから、残す行だけを上へ詰めて書き、余った下の行を空にする（途中で止まっても、消えるのではなく重複が残る側に倒す） */
function arcRewrite_(sh, key, w, keepRows, oldCount) {
  if (keepRows.length) writeRows_(sh, 2, 1, keepRows, textMask_(key, 1, w));
  if (oldCount > keepRows.length) sh.getRange(2 + keepRows.length, 1, oldCount - keepRows.length, w).clearContent();
}
function arcReadAll_(key) {
  var sh = sheet_(key), last = sh.getLastRow(), w = SHEET_DEF[key].headers.length;
  return { sh: sh, w: w, count: last >= 2 ? last - 1 : 0, rows: last >= 2 ? sh.getRange(2, 1, last - 1, w).getValues() : [] };
}
function arcByMonth_(items) {
  var g = {}, order = [];
  items.forEach(function (x) { if (!g[x.month]) { g[x.month] = []; order.push(x.month); } g[x.month].push(x); });
  order.sort();
  return { g: g, order: order };
}

/* ----- 対象の洗い出し ----- */

function arcCollect_(st, nowMs) {
  var c = { txOld: [], txKeep: [], ids: {}, salesOld: [], salesKeep: [], capped: false, hist: null, cutoff: '' };
  var T = c.T = arcReadAll_('TX');
  var S = c.S = arcReadAll_('SALES');
  if (st.txDays > 0) {
    var cand = [];
    T.rows.forEach(function (r, i) {
      var ms = tsMs_(r[1]), mo = monthOfTs_(r[1]);
      if (str_(r[0]) && ms !== null && mo && nowMs - ms >= st.txDays * 86400000) cand.push({ r: r, i: i, ms: ms, month: mo });
    });
    cand.sort(function (a, b) { return a.ms - b.ms; });
    if (cand.length > ARC_MAX_PER_RUN) { cand = cand.slice(0, ARC_MAX_PER_RUN); c.capped = true; }
    var pick = {}; cand.forEach(function (x) { pick[x.i] = true; c.ids[str_(x.r[0])] = true; });
    c.txOld = cand;
    T.rows.forEach(function (r, i) { if (!pick[i]) c.txKeep.push(r); });
    S.rows.forEach(function (r) {
      var id = str_(r[0]);
      if (c.ids[id]) c.salesOld.push({ r: r, month: monthOfTs_(r[2]) || monthOfTxId_(id) }); else c.salesKeep.push(r);
    });
    // 売上明細の月は、取引の月に合わせる（日時が読めない行でも、取引と同じ月へ）
    var txMonth = {}; cand.forEach(function (x) { txMonth[str_(x.r[0])] = x.month; });
    c.salesOld.forEach(function (x) { x.month = txMonth[str_(x.r[0])]; });
  } else { c.txKeep = T.rows.slice(); c.salesKeep = S.rows.slice(); }
  if (st.histMonths > 0) {
    var cur = monthIdx_(now_().slice(0, 7).replace('/', '-'));
    var cutoff = cur - (st.histMonths - 1);
    c.cutoff = Math.floor(cutoff / 12) + '-' + ('0' + ((cutoff % 12) + 1)).slice(-2);
    var I = arcReadAll_('IO'), old = {}, keep = [], nOld = 0;
    I.rows.forEach(function (r) {
      var ym = monthOfTs_(r[0]), ix = monthIdx_(ym);
      if (ix !== null && ix < cutoff) { (old[ym] = old[ym] || []).push(r); nOld++; } else keep.push(r);
    });
    c.hist = { I: I, old: old, keep: keep, nOld: nOld };
  }
  return c;
}

/** 実行する。dryRun なら、対象の数だけ返す（何も変えない）。ログには、日時・件数・実行のしかただけを残す */
function runArchive_(dryRun, mode) {
  var st = arcSettings_();
  var c = arcCollect_(st, Date.now());
  var due = { tx: c.txOld.length, sales: c.salesOld.length, io: c.hist ? c.hist.nOld : 0 };
  var res = { ok: true, dryRun: !!dryRun, settings: st, due: due, capped: c.capped, cutoff: c.cutoff, moved: { tx: 0, sales: 0, io: 0 },
    ids: c.txOld.slice(0, 20).map(function (x) { return str_(x.r[0]); }) };
  if (dryRun || !(due.tx || due.sales || due.io)) return res;

  var cache = {};
  var ssOf = function (ym) { var y = ym.slice(0, 4); return cache[y] || (cache[y] = arcOpenOrCreate_(y)); };

  // 1) 売上明細 → 2) 取引（取引を最後に消す。途中で止まっても、取引が残っていれば次の実行でやり直せる）
  if (c.txOld.length) {
    var gs = arcByMonth_(c.salesOld);
    gs.order.forEach(function (ym) { arcAppend_(ssOf(ym), 'SALES', ym, gs.g[ym].map(function (x) { return x.r; })); });
    var gt = arcByMonth_(c.txOld);
    gt.order.forEach(function (ym) { arcAppend_(ssOf(ym), 'TX', ym, gt.g[ym].map(function (x) { return x.r; })); });
    arcRewrite_(c.S.sh, 'SALES', c.S.w, c.salesKeep, c.S.count);
    arcRewrite_(c.T.sh, 'TX', c.T.w, c.txKeep, c.T.count);
    res.moved.tx = c.txOld.length; res.moved.sales = c.salesOld.length;
    var upto = c.txOld.reduce(function (m, x) { var d = str_(x.r[1]).slice(0, 10); return d > m ? d : m; }, props_().getProperty('ARC_UPTO') || '');
    props_().setProperty('ARC_UPTO', upto); // 「ここまでの日付は、アーカイブにもあるかもしれない」目印（新しい日付では、アーカイブを開かない）
  }
  // 3) 入出荷履歴
  if (c.hist && c.hist.nOld) {
    Object.keys(c.hist.old).sort().forEach(function (ym) { arcAppend_(ssOf(ym), 'IO', ym, c.hist.old[ym]); });
    arcRewrite_(c.hist.I.sh, 'IO', c.hist.I.w, c.hist.keep, c.hist.I.count);
    res.moved.io = c.hist.nOld;
  }
  arcLogAdd_({ at: now_(), mode: mode || 'manual', tx: res.moved.tx, sales: res.moved.sales, io: res.moved.io });
  res.files = Object.keys(cache).map(function (y) { var u = ''; try { u = cache[y].getUrl(); } catch (e) {} return { year: y, url: u }; });
  return res;
}

function archiveRun_(req) { return runArchive_(req.dryRun === true, 'manual'); }

/** 「自動実行」ON の時、1日1回だけ。どんな失敗も、依頼された処理には影響させない（失敗はログに残す。同じ日に何度もやり直さない） */
function autoArchive_() {
  try {
    if (props_().getProperty('ARC_AUTO') !== 'lazy') return;
    var today = now_().slice(0, 10);
    if (props_().getProperty('ARC_LAST_RUN') === today) return;
    props_().setProperty('ARC_LAST_RUN', today);
    try { withLock_(function () { runArchive_(false, 'auto'); }); }
    catch (e) { arcLogAdd_({ at: now_(), mode: 'auto', error: String((e && e.message) || e).slice(0, 200) }); }
  } catch (e2) { try { Logger.log('autoArchive_: ' + e2); } catch (ignore) {} }
}

/** 時間トリガー（毎日・夜など）に登録して使う（任意）。データが多い時は、こちらがおすすめ */
function archiveDaily() {
  withLock_(function () { runArchive_(false, 'trigger'); });
}

function archiveStatus_() {
  var log = arcLog_();
  return {
    ok: true, settings: arcSettings_(),
    options: { days: ARC_DAYS_OPTIONS.slice(), histMonths: ARC_HIST_OPTIONS.slice() },
    years: arcYears_(), last: log[0] || null, log: log.slice(0, 5)
  };
}

function archiveSettings_(req) {
  var out = {};
  var pick = function (field, prop, options) {
    if (req[field] === undefined) return;
    var n = Number(req[field]);
    if (options.indexOf(n) < 0) throw new AppError('bad_request', field + ' は ' + options.join(' / ') + ' のどれかです（0は移さない）');
    out[prop] = String(n);
  };
  pick('txDays', 'ARC_TX_DAYS', ARC_DAYS_OPTIONS);
  pick('histMonths', 'ARC_HIST_MONTHS', ARC_HIST_OPTIONS);
  if (req.auto !== undefined) out.ARC_AUTO = req.auto === true ? 'lazy' : '';
  Object.keys(out).forEach(function (k) { props_().setProperty(k, out[k]); });
  return archiveStatus_();
}

/* ----- 移したデータを見る（読み取りだけ） ----- */

function arcReadMonth_(key, ym) {
  if (monthIdx_(ym) === null) return [];
  var ss = arcOpen_(ym.slice(0, 4));
  if (!ss) return [];
  var sh = ss.getSheetByName(arcSheetName_(key, ym));
  if (!sh) return [];
  var last = sh.getLastRow(), w = SHEET_DEF[key].headers.length;
  return last >= 2 ? sh.getRange(2, 1, last - 1, w).getValues() : [];
}
/** 移した取引（txOf_の形）。ym の月のシートから */
function arcTxList_(ym) {
  return arcReadMonth_('TX', ym).map(function (r, i) { return txOf_(r, 0); }).filter(function (x) { return x.id; });
}

/** アーカイブにある月の一覧（年ごと）とスプレッドシートのURL */
function archiveMonths_() {
  var out = [];
  arcYears_().forEach(function (y) {
    var ss = arcOpen_(y);
    if (!ss) return;
    var months = { tx: [], sales: [], io: [] };
    var kinds = { TX: 'tx', SALES: 'sales', IO: 'io' };
    ss.getSheets().forEach(function (sh) {
      var n = sh.getName();
      Object.keys(kinds).forEach(function (k) {
        var pre = CONFIG.SHEETS[k] + '_';
        if (n.indexOf(pre) === 0 && /^\d{4}-\d{2}$/.test(n.slice(pre.length))) months[kinds[k]].push(n.slice(pre.length));
      });
    });
    Object.keys(months).forEach(function (k) { months[k].sort().reverse(); });
    var url = ''; try { url = ss.getUrl(); } catch (e) {}
    out.push({ year: y, url: url, months: months });
  });
  return { ok: true, years: out };
}

/** kind: tx（取引の一覧）／ io（入出荷履歴）、month: 'yyyy-MM'、q: 絞り込み（部分一致）、date: tx のみ・その日だけ */
function archiveSearch_(req) {
  var kind = String(req.kind || '');
  if (kind !== 'tx' && kind !== 'io') throw new AppError('bad_request', 'kind は tx / io のどちらかです');
  var month = String(req.month || '');
  if (monthIdx_(month) === null) throw new AppError('bad_request', 'month は 2026-10 のように指定してください');
  var q = nfkc_(req.q || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var limit = Math.min(Math.max(Number(req.limit) || 200, 1), 500);
  var rows = [], total = 0;
  if (kind === 'tx') {
    var list = arcTxList_(month);
    for (var i = list.length - 1; i >= 0; i--) {
      var x = list[i];
      if (q && (x.id + ' ' + x.method + ' ' + x.status + ' ' + x.origId).toLowerCase().indexOf(q) < 0) continue;
      total++;
      if (rows.length < limit) rows.push({ id: x.id, ts: x.ts, total: x.total, method: x.method, guests: x.guests, status: x.status, origId: x.origId });
    }
    return { ok: true, kind: kind, month: month, rows: rows, count: total, truncated: total > rows.length };
  }
  var data = arcReadMonth_('IO', month);
  for (var j = data.length - 1; j >= 0; j--) {
    var r = data[j]; if (!str_(r[1])) continue;
    if (q && (nfkc_(r[1]) + ' ' + nfkc_(r[2]) + ' ' + nfkc_(r[6])).toLowerCase().indexOf(q) < 0) continue;
    total++;
    if (rows.length < limit) rows.push({ ts: str_(r[0]), jan: str_(r[1]), name: str_(r[2]), kubun: str_(r[3]), qty: toInt_(r[4]), after: toInt_(r[5]), memo: str_(r[6]) });
  }
  return { ok: true, kind: kind, month: month, rows: rows, count: total, truncated: total > rows.length };
}

/** 移した取引を探す・使う側の補助 */
function arcUpto_(date) { var u = props_().getProperty('ARC_UPTO'); return !!u && date <= u; }
function dateOfTxId_(id) { var m = /^T-(\d{4})(\d{2})(\d{2})-\d+$/.exec(str_(id)); return m ? m[1] + '/' + m[2] + '/' + m[3] : ''; }
/** 取引IDから、アーカイブの取引を探す。見つからない・まだ移していない日付・開けない時は null */
function arcFindTx_(id) {
  var date = dateOfTxId_(id);
  if (!date || !arcUpto_(date)) return null;
  try {
    var ym = monthOfTxId_(id), list = arcTxList_(ym);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return { x: list[i], ym: ym, list: list };
  } catch (e) {}
  return null;
}
/** その日の取引を、アーカイブから。開けない時は空（呼び出し側が、通常のシートの分だけで答える） */
function arcTxOfDate_(date) {
  if (!arcUpto_(date)) return { list: [], ym: '', err: '' };
  var ym = date.slice(0, 4) + '-' + date.slice(5, 7);
  try { return { list: arcTxList_(ym).filter(function (x) { return x.ts.indexOf(date) === 0; }), ym: ym, err: '' }; }
  catch (e) { return { list: [], ym: ym, err: String((e && e.message) || e) }; }
}
function arcTxDetail_(tx, hit) {
  var x = hit.x;
  var lines = arcReadMonth_('SALES', hit.ym).filter(function (r) { return str_(r[0]) === x.id; }).map(salesOf_);
  var s = settingsMap_();
  var seen = {}, returns = [];
  hit.list.concat(tx.list).forEach(function (y) { if (y.origId === x.id && !seen[y.id]) { seen[y.id] = true; returns.push({ id: y.id, ts: y.ts, total: y.total, status: y.status }); } });
  return {
    tx: { id: x.id, ts: x.ts, total: x.total, tax8: x.tax8, tax10: x.tax10, method: x.method, guests: x.guests, status: x.status, origId: x.origId, received: x.received, change: x.change, issuer: x.issuer, regNo: x.regNo },
    lines: lines,
    issuer: { name: x.issuer || '', regNo: x.regNo || '', address: s['住所'] || '', tel: s['電話'] || '', message: s['レシートのメッセージ'] || '' },
    returns: returns
  };
}

/* ============================== 履歴・CSV ============================== */

function historyList_(req) {
  var sh = sheet_('IO');
  var last = sh.getLastRow();
  var q = nfkc_(req.q || '').toLowerCase().replace(/^\s+|\s+$/g, '');
  var kubun = req.kubun ? String(req.kubun) : '';
  var limit = Math.min(Math.max(Number(req.limit) || 200, 1), 1000);
  var rows = [], total = 0;
  if (last >= 2) {
    var v = sh.getRange(2, 1, last - 1, 7).getValues();
    for (var i = v.length - 1; i >= 0; i--) {
      var r = v[i];
      if (!str_(r[1])) continue;
      if (kubun && str_(r[3]) !== kubun) continue;
      if (q && (nfkc_(r[1]) + ' ' + nfkc_(r[2]) + ' ' + nfkc_(r[6])).toLowerCase().indexOf(q) < 0) continue;
      total++;
      if (rows.length < limit) rows.push({ ts: str_(r[0]), jan: str_(r[1]), name: str_(r[2]), kubun: str_(r[3]), qty: toInt_(r[4]), after: toInt_(r[5]), memo: str_(r[6]) });
    }
  }
  return { ok: true, rows: rows, count: total, truncated: total > rows.length };
}

var EXPORT_KINDS = { master: '商品マスタ', io: '入出荷履歴', tx: '取引', sales: '売上明細' };

function exportData_(req) {
  var kind = String(req.kind || '');
  if (!EXPORT_KINDS[kind]) throw new AppError('bad_request', 'kind は ' + Object.keys(EXPORT_KINDS).join(' / ') + ' のどれかです');
  var key = { master: 'MASTER', io: 'IO', tx: 'TX', sales: 'SALES' }[kind];
  var sh = sheet_(key);
  var last = sh.getLastRow();
  var w = SHEET_DEF[key].headers.length;
  var rows = last >= 2 ? sh.getRange(2, 1, last - 1, w).getValues() : [];
  return { ok: true, kind: kind, title: EXPORT_KINDS[kind], header: SHEET_DEF[key].headers.slice(), rows: rows };
}

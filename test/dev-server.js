'use strict';
// 画面の動作確認用の開発サーバー。index.html を配信し、/gas/exec で本物の Code.gs（模擬スプレッドシート上）を動かす。
// 使い方: node test/dev-server.js  →  http://localhost:8766/#gas=http%3A%2F%2Flocalhost%3A8766%2Fgas%2Fexec&token=dev-token-0123456789abcdef
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv, withCheck } = require('./gas-fake');

const env = createEnv();
const J = [['4901777300446', 'おにぎり 鮭', 150, '8%', 20], [withCheck('490123456789'), 'お茶 600ml', 162, '8%', 12], [withCheck('450000000001'), 'ノート A5', 220, '10%', 8], [withCheck('450000000002'), 'ボールペン', 110, '10%', 30]];
J.forEach((x) => env.post('masterUpsert', { jan: x[0], name: x[1], price: x[2], rate: x[3], stock: x[4] }));
console.log('seed', J.length);

// 画面確認用: 古い取引を作る（アーカイブの動作確認）。node test/dev-server.js --seed-old
if (process.argv.includes('--seed-old')) {
  const parts = (days) => { const d = new Date(Date.now() - days * 86400000); const p = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {}); return { id: `${p.year}${p.month}${p.day}`, ts: `${p.year}/${p.month}/${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}` }; };
  env.post('settingsSave', { values: { 事業者名: 'サンプル商店', 登録番号: 'T1234567890123' } });
  [[130, 'カード'], [125, '現金'], [100, '現金'], [100, '現金'], [10, '現金']].forEach(([days, method], n) => {
    const r = env.post('saleCreate', { txKey: 'seed-key-' + n + '-xxxxxxxx', method, lines: [{ jan: J[0][0], qty: 1 + (n % 2) }, { jan: J[1][0], qty: 1 }] });
    if (days < 30) return;
    const p = parts(days), nid = `T-${p.id}-${String(n + 1).padStart(4, '0')}`;
    const tx = env.sheet('取引'), sa = env.sheet('売上明細');
    tx.dump().forEach((row, i) => { if (i > 0 && row[0] === r.tx.id) tx.getRange(i + 1, 1, 1, 2).setValues([[nid, p.ts]]); });
    sa.dump().forEach((row, i) => { if (i > 0 && row[0] === r.tx.id) sa.getRange(i + 1, 1, 1, 3).setValues([[nid, row[1], p.ts]]); });
  });
  console.log('seed old tx: 4 old + 1 recent');
}

function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (u.pathname === '/gas/exec') {
    let out;
    if (req.method === 'POST') out = env.raw('POST', await readBody(req));
    else out = env.raw('GET', Object.fromEntries(u.searchParams));
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    return res.end(JSON.stringify(out));
  }
  if (u.pathname === '/__dump') {
    const o = {};
    for (const n of ['商品マスタ', '入出荷履歴', '売上明細', '取引', '設定']) { const s = env.sheet(n); o[n] = s ? s.dump() : null; }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    return res.end(JSON.stringify(o));
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, '..', 'index.html')));
  }
  res.writeHead(404); res.end('not found');
}).listen(8766, () => console.log('http://localhost:8766/'));

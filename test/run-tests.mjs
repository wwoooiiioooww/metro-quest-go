/* 地下鉄クエスト・ルーレット(配布版) 自動テスト(jsdom)
   実行: cd test && npm install && npm test

   主目的:
     (a) 家族版(metro-quest)と同一オリジンでも、互いのデータに触れないこと
     (b) 配布版として出してはいけないもの(実名・現金の初期表示)が出ないこと
     (c) TARGET の1行変更で配布先を切り替えられること
   の再発防止。差分の一覧は ../SYNC.md 参照。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const swjs = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}
function eq(a, b, name) {
  const same = Object.is(a, b);
  ok(same, name + (same ? '' : ` (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));
}

/* 起動ヘルパー。ls=起動前に仕込むlocalStorage / src=HTMLを差し替えたい場合 */
function boot(ls, src) {
  const errors = [];
  const alerts = [];
  const dom = new JSDOM(src || html, {
    url: 'https://example.com/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.confirm = () => true;
      window.alert = m => alerts.push(String(m));
      window.scrollTo = () => {}; // jsdom未実装。本物のエラーを埋もれさせないため潰す
      window.addEventListener('error', e => errors.push(e.message));
      if (ls) Object.entries(ls).forEach(([k, v]) => window.localStorage.setItem(k, v));
    },
  });
  return { dom, w: dom.window, errors, alerts };
}

/* ---------- 1. 起動 ---------- */
console.log('\n[1] 起動');
{
  const { w, errors } = boot();
  ok(w.eval('store') !== null, '起動して store が初期化される');
  eq(w.eval('totalMoney'), 0, '合計は0から始まる');
  eq(w.localStorage.getItem('mqgo_v1'), null, '起動しただけでは書き込まない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 2. 家族版のデータを取り込まない(最重要) ---------- */
console.log('\n[2] 家族版との分離');
{
  /* GitHub Pagesでは metro-quest と metro-quest-go が同一オリジン。
     家族版のデータ(mq_v1)と、v4時代の旧キーが両方残っている状況を再現する。 */
  const family = {
    mq_v1: JSON.stringify({ totalMoney: 8000, pin: '1234', history: [{ station: '家族版の記録' }], excluded: ['浅草'], settings: null, spinsLeft: 2 }),
    questSettings: '{"lines":["A"],"targets":[],"money":[],"missions":["旧指令"]}',
    questHistory: '[{"station":"旧データ"}]',
    totalMoney: '9999',
    parentPin: '4321',
    spinsLeft: '1',
    excludedStations: '["銀座"]',
  };
  const { w, errors } = boot(family);

  eq(w.eval('totalMoney'), 0, '家族版のmq_v1を読み込まない');
  eq(w.eval('history.length'), 0, 'v4旧キーの記録を取り込まない');
  eq(w.eval('getPin()'), '1234', 'PINは既定値(旧キーのPINを拾わない)');
  eq(w.eval('excludedStations.length'), 0, '旧キーの除外駅を取り込まない');
  ok(w.eval('typeof migrateLegacy') === 'undefined', 'migrateLegacy を持たない(SYNC.md #4)');

  /* 一通り操作しても家族版を壊さない */
  w.eval('addExclude("渋谷")');
  w.document.getElementById('new-pin').value = '5555';
  w.eval('changePin()');
  eq(JSON.parse(w.localStorage.getItem('mq_v1')).totalMoney, 8000, '家族版のmq_v1を書き換えない');
  eq(w.localStorage.getItem('questHistory'), '[{"station":"旧データ"}]', '旧キーにも書き戻さない');
  eq(w.localStorage.getItem('parentPin'), '4321', '旧PINキーを書き換えない');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).pin, '5555', '自分のPINは mqgo_v1 に入る');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, errors } = boot({ studykichi_v1: '{"s":1}', 'hk.state.v1': '{"s":2}' });
  w.eval('addExclude("上野")');
  const keys = Object.keys(w.localStorage).filter(k => k.length);
  const mine = keys.filter(k => k.startsWith('mqgo_'));
  const others = keys.filter(k => !k.startsWith('mqgo_'));
  eq(mine.length, 1, '自分が作るキーは mqgo_ の1つだけ');
  ok(!others.some(k => k.startsWith('mq_') && !k.startsWith('mqgo_')), '家族版のキーを作らない');
  eq(w.localStorage.getItem('studykichi_v1'), '{"s":1}', '姉妹アプリのキーを壊さない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 3. 配布ターゲット(TARGET) ---------- */
console.log('\n[3] 配布ターゲットの切り替え');
{
  const { w, errors } = boot();
  const lines = w.eval('settings.lines');
  const cos = [...new Set(lines.map(l => w.eval(`LINES["${l}"].co`)))];
  eq(cos.length, 1, '初期ONの事業者は1社だけ');
  eq(cos[0], 'metro', '初期ONは東京メトロ');
  ok(lines.length >= 9, '東京メトロの路線が9線以上ONになっている');
  ok(w.eval('Object.keys(LINES).length') > lines.length, 'strict:false なので他社もマスタに残っている');
  ok(w.eval('!!COMPANIES.toei'), '都営もマスタに残る(設定画面から選べる)');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* companies を1行変えるだけで都営版になること */
  const toei = html.replace(
    "const TARGET = { companies: ['metro'], strict: false };",
    "const TARGET = { companies: ['toei'], strict: false };");
  ok(toei !== html, 'TARGET行を置換できる(書式が変わっていない)');
  const { w, errors } = boot(null, toei);
  const cos = [...new Set(w.eval('settings.lines').map(l => w.eval(`LINES["${l}"].co`)))];
  eq(cos.join(), 'toei', 'companies:["toei"] で都営版になる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* strict:true で他社がマスタごと消えること */
  const strict = html.replace(
    "const TARGET = { companies: ['metro'], strict: false };",
    "const TARGET = { companies: ['metro'], strict: true };");
  const { w, errors } = boot(null, strict);
  const cos = [...new Set(Object.keys(w.eval('LINES')).map(l => w.eval(`LINES["${l}"].co`)))];
  eq(cos.join(), 'metro', 'strict:true で他社が LINES から消える');
  ok(!w.eval('!!COMPANIES.toei'), 'strict:true で COMPANIES からも消える');
  ok(w.eval('Object.keys(STATIONS).length') > 0, 'strict:true でも駅マスタが生成される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 4. ごほうびモード ---------- */
console.log('\n[4] ごほうび(スタンプ / おこづかい)');
{
  const { w, errors } = boot();
  eq(w.eval('rewardMode()'), 'stamp', '初期状態はスタンプモード');
  const total = w.document.getElementById('total-money').innerText;
  ok(!total.includes('円'), `初期表示に「円」が出ない (${total})`);
  ok(total.includes('こ'), '初期表示は「こ」');
  eq(w.document.getElementById('reel-label-2').innerText, 'スタンプ', 'リールのラベルが「スタンプ」');
  ok(w.eval('rewardTable()').every(r => !r.label.includes('円')), 'スタンプの抽選表に金額が入っていない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, errors } = boot();
  w.eval('setRewardMode("money")');
  eq(w.eval('rewardMode()'), 'money', 'おこづかいモードに切り替わる');
  ok(w.document.getElementById('total-money').innerText.includes('円'), '切替後は「円」表示');
  eq(w.document.getElementById('reel-label-2').innerText, '金額', 'リールのラベルが「金額」');
  /* 切り戻しても両方の表が残る */
  w.eval('setRewardMode("stamp")');
  ok(w.eval('settings.money.length') > 0 && w.eval('settings.stamps.length') > 0, '切り替えても双方の表が保持される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 加算がラベルの書式に依存しないこと */
  const { w } = boot();
  eq(w.eval('rewardValue("⭐10こ")'), 10, 'rewardValue: ⭐10こ → 10');
  eq(w.eval('rewardValue("500円")'), 500, 'rewardValue: 500円 → 500');
  eq(w.eval('rewardValue("なし")'), 0, 'rewardValue: 数字なし → 0');
  w.eval('currentResult = {station:"上野", mission:"テスト", money:"⭐3こ", target:"みんな"}');
  w.eval('clearMission()');
  eq(w.eval('totalMoney'), 3, 'スタンプが合計に加算される');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).totalMoney, 3, '加算が保存される');
  w.close();
}

/* ---------- 5. 「はじめる前に」パネル ---------- */
console.log('\n[5] 注意事項パネル');
{
  const { w, errors } = boot();
  eq(w.document.getElementById('notice').style.display, 'block', '初回起動で自動表示される');
  const t = w.document.getElementById('notice').textContent;
  ok(t.includes('非公式'), '非公式である旨が書かれている');
  ok(t.includes('保護者'), '保護者同伴の注意が書かれている');
  ok(t.includes('免責'), '免責が書かれている');
  w.eval('closeNotice()');
  eq(w.document.getElementById('notice').style.display, 'none', '「よみました」で閉じる');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).noticeSeen, true, '既読が保存される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const seen = { settings:null, spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w } = boot({ mqgo_v1: JSON.stringify(seen) });
  eq(w.document.getElementById('notice').style.display, '', '2回目以降は自動表示されない');
  w.eval('openNotice()');
  eq(w.document.getElementById('notice').style.display, 'block', 'ボタンからいつでも開ける');
  w.close();
}

/* ---------- 6. 保存の往復 ---------- */
console.log('\n[6] 保存の往復');
{
  const { w } = boot();
  w.eval('addExclude("五反田")');
  const saved = JSON.parse(w.localStorage.getItem('mqgo_v1'));
  ok(saved.excluded.includes('五反田'), '除外駅が保存される');
  w.close();

  const { w: w2, errors } = boot({ mqgo_v1: JSON.stringify(saved) });
  ok(w2.eval('excludedStations').includes('五反田'), '再起動後も復元される');
  eq(errors.length, 0, 'runtime errors: none');
  w2.close();
}
{
  const { w } = boot({ mqgo_v1: JSON.stringify({ excluded: ['浅草', '銀座'], history: [], totalMoney: 0, settings: null, spinsLeft: null, pin: null, noticeSeen: true }) });
  w.eval('resetExcluded()');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).excluded.length, 0, '全解除が保存に反映される');
  w.close();
}
{
  /* 項目が増えたときに古い保存が壊れないこと(loadSettingsの補完) */
  const old = { settings: { lines: ['G'], areas: ['tokyo23'], spinsPerDay: 5, targets: [{ label: 'A', w: 1 }], missions: ['m'] }, spinsLeft: null, excluded: [], history: [], totalMoney: 0, pin: null, noticeSeen: true };
  const { w, errors } = boot({ mqgo_v1: JSON.stringify(old) });
  ok(Array.isArray(w.eval('settings.stamps')), '古い保存に無い stamps がデフォルトで補われる');
  eq(w.eval('rewardMode()'), 'stamp', '古い保存に無い rewardMode も補われる');
  eq(w.eval('settings.spinsPerDay'), 5, 'ユーザーが編集済みの項目は上書きされない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 7. 配布物としての衛生 ---------- */
console.log('\n[7] 配布物としての衛生');
{
  ok(!/空花|風花|元気兄弟/.test(html), 'index.html に家族の実名が含まれない');
  ok(!/🎰/.test(html), '遊技機の絵文字(🎰)を使っていない');
  ok(!/スロット/.test(html), '「スロット」という語を使っていない');
  ok(!/fetch\s*\(|XMLHttpRequest|googleapis|cdn\./.test(html), '外部通信のコードが無い');
  ok(!/https?:\/\//.test(html), '外部URLの参照が無い');
  ok(!/navigator\.geolocation|getUserMedia|new Notification/.test(html), '位置情報・カメラ・通知を使っていない');

  const { w } = boot();
  const targets = w.eval('settings.targets').map(t => t.label).join();
  ok(!/そら|ふう|パパ|ママ/.test(targets), `対象者の初期値が一般名 (${targets})`);
  w.close();
}

/* ---------- 8. バージョンとキャッシュキー ---------- */
console.log('\n[8] バージョンとキャッシュキー');
{
  const vApp = (html.match(/APP_VER\s*=\s*'v(\d+)'/) || [])[1];
  const vSw = (swjs.match(/CACHE_NAME\s*=\s*'metro-quest-go-v(\d+)'/) || [])[1];
  ok(vApp !== undefined, 'index.html に APP_VER がある');
  ok(vSw !== undefined, 'sw.js の CACHE_NAME が metro-quest-go- 接頭辞');
  eq(vApp, vSw, `APP_VER(v${vApp}) と CACHE_NAME(v${vSw}) が一致する`);
  ok(!/'metro-quest-v/.test(swjs), '家族版のキャッシュ名を使っていない');

  const { w } = boot();
  eq(w.document.getElementById('app-ver').textContent, '地下鉄クエスト v' + vApp, '画面にバージョンが表示される');
  w.close();
}

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(46)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed) { console.log('\n  失敗:'); fails.forEach(f => console.log('   - ' + f)); }
console.log(`${'='.repeat(46)}\n`);
process.exit(failed ? 1 : 0);

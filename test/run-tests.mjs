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
const sleep = ms => new Promise(r => setTimeout(r, ms));
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
      // jsdomはcanvasに未対応。null を返させて「描画できない環境」を再現する
      window.HTMLCanvasElement.prototype.getContext = () => null;
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
  w.document.getElementById('parent-code').value = '5555';
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

/* ---------- 4b. 今日 / 累計 / 冒険日数 ---------- */
console.log('\n[4b] 今日の分と累計');
{
  const d = new Date();
  const T = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const st = {
    settings:null, spinsLeft:null, excluded:[], pin:null, noticeSeen:true, totalMoney: 40,
    history: [
      { station:'上野', money:'★★★',  date:T,            mode:'stamp' },
      { station:'銀座', money:'★★',    date:T,            mode:'stamp' },
      { station:'浅草', money:'★★★★', date:'2020-01-01', mode:'stamp' },
      { station:'新橋', money:'300円',  date:T,            mode:'money' }, // 別モードの記録
    ],
  };
  const { w, errors } = boot({ mqgo_v1: JSON.stringify(st) });
  const total = w.document.getElementById('total-money').innerText;
  const rank  = w.document.getElementById('rank').textContent;

  ok(total.includes('今日:5こ'), `今日は同じモードの今日の記録だけ (${total})`);
  ok(!total.includes('305'), 'モードの違う記録(円)を足し込まない');
  ok(total.includes('累計:40こ'), '累計は保持される');
  ok(rank.includes('クリア4回'), `累計回数は全件 (${rank})`);
  ok(rank.includes('ぼうけん2日'), `冒険日数が出る (${rank})`);
  eq(w.eval('history.length'), 4, '古い記録が自動で消えない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w } = boot();
  w.eval('currentResult = {station:"上野", mission:"テスト", money:"★★★", target:"みんな"}');
  w.eval('clearMission()');
  const h = JSON.parse(w.localStorage.getItem('mqgo_v1')).history[0];
  ok(/^\d{4}-\d{2}-\d{2}$/.test(h.date), `新しい記録に日付が入る (${h.date})`);
  eq(h.mode, 'stamp', '新しい記録にモードが入る');
  ok(w.document.getElementById('total-money').innerText.includes('今日:3こ'), '今日の合計に即反映');
  w.close();
}

/* ---------- 4c. おこづかいモードのフラグ ---------- */
console.log('\n[4c] ALLOW_MONEY_MODE');
{
  const { w } = boot();
  eq(w.eval('ALLOW_MONEY_MODE'), true, '既定では有効');
  eq(w.document.getElementById('reward-switch').style.display, 'block', '切替ボタンが見えている');
  w.close();
}
{
  /* 1行 false にするだけで、切替がUIごと消えること */
  const off = html.replace('const ALLOW_MONEY_MODE = true;', 'const ALLOW_MONEY_MODE = false;');
  ok(off !== html, 'ALLOW_MONEY_MODE行を置換できる');
  const { w, errors } = boot(null, off);
  eq(w.document.getElementById('reward-switch').style.display, 'none', 'false で切替ボタンが消える');
  w.eval('setRewardMode("money")');
  eq(w.eval('rewardMode()'), 'stamp', 'false ならおこづかいに切り替わらない');
  ok(!w.document.getElementById('total-money').innerText.includes('円'), 'false なら円が一切出ない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 4d. 音と入力欄 ---------- */
console.log('\n[4d] 音と入力欄');
{
  const { w, errors } = boot();
  eq(w.eval('typeof unlockAudio'), 'function', 'unlockAudio がある');
  eq(w.eval('(function(){try{beep(440,0.1);return "ok"}catch(e){return e.message}})()'), 'ok',
     'AudioContext非対応環境でも beep が例外を投げない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
  ok(/autocomplete="off"/.test(html.match(/<input[^>]*id="parent-code"[^>]*>/s)[0]),
     'PIN入力に autocomplete="off" がある');
}

/* ---------- 5. 「はじめる前に」パネル ---------- */
console.log('\n[5] 注意事項パネル');
{
  const { w, errors } = boot();
  ok(w.document.getElementById('notice').style.display !== 'block', '起動演出の最中は注意書きを出さない');
  w.eval('hideSplash()');
  eq(w.document.getElementById('notice').style.display, 'block', '起動演出のあとに自動表示される');
  const t = w.document.getElementById('notice').textContent;
  ok(t.includes('非公式'), '非公式である旨が書かれている');
  ok(t.includes('保護者'), '保護者同伴の注意が書かれている');
  ok(t.includes('免責'), '免責が書かれている');

  /* スクロールしないと見えない問題の再発防止: 全画面オーバーレイであること */
  const css = html.match(/#notice \{[^}]*\}/s)[0];
  ok(/position:fixed/.test(css), '#notice が position:fixed(全画面オーバーレイ)');
  ok(/inset:0/.test(css), '#notice が画面全体を覆う');
  ok(/z-index:\s*(\d{3,})/.test(css), '#notice が最前面に出る');
  ok(w.document.querySelector('#notice details'), '「くわしく」が折りたたみになっている');
  ok(w.document.querySelector('#notice .big'), '要点が大きい文字で書かれている');

  w.eval('closeNotice()');
  eq(w.document.getElementById('notice').style.display, 'none', '「よみました」で閉じる');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).noticeSeen, true, '既読が保存される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 設定からいつでも読み返せる */
  const seen = { settings:null, spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w } = boot({ mqgo_v1: JSON.stringify(seen) });
  eq(w.eval('typeof openNoticeFromSettings'), 'function', '設定から開く関数がある');
  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  w.eval('openNoticeFromSettings()');
  eq(w.document.getElementById('notice').style.display, 'block', '設定から読み返せる');
  /* 注意書きは全画面オーバーレイなので、背後の設定タブは開いたままでよい。
     とじたら元の設定タブに戻ること */
  w.eval('closeNotice()');
  ok(w.document.getElementById('tab-set').classList.contains('on'), 'とじると元の設定タブに戻る');
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


/* ---------- 10. 称号 ---------- */
console.log('\n[10] 称号');
{
  const { w, errors } = boot();
  const R = w.eval('RANKS');
  eq(R.length, 5, '称号は5段階');
  eq(w.eval('getRank(0)'),   R[0].label, 'クリア0回はスタートの称号');
  eq(w.eval('getRank(4)'),   R[1].label, 'クリア4回は2番目');
  eq(w.eval('getRank(5)'),   R[2].label, 'クリア5回で3番目に上がる');
  eq(w.eval('getRank(999)'), R[4].label, 'しきい値を大きく超えても最高位');
  eq(w.eval('nextRank(4).n'), 5, '次の称号のしきい値がわかる');
  eq(w.eval('nextRank(15)'), null, '最高位なら次はない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* クリア6回 = 3番目の称号が現在地 */
  const st = { settings:null, spinsLeft:null, excluded:[], pin:null, totalMoney:0, noticeSeen:true,
    history: Array.from({ length: 6 }, () => ({ station:'x', money:'1', date:'2020-01-01' })) };
  const { w, errors } = boot({ mqgo_v1: JSON.stringify(st) });
  w.eval('openRanks()');
  eq(w.document.getElementById('ranks').style.display, 'block', '称号一覧が開く');
  eq(w.document.querySelectorAll('#ranks-list .rank-row').length, 5, '全5段階が並ぶ');
  eq(w.document.querySelectorAll('#ranks-list .rank-row.now').length, 1, '現在地が1つだけ強調される');
  ok(w.document.querySelector('#ranks-list .rank-row.now').textContent.includes('いっちょまえ'),
     'クリア6回なら3番目が現在地');
  ok(w.document.getElementById('ranks-next').innerText.includes('あと 4回'),
     `次の称号まであと何回か出る (${w.document.getElementById('ranks-next').innerText})`);
  w.eval('closeRanks()');
  eq(w.document.getElementById('ranks').style.display, 'none', 'とじられる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w } = boot();
  const rank = w.document.getElementById('rank');
  ok(rank.innerHTML.includes('openRanks'), 'ヘッダーから称号一覧を開ける');
  ok(rank.textContent.trim().startsWith('🥚'), `称号が先頭に来る (${rank.textContent})`);
  ok(rank.textContent.includes('クリア0回'), 'クリア回数が併記される');
  w.close();
}

/* ---------- 11. 重みと実際の割合 ---------- */
console.log('\n[11] 重みの割合表示');
{
  const { w, errors } = boot();
  w.eval('settings.targets = [{label:"A",w:40},{label:"B",w:40},{label:"C",w:20}]');
  w.eval('renderWeightEditor("target-editor", settings.targets)');
  eq(w.document.getElementById('target-editor-pct-0').textContent, '40%', '合計100なら 40 は 40%');

  /* 「合計が100を超えると効かない」という誤解の再発防止。
     実際は合計に対する割合として正しく効く */
  w.eval('editItem("target-editor",0,"w",80)');
  eq(w.document.getElementById('target-editor-pct-0').textContent, '57.1%', '80/140 → 57.1%(頭打ちにならない)');
  eq(w.document.getElementById('target-editor-pct-1').textContent, '28.6%', '他の項目の割合は下がる');
  ok(w.document.getElementById('target-editor-total').textContent.includes('140'), '重みの合計が表示される');

  /* 抽選そのものも合計に追従しているか(100超で偏ること) */
  w.eval('settings.targets = [{label:"A",w:1000},{label:"B",w:1}]');
  let a = 0;
  for (let i = 0; i < 200; i++) if (w.eval('weightedPick(settings.targets)') === 'A') a++;
  ok(a > 180, `重み1000対1なら大きく偏る (Aが200回中${a}回)`);
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, errors } = boot();
  w.eval('settings.targets = [{label:"A",w:0},{label:"B",w:0}]');
  w.eval('renderWeightEditor("target-editor", settings.targets)');
  eq(w.document.getElementById('target-editor-pct-0').textContent, '—', '重みが全部0なら % を出さない');
  ok(w.document.getElementById('target-editor-total').textContent.includes('0です'), '全部0のときは注意を出す');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* ラベルに引用符やタグが入っても編集欄が壊れない */
  const { w, errors } = boot();
  const weird = 'あ"い<b>&';
  w.eval('settings.targets = [{label:' + JSON.stringify(weird) + ',w:10}]');
  w.eval('renderWeightEditor("target-editor", settings.targets)');
  const inp = w.document.querySelector('#target-editor input[type=text]');
  eq(inp.value, weird, 'ラベルの引用符・タグでエディタが壊れない(esc)');
  eq(w.document.querySelectorAll('#target-editor .edit-row').length, 1, '余計な要素が生えない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 12. 表示文言とタイトル ---------- */
console.log('\n[12] 文言とタイトル');
{
  ok(!/ぜんぶ:/.test(html), '「ぜんぶ」表記が残っていない');
  const { w } = boot();
  const total = w.document.getElementById('total-money').innerText;
  ok(total.includes('累計:'), `「累計」表記になっている (${total})`);
  ok(total.includes('今日:'), '「今日」も併記される');
  w.close();

  const h1css = html.match(/h1 \{[^}]*\}/s)[0];
  ok(/white-space:nowrap/.test(h1css), 'タイトルが折り返さない');
  ok(/clamp\(/.test(h1css), '狭い画面でタイトルが縮む');
  const title = html.match(/<h1[^>]*>([^<]*)<\/h1>/)[1];
  ok([...title].length <= 14, `タイトルが十分短い (${title} = ${[...title].length}文字)`);
}

/* ---------- 13. 自動入力バーの抑止(第1段階) ---------- */
console.log('\n[13] 自動入力バーの抑止');
{
  ok(!/id="new-pin"/.test(html), 'idから "pin" を外した(パスワードマネージャ対策)');
  const forms = html.match(/<form[^>]*>/g) || [];
  ok(forms.length >= 1, '残った入力欄は form で包まれている');
  ok(forms.every(f => /autocomplete="off"/.test(f)), 'form に autocomplete="off" がある');
  /* 自動入力バー(鍵/カード/住所)はOS側が <input> に対して出すため、
     属性では抑止しきれなかった。駅名の自由入力欄そのものを廃止した */
  ok(!/pre-exclude-input/.test(html), '駅名の自由入力欄を廃止した');
  ok(!/<datalist/.test(html), '駅名のdatalistも残っていない');
  ok(!/function preExclude/.test(html), '未使用になった preExclude() が残っていない');
  const pc = html.match(/<input[^>]*id="parent-code"[^>]*>/s)[0];
  ok(/name="mq-/.test(pc), 'あいことば入力の name も同様');

  /* 参照の付け替え漏れがないこと */
  const { w, errors } = boot();
  w.document.getElementById('parent-code').value = '7777';
  w.eval('changePin()');
  eq(w.eval('getPin()'), '7777', 'あいことばの変更が動く(id変更の追従漏れなし)');
  eq(w.document.getElementById('parent-code').value, '', '入力欄がクリアされる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 14. GO: ⭐表記 ---------- */
console.log('\n[14] ⭐表記');
{
  const { w, errors } = boot();
  const tbl = w.eval('settings.stamps');
  eq(tbl.length, 5, 'スタンプは5段階');
  ok(tbl.every(r => /^⭐+$/.test(r.label)), '全部⭐の並びになっている');
  eq(tbl[4].label, '⭐⭐⭐⭐⭐', '最大は⭐5つ');
  eq(w.eval('rewardValue("⭐⭐⭐")'), 3, '⭐の数を値として数える');
  eq(w.eval('rewardValue("★★")'), 2, '★(記号)でも数えられる(後方互換)');
  ok(!/★/.test(html.match(/stamps: \[[^\]]*\]/s)[0]), '抽選表に★(記号)が残っていない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}


/* ---------- 15. 未編集の★テーブルを⭐へ移行 ---------- */
console.log('\n[15] ★ → ⭐ の移行');
{
  /* v2で保存された「記号の★」の表。手を入れていないので⭐に差し替わる */
  const v2 = [
    {label:"★", w:30},{label:"★★", w:26},{label:"★★★", w:22},
    {label:"★★★★", w:14},{label:"★★★★★", w:8}
  ];
  const st = { settings:{ lines:['G'], areas:['tokyo23'], spinsPerDay:20,
                          targets:[{label:'A',w:1}], missions:['m'], stamps:v2, rewardMode:'stamp' },
               spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w, errors } = boot({ mqgo_v1: JSON.stringify(st) });
  const cur = w.eval('settings.stamps');
  ok(cur.every(r => /^⭐+$/.test(r.label)), `未編集の★表は⭐に差し替わる (${cur.map(r=>r.label).join()})`);
  eq(cur.length, 5, '段階数は変わらない');
  eq(cur[0].w, 30, '重みは引き継がれる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 保護者が書きかえた表は触らない(review-core: カスタマイズ済みは上書きしない) */
  const edited = [
    {label:"★", w:50},{label:"★★", w:26},{label:"★★★", w:22},
    {label:"★★★★", w:14},{label:"★★★★★", w:8}
  ];
  const st = { settings:{ lines:['G'], areas:['tokyo23'], spinsPerDay:20,
                          targets:[{label:'A',w:1}], missions:['m'], stamps:edited, rewardMode:'stamp' },
               spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w } = boot({ mqgo_v1: JSON.stringify(st) });
  eq(w.eval('settings.stamps')[0].label, '★', '重みを変えてあれば書き換えない');
  eq(w.eval('settings.stamps')[0].w, 50, '編集内容が保持される');
  w.close();
}
{
  const custom = [{label:"にく1こ", w:10},{label:"にく2こ", w:5}];
  const st = { settings:{ lines:['G'], areas:['tokyo23'], spinsPerDay:20,
                          targets:[{label:'A',w:1}], missions:['m'], stamps:custom, rewardMode:'stamp' },
               spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w } = boot({ mqgo_v1: JSON.stringify(st) });
  eq(w.eval('settings.stamps').length, 2, '自作の表は件数ごと保持される');
  eq(w.eval('settings.stamps')[0].label, 'にく1こ', '自作のラベルも保持される');
  w.close();
}


/* ---------- 16. 画面下タブ ---------- */
console.log('\n[16] 画面下タブ');
{
  const { w, errors } = boot();
  ok(w.document.getElementById('tabbar'), 'タブバーがある');
  eq(w.document.querySelectorAll('#tabbar button').length, 3, 'タブは3つ');
  ok(w.document.getElementById('tab-play').classList.contains('on'), '起動時は「あそぶ」タブ');
  w.eval('switchTab("log")');
  ok(w.document.getElementById('tab-log').classList.contains('on'), 'きろくタブに切り替わる');
  eq(w.document.querySelectorAll('.tab-pane.on').length, 1, '同時に開くのは1つだけ');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w } = boot();
  w.prompt = () => '9999';
  w.eval('switchTab("set")');
  ok(!w.document.getElementById('tab-set').classList.contains('on'), '違うあいことばでは開かない');
  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  ok(w.document.getElementById('tab-set').classList.contains('on'), '正しいあいことばで開く');
  w.close();
}
{
  /* 注意書きはタブ構成でも設定から開ける */
  const seen = { settings:null, spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w } = boot({ mqgo_v1: JSON.stringify(seen) });
  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  w.eval('openNoticeFromSettings()');
  eq(w.document.getElementById('notice').style.display, 'block', '設定から注意書きを開ける');
  w.close();
}

/* ---------- 17. 指令リストの行編集 ---------- */
console.log('\n[17] 指令リストの行編集');
{
  const { w, errors } = boot();
  w.eval('renderMissionEditor()');
  const rows = w.document.querySelectorAll('#mission-editor .edit-row');
  eq(rows.length, w.eval('DEFAULT_MISSIONS.length'), `初期指令がすべて出る (${rows.length}件)`);
  ok(!/<textarea id="mission-editor"/.test(html), 'テキストエリアではなくなっている');

  w.eval('editMission(0, "テスト指令にへんこう")');
  eq(w.eval('settings.missions[0]'), 'テスト指令にへんこう', '1行だけ書きかえられる');

  const before = w.eval('settings.missions.length');
  w.eval('addMissionRow()');
  eq(w.eval('settings.missions[0]'), 'あたらしい指令', '追加した指令は先頭に入る');
  w.eval('delMission(0)');
  eq(w.eval('settings.missions.length'), before, '指令を削除できる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w, alerts } = boot();
  w.eval('settings.missions = ["ひとつだけ"]');
  w.eval('renderMissionEditor()');
  w.eval('delMission(0)');
  eq(w.eval('settings.missions.length'), 1, '最後の1件は削除できない');
  ok(alerts.some(a => a.includes('最低1つ')), '理由が伝わる');
  w.close();
}
{
  const { w } = boot();
  w.eval('settings.missions = ["のこす", "   ", ""]');
  w.eval('saveSettings()');
  eq(w.eval('settings.missions.length'), 1, '空白だけの指令は保存時に落ちる');
  w.close();
}
{
  const { w } = boot();
  w.eval('settings.missions = [' + JSON.stringify('"あぶない"<b>指令') + ']');
  w.eval('renderMissionEditor()');
  eq(w.document.querySelector('#mission-editor input').value, '"あぶない"<b>指令', '引用符やタグでも壊れない');
  w.close();
}


/* ---------- 18. 保護者モードのロック ---------- */
console.log('\n[18] 保護者モードのロック');
{
  const { w, alerts, errors } = boot();
  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  eq(w.eval('parentAuthed'), true, 'あいことばを通すと認証済みになる');

  w.eval('lockParent()');
  eq(w.eval('parentAuthed'), false, 'ロックで認証が外れる');
  ok(w.document.getElementById('tab-play').classList.contains('on'), 'ロックすると「あそぶ」タブへ戻る');
  ok(alerts.some(a => a.includes('ロック')), 'ロックしたことがユーザーに伝わる');

  /* 子どもが設定を開こうとしても、あいことばを聞かれる */
  let asked = 0;
  w.prompt = () => { asked++; return null; };
  w.eval('switchTab("set")');
  eq(asked, 1, 'ロック後はあいことばを聞かれる');
  ok(!w.document.getElementById('tab-set').classList.contains('on'), 'あいことばなしでは開けない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 端末を渡したまま放置される事故を防ぐ自動ロック */
  const { w, errors } = boot();
  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  eq(w.eval('parentAuthed'), true, '認証済みの状態をつくる');
  Object.defineProperty(w.document, 'visibilityState', { value: 'hidden', configurable: true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  eq(w.eval('parentAuthed'), false, 'アプリが背面に回ると自動でロックされる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  ok(/id="lock-btn"/.test(html), 'ロックボタンが設置されている');
  ok(/lockParent\(\)/.test(html), 'ロックボタンから lockParent が呼ばれる');
}


/* ---------- 19. 運転台の状態機械 ---------- */
console.log('\n[19] 運転台');
{
  const { w, errors } = boot();
  const root = () => w.document.documentElement.style;
  eq(w.eval('cabState'), 'stopped', '起動時は停車');
  eq(root().getPropertyValue('--spd'), '0s', '停車中は車窓が止まっている');
  eq(root().getPropertyValue('--kmh'), '0', '速度計は0');
  eq(w.document.getElementById('speedo-num').textContent, '0', '速度計の数字も0');

  w.eval('setCab("cruise")');
  eq(w.eval('cabState'), 'cruise', '巡航に移れる');
  ok(root().getPropertyValue('--spd') !== '0s', '巡航中は車窓が流れる');
  eq(root().getPropertyValue('--kmh'), '78', '巡航の速度計');
  ok(w.document.getElementById('cab-view').className.split(' ').includes('cruise'), '車窓に状態クラスが付く');
  ok(/sc-/.test(w.document.getElementById('cab-view').className), '状態クラスと景色クラスが併記される');

  w.eval('setCab("arriving")');
  eq(root().getPropertyValue('--kmh'), '12', '到着時は減速している');
  w.eval('setCab("stopped")');
  eq(root().getPropertyValue('--spd'), '0s', '停車で車窓が止まる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 発車 → ブレーキ4回 → 停車。状態遷移が閉じていること */
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('startAll()');
  ok(['accel','cruise'].includes(w.eval('cabState')), `発車で加速する (${w.eval('cabState')})`);
  eq(w.eval('runningCount()'), 4, '4つとも回っている');

  w.eval('stopReel(0)');
  eq(w.eval('cabState'), 'braking', '1本目のブレーキで減速に入る');
  eq(w.eval('runningCount()'), 3, '残り3つ');
  const k3 = +w.document.documentElement.style.getPropertyValue('--kmh');
  w.eval('stopReel(1)');
  const k2 = +w.document.documentElement.style.getPropertyValue('--kmh');
  ok(k2 < k3, `ブレーキごとに速度が落ちる (${k3} → ${k2})`);

  w.eval('stopReel(2)');
  w.eval('stopReel(3)');
  eq(w.eval('runningCount()'), 0, '全部止まった');
  eq(w.eval('cabState'), 'arriving', '全部止まると到着状態');
  ok(w.document.getElementById('dest-panel').classList.contains('fixed'), '行き先パネルが確定表示になる');
  ok(w.document.getElementById('reel-0').textContent.length > 0, '車窓に行き先が出ている');
  ok(w.document.getElementById('dest-lines').children.length > 0, '路線カラーバッジが出る');

  await sleep(900);
  eq(w.eval('cabState'), 'stopped', '0.8秒後に停車へ戻る(遷移が閉じている)');
  eq(w.document.documentElement.style.getPropertyValue('--spd'), '0s', '停車で車窓が止まる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 20. 演出OFF ---------- */
console.log('\n[20] 演出OFF');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('setMotion(false)');
  eq(w.eval('motionOn()'), false, '設定でOFFにできる');
  ok(w.document.body.classList.contains('no-motion'), 'body に no-motion が付く');

  /* OFFでも全機能が使えること */
  w.eval('startAll()');
  eq(w.document.documentElement.style.getPropertyValue('--spd'), '0s', 'OFFなら車窓は動かない');
  eq(w.eval('runningCount()'), 4, 'OFFでも発車できる');
  for (let i = 0; i < 4; i++) w.eval('stopReel(' + i + ')');
  eq(w.eval('runningCount()'), 0, 'OFFでも止められる');
  ok(w.eval('currentResult.station').length > 0, 'OFFでも行き先が決まる');
  eq(w.document.documentElement.style.getPropertyValue('--spd'), '0s', 'OFFなら到着時も動かない');

  w.eval('clearMission()');
  eq(w.eval('history.length'), 1, 'OFFでも記録できる');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).history.length, 1, 'OFFでも保存できる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* OSの「視差効果を減らす」は設定より優先される */
  const { w, errors } = boot();
  w.matchMedia = () => ({ matches: true, media: '', addListener(){}, removeListener(){} });
  w.eval('settings.motion = true');
  eq(w.eval('motionOn()'), false, 'prefers-reduced-motion なら設定に関係なくOFF');
  w.eval('setCab("cruise")');
  eq(w.document.documentElement.style.getPropertyValue('--spd'), '0s', 'その場合は車窓も動かない');
  eq(w.document.documentElement.style.getPropertyValue('--kmh'), '78', '速度計の数値は情報なので出す');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 設定に無い古い保存でも既定ON */
  const st = { settings:{ lines:['G'], areas:['tokyo23'], spinsPerDay:20,
                          targets:[{label:'A',w:1}], missions:['m'] },
               spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w } = boot({ mqgo_v1: JSON.stringify(st) });
  eq(w.eval('settings.motion'), true, '古い保存には motion がデフォルトで補われる');
  w.close();
}

/* ---------- 21. 起動演出 ---------- */
console.log('\n[21] 起動演出');
{
  const { w, errors } = boot();
  ok(w.document.getElementById('splash'), 'スプラッシュがある');
  ok(!w.document.getElementById('splash').classList.contains('off'), '起動直後は表示されている');
  await sleep(1500);
  ok(w.document.getElementById('splash').classList.contains('off'), '1.2秒で消える');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  const { w } = boot();
  w.eval('hideSplash()');
  ok(w.document.getElementById('splash').classList.contains('off'), 'タップで即スキップできる');
  w.close();
}
{
  /* 演出OFFのときはスプラッシュを待たない */
  const off = { settings:{ lines:['G'], areas:['tokyo23'], spinsPerDay:20,
                           targets:[{label:'A',w:1}], missions:['m'], motion:false },
                spinsLeft:null, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:false };
  const { w } = boot({ mqgo_v1: JSON.stringify(off) });
  ok(w.document.getElementById('splash').classList.contains('off'), '演出OFFなら起動演出を出さない');
  eq(w.document.getElementById('notice').style.display, 'block', 'その場合も注意書きは出る');
  w.close();
}

/* ---------- 22. 意匠を変えてもidが変わっていないこと ---------- */
console.log('\n[22] idの回帰防止');
{
  const { w } = boot();
  for (let i = 0; i < 4; i++) {
    ok(w.document.getElementById('reel-' + i), '表示器 reel-' + i + ' が残っている');
    ok(w.document.getElementById('stop-' + i), 'ブレーキ stop-' + i + ' が残っている');
  }
  ok(w.document.getElementById('start-btn'), '発車ボタンのidが変わっていない');
  ok(w.document.getElementById('clear-btn'), '達成ボタンのidが変わっていない');
  ok(w.document.getElementById('reel-label-2'), 'ごほうびのラベルidが変わっていない');
  ok(w.document.getElementById('bonus-msg'), 'ボーナス表示のidが変わっていない');
  w.close();
}


/* ---------- 23. 景色（時刻連動） ---------- */
console.log('\n[23] 景色');
{
  const { w, errors } = boot();
  const scenes = w.eval('SCENES');
  eq(scenes.length, 5, '景色は5種類（あさ/ひる/ゆうがた/よる/ちかてつ）');
  for (const k of ['morning','day','dusk','night','under'])
    ok(scenes.some(s => s.key === k), k + ' がある');
  for (const s of scenes) {
    ok(Array.isArray(s.sky) && s.sky.length >= 2, s.tag + ' の空が2色以上ある');
    ok(/^#[0-9a-f]{6}$/i.test(s.ground), s.tag + ' の地面の色がある');
    ok(/^#[0-9a-f]{6}$/i.test(s.rail),   s.tag + ' の線路の色がある');
    ok(Array.isArray(s.kinds) && s.kinds.length > 0, s.tag + ' に通り過ぎるものがある');
    ok(new RegExp('#cab-view\\.' + s.cls + '\\s').test(html),
       s.tag + ' の背景色がCSSにもある(canvas非対応時の保険)');
  }
  ok(scenes.find(s => s.key === 'night').stars, '夜は星が出る');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 時刻で景色が決まる。画面が勝手に暗くなることで
     「そろそろ帰ろう」が言いやすくなる、というのが主目的 */
  const { w, errors } = boot();
  const at = (hh, mm) => w.eval(`sceneKeyByClock(new Date(2026,0,1,${hh},${mm || 0}))`);
  eq(at(7),      'morning', '7時は あさ');
  eq(at(12),     'day',     '12時は ひる');
  eq(at(17),     'dusk',    '17時は ゆうがた');
  eq(at(20),     'night',   '20時は よる');
  eq(at(3),      'night',   '深夜3時も よる');
  eq(at(4, 59),  'night',   '4時59分はまだ よる');
  eq(at(5, 0),   'morning', '5時ちょうどで あさ');
  eq(at(8, 59),  'morning', '8時59分はまだ あさ');
  eq(at(9, 0),   'day',     '9時ちょうどで ひる');
  eq(at(15, 59), 'day',     '15時59分はまだ ひる');
  eq(at(16, 0),  'dusk',    '16時で ゆうがた');
  eq(at(18, 29), 'dusk',    '18時29分はまだ ゆうがた');
  eq(at(18, 30), 'night',   '18時半で よる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 地下鉄なので、トンネルもときどき走る */
  const { w } = boot();
  const keys = new Set();
  for (let i = 0; i < 80; i++) { w.eval('pickScene()'); keys.add(w.eval('curScene.key')); }
  ok(keys.has('under'), 'トンネルもときどき走る');
  ok(keys.size >= 2, '時刻の景色と地下が混ざる');
  ok(w.document.getElementById('scene-tag').textContent.length > 0, '景色のラベルが出る');
  w.close();
}

/* ---------- 24. ブレーキの順番と定位置 ---------- */
console.log('\n[24] ブレーキ');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const d = w.document;
  eq(w.eval('BRAKE_ORDER').join(), '0,2,1,3', '駅 → ごほうび → 指令 → だれ の順');
  eq(d.getElementById('brake-btn').disabled, true, '停車中は押せない');

  w.eval('startAll()');
  eq(w.eval('activeReel'), 0, '最初は行き先');
  ok(d.getElementById('dest-panel').classList.contains('active'), '行き先パネルが光る');
  ok(d.getElementById('brake-label').textContent.includes('行き先'), '何を止めるのか分かる');

  w.eval('pullBrake()');
  eq(w.eval('activeReel'), 2, '次はごほうび');
  ok(d.getElementById('reward-board').classList.contains('active'), 'ごほうびのLEDが光る');
  ok(!d.getElementById('dest-panel').classList.contains('active'), '行き先はもう光らない');
  ok(d.getElementById('brake-label').textContent.includes('ごほうび'), 'ラベルが追従する');

  w.eval('pullBrake()');
  eq(w.eval('activeReel'), 1, '次は指令');
  ok(d.getElementById('reel-1').closest('.reel-row').classList.contains('active'), '指令の段が光る');

  w.eval('pullBrake()');
  eq(w.eval('activeReel'), 3, '最後はだれ');
  ok(d.getElementById('reel-3').closest('.reel-row').classList.contains('active'), 'だれの段が光る');

  w.eval('pullBrake()');
  eq(w.eval('runningCount()'), 0, '4回で全部止まる');
  eq(d.getElementById('brake-btn').disabled, true, '止まったら押せない');
  ok(w.eval('currentResult.station').length > 0, '行き先が決まっている');
  ok(w.eval('currentResult.target').length > 0, 'だれが決まっている');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 抽選ごとの定位置。隠したり畳んだりしないのでブレーキの位置が動かない */
  const { w } = boot();
  const d = w.document;
  eq(d.querySelectorAll('#cab-console .reel-row').length, 2, '下の段は 指令 と だれ の2つだけ');
  ok(d.getElementById('cab-view').contains(d.getElementById('reel-0')), '行き先は車窓の中');
  ok(d.getElementById('reward-board').contains(d.getElementById('reel-2')), 'ごほうびはLEDの中');
  ok(!/\.reel-row\.pending/.test(html), '項目を隠す指定が残っていない');
  ok(!/#dest-text|#station-sign/.test(html), '行き先の重複表示が残っていない');
  w.close();
}
{
  /* 順番を飛ばして止めても、残りを止められる */
  const { w } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('startAll()');
  w.eval('stopReel(2)');
  w.eval('pullBrake()');
  eq(w.eval('runningCount()'), 2, '順番を飛ばしても残りを止められる');
  w.close();
}
{
  /* 個別のブレーキidは残してある（既存テストとの互換） */
  const { w } = boot();
  for (let i = 0; i < 4; i++) ok(w.document.getElementById('stop-' + i), 'stop-' + i + ' のidが残っている');
  w.close();
}

/* ---------- 25. お地蔵さんが車窓に出る ---------- */
console.log('\n[25] お地蔵さん');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const j = w.document.getElementById('jizo');
  ok(j, 'お地蔵さんの要素が車窓の中にある');
  ok(w.document.getElementById('cab-view').contains(j), '車窓の内側に置かれている');
  eq(j.classList.contains('on'), false, '普段は出ていない');
  w.eval('showJizo()');
  eq(j.classList.contains('on'), true, 'ボーナスで車窓を横切る');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 演出OFFのときは動かさない */
  const { w } = boot();
  w.eval('settings.motion = false');
  w.eval('showJizo()');
  eq(w.document.getElementById('jizo').classList.contains('on'), false, '演出OFFなら動かさない');
  w.close();
}

/* ---------- 26. 画面の高さ ---------- */
console.log('\n[26] 縦の圧縮');
{
  ok(!/id="gear-btn"/.test(html), '⚙️ボタンを削除した(タブと重複していた)');
  ok(!/id="notice-btn"/.test(html), '注意書きボタンをせっていへ移した');
  const { w } = boot();
  /* あそぶタブに常時見えている主要ブロックの数を抑える */
  const play = w.document.getElementById('tab-play');
  const rows = play.querySelectorAll('.reel-row:not(.pending)');
  ok(rows.length <= 4, '表示器は最大4行');
  ok(w.document.getElementById('app-ver').closest('#tab-set'), 'バージョン表示はせっていタブへ移動');
  w.close();
}


/* ---------- 27. 画面構造の回帰防止 ---------- */
console.log('\n[27] 画面構造');
{
  /* v7で「設定内の重複導線を消したときに </div> を1つ余分に消し、
     タブバーが #tab-set(非表示) の中に閉じ込められて画面から消えた」。
     HTMLの入れ子は壊れても構文エラーにならないので、テストで固定する */
  const { w, errors } = boot();
  const d = w.document;
  eq(d.getElementById('tabbar').parentElement.tagName, 'BODY', 'タブバーは body 直下にある(タブの中に入っていない)');
  ok(!d.getElementById('tab-set').contains(d.getElementById('tabbar')), 'タブバーが設定タブに飲み込まれていない');
  ok(!d.getElementById('tab-play').contains(d.getElementById('tabbar')), 'タブバーがあそぶタブに飲み込まれていない');

  const parents = ['tab-play','tab-log','tab-set'].map(i => d.getElementById(i).parentElement);
  ok(parents.every(p => p === parents[0]), '3つのタブは同じ親を持つ(入れ子になっていない)');
  ok(!d.getElementById('tab-play').contains(d.getElementById('tab-set')), 'タブ同士が入れ子になっていない');

  ok(d.getElementById('tab-play').contains(d.getElementById('cab-view')), '車窓はあそぶタブの中');
  ok(d.getElementById('tab-play').contains(d.getElementById('brake-btn')), 'ブレーキはあそぶタブの中');
  ok(d.getElementById('tab-log').contains(d.getElementById('history-list')), '記録はきろくタブの中');
  ok(d.getElementById('tab-set').contains(d.getElementById('parent-code')), 'あいことば欄はせっていタブの中');
  ok(d.getElementById('tab-set').contains(d.getElementById('lock-btn')), 'ロックはせっていタブの中');
  eq(d.getElementById('splash').parentElement.tagName, 'BODY', 'スプラッシュは body 直下');
  eq(d.getElementById('notice').parentElement.tagName, 'BODY', '注意書きは body 直下');
  eq(d.getElementById('ranks').parentElement.tagName, 'BODY', '称号一覧は body 直下');

  /* 設定セクションが閉じ忘れていないか（今回の原因そのもの） */
  ok(!/<div class="sec">\s*<div class="sec">/.test(html), '閉じていない .sec が残っていない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 抽選ごとに定位置を持たせたので、確定が進んでも高さが変わらない
     （以前は項目を隠す→出すで行数が増え、ブレーキが下へズレていた） */
  ok(!/\.reel-row\.pending/.test(html), '項目を隠す指定が無い（＝行数が増減しない）');
  const { w } = boot();
  eq(w.document.querySelectorAll('#cab-console .reel-row').length, 2, '下の段は常に2行');
  w.close();
}


/* ---------- 28. 車窓（canvas / 一点透視） ---------- */
console.log('\n[28] 車窓の描画');
{
  const { w, errors } = boot();
  const cv = w.document.getElementById('cab-canvas');
  ok(cv, 'canvasがある');
  eq(cv.tagName, 'CANVAS', 'canvas要素である');
  ok(w.document.getElementById('cab-view').contains(cv), '車窓の中に置かれている');

  /* 投影の計算。奥にあるほど中心に寄り、小さくなる（一点透視そのもの） */
  const near = w.eval('projX(100, 260, 0)');
  const far  = w.eval('projX(100, 520, 0)');
  eq(near, 100, '距離260なら x=100 はそのまま100');
  eq(far, 50, '距離が2倍になると画面上の位置は半分（＝中心に寄る）');
  ok(Math.abs(far) < Math.abs(near), '奥のものほど消失点に近づく');
  const h1 = w.eval('260/260'), h2 = w.eval('260/520');
  ok(h2 < h1, '奥のものほど小さく描かれる');

  /* 物体が奥行き方向にばらまかれている */
  w.eval('cabSeed()');
  const objs = w.eval('CAB.objs');
  ok(objs.length > 10, `通り過ぎるものが生成される (${objs.length}個)`);
  const zs = objs.map(o => o.z);
  ok(Math.max(...zs) - Math.min(...zs) > 200, '奥行きにばらけている（同じ位置に固まらない）');
  ok(objs.every(o => o.side === 1 || o.side === -1), '線路の左右に振り分けられている');
  ok(objs.every(o => w.eval('curScene.kinds').includes(o.kind)), '景色に合ったものだけが出る');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* canvasが使えない環境でも、アプリが壊れないこと（この環境がまさにそれ） */
  const { w, errors } = boot();
  eq(w.eval('CAB.ctx'), null, '2dコンテキストが取れない環境を再現している');
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('drawCab(0.016)');
  w.eval('startAll()');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  eq(w.eval('runningCount()'), 0, '描画できなくても発車から停車まで通る');
  ok(w.eval('currentResult.station').length > 0, '描画できなくても行き先は決まる');
  w.eval('clearMission()');
  eq(w.eval('history.length'), 1, '描画できなくても記録できる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 演出OFFなら描画ループを回さない（電池対策） */
  const { w } = boot();
  w.eval('settings.motion = false');
  w.eval('setCab("cruise")');
  eq(w.eval('CAB.raf'), 0, '演出OFFでは描画ループを回さない');
  w.close();
}

/* ---------- 29. 操作系 ---------- */
console.log('\n[29] 操作系');
{
  const { w, errors } = boot();
  ok(/はっしゃ/.test(w.document.getElementById('start-btn').textContent), '発車ボタンは平易な言葉');
  ok(!/マスコン/.test(html), 'なじみのない言葉を使っていない');
  /* 警笛とドアは、役割を持たせられなかったので削除した */
  ok(!w.document.getElementById('horn-btn'), '警笛ボタンは無い');
  ok(!w.document.getElementById('door-btn'), 'ドアボタンは無い');
  ok(!/pressHorn|pressDoor|hornSound|doorSound/.test(html), '警笛とドアのコードが残っていない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 30. 発車ボタンの状態 ---------- */
console.log('\n[30] 発車ボタン');
{
  const { w, alerts, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const sb = w.document.getElementById('start-btn');
  eq(sb.disabled, false, '回数が残っていれば押せる');
  ok(/はっしゃ/.test(sb.textContent), '「はっしゃ」と出ている');

  /* 走行中は押せない */
  w.eval('startAll()');
  eq(sb.disabled, true, '走行中は押せない');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  eq(sb.disabled, false, '停車したらまた押せる');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 回数を使い切った状態で開くと、ボタンは普通の見た目のまま無反応だった */
  const st = { settings:null, spinsLeft:0, excluded:[], history:[], totalMoney:0, pin:null, noticeSeen:true };
  const { w, alerts, errors } = boot({ mqgo_v1: JSON.stringify(st) });
  const sb = w.document.getElementById('start-btn');
  eq(w.eval('spinsLeft'), 0, '回数ゼロの状態で起動');
  eq(sb.disabled, true, '回数ゼロなら最初から押せない状態になっている');
  ok(/おわり/.test(sb.textContent), `理由がボタンに出ている (${sb.textContent})`);

  /* それでも呼ばれたときに黙って終わらない */
  w.eval('startAll()');
  ok(alerts.some(a => a.includes('リセット')), '押しても無反応ではなく、直し方を伝える');
  eq(w.eval('runningCount()'), 0, '回数ゼロでは発車しない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 31. 操作系の配置 ---------- */
console.log('\n[31] 操作系の配置');
{
  const { w } = boot();
  const d = w.document;
  const mc = d.getElementById('main-controls');
  ok(mc, '発車とブレーキをまとめる行がある');
  ok(mc.contains(d.getElementById('start-btn')), '発車が同じ行にある');
  ok(mc.contains(d.getElementById('brake-btn')), 'ブレーキが同じ行にある');
  eq(mc.querySelectorAll('button').length, 2, '主操作は2つだけ');
  ok(/#main-controls button \{[^}]*flex:1/.test(html), '2つが同じ幅で並ぶ');
  ok(/#main-controls button \{[^}]*height:62px/.test(html), '2つが同じ高さ');
  ok(!d.getElementById('switches'), '小スイッチのまとまりは無くなった');
  ok(!/id="sub-controls"/.test(html), '旧レイアウトが残っていない');

  /* 計器まわりは ごほうび表示器 と 速度計 だけ */
  const top = d.querySelector('.console-top');
  ok(top.contains(d.getElementById('reward-board')), 'ごほうび表示器が計器側にある');
  ok(top.contains(d.getElementById('speedo')), '速度計が計器側にある');
  w.close();
}

/* ---------- 32. タブから戻っても車窓が消えない ---------- */
console.log('\n[32] タブ復帰');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  /* タブが非表示のあいだ getBoundingClientRect は0を返す。
     そのまま反映するとcanvasの中身が消えるので、前の大きさを保つ */
  w.eval('CAB.w = 320; CAB.h = 200;');
  w.eval('cabResize()');
  eq(w.eval('CAB.w'), 320, '0サイズのときは前の幅を保つ');
  eq(w.eval('CAB.h'), 200, '0サイズのときは前の高さを保つ');

  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  eq(w.eval('CAB.raf'), 0, '他のタブでは描画を止める(電池対策)');
  w.eval('switchTab("play")');
  eq(w.eval('CAB.w'), 320, 'あそぶタブに戻っても大きさが潰れない');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}


/* ---------- 33. 駅名が読めること ---------- */
console.log('\n[33] 駅名の視認性');
{
  /* #reel-0 は .reel-box も持つため、黒背景と緑文字を打ち消していないと
     確定後に「白い駅名標の中で黒地に黒文字」になり読めなくなる */
  const css = html.match(/#dest-panel \.dp-name \{[^}]*\}/s);
  ok(css, '#dest-panel .dp-name の指定がある(.reel-boxより強い)');
  ok(/background:none/.test(css[0]), '表示器の黒背景を打ち消している');
  ok(/height:auto/.test(css[0]), '表示器の固定高さを打ち消している');
  ok(/#dest-panel\.fixed \.dp-name \{[^}]*color:#111/.test(html), '確定後は黒文字');
  ok(/#dest-panel\.fixed \{[^}]*background:rgba\(248/.test(html), '確定後の背景は白');
}

/* ---------- 34. お地蔵さんの見せ方 ---------- */
console.log('\n[34] お地蔵さん');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const d = w.document;
  const banner = d.getElementById('jizo-banner');
  ok(banner, '当たったことを知らせる帯がある');
  ok(d.getElementById('cab-view').contains(banner), '帯は車窓の中にある(スクロール不要)');
  ok(d.getElementById('cab-view').contains(d.getElementById('cab-flash')), '閃光も車窓の中');

  w.eval('showJizo()');
  ok(banner.classList.contains('on'), '帯が出る');
  ok(banner.textContent.includes('じぞうチャンス'), `当たったことが読める (${banner.textContent}) `);
  ok(banner.textContent.includes('⭐') || banner.textContent.includes('円'), 'いくらもらえるかも読める');
  ok(d.getElementById('jizo').classList.contains('on'), 'お地蔵さんが横切る');
  ok(d.getElementById('cab-flash').classList.contains('on'), '車窓が光る');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 演出OFFでも「当たった」という情報は伝える */
  const { w } = boot();
  w.eval('settings.motion = false');
  w.eval('showJizo()');
  ok(w.document.getElementById('jizo-banner').classList.contains('on'), '演出OFFでも帯は出す(情報だから)');
  eq(w.document.getElementById('jizo').classList.contains('on'), false, '演出OFFなら動かさない');
  w.close();
}

/* ---------- 35. 達成ボタンの誤タップ防止 ---------- */
console.log('\n[35] 達成ボタンの2回押し');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('startAll()');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  const b = w.document.getElementById('clear-btn');

  /* 1回目では確定しない */
  w.eval('confirmClear()');
  eq(w.eval('history.length'), 0, '1回目のタップでは記録されない');
  ok(b.classList.contains('armed'), 'ボタンが確認状態になる');
  ok(b.innerText.includes('ほんとうに'), `確認の文言に変わる (${b.innerText}) `);

  /* 2回目で確定 */
  w.eval('confirmClear()');
  eq(w.eval('history.length'), 1, '2回目のタップで記録される');
  ok(!b.classList.contains('armed'), 'ボタンが元に戻る');
  ok(b.innerText.includes('ミッション達成'), '文言も元に戻る');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 時間が経てば解除される（押しっぱなしの誤爆を防ぐ） */
  const { w } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('startAll()');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  w.eval('confirmClear()');
  w.eval('clearArmedAt = Date.now() - 9000');   // 4秒以上たった状態にする
  w.eval('confirmClear()');
  eq(w.eval('history.length'), 0, '時間が経っていたら1回目からやり直しになる');
  w.close();
}
{
  /* 発車したら確認状態は解除される */
  const { w } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  w.eval('startAll()');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  w.eval('confirmClear()');
  w.eval('startAll()');
  eq(w.eval('clearArmedAt'), 0, '発車で確認状態が解除される');
  ok(!w.document.getElementById('clear-btn').classList.contains('armed'), '見た目も戻る');
  w.close();
}


/* ---------- 36. お地蔵さんの重なり ---------- */
console.log('\n[36] 重なり順');
{
  /* 帯の下にお地蔵さんが隠れていた。主役なので最前面に置く */
  const jz = (html.match(/#jizo \{[^}]*\}/s) || [''])[0].match(/z-index:(\d+)/);
  const bn = (html.match(/#jizo-banner \{[^}]*\}/s) || [''])[0].match(/z-index:(\d+)/);
  ok(jz && bn, 'どちらにも重なり順の指定がある');
  ok(+jz[1] > +bn[1], `お地蔵さん(${jz[1]})が帯(${bn[1]})より前にいる`);
}

/* ---------- 37. 達成したら回数がもどる ---------- */
console.log('\n[37] 達成で回数リセット');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const per = w.eval('settings.spinsPerDay');
  w.eval('startAll()');
  eq(w.eval('spinsLeft'), per - 1, '発車すると1回へる');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  w.eval('confirmClear()'); w.eval('confirmClear()');
  eq(w.eval('spinsLeft'), per, '達成したら回数がもどる');
  eq(JSON.parse(w.localStorage.getItem('mqgo_v1')).spinsLeft, per, 'もどった回数が保存される');
  ok(w.document.getElementById('spins-left').innerText.includes(String(per)), '画面表示にも反映される');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}
{
  /* 達成しなければ減ったまま（引き直し続けるのを防ぐのが回数制限の目的） */
  const { w } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const per = w.eval('settings.spinsPerDay');
  w.eval('startAll()');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  w.eval('startAll()');
  eq(w.eval('spinsLeft'), per - 2, '達成しないと減ったまま');
  w.close();
}

/* ---------- 38. あいことばの周知 ---------- */
console.log('\n[38] あいことば');
{
  const { w, errors } = boot();
  eq(w.eval('DEFAULT_PIN'), '1234', '初期のあいことばは1234');
  eq(w.eval('getPin()'), '1234', '未設定なら初期値が使われる');
  eq(w.eval('isDefaultPin()'), true, '初期値のままだと分かる');

  w.prompt = () => '1234';
  w.eval('switchTab("set")');
  const note = w.document.getElementById('pin-note');
  ok(note.textContent.includes('1234'), '初期値のままなら設定画面で知らせる');
  ok(note.textContent.includes('変更'), '変更をすすめている');

  w.document.getElementById('parent-code').value = '4649';
  w.eval('changePin()');
  eq(w.eval('isDefaultPin()'), false, '変更したら初期値ではなくなる');
  w.eval('renderSettings()');
  ok(w.document.getElementById('pin-note').textContent.includes('変更ずみ'), '変更後は表示が変わる');

  /* 配布したときに保護者が分かるよう、注意書きにも書いてある */
  const notice = w.document.getElementById('notice').textContent;
  ok(notice.includes('1234'), '「はじめる前に」に初期値が書いてある');
  ok(notice.includes('誤操作'), '秘密ではなく誤操作防止だと説明している');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 39. あいことばの入力画面に初期値を出す ---------- */
/* 配ったばかりの人は 1234 を知らないので、保護者モードに入れなかった。
   ただし変更後に 1234 と出したら嘘になるので、初期値のときだけ出す */
console.log('\n[39] あいことばの案内');
{
  const { w, errors } = boot();
  let asked = '';
  w.prompt = (msg) => { asked = String(msg); return '1234'; };
  w.eval('switchTab("set")');
  ok(asked.includes('1234'), '初期値のままなら入力画面に1234と書いてある');
  ok(asked.includes('変更'), '変更できることも書いてある');

  w.document.getElementById('parent-code').value = '4649';
  w.eval('changePin()');
  w.eval('lockParent()');
  asked = '';
  w.prompt = (msg) => { asked = String(msg); return '4649'; };
  w.eval('switchTab("set")');
  ok(!asked.includes('1234'), '変更後は 1234 と出さない（嘘にならない）');
  ok(asked.includes('あいことば'), '入力を求める文言は残っている');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 40. 表示器は順番に1つずつ回す ---------- */
/* 4つ同時に回ると目が疲れるとの指摘。回るのは常にブレーキが向いている1つだけ */
console.log('\n[40] 順番に回す');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const d = w.document;
  eq(w.eval('REEL_COVER'), '- - -', 'まだの表示器はハイフンで伏せる');

  w.eval('startAll()');
  eq(w.eval('BRAKE_ORDER[0]'), 0, '最初に止めるのは行き先');
  eq(w.eval('intervals[0] ? 1 : 0'), 1, '発車したら行き先だけが回る');
  for (const i of [1, 2, 3]) {
    eq(w.eval(`intervals[${i}] ? 1 : 0`), 0, `表示器${i}はまだ回っていない`);
    ok(d.getElementById('reel-' + i).classList.contains('pending'), `表示器${i}は伏せてある`);
    eq(d.getElementById('reel-' + i).innerText, '- - -', `表示器${i}はハイフンのまま`);
  }
  /* 4つとも「未確定」ではある（ブレーキの残り本数の数え方は変えていない） */
  eq(w.eval('runningCount()'), 4, '未確定の数はこれまでどおり4');

  /* 1本目のブレーキ → 行き先が確定し、次（ごほうび）が回りだす */
  w.eval('pullBrake()');
  eq(w.eval('activeReel'), 2, '次はごほうび');
  eq(w.eval('intervals[2] ? 1 : 0'), 1, 'ブレーキを引いてはじめて回りだす');
  ok(!d.getElementById('reel-2').classList.contains('pending'), '回りだしたら伏せをはずす');
  ok(!d.getElementById('reel-0').classList.contains('pending'), '確定した表示器も伏せない');
  ok(d.getElementById('reel-1').classList.contains('pending'), 'まだ先の表示器は伏せたまま');
  eq(w.eval('intervals[0]'), null, '止めた表示器のタイマーは残さない');

  /* 最後まで引ける（順番に回しても4つとも確定する） */
  w.eval('pullBrake()'); w.eval('pullBrake()'); w.eval('pullBrake()');
  eq(w.eval('runningCount()'), 0, '4回で全部決まる');
  for (const i of [0, 1, 2, 3]) {
    ok(!d.getElementById('reel-' + i).classList.contains('pending'), `確定後の表示器${i}は伏せていない`);
    ok(d.getElementById('reel-' + i).innerText !== '- - -', `確定後の表示器${i}に中身がある`);
  }
  ok(w.eval('currentResult.station').length > 0, '行き先が入っている');
  ok(w.eval('currentResult.money').length > 0, 'ごほうびが入っている');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();
}

/* ---------- 41. ブレーキの色 ---------- */
/* はっしゃ が「黄→灰」で分かるのに、ブレーキは「灰→灰」で区別がつかなかった */
console.log('\n[41] ブレーキの色');
{
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const startOff = /#start-btn:disabled\s*\{([^}]*)\}/.exec(css);
  const brakeOff = /#brake-btn:disabled\s*\{([^}]*)\}/.exec(css);
  const brakeOn  = /#brake-btn\s*\{([^}]*)\}/.exec(css);
  ok(startOff && brakeOff && brakeOn, '3つのルールが揃っている');
  const greyOf = s => (/#([0-9a-f]{6})/i.exec(s) || [])[1];
  eq(greyOf(brakeOff[1]), greyOf(startOff[1]), '押せないときは はっしゃ と同じ灰色');
  ok(!/#6d757b/i.test(brakeOn[1]), '押せるときは灰色ではない');
  ok(/#9df3f6|#25c6d8/i.test(brakeOn[1]), '押せるときは明るい色');
  ok(/color:#06323c/i.test(brakeOn[1]), '明るい下地に合わせて文字は濃い色');
}

/* ---------- 42. 写真機能は取り下げた ---------- */
/* 「ボタンの位置も目的もあいまい」との判断で v14 で削除。
   説明（注意書き・README）に嘘が残らないことまで見る */
console.log('\n[42] 写真の取り下げ');
{
  const { w, errors } = boot();
  w.eval('hideSplash()'); w.eval('closeNotice()');
  const d = w.document;
  for (const id of ['photo-row', 'photo-btn', 'photo-preview', 'photo-drop', 'photo-input']) {
    ok(!d.getElementById(id), `#${id} が残っていない`);
  }
  for (const fn of ['pickPhoto', 'dropPhoto', 'onPhotoPicked', 'shrinkImage', 'prunePhotos', 'photoPut', 'idbOpen']) {
    eq(w.eval(`typeof ${fn}`), 'undefined', `${fn}() が残っていない`);
  }
  ok(!/indexedDB/i.test(html), 'IndexedDBを使わなくなった');
  ok(!/capture="environment"/.test(html), 'カメラを開く入力欄が残っていない');

  /* 記録はこれまでどおり残る。idだけは将来のために残してある */
  w.eval('startAll()');
  for (let i = 0; i < 4; i++) w.eval('pullBrake()');
  w.eval('confirmClear()'); w.eval('confirmClear()');
  eq(w.eval('history.length'), 1, '達成の記録はこれまでどおり残る');
  ok(w.eval('history[0].id').length > 0, '記録のidは残してある');
  eq(w.eval('history[0].pid'), undefined, '写真idは付かない');
  w.eval('renderHistory()');
  ok(!d.querySelector('.hphoto'), '一覧に写真は出ない');
  ok(d.getElementById('history-list').textContent.length > 0, '一覧は描ける');

  const notice = d.getElementById('notice').textContent;
  ok(!notice.includes('しゃしん'), '注意書きから写真の説明が消えている');
  ok(notice.includes('1234'), 'あいことばの説明は残っている');
  eq(errors.length, 0, 'runtime errors: none');
  w.close();

  /* 事業者向けの説明を、実装に戻す */
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  ok(!/しゃしんをとる/.test(readme), 'READMEから写真ボタンの記述が消えている');
  ok(!/IndexedDB/.test(readme), 'READMEからIndexedDBの記述が消えている');
  ok(/端末の権限要求.+\*\*なし。\*\* カメラ/.test(readme), 'READMEが「権限要求：なし」に戻っている');
}

/* ---------- 結果 ---------- */
console.log(`\n${'='.repeat(46)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);
if (failed) { console.log('\n  失敗:'); fails.forEach(f => console.log('   - ' + f)); }
console.log(`${'='.repeat(46)}\n`);
process.exit(failed ? 1 : 0);

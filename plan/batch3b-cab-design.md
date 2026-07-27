# バッチ3b 実装仕様 — 電車でGO風「あそぶ」タブ

**状態: 実装完了（v6）。この文書は設計の記録として残す。**
このファイルだけ読めば、文脈ゼロから実装に入れるように書いてある。

---

## 0. 着手時の前提確認

```bash
cd /workspace/metro-quest-go && git log --oneline -1   # d74fdb5 バッチ3a...
cd test && npm install && npm test                     # 197件パス / 0失敗
```

| | 値 |
|---|---|
| 現在の `APP_VER` | `v5`（→ 実装後 `v6`） |
| 現在の `CACHE_NAME` | `metro-quest-go-v5`（→ `metro-quest-go-v6`） |
| 作業ブランチ | `claude/toei-subway-collaboration-33nhwb` |
| 対象 | **GOのみ**。家族版には入れない（気に入られたら後で移植） |

### 絶対に触らないもの（承認①で合意した「案A」の核心）

以下は**資産であり、197件のテストが乗っている**。演出は「上にかぶせる」だけにする。

- `weightedPick()` / `missionBag` のシャッフルバッグ
- `getCandidates()` とフィルタまわり
- `STATIONS` / `LINES` / `LINE_STATIONS` / `ALIAS` の各マスタ
- `startAll()` / `stopReel()` の**呼び出し契約**（引数と、確定値を `currentResult` に入れる責務）
- `store` / `saveStore()` / `loadStore()` のデータ層
- `clearMission()` の加算・記録ロジック

**やるのは「見た目と演出の差し替え」だけ。** 抽選の中身を作り替えたくなったら、それは別バッチ（案B）として改めて承認を取る。

---

## 1. 画面構成（`#tab-play` の中身）

```
┌──────────────────────────┐
│  ◆ 前面展望（車窓）                 │  #cab-view
│    トンネルの壁 + 天井照明が            │  高さ 34vh（最小150px/最大260px）
│    奥から手前へ流れる                  │
│    停車時は駅名標が浮かぶ               │
├──────────────────────────┤
│ [次は]▓▓▓▓▓▓▓▓▓▓▓   ╭─╮      │  #dest-board（LED方向幕）
│                      │速度│      │  #speedo（速度計）
│  行き先 / 指令 / ⭐ / だれ           │  4つの表示器（既存リールの後継）
├──────────────────────────┤
│   ▐▌  ▐▌  ▐▌  ▐▌                │  ブレーキレバー ×4（既存STOPの後継）
│  [ 発車 ]                        │  #start-btn
└──────────────────────────┘
```

### 既存DOMとの対応（idは変えない＝テストを壊さない）

| 既存 | 3bでの見せ方 | id |
|---|---|---|
| `.reel-box` ×4 | LED表示器 | `reel-0`〜`reel-3` **のまま** |
| `.stop-btn` ×4 | ブレーキレバー | `stop-0`〜`stop-3` **のまま** |
| `#start-btn` | 「発車」ボタン | **のまま** |
| `#reel-label-2` | 表示器のラベル | **のまま**（`updateHeader()` が書き換える） |
| `#bonus-msg` | 車内放送風の帯 | **のまま** |

**idを変えないこと。** 既存テストが `getElementById` で参照している。CSSクラスの追加は自由。

---

## 2. CSSの作り方（画像素材ゼロ）

### 2-1. 車窓 `#cab-view`

- 外枠：`border-radius:14px; overflow:hidden; background:#05070f;`
- **奥行き**：`perspective:320px` を親に置き、内側の壁を `transform:rotateX()` で寝かせる
- **トンネルの壁**：`repeating-linear-gradient` の縞を2枚（左右）。`background-position` を `@keyframes` で流す
- **天井照明**：`repeating-linear-gradient` で等間隔の明るい帯。壁より速く流す＝視差
- **速度連動**：`animation-duration` を CSS変数 `--spd` で制御し、JSは `style.setProperty('--spd', ...)` だけ触る

```css
#cab-view { --spd: 0s; }              /* 停車中 */
.tunnel { animation: rush var(--spd) linear infinite; }
@keyframes rush { to { background-position-y: 240px; } }
```
`--spd` を `0s`→`0.35s`（加速）→`0.9s`（減速）→`0s`（停車）と変える。
**`--spd:0s` はアニメーション停止と同義**なので、停車の表現がタダで手に入る。

### 2-2. 速度計 `#speedo`

- 円：`conic-gradient(from 220deg, var(--cyan) 0 calc(var(--kmh)*1%), #0b1330 0)`
- 針：細い矩形を `transform: rotate(calc(-140deg + var(--kmh)*2.8deg))`
- 数値表示：`#speedo-num`（JSで更新）
- `--kmh` は 0〜100 の数値。JSは変数を書くだけ

### 2-3. LED方向幕 `#dest-board`

- 背景 `#0a0f08`、文字 `#7CFC55`、`letter-spacing:2px`
- ドット感：`background-image: radial-gradient(#000 30%, transparent 31%)` を `background-size:3px 3px` で重ねる
- 走行中は「次は ▓▓▓」、確定後は駅名

### 2-4. ブレーキレバー `.stop-btn`

- 縦長（幅42px / 高さ64px）、上部にグリップの丸
- `:active` と `.pulled` で `transform: translateY(10px) rotate(3deg)`
- 引くと `--spd` が1段階遅くなる

---

## 3. 状態機械

```
stopped ──[発車]──▶ accel ──(0.6s)──▶ cruise
                                        │
                              [ブレーキ×4]（1本ごとに減速）
                                        ▼
                                     arriving ──(0.8s)──▶ stopped
```

- 状態は `let cabState = 'stopped'` で保持し、`setCab(state)` で `--spd` / `--kmh` / クラスを一括更新
- **`isRunning[]` / `intervals[]` の既存ロジックはそのまま**。`setCab()` を呼ぶ行を足すだけ
- 4本目のブレーキ後に `arriving` → 駅名標がせり上がる → `stopped`

---

## 4. 音（既存 `beep()` を使う。音声ファイルなし）

| タイミング | 音 |
|---|---|
| 発車 | 発車ベル（880Hz→1047Hz の2音、`triangle`） |
| 走行中 | 低い持続音（55Hz `sawtooth`、gain 0.04）※`cruise` の間だけ |
| ブレーキ | 短い減衰音（300Hz `square`, 0.1s） |
| 到着 | 3音の下降（784→659→523） |

**あわせて音量を上げる**（現状 `gain 0.2` → `0.35`）。前回「小さくて聞こえなかった」との報告があったため。
走行音は `oscillator` を1本持ち続け、`stopped` で `stop()` する。**必ず `unlockAudio()` を通すこと。**

---

## 5. 演出OFF（配布物として必須）

```js
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function motionOn() { return settings.motion !== false && !REDUCED; }
```

- `settings.motion`（既定 `true`）を `DEFAULT_SETTINGS` に追加 → **`loadSettings()` の欠損補完が効くので migrate 不要**
- せっていに「🎬 えんしゅつ」ON/OFFを追加
- OFF時：`--spd` を常に `0s`、速度計の針は瞬間移動、走行音なし。**機能はすべて使える**
- `prefers-reduced-motion` が reduce なら**設定に関係なくOFF**

---

## 6. 起動演出（1.2秒）

- `#splash`：全画面、電車アイコンが左から中央へ滑り込み、下に線路が流れる
- 1.2秒後にフェードアウト。**タップで即スキップ**（Studyきち準拠）
- `store.noticeSeen` が false のときは**スプラッシュ後に注意書き**を出す（順序に注意）
- OFF時はスプラッシュを出さない

---

## 7. 変更対象

| ファイル | 内容 |
|---|---|
| `index.html` | `<style>` に運転台のCSS追加 / `#tab-play` のHTML差し替え / `setCab()`・音・スプラッシュのJS追加 / `DEFAULT_SETTINGS.motion` / せっていにトグル |
| `sw.js` | `CACHE_NAME` → `metro-quest-go-v6` |
| `test/run-tests.mjs` | 下記テストを追加 |
| `SYNC.md` | 差分表に「あそぶタブの意匠」「`setCab()`」「`settings.motion`」「スプラッシュ」を追記 |

**追加ファイルは作らない**（フラット構成の原則）。

---

## 8. 追加するテスト

1. 既存197件が**全部通ること**（意匠を変えても抽選は無傷）
2. `setCab()` で `--spd` / `--kmh` が状態どおりに変わる
3. 発車 → ブレーキ4回 → `stopped` に戻る（状態遷移が閉じている）
4. `settings.motion = false` で `--spd` が常に `0s`
5. **演出OFFでも**発車・停止・指令達成・記録保存が全部できる
6. `prefers-reduced-motion` が reduce なら設定に関係なくOFF
7. スプラッシュが1.2秒で消える / タップで即消える
8. 未読の注意書きは**スプラッシュの後**に出る
9. `APP_VER` と `CACHE_NAME` が一致（既存テストが担保）
10. リールとブレーキの **id が変わっていないこと**（回帰防止）

---

## 9. 作業順序（この順で、各段階でテストを流す）

1. CSSだけ先に入れて**見た目を差し替える**（JSは触らない）→ 既存197件が通ることを確認
2. `setCab()` と状態遷移を足す → テスト2・3を追加
3. 演出OFFを足す → テスト4・5・6を追加
4. 音を足す
5. スプラッシュを足す → テスト7・8を追加
6. `APP_VER`/`CACHE_NAME` を v6 へ、`SYNC.md` 更新、コミット

**1で一度止めて実機確認してもらうのが安全。** 見た目の方向性が違ったら、そこで戻る方が安い。

---

## 10. 未確定・実装者の判断に委ねる点

- トンネルの色味（現在のパレット `--bg:#1a1a2e` / `--cyan:#00d2d3` の範囲で）
- 速度計の目盛りを描くか、数値だけにするか（**360px幅で潰れるなら数値だけに倒す**）
- 車窓の高さ（34vh は目安。運転台が画面内に収まることを優先）

## 11. やらないと決めたこと

- 実写風グラフィック、画像素材の追加（50KBの軽さと権利の明快さを守る）
- 物理シミュレーション
- 抽選ロジックの作り替え（案B。やるなら別途承認）
- 家族版への同時適用（GOで確認してから）

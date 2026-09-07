# Design

コーディングエージェントからブラウザーのブックマークを操作するためのローカル拡張機能。**エージェント向けの操作口を提供することが主目的**で、ブラウザー操作用のコマンドAPIと計画JSONの受け渡しを提供する。手動UIは、エージェントを使わない場合の操作と結果確認にも使える。入力経路によらず同じスキーマ検証・Dry Run・承認・適用・検証・rollback を通す。AIモデルや自動接続機構は内蔵せず、API自体もエージェントのブラウザー権限を制限する仕組みではない。

読む前に知っておくべき 3 点。

- 削除は実装済みだが、**Trash への可逆な移動と、確認付きの不可逆な永続削除の 2 段階**に限定されている。削除済み項目を再作成する機能はない。
- **操作者を人と AI で区別する手段はない。** 安全性は操作者の識別に依存させていない。
- account / local の境界越え拒否は **`syncing: true` と `false` が共存するプロファイルで未検証**（Known Limitations 参照）。

## Phases

| Phase | 内容                                                                     | 書き込み       |
| ----- | ------------------------------------------------------------------------ | -------------- |
| 0     | ライブツリーの取得、統計、スナップショット書き出し、重複レポート         | なし           |
| 1     | 計画 JSON のスキーマ検証、ライブツリーとの照合、Dry Run                  | なし           |
| 2     | Apply / Verify / Rollback / Restore、Trash 隔離と復元                    | あり（実装済） |
| 2.5   | Trash 内項目の永続削除（確認付き・1 件ずつ・不可逆）、ブックマークの改名 | あり（実装済） |
| 3     | 一括削除、`removeTree`、URL 変更、フォルダーの改名                       | あり（未実装） |

**このリポジトリの現状は Phase 0-2.5。** 書き込み経路は 4 つだけで、いずれも `extension/src/adapters/bookmarks-api.js` の中にしか存在しない。

1. `chrome.bookmarks.move` — `moveBookmark` 本体のみ。
2. `chrome.bookmarks.create` — `createFolder` 本体のみ。Trash フォルダーをユーザーが選んだ場所に 1 つ作るためだけに使う。
3. `chrome.bookmarks.remove` — `removeBookmark` 本体のみ。Trash 台帳で管理されている項目を 1 件ずつ消すためだけに使う。
4. `chrome.bookmarks.update` — `updateBookmark` 本体のみ。引数は `(id, { title })` の固定形で、**ブックマークのタイトル以外を書く経路はない**。

`removeTree` はソース全体で禁止し、`tests/no-write-api.test.js` が機械的に検査する。

### update を許した理由と、狭めた適用範囲

整理では「同じページを指すがタイトルがゴミ」というブックマークが必ず残る。これを直せないと重複判定と分類の精度が上がらないので、**タイトルだけ**を同じ安全ゲートの中に入れた。

- **URL は書かない。** URL は `expectedUrl`、重複判定、Trash の identity 照合、スナップショット照合のすべてで identity として使われている。静的ゲートが `updateBookmark` 本体に `url` という語が現れないことを検査する。
- **フォルダーは改名しない。** フォルダー名は配下すべてのノードの path セグメントなので、改名すると Trash receipt の `originalParentPath`、スナップショットの ancestor 鎖、他の操作の `currentPath` / `destinationPath` が一斉に崩れる。ブックマークに限定すれば、改名は**他のどの操作の解決結果にも影響しない**。
- **Trash 台帳の管理下にある項目は改名しない。** タイトルは restore / delete の identity 照合に使われる。active な receipt を持つ id、poison された id、そして**台帳自体が読めない場合は全 id** を拒否する。
- **回復手段は journal rollback だけ。** スナップショット復元は `nodeIdentityMatches` で title を identity に使うため、改名後のノードは復元対象から外れる。この非対称性は隠さずに明記する。
- **rollback は atomic ではない。** 逆操作前に現在値が自分の書いた `newTitle` であることを確かめるが、これは optimistic check で、確認直後の外部変更（TOCTOU）と `new → other → new` の ABA を検出できない。「自分の変更だけを確実に戻す」とは主張しない。
- **入力経路は計画 JSON だけ。** UI に改名ビルダーはない。スキーマ v2 の `type: "update"` でのみ表現でき、v1 の計画は move 専用のまま受理される。

### create を許した理由と、狭まった主張

Trash フォルダーをユーザーに手作業で作らせる案（拡張機能は既存フォルダーを指定してもらうだけ）も検討したが、採用しなかった。アカウント同期プロファイルでは `syncing: true` と `false` のストアが共存し、境界をまたぐ move は拒否されるため **Trash は境界ごとに必要**になる。拡張機能が置き場所を推測すると、ユーザーが整理したい側で使えない Trash ができる。よって「置き場所はユーザーが選び、作成は拡張機能が行い、実行前に確認を出す」形にした。

これにより安全上の主張は **「何も作成できない」から「空フォルダー以外は作成できない」へ狭まった**。この後退を隠さないために、ゲートは次を機械的に固定する。

- `chrome.bookmarks.create` の参照はビルド全体で 1 箇所。
- その呼び出しは `createFolder` 本体にあり、**引数は `{ parentId, title }` の固定形**。
- `createFolder` 本体に `url` という語が出現しない。spread も computed key も使わない。

つまり「このビルドはブックマークを新規作成できない」ことは、意図ではなく検査で示されたままである。作成はユーザーの明示操作でしか起きないので、「インストールしただけでは何も変更しない」も維持される。

### remove を許した理由と、狭まった主張

Trash への退避だけでは、ユーザーは最後に別の道具（ブラウザー標準のマネージャー）へ移らなければ整理を終えられない。その乗り換えは、この拡張機能が積み上げた台帳とバックアップの文脈を捨てることを意味するので、最後の 1 歩だけを同じ安全ゲートの中で扱えるようにした。

これにより安全上の主張は **「削除能力がない」から「 Trash 内・単一 id ・identity 照合済み・不可逆・再作成なしの削除のみ」へ狭まった**。この後退を隠さないために、削除は次をすべて満たすときだけ実行できる。

- `chrome.bookmarks.remove` の参照はビルド全体で 1 箇所、`removeBookmark` 本体のみ。`removeTree` は存在しないので、子孫をまとめて消す経路はない。
- 削除対象は台帳で `trashed` として管理されている receipt に限る。
- 検証済みバックアップ（再選択して照合したスナップショット）と明示の確認チェックが必要。
- 1 件ずつ identity（title / URL / `dateAdded`）、Trash 在席、境界を照合し、不一致なら残りを中止する。
- 削除後に対象が不在になったことを検証する。

**削除後の再作成は実装していない。** バックアップを要求するのは監査とユーザー保護のためであって、拡張機能が削除済み項目を復旧するわけではない。

### 静的ゲートが証明できる範囲

静的走査が固定するのは、**呼び出しがどのファイルに何箇所、どんな引数形で書かれているか**だけである。スナップショット検証、確認チェック、台帳の状態遷移が実行時の呼び出しグラフで必ず通ることは、regex では証明できない。それらは `core/` の unit test と、実ブラウザーを通す `run-pilot.mjs` が担当する。静的ゲートの役割は「意図しない書き込み経路が増えないこと」に限定する。

### 操作者を人と AI で区別する手段はない

エージェントの計画 JSON は `move` とブックマークの `update` しか表現できないので、**計画ファイル経由で削除を指示することはできない**。

ただし、ブラウザー操作を許可されたエージェントは、人と同じ UI 操作（永続削除ボタンを含む）を実行できる。options ページは拡張機能 origin のスクリプトと devtools / CDP から到達できるため、拡張機能側からその操作主体を見分ける方法はない。

したがって安全性は **操作者の識別に依存させない**。依存先は次の 4 つだけにする。

1. 可逆な Trash という前段があること
2. 削除にバックアップの検証を要求すること
3. 1 件ずつ identity を照合すること
4. 不一致で残りを中止すること

### TOCTOU（受容している残リスク）

`chrome.bookmarks.remove(id)` は条件付き API ではない。「この内容のときだけ消す」を渡せないため、**最終照合と remove の間に他端末やブラウザー UI が対象を移動させた場合、移動先の対象を削除し得る**。

- 緩和: 1 件ずつ処理することで、この窓が開いてしまった場合でも被害を 1 ノードに限定する。削除直前の外部変更検知と、削除後の不在検証で窓を可能な限り狭くする。
- 残余: 窓自体は閉じられない。API 側に条件付き削除が入らない限り、これは受容リスクとして残る。

## Architecture

- Manifest V3、バンドラーなし、ランタイム依存ゼロ。unpacked で読み込まれるコードとレビュー対象のソースが同一であることを優先する。
- **background service worker を持たない。** 全処理は options ページ上で動く。install / update / startup で走るコードパスが存在しないため、「インストールだけでは何も変更しない」が構造的に保証される。
- `extension/src/core/` は純粋関数のみ（`chrome.*` を参照しない）。`node:test` でユニットテストする。
- `extension/src/adapters/` だけがブラウザ API に触れる。書き込みは `bookmarks-api.js` の `moveBookmark` / `createFolder` / `removeBookmark` / `updateBookmark` のみ、`chrome.storage` は `journal-store.js` のみに閉じる。
- バッチの実行寿命（ロック取得、イベント台帳、ジャーナル、中止、再開）は `extension/ui/execution-controller.js` が持つ。`options.js` はイベント配線と描画に限定する。
- コントロールの有効/無効と、スコープ警告の判定は `core/ui-state.js` の純粋関数が持ち、UI 層は結果を DOM へ写すだけにする。`disabled` を書くのは `applyControlState()` の 1 箇所に限り、テストで固定する。
- 計画ファイルは untrusted input として扱う。描画は `textContent` 経由のみで、HTML sink を使わない。

### ソース走査テストの注意

ソースファイルは Windows では CRLF になる。オフセットや `indexOf("\n}\n")` で関数本文を切り出す静的ガードは、読み込み時に `\r\n` を `\n` へ正規化してから使う。正規化を忘れると本文の切り出しに失敗し、**ガードが全ファイルを検査して誤って PASS する**。

## Accessibility

- 配色は light / dark の両方で WCAG AA（通常テキスト 4.5:1）を満たす。`--fg` / `--muted` / `--ok` / `--warn` / `--error` を `--bg` と `--panel` の両方に対して、`--accent-fg` を `--accent` に対して検査する。ダークモードでは意味色（accent / ok / warn / error）を必ず上書きする。上書きが無いと 2.8〜3.6:1 まで落ちる。
- 比率はテストが `styles.css` を実際にパースして計算する。ハードコードした期待値ではないので、色を変えれば検査も追随する。
- テキストを `opacity` で薄くしない。計算上のコントラストを黙って壊すため、`:disabled` 以外での `opacity` はテストで禁止する。
- キーボードフォーカスは `:focus-visible` で可視化する。
- 生成する表のヘッダーには `scope="col"` を付ける。パネル内の生成見出しはセクションの `h2` に続く `h3` に揃え、レベルを飛ばさない。

## Presentation

- 数値は locale で桁区切りする。翻訳パラメータの数値は `createTranslator` が自動で整形し、表へ直接入れる値は `formatCount` を通す。`String(n)` で数値を表示しない。
- バイト数は `formatBytes` で B / KiB / MiB / GiB にする。単位はメッセージ文ではなく値側に含める。`LocalizedError` のパラメータは `sizeBytes` / `limitBytes` のように単位を名前へ入れ、`describeError` がそれだけをサイズとして描画する。単なる `limit` は数値のまま出す。
- 64 文字のダイジェストは文中に生で出さず `formatDigest` で先頭 12 文字 + 省略記号にする。完全な値は書き出したファイル側に残す。
- 折り返しは `overflow-wrap: anywhere` を使う。`word-break: break-all` は長い URL のために入れていたが、文言が散文中心になった今は通常の単語まで途中で割るのでテストで禁止する。
- 配置対象の選択は恒久ルートごとの `optgroup` に分ける。option ラベルはルート部分を落とすが、落とすと別ルート配下と同名になる場合と、ルート自身の場合は完全パスを出す。判定は `foldersByPermanentRoot` の純粋関数側で行う。
- 行が 0 件のときはヘッダーだけの表を描かない。件数の要約行は常に出す。

## Permissions

- `bookmarks`: ツリーの読み取り、move、Trash フォルダーを 1 つ作るための空フォルダー作成、および Trash 台帳下の項目を 1 件ずつ永続削除すること。
- `storage`: `chrome.storage.local` に 2 つのキーだけを持つ。`apply-journal` は rollback 用でバッチが確定したら削除し、`trash-ledger` は Trash receipt を保持する（上限は Known Limitations を参照）。ホスト権限、`optional_permissions`、`content_scripts`、`background` はいずれも持たない。`check:store` が完全一致で固定する。
- スナップショット書き出しは Blob URL + `<a download>` で行うため `downloads` 権限は不要。

## Localization

- UI は英語と日本語。SSOT は `extension/src/core/messages.js` で、`_locales/{en,ja}/messages.json` はマニフェストの `__MSG_*__` が参照する 3 キーだけを持つ。両者の一致はテストで検査する。
- 既定ロケールは `chrome.i18n.getUILanguage()` → `navigator.languages` の順で解決し、`en` にフォールバックする。ユーザーの明示選択だけを `localStorage` に保存する（唯一の `localStorage` 用途で、テストで局所化を検査する）。
- `chrome.i18n` の言語はブラウザー UI 言語に固定されて実行時に切り替えられないため、ページ内の文言は自前カタログで描画する。`_locales` はマニフェスト表示名の多言語化のみに使う。
- core が返す分類・エラーはロケール非依存のメッセージキー（`detail.*` / `schema.*` / `status.*`）で、翻訳は UI 層だけが行う。
- 拡張機能自身が投げるエラーは `LocalizedError`（`extension/src/core/errors.js`）にメッセージキーを載せ、UI が `describeError` で翻訳する。プラットフォーム由来のエラー（`JSON.parse` など）は元の文言のまま、ローカライズ済みの枠に入れて表示する。カタログの未使用キーはテストで検出する。

## Browser Support

- Chrome / Edge 134 以降（`BookmarkTreeNode.syncing` に依存するため）。
- Edge は Chrome 拡張機能 API と互換で、`bookmarks` / `i18n` とも Manifest V3 で対応する。参照: <https://learn.microsoft.com/ja-jp/microsoft-edge/extensions/developer-guide/api-support>
- Edge へのポート条件として `update_url` を持たないこと、表示名と説明に `Chrome` を含めないことをテストで検査する。参照: <https://learn.microsoft.com/ja-jp/microsoft-edge/extensions/developer-guide/port-chrome-extension>
- 実行環境の判定は `navigator.userAgentData.brands`（フォールバックは UA 文字列）で行い、UI 表示のみに使う。

## Agent Handoff

- 拡張機能は分類しない。分類はエージェントが行い、拡張機能はライブツリーとの照合と Dry Run を担当する。
- **計画 JSON が表現できるのは `type: "move"` と、スキーマ v2 の `type: "update"`（ブックマークの改名）だけ。** 削除・URL 変更・フォルダー作成・フォルダーの改名は計画に書けない。ただしこれは入力形式の制約であって、**エージェントの権限の上限ではない**。ブラウザー操作を持つエージェントは人と同じ UI 操作をできる。
- **境界をまたぐ移動は拒否されるが、その拒否は `syncing: true` を含むプロファイルでは実機未検証である。** エージェントに境界をまたぐ計画を作らせない。
- 引き渡しはフォルダー単位でスコープできる。`scopeFolderId` を指定すると `bookmarks[]` はそのサブツリーだけになるが、`folders[]`（移動先候補）と `boundaries[]` は常にプロファイル全体を保つ。スコープ外への移動が主目的なため。未知の `scopeFolderId` は全体にフォールバックする。
- `agent-context.json` は `bookmarks[]`（id / title / url / path / parentPath / boundary）、`folders[]`（移動先候補と `isPermanentRoot` / `unmodifiable`）、`boundaries[]`、`ambiguousFolderPaths[]`、`treeDigest` を含む。
- `ambiguousFolderPaths` を先に渡すことで、`destination-ambiguous` になる計画をエージェント側で回避させる。
- プロンプトは `extension/src/core/agent-prompt.js` が件数と曖昧パスを埋め込んで生成する。文言はラベルではなく文書なのでメッセージカタログには置かない。
- クリップボードは操作しない。生成物は読み取り専用 textarea への表示とファイル書き出しのみ。
- ツリーを再読み込みしたら、重複レポート・エージェント引き渡し・Dry Run 結果はすべて破棄する。派生パネルはツリーの世代 (`state.generation`) に紐づき、古い世代の非同期完了は表示に反映しない。`treeDigest` と `entries` は await を挟まず同期でコミットする。

## Agent Command API

DOM をスクレイピングさせないための、バージョン付きの入口を options ページに 1 つだけ公開する。

ページ初期化と API 公開の後、ツリーが未読込なら `loadTree({ focus: false })` を一度だけ呼ぶ。読込中の再入は既存の `state.loading` で拒否し、完了後の再読込はユーザー操作に限定する。自動読込はフォーカスを移さず、スナップショット保存もブックマーク変更も行わない。失敗時は既存のエラー表示と手動再試行を利用する。`agent.error.noTree` はツリー未読込を示し、API の不存在を意味しない。復旧待ち journal の検出と Apply の安全ゲートは既存処理を維持する。

- 公開は `extension/ui/agent-api.js` の 1 文のみ。`Object.freeze` したオブジェクトを `defineProperty` で non-writable / non-configurable にする。これは偶発的な差し替えを防ぐだけで、CDP クライアントに対する防御にはならない。
- 語彙と入力検証と戻り値の形は pure core の `extension/src/core/agent-command.js` が持つ。`COMMAND_NAMES` は handler マップから導出せず、リテラルで固定する。
- 入口は `run(command, input)` の 1 つ。全 command が同じ検証を通ることを、dispatch 箇所が 1 つであることとあわせて静的に固定する。
- **状態を変える handler は対応する UI コントロールの `disabled` を先に見る**（`loadPlan` / `dryRun` / `apply` / `verify` / `rollback`）。ボタンが拒否している状態を API が迂回できない。書き込みを伴う command は、ボタンが呼ぶのと同じ関数を呼ぶ。`getStats` / `getTree` / `search` はツリーの存在を確認してから `requireControl("export-tree")` を通り、読込中だけでなくUIが実行するバッチ中も拒否する。`getSession.ready` も同じコントロールに従い、診断用に `loading` と `mode` を分けて返す。`ready` は呼出時点の読取可否であり、ツリーの鮮度や実行中の書き込みに対するロック取得を意味しない。
- **逐次実行**。実行中の command があれば `agent.error.busy` で拒否する。同一 tick から 2 つ走らせると journal で競合するため。
- **入力検証は例外変換の内側で行う**。入力は untrusted なので、自分のキーを読むだけで throw し得る（throwing getter / Proxy）。固定形を返すという契約を守る。
- `emptyTrash` / `exportSnapshot` / `sendToTrash` / `restoreBatch` は公開しない。これはスコープの選択であって安全境界ではない。
- `apply` はバックアップの再選択（ファイルピッカー = 人の操作）を前提にするので、**API だけでは適用を完結できない**。

### ページ送りと接続先

`getTree` と `search` は共通の `paginateEntries` を使い、1ページ最大500ノードのまま `nextCursor` / `truncated` / `snapshotId` を返す。cursor は `{ snapshotId, offset, command, query }` の固定形で検証し、別command・検索条件・世代への流用を拒否する。ページ初期化で生成するランダムな `sessionId` と `state.generation` を組み合わせるため、同じ内容を再読込した場合も古いcursorは失効する。外部のブックマーク変更ではなく、ページに読み込んだツリーの世代を固定する契約である。

取得CLIはloopbackのCDP endpoint、拡張オプションの完全一致URL、target ID、session IDを照合する。各評価前にURLを再確認し、呼び出すのは `capabilities` / `getSession` / `getStats` / `getTree` のみ。全ページの件数・世代・ID一意性・終了時セッションを照合してから、明示指定された新規ファイルだけを書き出す。ラベルは出力用の利用者指定名であり、認証やプロファイルの自動判定ではない。旧APIや途中失敗を直接書き込みAPIへの切り替え理由にしない。

UIから開始したバッチ中もツリー読取を拒否し、CLI一覧では `mode` を表示して件数を `null` とする。開始前・ページ間・全件取得直後のロック検出はいずれも収集失敗であり、途中の一覧を保存しない。バッチ完了後は読み込み済みスナップショットを取得できる。実機pilotではUIの最初のmoveを一時停止して、API拒否・CLI診断・ファイル未生成を確認し、解除後に適用・検証・ロールバックまで継続する。

### 静的ゲートが証明する範囲

証明できるのは**公開の形**だけである。公開文が 1 箇所、凍結済みオブジェクトリテラル、`writable: false` / `configurable: false`、dispatch 前に検証が入ること、他に `window` への代入がないこと。

「すべての command がゲートを通る」は推移的な実行時の性質で、regex では証明できない。それは dispatcher spy を使う wiring test と、CDP から実際に呼ぶ `run-pilot.mjs` が担当する。

### これは権限境界ではない

このオブジェクトへ到達できるものは、同じページで `chrome.bookmarks` を直接呼べるし、すべてのコントロールをクリックできる。到達できるのは拡張機能 origin のスクリプト、devtools / CDP、そして `debugger` 権限を持つ別拡張機能。通常の Web origin からは到達できない。

したがって API の存在は新しい権限を与えていない。与えているのは**安定した契約**で、DOM 変更で壊れることと、エージェントが別のボタンを誤って押すことを減らすためのものである。

## Boundary Rules

- account / local の境界判定は `BookmarkTreeNode.syncing`（Chrome 134+）のみを鍵にする。`folderType` や恒久ルート ID は鍵に含めない。同一ストア内では「その他のブックマーク → ブックマーク バー」の移動が正当なため。
- `syncing` が取得できない runtime では境界を証明できないので `boundary-indeterminate` として fail closed する。
- `unmodifiable`（`managed`）のノードは移動元・移動先いずれも拒否する。
- 恒久ルート自体は移動できない。フォルダを自身または自身の子孫へ移動する操作も拒否する。

参照: <https://developer.chrome.com/docs/extensions/reference/api/bookmarks>

## Plan Format

`extension/schemas/bookmark-plan.schema.json` を SSOT とする。`currentPath` / `destinationPath` は区切り文字の曖昧さを避けるため文字列配列で表現する。

`destinationFolderId` は任意項目だが、存在する場合はそのノードのライブ path が `destinationPath` と一致していなければならない。不一致は優先規則ではなく **hard error (`destination-conflict`)** として扱う。人間がレビューした移動先と実際の移動先が食い違うことを防ぐため。

逆に、同名 path のフォルダが複数ある場合は `destinationFolderId` だけが移動先を一意にできる。このときも path 一致を要求するので、表示と実行対象は一致したままである。`destinationFolderId` がない場合のみ、複数一致を `destination-ambiguous` として拒否する。

`originalParentId` / `originalIndex` は計画ファイルから受け取らない。Phase 2 で移動直前にライブツリーから読み取り、ジャーナルへ記録する。

`operations` は空配列を許容する。スコープした引き渡しでは「全件その場に残す」もエージェントの正当な結論であり、それを表現できない契約にしないため。据え置いた理由はトップレベルの `notes` に書かせ、Dry Run の先頭に表示する。操作単位の `reason` は move にしか存在しないので、そこに据え置き理由を要求しない。

## Dry Run Classifications

`movable` / `no-op` / `duplicate-op` / `unsupported-op-type` / `id-not-found` / `permanent-root-source` / `unmodifiable-node` / `title-mismatch` / `url-mismatch` / `current-path-mismatch` / `destination-not-found` / `destination-ambiguous` / `destination-id-not-found` / `destination-not-folder` / `destination-conflict` / `destination-unmodifiable` / `destination-is-descendant` / `boundary-violation` / `boundary-indeterminate` / `operation-interdependent`

`movable` 以外は適用対象にしない。

## Apply Phase

Phase 2 の 8 つの入場条件は次のように実装した。

1. **バックアップの往復検証** — 書き出したスナップショットの SHA-256 を保持し、ユーザーが保存済みファイルを再選択してバイト一致し、かつファイル内の `treeDigest` が現在のツリーと一致するまで Apply を解錠しない。
2. **承認バインディング** — Dry Run がブロック 0 件のときだけ approval token を作る。token は `planDigest` / `treeDigest` / `snapshotDigest` と **順序付き** `approvedOpIds` を持つ。Apply 直前にツリーを取り直して両ダイジェストを再計算し、承認済み opId が再分類後も全件 `movable` であることを要求する。
3. **再開経路の独立したバインディング** — resume は `treeDigest` を使わない。ジャーナルの `planDigest` と `snapshotDigest` の一致に束縛し、`attempted` のまま残ったエントリはライブノードだけで「目標位置＝適用済み / 元位置＝未適用 / それ以外と消失＝conflict」に分類する。
4. **複数タブの排他** — バッチ全体を `navigator.locks` の `ifAvailable` で囲む。取得できなければ実行せず拒否する。
5. **境界の移動前後の検証** — 移動直前にツリーを取り直して `validator` の per-op 評価を再実行し、移動直後に `get([moved, destination])` で両者の `syncing` が同じ boolean であることを要求する。単一ノードの `get` 結果を `isBoundaryIndeterminate` に渡してはならない（恒久ルート祖先を必要とするため）。
6. **外部変更の検知と即時 abort** — 期待イベント台帳を move 前に登録し、5 項目一致の `onMoved` だけが 1 回だけ消費できる。台帳に一致しない move、消費済みエントリへの再一致、`onCreated` / `onRemoved` / `onChanged` / `onChildrenReordered` / `onImportBegan` はいずれも即時中止。加えて、move ごとに期待ツリーを純粋関数で射影し、次の move の直前にダイジェストを照合する。**この射影チェーンはイベントの発信者に依存しない決定論的な検出器**であり、台帳の弱点を補う。
7. **クランプなしの厳密 rollback** — 適用の逆順に、各ノードが移動直前に持っていた index へ戻す。戻した直後に `parentId` と `index` を照合し、一致しなければ `rollback-conflict` として中止する。
8. **スナップショットからの復元と出自検証** — プロファイル全体の一致率は診断のみ。実際に動かすのは、対象ノード・移動先フォルダー・移動先パス上の全祖先が `id` + 種別 + `dateAdded` + `title` + `url` で個別に一致したものだけ。恒久ルートだけは表示名がロケール依存のため id と種別で照合する。

### Operation Independence

`dryRun` は各操作を元ツリーに対して独立に評価する。したがって操作どうしが干渉する計画は適用できない。次のいずれかに当てはまる movable の組は `operation-interdependent` として**両方拒否**する。

- ある操作の移動元が、別の操作の移動元または移動先の祖先である
- ある操作の移動先が、別の操作の移動元の親フォルダーである（append した index が後からずれる）

この規則があるため、承認済み操作は互いに独立で、Verify が `(parentId, index)` を厳密比較できる。順序付き実行とツリー・シミュレーターによる一般化は Phase 3 以降の課題。

### Index Semantics

- Apply が同一親の move を出すことはない。`dryRun` が同一親を `no-op` に分類するため。rollback も同じ理由で必ず親をまたぐ。
- 同一親の並べ替えが起きるのは Restore だけ。move API の `index` は「ノードを外す前の親における挿入位置」として扱われるため、`apiIndexForMove` が最終位置から API 引数へ変換する。この挙動は公開ドキュメントに明記がないので、**移動後の読み戻しが最終的な判定**であり、想定が外れた場合は静かにずれるのではなく中止する。

## Untrusted Input

- 計画ファイルとスナップショットファイルは untrusted input として扱う。読み込む前に `file.size` を検査する。
- Dry Run の行描画は `MAX_RENDERED_ROWS`（500）で打ち切る。件数集計は全操作を含むままにし、打ち切ったことを明示する。
- 重複レポートはグループ 100 / グループ内メンバー 50 で打ち切る。どちらも展開で全件表示でき、**打ち切られたグループは送信対象から外す**。見えていないコピーを「残り」に含めないため。
- ブックマークの title / URL と計画ファイルの内容はすべて `textContent` 経由で描画する。HTML sink、`href` への流入、`eval` はテストで禁止する。生成する `<a download>` の URL とファイル名にユーザー入力を入れない。
- `localStorage` に保存するのは UI 言語のみで、読み出し時に `SUPPORTED_LOCALES` で allowlist 検査する。
- CSP は `script-src 'self'; object-src 'self'` を明示宣言し、`unsafe-eval` / `unsafe-inline` / リモート scheme / `sandbox` / `web_accessible_resources` / `externally_connectable` が無いことをテストで固定する。

## Batch Size

- Apply は 1 操作ごとにツリー全体を再取得するので、`MAX_BATCH_OPERATIONS`（200）を超える計画は**承認させない**。判定は Dry Run の行状態とは独立に行い、超過時は `dryRunRows` を埋めないので承認トークンが生成されない。手動・ファイル・重複隔離のどの経路もこの 1 箇所で塞がる。
- 重複隔離の送信は、既に選択済みの件数を引いた**残り容量**だけを追加する。選択済みの id を先に除外してから容量で切るので、適用 → ツリー再読み込み → 再送信で次のバッチへ進める。
- **Restore には上限を掛けない。** 復旧経路に上限を掛けると、大きなスナップショットを持つ利用者が復旧途中で立ち往生する。この非対称は意図的で、代償として大きな Restore は進捗表示のまま長時間 UI を占有しうる。

## Measured Scale

`npm run scale` が使い捨てプロファイルに **5000 ブックマーク / 101 フォルダー / 3 件ずつの重複 50 グループ**を作り、各段階を実測する。以下は Edge 151.0.4129.78、開発機 1 台での clean run 4 回分の幅。

| 段階                                                   | 実測（ms）       |
| ------------------------------------------------------ | ---------------- |
| `chrome.bookmarks.getTree()` 単体                      | 74〜156          |
| ツリー読み込み全体（取得 + flatten + digest + 各描画） | 162〜456         |
| 重複検出と描画                                         | 83〜216          |
| ビルダーの絞り込みと再描画                             | 16〜61           |
| エージェント context 書き出し                          | 39〜216          |
| 200 操作の計画作成と Dry Run                           | 48〜57           |
| **200 行を 1 件ずつ選択**                              | **9.3〜15.2 秒** |

- 5000 件規模でも、1 回のユーザー操作あたりの応答は概ね数百 ms に収まる。API 単体とツリー読み込み全体の差は観測できるが、その差を flatten / digest / 各描画へ分解する計測はしていないので、内訳は未特定のままにしておく。
- 例外は**選択の積み上げ**で、1 クリックあたり 47〜76 ms かかる。「選択中の項目は常に全件表示する」という安全上の決定から、チェックのたびにビルダーパネル全体を再描画するためで、件数に比例して増える。200 件を手で選ぶ運用は現実的でないので、その規模は重複レポートからの一括送信で入力する。
- **この数値は budget ではない。** 開発機 1 台の wall-clock なのでゲートにはせず、`run-scale.mjs` が pass/fail に使うのは機能的な不変条件だけにしている（シードした形状、描画した重複グループ数、描画上限、選択できた件数、Dry Run がブロック 0 で戻ること、使い捨てプロファイルが削除できたこと）。
- 計測器自身の落とし穴が多いことも実測で分かった。実際にこのハーネスが一度ずつ踏んだものを残しておく。
  - ページは読み込み中に全コントロールを disabled にするので、無効なボタンへのクリックは黙って捨てられる。待ちを入れなかった初期版は、自身のクリック取りこぼしを「ツリー読み込みに 135 秒」と誤って記録していた。
  - 選択は 1 件ごとにパネル全体を再描画するので、`querySelectorAll` の結果を保持して順にクリックすると 2 件目以降は切り離されたノードを叩いている。毎回引き直す。
  - オプションページの `options.js` は module なので、開いた直後はまだハンドラーが付いていない。最初の冪等な操作だけはクリックを再試行する。
  - Dry Run のパネルは分類サマリー表と操作表の 2 つを描画するので、`table tbody tr` を数えると操作数と合わない。
  - 直前の操作が書いた `dataset.kind` が残っているので、待つ前にステータスを消さないと条件が即座に成立し、次の操作が前の操作と競合する。

## Known Limitations

- Apply 直後の再取得はローカルのブックマークモデルを検証するだけで、アカウント同期への反映や他端末への収束を証明しない。同期完了を確認する公開 API は存在しない。
- Trash フォルダーの作成は、作成後にツリーを取り直して配置と親の祖先鎖を照合する。照合に失敗した場合は Trash として採用しないが、**作成済みのフォルダーは残る**。削除経路は Trash 台帳下の項目に限定していて、台帳に乗っていないこのフォルダーを自動で消すことはしない。id を提示してユーザーに手動削除を促すところまでが対応範囲。
- Bookmarks API には条件付き更新もバッチ原子操作もない。同期・他端末・手操作との競合は排除できず、「検知して即座に中止し、ジャーナルと検証で復旧可能にする」までが保証範囲。
- イベントに発信者情報がないため、**このバッチが実行しようとしている操作列と完全に同値な外部操作列**は帰属できない。その場合でも最終的なツリー状態は意図した状態と一致し、Verify は真実を返す。保証するのは「意図と異なる変更を検知・中止・復旧可能にする」ことであり、「各書き込みの発信者を証明する」ことではない。
- 同じ理由で、rollback はノードがすでに元の `parentId` / `index` にあれば「戻し済み」と記録する。逆移動直後のクラッシュから再開できることを優先した判断で、外部が元の位置へ戻した場合も同じ扱いになる。到達状態はいずれも意図した位置で、失われるのは帰属情報だけ。
- 期待ツリーの射影は `parentId` / `index` しか予測できない。`syncing` / `folderType` / `unmodifiable` はブラウザー側で変化しうるため、変化すれば drift として中止する（安全側の偽陽性）。中止時はどの項目が違ったかを表で提示する。
- 重複隔離は move なので、隔離後もツリーを再読み込みすれば同じ URL グループが引き続き報告される。隔離先の直下にいるメンバーを送信対象から外すことで収束させるが、レポートからグループが消えるわけではない。
- 削除は不可逆で、**削除済み項目を再作成する機能は存在しない**。`deleted` になった receipt は監査記録としては有効だが、復旧には使えない。
- Trash 台帳には上限がある。receipt は最大 500 件、台帳全体のシリアライズサイズは 1 MiB、title / URL は各 2048 文字まで。既存件数と追加件数の合計が上限を超えるバッチは、**書き込みを一切行わずに**拒否する。
- 境界の実値は `syncing: false` のプロファイルでしか実機確認できていない。`syncing: true` と `false` が共存するアカウント同期プロファイルでの境界越え拒否は **未検証**。判定ロジック自体は `tests/validator.test.js` の boundary-violation / boundary-indeterminate ケースで固定されているが、実機で確かめるまで「検証済み」とは書かない。
- 実機検証の手順: `PILOT_SIGNIN_PAUSE=1 npm run pilot` を実行すると、**ブラウザーを起動する前に**リスクを提示して `yes` を求める。同意後に使い捨てプロファイルを sync 有効で起動し、サインイン前にローカル marker を作り、そこで停止する。そのウィンドウでテスト用アカウントにサインインし、同期の有効化と既存ブックマークのアップロードをいずれも断ってから Enter を押すと、期限付きで 2 つ目のストアの出現を待つ。**異なる 2 つの境界が実在する場合に限り**両側に fixture を作って境界越えが拒否されることを確かめる。2 つ揃わなければ観測値を名指して SKIP する。サインイン自体は検証対象ではないので、「サインインしていない」とは報告しない。
- 境界の eligibility は `syncing` が boolean で、かつ `unmodifiable` が付いていない恆久ルートに限る。`folderType` は証拠として記録するだけで条件にしない（同一ストア内の「その他 → ブックマーク バー」は正当な移動なので、`folderType` の一致を要求すると実在の 2 ストアを取りこぼす）。managed ルートを除くのは、それが常に `syncing: false` を返すため、単一ストアのプロファイルが 2 境界に見えてしまうから。
- 境界 PASS の条件は、`dryRun` コマンドの成功、`approvable === false`、`plan-status` が `warn`、操作行がちょうど 1 件、その行がこの実行の fixture を指すこと、status セルが拡張機能自身のカタログの `status.boundary-violation`（出荷している全ロケール分）と一致すること、Apply がロックされたままであること。1 つでも欠ければ FAIL。「2 つ目のストアが現れなかった」場合だけが SKIP。
- **実測結果（2026-08-14）: 境界は依然として未検証。** sync 有効で起動した使い捨てプロファイルで観測できた境界キーは `syncing:true` の 1 つだけだった。プロファイル全体がアカウント同期側になり、ローカルストアが同居しなかったため。cross-boundary の拒否は実行されていない。
- **再検証は Chrome を要求するが、harness は現時点で Chrome を駆動できない（2026-08-14 実測）。** 2 ストアを作る手順は Chrome の手順（サインインして同期を断る）で、Edge が同じ dual store を提供するかは未確認のため、`PILOT_SIGNIN_PAUSE=1` は Chrome 以外を拒否する。一方 Chrome 151 では `Extensions.loadUnpacked` が id を返すのに `Extensions.getExtensions` の一覧に現れず、拡張機能が実際には入らないため options ページを駆動できない（WebSocket 接続では Extensions ドメインが実質的に効かない）。`--remote-debugging-pipe` への移行が前提条件になる。Edge 151（`Edg/151.0.4129.78`）では従来どおり駆動できる。
- **危険: 使い捨てプロファイルが勝手にサインインし得る。** 同じ実測で、起動時 0 ノードだったプロファイルが、誰もウィンドウを触らないまま pause 中に **665 ノード**へ増えた（Edge のシングルサインオンで既存アカウントが入った）。人の実ブックマークの中で fixture を作って削除することになるので、同意はブラウザー起動前に無条件で取る。ノード数は証拠として記録するだけで、ゲートにはしない（10 件しかない実アカウントも実アカウントであり、件数では使い捨てかどうかを判定できない）。
- サインイン実行の後始末: 作った fixture はプロファイル削除前にローカルで消す。削除は `finally` で行い、収集した id を消したうえで実行ごとの nonce で全ツリーを掃く（create の応答が CDP で失われても、名前なら見つけられる）。**その削除がアカウント側へ届いたかは harness から証明できない**ので、実行後にアカウントを目視で確かめる。

## Phase 3 Prerequisites

Phase 2.5 の削除は「ユーザーが Trash へ送ったものを、1 件ずつ確認しながら消す」だけの範囲。下記は、ここから**拡張機能側が削除対象を選ぶ**方へ進む場合の前提条件。

- 同一性判定を URL 一致だけに依存しない（正規化前後の URL、title、親、index、`dateAdded`、判定規則のバージョンを削除対象に紐づける）。
- 削除前スナップショットを拡張機能ストレージの外に持ち、中断後も再照合できる形式にする。
- 削除後に、削除対象以外の全ノード ID・親子関係・順序が不変であることを検査する。
- 現行ビルドに**削除済み項目の再作成機能はない**。付ける場合は、再作成が新しい ID を採番する非対称性を UI で明示し、台帳とスナップショットの identity 契約を先に再設計する必要がある。

# Chrome Web Store listing copy — Splendid Bookmarks

Two locales. The summaries mirror the localized manifest description in the extension
package; editing this document does not change the live summary. Paste each detailed
description into the matching language in the Developer Dashboard's Store listing tab.

Read this against the build before every submission. It must not claim the extension is
read-only or that it cannot delete bookmarks: it can, from the Trash, after a confirmed
two-step flow.

This copy targets release 0.6.0. Use it with the matching package; dashboard submission
and public availability must be verified separately.

---

## English

### Summary

```text
Let coding agents search, move and rename your bookmarks, with dry runs, verified backups and rollback.
```

### Detailed description

```text
Splendid Bookmarks is built for coding agents to work with your browser bookmarks.
It gives an agent an API to inspect and search the tree, load an organisation plan,
run a Dry Run, apply changes, verify the result and request rollback.

CONNECT YOUR AGENT

Direct operation requires a coding agent with browser automation access to the extension's
manager page, for example through Chrome DevTools Protocol (CDP). Installing this extension
does not connect your agent automatically. It does not include an AI model or contact an
AI service itself. The manager automatically loads the tree when opened. Use getSession
to check readiness; if loading fails, use Load tree to retry.

Copy agent instructions from the top of the manager. The instructions include the
manager/session identity, browser-reported family, tree capture time and scope. Optional
profile labels and CDP hints remain unverified. The agent is asked to reuse a matching
connection, propose changes before execution, request restart approval and preserve your
foreground work. These instructions are not an enforcement boundary for external tools.
Connected agents read the tree through the API; a context file attachment is not required.

The entry point is window.splendidBookmarks.run(command, input). Commands include
capabilities, getSession, refreshTree, getStats, getTree, search, listTrash, loadPlan, dryRun, apply,
verify and rollback. Tree and search results are paginated, with up to 500 entries per
page. Follow nextCursor to collect the rest. Reloading the tree invalidates older cursors.
Reads respect the manager's operation locks, and getSession reports the current mode.
Tree rows include boundary and protection flags. Dry Run and verification return
per-operation results, and apply can check the approved plan digest. Each batch is
limited to 200 operations. Scope and goal are independent; an unavailable scope is not
silently expanded to the whole profile.

A separate inventory CLI is available in the project repository for Node.js 22
and CDP. It verifies the selected tab, session and complete page counts before an optional
JSON export. The CLI is not installed by adding this browser extension.

You can also export a context file and a ready-made prompt, ask an agent to prepare a
plan, and import its JSON result without giving the agent browser access.

WHAT YOU CAN DO

• Inspect and search your bookmarks before deciding what to change
• Ask an agent to propose moves into existing folders
• Rename bookmark titles through a plan, without changing URLs or folder names
• Preview, apply and verify a batch of moves or title changes, then request rollback
• Find duplicate URLs and move the copies you select into a review folder
• Use the same manager by hand when you do not need an agent

REVIEW BEFORE APPLYING

Export a snapshot, review the Dry Run and re-select the backup file to verify it before
applying a plan. The API follows the same controls as the manager; it does not replace
the backup-file selection step. An agent's browser access is not sandboxed by this API.
Rollback is available for a batch, but it can stop if items have changed in the meantime.
An exported snapshot can restore positions; reverting a title change requires batch rollback.

TRASH AND PERMANENT DELETION

Sending bookmarks to Trash is a reversible move. Permanent deletion is a separate,
confirmed action in the manager: it requires a verified backup, checks each recorded
item and stops on a mismatch. That deletion cannot be undone by this extension.
Recursive folder deletion is not supported.

PRIVACY AND PERMISSIONS

The extension itself does not send bookmark data to the developer or an AI service.
It has no network requests, analytics, telemetry or host permissions. Recovery records
and your language preference stay on your device.

Copy agent instructions writes the generated text to the clipboard only when clicked;
it never reads the clipboard. The text includes local target information and any optional
connection hints you enter. Operating-system clipboard history or sync may retain it.

If you share context with an external agent or give it browser access, that tool may
process bookmark titles and URLs under its own settings and privacy policy.

Permissions: "bookmarks" for reading and organising bookmarks, and "storage" for the
local execution journal and Trash recovery ledger. No AI subscription is bundled.
```

---

## 日本語

### 概要

```text
コーディングエージェントからブックマークを検索・移動・改名。Dry Run、バックアップ検証、ロールバックで整理を支援します。
```

### 詳細な説明

```text
Splendid Bookmarks は、コーディングエージェントからブラウザーのブックマークを操作するための
拡張機能です。専用APIを通じてツリーの確認・検索、整理計画の読み込み、Dry Run、適用、検証、
ロールバックを行えます。

エージェントとの接続

直接操作には、CDP（Chrome DevTools Protocol）などで拡張機能のマネージャー画面を操作できる
コーディングエージェント環境が必要です。インストールだけでエージェントと自動接続するわけでは
ありません。AIモデルは内蔵しておらず、拡張機能自身がAIサービスに接続することもありません。
マネージャーを開くとツリーを自動で読み込みます。getSessionで準備状態を確認し、失敗した場合は
「ツリーを読み込む」で再試行してください。

マネージャー上部からエージェントへの指示文をコピーできます。管理画面・セッションの識別情報、
ブラウザー自己申告の種別、ツリー取得時刻、対象範囲を自動で含めます。任意入力の呼び名やCDP接続先は
未検証として区別します。エージェントには対象を照合して既存接続を再利用し、実行前に整理案を提案すること、
再起動前の承認と前面作業の維持を指示します。外部ツールの挙動を強制制御する機能ではありません。
接続済みエージェントはAPIから取得するため、コンテキストJSONの添付は不要です。

操作の入口は window.splendidBookmarks.run(command, input) です。capabilities、getSession、
refreshTree、getStats、getTree、search、listTrash、loadPlan、dryRun、apply、verify、rollback を利用できます。
ツリー取得と検索は1ページ最大500項目で、nextCursorを使って続きを取得できます。ツリーの
再読込後は古いcursorを拒否します。読取APIも画面の操作ロックに従い、getSessionで現在の
実行モードを確認できます。
取得行には同期境界と保護情報を含め、Dry Runと検証は操作別の結果を返します。適用時は承認した
計画のダイジェストを照合できます。1バッチの上限は200操作です。対象と整理目的は別々に選択し、
対象フォルダーが消えた場合は停止して再選択を求めます。

リポジトリにはNode.js 22とCDPを使う一覧取得CLIもあります。対象タブ・セッション・
全件数を検証してから必要に応じてJSONを保存します。CLIは拡張機能のインストールには含まれません。

ブラウザーへのアクセスを与えず、コンテキストファイルと定型プロンプトをエージェントへ渡し、
返ってきた計画JSONを読み込む使い方もできます。

できること

• 変更前にブックマークの一覧や検索結果を確認する
• エージェントに既存フォルダーへの移動案を作らせる
• 計画を通じてブックマークのタイトルを変更する（URL変更・フォルダー改名は対象外）
• 移動・改名のバッチをプレビューし、適用・検証・ロールバックを行う
• 重複URLを検出し、自分で選んだコピーを確認用フォルダーへ移動する
• エージェントを使わず、同じマネージャーで手動整理する

適用前の確認

スナップショットを書き出し、Dry Runを確認し、バックアップファイルを再選択して検証してから
計画を適用します。APIも画面と同じ操作条件に従い、バックアップ再選択を代行しません。
このAPIは、エージェントに与えたブラウザー操作権限を制限する仕組みではありません。
バッチはロールバックできますが、その後に項目が変更されている場合は停止することがあります。
スナップショットから復元できるのは配置で、改名を戻すにはバッチのロールバックが必要です。

Trashと永続削除

Trashへの退避は元に戻せる移動です。永続削除はマネージャー上の別の確認付き操作で、
検証済みバックアップを必要とし、記録した項目を1件ずつ照合して不一致があれば停止します。
永続削除した項目はこの拡張機能では元に戻せません。フォルダーごとの再帰削除は非対応です。

プライバシーと権限

拡張機能自身は開発者やAIサービスへブックマークデータを送信しません。ネットワーク通信、
アナリティクス、テレメトリ、ホスト権限はありません。復元用の記録と表示言語の設定は端末内に
保持します。

指示文のコピーはボタンを押したときだけ行い、クリップボードは読み取りません。コピー内容には
ローカルの対象情報と任意入力の接続情報が含まれます。OSのクリップボード履歴や同期設定によっては
コピー内容が保持されます。

外部エージェントにコンテキストを渡したりブラウザー操作を許可したりすると、そのツールの設定・
プライバシーポリシーに従ってブックマークのタイトルやURLが処理される可能性があります。

権限は読み取り・整理用の "bookmarks" と、実行ジャーナル・Trash復元台帳用の "storage" です。
AIサービスの利用契約は付属しません。
```

# Privacy Policy — Splendid Bookmarks

Last updated: 2026-09-07

## English

**The extension itself makes no network requests to the developer, a server or a third party.**
It does read your bookmarks, and it does keep a few small records on your own device. Both
are itemised below, because "nothing leaves your computer" is not the same as "nothing is
read or stored".

### What the extension reads

With the `bookmarks` permission, the extension reads your bookmark tree: each bookmark's
title, URL, folder path, position, and the browser-provided flags that tell account-synced
bookmarks apart from local ones. It reads this only while its manager page is open.
Version 0.4.0 requires a tree-load action; version 0.5.0 starts the first
read automatically when the manager opens. Neither reads bookmarks in the background
after the manager is closed.

### Where that data goes

Nowhere. The extension has no server, makes no network requests of any kind, and contains
no analytics, telemetry, or advertising code. Its content security policy forbids loading
remote code, and it declares no host permissions.

Two features write files, and both are started by you:

- **Export snapshot** and **Export agent context** save a JSON file through your browser's
  normal download flow, to a location you choose on your own computer.

Those files stay on your computer. What you subsequently do with them — for example pasting
them into an AI assistant — is outside this extension and under your control. The extension
never sends them anywhere.

If you give an external coding agent browser automation access to the manager, it can
also read bookmark titles and URLs through that access. Data shared by file or browser
access may be processed by the agent's provider under that tool's settings and privacy
policy. The extension does not control that external processing.

### What is stored on your device

Three things, all local and all small:

- Your chosen interface language, in `localStorage`.
- While a batch of moves is running, and afterwards until you roll it back, a journal in
  extension storage (`storage` permission) recording which move was attempted and where each
  bookmark came from. It exists so an interrupted batch can still be undone. It is deleted
  when the batch is rolled back, and it never leaves your device.
- **Trash recovery records**, also in extension storage (under the `trash-ledger` key). When
  you send bookmarks to the Trash folder, the extension keeps one record per item holding its
  title, URL, the folder it came from and the time it was moved, so it can be put back later.
  Unlike the journal above, **these records are kept indefinitely** — they outlive the move,
  and they remain even if the bookmark is later removed elsewhere. At most 500 records are
  kept, the whole ledger is capped at 1 MiB, and each title and URL is capped at 2048
  characters. They never leave your device, and **Forget the recovery records** in the Trash
  section deletes all of them at any time. Doing so leaves the bookmarks themselves untouched
  in the Trash folder. A record for an item you have already deleted for good stays as an
  audit trail; it **cannot** be used to bring that bookmark back.

### What the extension changes

It can **move** bookmarks and folders, it can **create one empty folder** to use as the Trash
folder when you ask it to, it can **rename a bookmark** when a plan you loaded asks for it, and
it can **permanently delete** bookmarks that you have sent to the Trash and then confirmed.

Moving and renaming run only after you have loaded a plan, run a dry run with nothing blocked,
and re-selected the backup file it asked you to export. Creating the Trash folder, sending
items to it and putting them back are direct actions and do not go through a plan; deleting for
good does require a re-selected backup plus an explicit confirmation, and is done one item at a
time after re-checking each item's identity.

The build contains exactly four bookmark-writing calls — one move, one folder create, one
title-only rename, one single-item delete — and a test fails if a fifth one appears. There is
no code path that changes a bookmark's URL, renames a folder, or deletes a folder together
with its contents.

**Deleting for good cannot be undone.** The extension has no feature that re-creates a deleted
bookmark. The backup it asks for exists so you can audit and protect yourself, not because the
extension will restore deleted items for you.

### What the extension does not do

It never reads page content, browsing history, cookies, or anything outside the bookmarks
API, and it never contacts a website.

### Contact

Use the issue tracker on the project repository, or the support link on the store listing
once the extension is published there.

---

## 日本語

**この拡張機能自身は、開発者・サーバー・第三者へネットワーク送信しません。**
ただし、ブックマークの読み取りと、お使いの端末内への小さな記録の保存は行います。いずれも
以下に列挙します。「外部に出ない」ことと「読まない・保存しない」ことは別だからです。

### 読み取るもの

`bookmarks` 権限により、ブックマークツリーを読み取ります。各ブックマークのタイトル、URL、
フォルダーパス、位置、およびアカウント同期ブックマークとローカルブックマークを区別する
ためのブラウザー提供フラグです。読み取りはマネージャー画面を開いている間だけ行います。
0.4.0はツリー読込の操作が必要で、0.5.0は画面を開くと初回読込を自動で開始します。
どちらも画面を閉じた後にバックグラウンドでブックマークを読み取ることはありません。

### そのデータの行き先

どこにも送信しません。サーバーを持たず、いかなるネットワーク通信も行わず、解析・テレメトリ・
広告のコードを含みません。コンテンツセキュリティポリシーでリモートコードの読み込みを禁止し、
ホスト権限も宣言していません。

ファイルを書き出す機能が 2 つありますが、どちらもご自身の操作で開始されます。

- **スナップショットの書き出し** と **エージェント向けコンテキストの書き出し** は、ブラウザーの
  通常のダウンロード機能で JSON ファイルを、ご自身が選んだ場所に保存します。

保存されたファイルはお使いのコンピューター内に留まります。その後それらを AI アシスタントへ
貼り付けるなどの操作は、この拡張機能の外側であり、利用者の管理下にあります。拡張機能が
それらをどこかへ送ることはありません。

外部のコーディングエージェントにマネージャー画面のブラウザー操作を許可すると、そのアクセスを
通じてタイトルやURLを読み取ることもできます。ファイルやブラウザー経由で渡したデータは、
そのツールの設定・プライバシーポリシーに従ってエージェントの提供元で処理される可能性があります。
拡張機能は外部ツールでの処理を管理しません。

### 端末に保存するもの

いずれも端末内に留まる 3 つだけです。

- 選択した表示言語（`localStorage`）。
- 移動バッチの実行中と、ロールバックするまでの間、どの移動を試み、各ブックマークがどこにあったかを
  記録するジャーナル（`storage` 権限、`apply-journal` キー）。中断されたバッチでも元に戻せるように
  するためだけに存在し、ロールバック完了時に削除します。外部へ送信することはありません。
- **Trash の復元記録**（`storage` 権限、`trash-ledger` キー）。Trash フォルダーへ送った項目ごとに、
  タイトル、URL、元のフォルダー、移動した時刻を 1 件保持し、あとで戻せるようにします。上のジャーナルと違い、
  **この記録は期限なく保持されます**。receipt は最大 500 件、台帳全体は 1 MiB、タイトルと URL は
  各 2048 文字が上限です。外部へ送信せず、Trash セクションの**復元記録を忘れる**でいつでも全件削除できます。
  削除しても Trash フォルダー内のブックマーク自体はそのままです。すでに永続削除した項目の記録は
  監査記録として残りますが、そのブックマークを戻すためには**使えません**。

### 変更するもの

ブックマークとフォルダーの **移動**、依頼されたときに Trash として使う **空フォルダーを 1 つ作成**
すること、読み込んだ計画が指示した場合の **ブックマークの改名**、そして Trash へ送って確認した
ブックマークの **永続削除** を行います。

移動と改名は、計画を読み込み、ブロック 0 件の Dry Run を実行し、書き出したバックアップ
ファイルを再選択した後にだけ実行されます。Trash フォルダーの作成、Trash への送信、
そこからの復元は直接操作で、計画を経由しません。永続削除はバックアップの再選択と
明示の確認を必要とし、1 件ずつ identity を再照合しながら実行します。

書き込み呼び出しはビルド全体で 4 箇所だけ（移動 1 つ、フォルダー作成 1 つ、タイトルのみの
改名 1 つ、単一項目の削除 1 つ）で、増えればテストが失敗します。ブックマークの URL 変更、
フォルダーの改名、フォルダーごとの削除の経路はありません。

**永続削除は元に戻せません。** 削除したブックマークを再作成する機能はありません。バックアップを
要求するのは、あなた自身が監査し、自分を守るためであって、拡張機能が削除済み項目を復旧する
ためではありません。

### 行わないこと

ページの内容、閲覧履歴、Cookie などブックマーク API の外にあるものを読み取ることはありません。
どのウェブサイトへも接続しません。

### 連絡先

プロジェクトリポジトリの issue、またはストア公開後は掲載ページのサポートリンクをご利用ください。

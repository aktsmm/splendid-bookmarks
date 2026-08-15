# Chrome Web Store listing copy — Splendid Bookmarks

Two locales. Paste the matching block into the Developer Dashboard after selecting the
language at the top of the Store listing tab.

Read this against the build before every submission. It must not claim the extension is
read-only or that it cannot delete bookmarks: it can, from the Trash, after a confirmed
two-step flow.

---

## English

### Summary

```text
Tidy bookmarks with a dry run, a verified backup, one-click rollback, a reversible Trash and a confirmed delete.
```

### Detailed description

```text
Splendid Bookmarks reorganises the bookmarks you already have, without asking you to
trust it blindly.

Every batch is previewed before it runs. You export a snapshot of your tree first, the
Dry Run checks each move against the live tree, and nothing is applied until you
re-select that snapshot. If the result is not what you expected, one button puts the
whole batch back where it came from.

WHAT IT DOES

• Reads your bookmark tree and reports how many URLs, folders and levels it holds
• Finds duplicates by exact URL, or by a normalised URL that ignores tracking
  parameters, trailing slashes, "www" and fragments
• Quarantines duplicates: you pick the one copy to keep in each group, and the rest are
  moved into a folder you choose. Nothing is deleted at this step
• Lets you pick moves by hand, with a location filter and a search box, so it is useful
  without any AI involved
• Applies moves one at a time, verifies the resulting positions, and rolls the batch back
  in reverse order on request
• Restores positions from an exported snapshot, even after a reinstall
• Sends bookmarks to a Trash folder you nominate, and puts a whole batch back in its
  original order while the items are still there

ABOUT DELETING

Deleting is deliberately two steps. Sending to Trash is a move, and it is reversible.
Deleting for good is separate: it needs a verified backup and a confirmation tick, it
only ever touches items this extension put in the Trash, it deletes them one at a time,
and it stops at the first item that no longer matches its record. That step cannot be
undone. Recursive folder deletion does not exist in this extension.

PRIVACY

Nothing is sent to the developer, to a server, or to any third party. There is no
network code, no analytics, no telemetry and no host permissions. Two small records are
kept on your own device so the reversible steps stay reversible: a journal of a running
batch, and a Trash recovery ledger.

OPTIONAL: AI AGENTS

If you want an AI assistant to propose the moves, the extension can export a context
file and a ready-made prompt, and can load the plan the assistant returns. That path is
entirely optional, and it changes nothing about the safety gates: a loaded plan still
goes through the same Dry Run, the same backup requirement and the same confirmation as
one you built by hand. The extension never contacts an AI service itself.

PERMISSIONS

"bookmarks" to read and reorganise your bookmarks, and "storage" for the two local
records above. Nothing else is requested.
```

---

## 日本語

### 概要

```text
Dry Run、検証済みバックアップ、ワンクリックのロールバック、可逆な Trash と確認付き削除でブックマークを整理します。
```

### 詳細な説明

```text
Splendid Bookmarks は、いまあるブックマークを整理するための拡張機能です。盲目的に信用する
ことを求めません。

すべてのバッチは実行前にプレビューされます。先にツリーのスナップショットを書き出し、Dry Run
が 1 件ずつライブツリーと照合し、そのスナップショットを選び直すまで何も適用されません。結果
が想定と違えば、ボタン 1 つでバッチ全体を元の位置へ戻せます。

できること

• ブックマークツリーを読み込み、URL 数・フォルダ数・階層の深さを表示します
• 重複を検出します。完全一致に加えて、トラッキングパラメータ・末尾スラッシュ・www・
  フラグメントを無視する正規化 URL でも検出できます
• 重複の隔離: グループごとに残す 1 件を自分で選び、残りを指定したフォルダーへ移動します。
  この段階で削除されるものはありません
• 場所の絞り込みと検索で、移動したい項目を自分で選べます。AI なしで使えます
• 移動を 1 件ずつ適用し、適用後の位置を照合し、必要なら逆順でロールバックします
• 書き出したスナップショットから位置を復元します。再インストール後でも動きます
• 指定した Trash フォルダーへ退避し、項目がそこに残っている間はバッチ単位で元の並び順ごと
  戻せます

削除について

削除は意図的に 2 段階です。Trash への退避は移動であり、元に戻せます。永続削除はそれとは別で、
検証済みバックアップと確認チェックが必要で、この拡張機能が Trash に入れた項目だけを対象に、
1 件ずつ照合しながら削除し、記録と一致しない項目が現れた時点で停止します。この操作は元に
戻せません。フォルダーごとの再帰削除は、この拡張機能には存在しません。

プライバシー

開発者・サーバー・第三者のいずれに対してもデータを送信しません。ネットワークコード、
アナリティクス、テレメトリ、ホスト権限のいずれもありません。可逆な操作を可逆に保つために、
実行中バッチのジャーナルと Trash の復元台帳の 2 つだけを端末内に保持します。

任意: AI エージェント

移動案を AI アシスタントに考えさせたい場合は、コンテキストファイルと定型プロンプトを書き出し、
返ってきた計画を読み込めます。この経路は完全に任意で、安全ゲートは何も変わりません。読み込んだ
計画も、手で作った計画とまったく同じ Dry Run、同じバックアップ要件、同じ確認を通ります。
拡張機能自身が AI サービスへ接続することはありません。

権限

ブックマークの読み取りと整理のための "bookmarks"、上記 2 つのローカル記録のための "storage"。
それ以外は要求しません。
```

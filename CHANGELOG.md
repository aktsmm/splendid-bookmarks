# Changelog

Splendid Bookmarks の変更履歴です。書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、
バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [0.4.0] - 2026-08-15

初回公開リリース。unpacked 読み込みでの配布です。

### 追加

- ライブツリーの取得と統計表示（URL 数、フォルダ数、ブラウザー判定、恒久ルート一覧、`syncing` 境界シグナル）
- ツリースナップショットの JSON 書き出し（SHA-256 付き）と、そのファイルだけを使った復元
- 重複検出（完全一致 / 正規化 URL）と、グループごとに残す 1 件を選んでの隔離移動
- 場所と絞り込みによる手動での移動選択（AI エージェント不要）
- Dry Run、適用、適用後の位置照合、逆順ロールバック
- Trash への退避とバッチ単位の復元（この段階は移動であって削除ではない）
- Trash からの永続削除。検証済みバックアップと確認チェックが揃った場合のみ、Trash 内の項目を 1 件ずつ照合しながら削除する
- エージェント用コンテキスト JSON の書き出しと、貼り付け用プロンプト
- 計画ファイルの公開スキーマ [extension/schemas/bookmark-plan.schema.json](extension/schemas/bookmark-plan.schema.json)
- UI の日本語 / 英語切り替え

### セキュリティ

- 書き込み経路は `extension/src/adapters/bookmarks-api.js` の 4 つだけ。`move`、Trash 用の空フォルダー作成、
  タイトルのみの `update`、Trash 内の単一 id 削除。`removeTree` は全面禁止
- 権限は `bookmarks` と `storage` の 2 つのみ。background service worker、ホスト権限、リモートコード、
  ネットワーク送信のいずれも持たない
- 上記の境界は [tests/no-write-api.test.js](tests/no-write-api.test.js) が実コードに対して機械的に固定し、
  検査自体が回避サンプルを検出できることも併せて検証する
- 1 バッチの上限は 200 操作。計画ファイルとスナップショットは untrusted input として扱い、読み込み前にサイズ上限を検査する

### 既知の制限

- アカウント / ローカルの同期境界越えの拒否は、境界が 2 つ実在するプロファイルでのみ検証できる。
  2026-08-14 の実測では境界が 1 つしか観測できず、**未検証のまま**
- 永続削除と外部からのツリー変更の間には TOCTOU が残る。詳細は [README](README.md) を参照

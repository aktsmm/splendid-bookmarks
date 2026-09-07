# Microsoft Edge Add-ons submission draft — Splendid Bookmarks 0.4.0

Partner Center 提出用。Chrome ウェブストア版は [cws-submit-draft.md](cws-submit-draft.md)、
掲載文の本体は [cws-listing.md](cws-listing.md) と共通で、そこから貼る。

同じ `builds/splendid-bookmarks-v0.4.0.zip` をそのまま提出できる。MV3 でリモートコードを
持たないため、Edge 側の「マニフェスト V3 ではリモートホストコードを許可しない」制約に抵触しない。
ただし**宣言欄自体は存在する**ので、「使用していない」を明示的に選ぶ。
ただし**宣言欄自体は存在する**ので、「使用していない」を明示的に選ぶ。

出典: [Microsoft Edge アドオンに拡張機能を公開する](https://learn.microsoft.com/ja-jp/microsoft-edge/extensions/publish/publish-extension)

---

## Chrome ウェブストアとの差分（ここだけ読めば足りる）

| 項目                   | Chrome                                                   | Edge                                             |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| ストアロゴ             | 128x128                                                  | **300x300 推奨 / 最小 128x128、比率 1:1**        |
| スクリーンショット     | 1280x800 または 640x400、最大 5 枚                       | **1280x800 または 640x480**、最大 6 枚           |
| 詳細な説明             | 上限のみ                                                 | **最小 250 文字**、最大 10,000 文字              |
| プロモーションタイル大 | 1400x560                                                 | 1400x560（PNG 指定）                             |
| 言語ごとの必須         | 説明のみ                                                 | **説明とロゴが各言語で必須**                     |
| プライバシー申告       | 単一目的 / 権限根拠 / リモートコード / データ種別 + 証明 | **現行はほぼ同型**（旧 UI は Yes/No + URL のみ） |

**640x400 と 640x480 は別物**。Chrome 用に 640x400 で撮ったものは Edge では使えない。
このリポジトリの `npm run screenshots` は 1280x800 を出すので、両ストアでそのまま使える。

ストアロゴは `node scripts/generate-icons.mjs` が `store-assets/store-logo-300.png` に生成する。
`store-assets/` は追跡しない（拡張機能パッケージには含めない。含めると `check:store` が
「マニフェストが参照しないファイル」として弾く）。

---

## プロパティ ページ

| フィールド     | 値                                                    |
| -------------- | ----------------------------------------------------- |
| カテゴリ       | `Productivity`（必須）                                |
| Web サイト     | `https://github.com/aktsmm/splendid-bookmarks`        |
| サポート連絡先 | `https://github.com/aktsmm/splendid-bookmarks/issues` |

## プライバシー ページ

現行の Edge Privacy ページは Chrome の Privacy タブとほぼ同型で、**単一目的 / 権限ごとの正当化 /
リモートコード宣言 / データ使用慣行のサーティフィケーション / ポリシー URL** がある。
内容は [cws-submit-draft.md](cws-submit-draft.md) の Privacy タブ節をそのまま使える。
MV3 はリモートコード自体が不可だが、**宣言欄は存在する**ので「使用していない」を明示する。

旧 UI（Properties ページ）に当たった場合は、**プライバシー ポリシーの要件**が
「個人情報にアクセス / 収集 / 送信するか」の Yes/No だけになる。

```text
いいえ
```

判断根拠: この拡張機能はブックマークのタイトル・URL・フォルダーパスを**端末内でのみ**読み、
開発者・サーバー・第三者のいずれにも送信しない。ホスト権限もネットワークコードも持たず、
CSP がリモートコードを禁止している。`tests/no-write-api.test.js` がネットワーク送信の不在を
実コードに対して機械的に固定している。

ただし公式ドキュメントは「**いいえ を選んでも、後で個人情報を処理すると判断されれば認定に
失敗しうる**」と明記している。ブックマークの URL は見方によっては個人情報に近いので、
**プライバシー ポリシー URL は「いいえ」を選ぶ場合でも併せて提示する**。

**プライバシー ポリシー URL**

```text
https://github.com/aktsmm/splendid-bookmarks/blob/main/docs/privacy-policy.md
```

> 注: Partner Center はプライバシー項目を **プロパティ ページから独立した「プライバシー」ページ**へ
> 移行中で、2026 年 5 月末までに全開発者へ展開予定。どちらの UI が出るかは実際の画面で確認する。

## ストア登録情報ページ（言語ごと）

| フィールド           | 値                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------- |
| 拡張機能名           | `Splendid Bookmarks`（マニフェスト由来、Partner Center 上は読み取り専用）                    |
| 簡単な説明           | マニフェストの `description` 由来。変更するにはパッケージ再アップロードが必要                |
| 説明                 | [cws-listing.md](cws-listing.md) の対応言語の詳細説明。提出前に現行原稿の文字数を検査する |
| 拡張機能のロゴ       | `store-assets/store-logo-300.png`（300x300）                                                 |
| スクリーンショット   | `submission-screenshots/01..05`（1280x800、最大 6 枚まで可）                                 |
| 検索語句             | `bookmarks, coding agents, automation, API, rollback, backup`                               |
| プロモーションタイル | 未作成（省略可）                                                                             |

英語で 1 言語ぶん入れれば提出できる。日本語を足す場合は同じページで言語を追加し、
[cws-listing.md](cws-listing.md) の日本語ブロックを貼る。**説明とロゴは言語ごとに必須**。

---

## 提出前チェック

- [ ] Partner Center の開発者登録が済んでいる
- [ ] `npm test` / `npm run check:store` が緑
- [ ] `npm run zip` を対象タグから作り直した
- [ ] `node scripts/generate-icons.mjs` で 300x300 ロゴを再生成した
- [ ] スクリーンショットに実データが写っていない（`npm run screenshots` は合成プロファイル）
- [ ] 説明文が 250 文字以上で、削除できないとは書いていない

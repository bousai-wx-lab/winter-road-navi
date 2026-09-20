# Security

## 対応対象

公開中の `main` ブランチだけを対応対象とします。

## 報告方法

公開リポジトリのPrivate vulnerability reportingを利用してください。

https://github.com/bousai-wx-lab/winter-road-navi/security/advisories/new

秘密情報、個人情報、攻撃手順を公開Issueへ投稿しないでください。

## 現在の設計

- 認証、アカウント、フォーム、住所入力、現在地取得を持ちません。
- Cookie、Web Storage、IndexedDB、アクセス解析を使用しません。
- JavaScript、CSS、Web Workerは同じ公開リポジトリから配信します。
- 外部通信先は国土地理院のタイル配信先だけです。
- Content Security Policyでスクリプト、スタイル、画像、通信、Workerの配信元を制限します。
- GitHub Pagesへ出すファイルを完全一致一覧に限定し、全Git履歴と配信用アーカイブを公開前に検査します。

GitHub Pagesでは任意のHTTPレスポンスヘッダーを設定できないため、CSPとReferrer PolicyはHTMLのmeta要素で適用しています。`frame-ancestors`、`X-Content-Type-Options`等のHTTPヘッダーを静的ページ側から追加できない点は配信基盤上の制約です。


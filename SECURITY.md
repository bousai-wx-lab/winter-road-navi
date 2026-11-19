# Security

## 対応対象

公開中の `main` ブランチだけを対応対象とします。

## 報告方法

公開リポジトリのPrivate vulnerability reportingを利用してください。

https://github.com/bousai-wx-lab/winter-road-navi/security/advisories/new

秘密情報、個人情報、攻撃手順を公開Issueへ投稿しないでください。

## 現在の設計

- 認証、アカウント、フォーム、住所入力、現在地取得を持ちません。
- アクセス解析は初期OFFで、許可後のみ専用のGoogle Analytics 4へ固定URL・タイトルのページビューを送ります。地点・経路・日時・表示設定・クエリ・フラグメント・参照元は送りません。広告機能と拡張計測は無効です。
- Web Storageはこのツールの解析同意だけを保存します。解析Cookieは専用名・専用パスで最長60日、拒否への変更で送信停止・専用Cookie削除・再読込を行います。IndexedDBと地図条件の永続保存は使いません。ローカルプレビューからはGoogleタグを読み込みません。
- JavaScript、CSS、Web Workerは同じ公開リポジトリから配信します。
- 外部通信は国土地理院、気象庁、公開気象データ配信元に加え、ドライブ解析時のFOSSGIS Valhalla経路サービスを使います。経路サービスへ選択した始点・終点と出発日時を送り、画面にも明記します。住所検索・現在地取得・経路の永続保存は行いません。
- Content Security Policyでスクリプト、スタイル、画像、通信、Workerの配信元を制限します。
- GitHub Pagesへ出すファイルを完全一致一覧に限定し、全Git履歴と配信用アーカイブを公開前に検査します。

GitHub Pagesでは任意のHTTPレスポンスヘッダーを設定できないため、CSPとReferrer PolicyはHTMLのmeta要素で適用しています。`frame-ancestors`、`X-Content-Type-Options`等のHTTPヘッダーを静的ページ側から追加できない点は配信基盤上の制約です。


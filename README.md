# 冬道そなえナビ / Winter Road Navi

全国の高速道路と一般道路を地図で確認する、Bousai Wx Labの公開ツールです。

公開URL: https://bousai-wx-lab.github.io/winter-road-navi/

## 現在の公開範囲

初期公開版では、国土地理院のベクトルタイルから道路を読み込み、次の2種類を別の色で表示します。

- 高速道路：緑色
- 一般道路：青色。拡大するほど細い道路を表示

地図の移動、拡大・縮小、道路種別の表示切替、全国表示への復帰、道路のクリック確認ができます。

薄型のヘッダーから、Bousai Wx Labブログと公式X `@bousai_wx_lab` を新しいタブで開けます。使い方ページへのリンクは、案内記事を用意するまで表示しません。

気温、積雪、凍結、通行規制、渋滞、経路案内はまだ表示しません。現在の道路状況や安全を示す地図ではありません。

## データと表示

- 道路：国土地理院「地理院地図Vector（試験公開）」の `road` レイヤー
- 背景：国土地理院「淡色地図」タイル
- 道路区分：`motorway`、`rdCtg`、`ftCode` を使った本ツール独自の表示区分
- 地図描画：MapLibre GL JS 6.10.0

地理院地図Vectorは試験提供で、URL、属性、データ構成が変更される場合があります。公式案内では2026年9月16日に全国データを2026年7月1日時点へ更新したとされています。

- https://maps.gsi.go.jp/development/vt.html
- https://maps.gsi.go.jp/development/ichiran.html
- https://www.gsi.go.jp/LAW/2930-index.html

国土地理院のデータをBousai Wx Labが独自に区分・着色して表示しています。国土地理院が本ツールの区分を作成・認定したものではありません。

## 通信とプライバシー

この版は、現在地、住所、自由入力、Cookie、Web Storage、アクセス解析を使用しません。表示状態を端末やURLへ保存しません。

地図を動かすと、表示範囲に応じたタイルを国土地理院へ直接要求します。この通信では、IPアドレス、要求したタイルURL、時刻、一般的な通信情報が配信元に伝わり得ます。GitHub Pagesへのアクセス情報はGitHub側の通信記録に残り得ます。

ブログとXには、利用者がヘッダーのリンクを押した時だけ移動します。

## ローカル確認

```sh
python3 -m http.server 8000
```

`http://127.0.0.1:8000/` を開きます。`file:` URLではWeb Workerやモジュールの制約により動きません。

## 検査

```sh
python3 scripts/build_release_manifest.py
python3 scripts/privacy_gate.py
python3 scripts/test_privacy_gate.py
python3 scripts/test_pages_release.py
node --test tests/*.test.mjs
```

公開候補は `release-allowlist.json` の完全一致一覧だけです。検査は現在ファイル、全Git object、全branch・tag・ref、commitとtagの作成者情報、外部通信先、危険なブラウザAPI、配信ファイルのハッシュを確認します。

## 外部ライブラリ

MapLibre GL JS 6.10.0を固定した自己ホスト版として同梱しています。ライセンス全文は `vendor/maplibre-gl-LICENSE.txt` にあります。更新時は配布元、版、差分、ライセンス、ファイルハッシュ、ブラウザ動作を再確認します。

# 酒類等製造所マップ（平成26年度〜）

国税庁公表「酒類等製造免許の新規取得者名等一覧」の Excel データを地図上にプロットするアプリ。
年度・免許等区分・品目・都道府県・任意ノードからの距離（プラグイン）などでフィルタできます。

## 構成

- TypeScript + Vite + Leaflet（地図表示）
- 地図タイル: 国土地理院（淡色地図）
- ジオコーディング: 国土地理院 Address Search API（APIキー不要）
- データソース: `masters/www.nta.go.jp/.../zenkoku/{h26..r08}.xlsx`

```
scripts/parse.ts    # XLSX を JSON にパース
scripts/geocode.ts  # 住所→緯度経度 を付与（キャッシュあり）
src/                # フロントエンド（Vite ルート）
public/data/        # 静的データ（フロントが fetch する）
data/               # ジオコーディングキャッシュ（git管理可）
```

## セットアップ

```bash
npm install
```

## データ生成

```bash
# XLSX → public/data/breweries.json
npm run parse

# 住所 → 緯度経度 (public/data/breweries.geo.json)
# レート配慮で 300ms ごとにリクエスト。初回は時間がかかります。
npm run geocode

# まとめて
npm run build:data
```

ジオコーディング結果は `data/geocode-cache.json` にキャッシュされ、
再実行時は差分のみ問い合わせします。

## 開発

```bash
npm run dev      # http://localhost:5173
npm run build    # dist/ に出力
npm run preview  # build 結果をローカル確認
```

## 距離フィルタプラグイン

アプリ本体は特定の駅・路線データを内蔵していません。サイドバーの「📍 距離フィルタ」から
ブラウザでノードJSONを取り込むと、そこから N km 以内の製造所だけに絞り込めます。

受け付ける JSON 形式:

```jsonc
// 1) シンプル配列
[{ "name": "渋谷", "lat": 35.658, "lon": 139.701, "group": "任意" }]

// 2) GeoJSON FeatureCollection of Point
//    properties.name / properties.group が読まれます
```

複数セットを取り込んだ場合、セット間は AND、セット内のグループ間は OR で判定します。
設定は localStorage に保存されるためリロードしても残ります。

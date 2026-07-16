# 全国バドミントン成績アーカイブ（小中学生メイン）

大会結果を全国のバドミントン協会・連盟サイトから**毎週自動収集**し、
検索・年度別一覧・ポイントランキングをWebアプリで提供する。

## セットアップ（1回だけ・5分）
1. GitHubで新規リポジトリ作成（Public）
2. このフォルダの中身を丸ごとアップロード（`index.html` / `backend/` / `.github/`）
3. リポジトリの **Settings → Pages → Branch: main / (root)** で公開をON
4. **Actions タブ → collect-badminton-results → Run workflow** で初回収集

以上。以降は毎週土曜朝に自動で全国サイトを巡回し、`data.json` を更新。
アプリURL（`https://<ユーザー名>.github.io/<リポジトリ名>/`）を開くだけで最新データが見られる。

## 収集元を増やす
`backend/sources.json` に1ブロック足すだけ。
```json
{ "name": "○○県小学生バドミントン連盟", "url": "https://...", "pref": "○○県", "type": "both", "depth": 1, "focus": "小学生" }
```

## 収集の仕組み（backend/）
- `auto.js` … 巡回→PDF/HTML自動判定→解析→区分(小学生/中学生/社会人)・県タグ付与→data.json統合
- `index.js` … 一覧形式PDF解析・OCRフォールバック・`--import`
- `bracket.js` … トーナメント表PDFの座標解析（優勝/3位復元、review出力）
- 精度方針: 順位が根拠付きで確定できたものだけ収録（推測しない）

## ローカルで動かす場合
```
cd backend && npm install && npm i tesseract.js pdf-to-img && npm run auto
```
生成された `backend/output/data.json` をアプリの「data.json読込」で選択。

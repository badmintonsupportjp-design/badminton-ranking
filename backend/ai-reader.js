/**
 * ai-reader.js — スキャン画像PDFのAI読取フォールバック（最終手段）
 * ------------------------------------------------------------
 * tesseractでも座標解析でも読めないPDFを、Claude APIに画像として渡し、
 * 大会結果の構造化JSONを直接受け取る。人間（AI）が目で読むのと同じことを自動化する。
 *
 * 有効化（1回だけ）:
 *   GitHubリポジトリ → Settings → Secrets and variables → Actions
 *   → New repository secret → Name: ANTHROPIC_API_KEY / Value: APIキー
 *   （キーは https://console.anthropic.com で取得。未設定なら本機能は静かにスキップされ、
 *     従来どおりの動作になる）
 *
 * コスト目安: 画像PDF1本あたり数円〜十数円。他の手段で読めたPDFには一切使わない。
 */

"use strict";

const MODEL = "claude-sonnet-4-6";
const MAX_PAGES = 6; // 1PDFあたりの読取ページ上限（コスト暴走防止）

const PROMPT = `あなたはバドミントン大会結果の読取係です。画像は大会結果のスキャンです。
読み取れた「確定順位」だけを、次のJSONだけで出力してください（説明文・Markdown禁止）。

{"year": 西暦年(数値, 不明なら null),
 "tournament": "大会名(不明なら空文字)",
 "categories": [
   {"name": "種目名(例: 中学男子シングルス)",
    "gender": "男子/女子/混合/不明",
    "grade": "小学生/中学/高校/一般/不明",
    "players": [
      {"name": "氏名またはチーム名", "team": "所属(なければ空文字)", "rank": 順位数値}
    ]}
 ]}

厳守事項:
- 画像に明記された順位（優勝=1, 準優勝=2, 第3位=3, ベスト4=4, ベスト8=8）だけを出力。
- トーナメント表しかない場合は、決勝の勝者が特定できるときのみ rank1/rank2 を出力。特定できなければその種目は出力しない。
- 判読できない氏名は出力しない。推測・補完は禁止。
- 結果が読み取れなければ {"categories": []} を返す。`;

/** PDFバッファ → ページ画像(base64 PNG)配列 */
async function pdfToImages(buffer) {
  const { pdf } = await import("pdf-to-img");
  const doc = await pdf(buffer, { scale: 2.5 });
  const images = [];
  for await (const page of doc) {
    images.push(page.toString("base64"));
    if (images.length >= MAX_PAGES) break;
  }
  return images;
}

/** Claude APIで画像群を読取 → parsed（extractResultsと同形） */
async function aiReadPdf(buffer, meta = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // キー未設定なら静かにスキップ

  const images = await pdfToImages(buffer);
  if (!images.length) return null;

  const content = [
    ...images.map((data) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data },
    })),
    { type: "text", text: PROMPT + (meta.hint ? `\n\n参考: この結果の掲載元ページは「${meta.hint}」です。` : "") },
  ];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  return sanitize(text, meta);
}

/** APIの応答テキスト → 検証済み parsed（不正データは捨てる） */
function sanitize(text, meta = {}) {
  const jsonStr = text.replace(/```json|```/g, "").trim();
  let raw;
  try { raw = JSON.parse(jsonStr); } catch { return null; }

  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .map((c) => ({
      name: String(c.name || "").slice(0, 30) || "種目不明",
      gender: ["男子", "女子", "混合"].includes(c.gender) ? c.gender : "不明",
      grade: ["小学生", "中学", "高校", "一般"].includes(c.grade) ? c.grade : "不明",
      players: (Array.isArray(c.players) ? c.players : [])
        .filter((p) => p && typeof p.name === "string" && p.name.length >= 2 && p.name.length <= 30
          && Number.isInteger(p.rank) && p.rank >= 1 && p.rank <= 16)
        .map((p) => ({
          name: p.name.trim(),
          team: String(p.team || "").slice(0, 30),
          tournament: "", // 呼び出し側で設定
          rank: p.rank,
        })),
    }))
    .filter((c) => c.players.length > 0);

  if (!categories.length) return null;
  const tournament = String(raw.tournament || meta.hint || "大会名不明").slice(0, 60);
  categories.forEach((c) => c.players.forEach((p) => (p.tournament = tournament)));
  return {
    year: Number.isInteger(raw.year) && raw.year >= 2000 && raw.year <= 2100 ? raw.year : (meta.year || new Date().getFullYear()),
    tournament,
    categories,
  };
}

module.exports = { aiReadPdf, sanitize };

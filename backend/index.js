/**
 * バドミントン大会結果 自動収集バックエンド
 * ------------------------------------------------------------
 * 1. 対象サイトをスクレイピングして大会結果PDFのリンクを収集
 * 2. 最新PDFをダウンロード
 * 3. pdf-parse でテキスト抽出し、カテゴリ・順位・選手・チームを解析
 * 4. output/data.json に統合保存（フロントエンドがこれを読み込む）
 *
 * 使い方:
 *   npm install
 *   node index.js                              … サイト巡回 → PDF取得 → 解析 → data.json 更新
 *   node index.js --pdf ./results.pdf          … 手元のPDFを解析して data.json に追加
 *   node index.js --pdf ./r.pdf --year 2025 --tournament 春季大会
 *
 * 【実サイト調査に基づく注意】nagano-badminton.com の結果PDFは3タイプ混在:
 *   A) 順位一覧形式（例: 全信州選手権 -allshinsyu-k.pdf）→ 本プログラムで解析可
 *   B) トーナメント表のテキストPDF → 列順が崩れ順位復元不可（要レイアウト解析）
 *   C) スキャン画像PDF（例: 中学春季 -syunki-k-a.pdf）→ pdf-parseではテキスト0。
 *      OCRが必要な場合は tesseract.js + pdf-to-img 等を追加導入すること。
 *
 * 【完全収録ワークフロー】
 *   タイプA: node index.js                     … 一覧形式PDFを自動取込
 *   タイプB: node bracket.js <pdf> --year ...  … 座標解析→review出力→目視確認
 *            node index.js --import output/review-*.json … 確定分を取込
 *   タイプC: npm i tesseract.js pdf-to-img → node index.js … 画像PDFをOCR自動取込
 *   最後に output/data.json をフロントHTMLと同じ場所に置く（またはアプリの
 *   「data.json読込」ボタンで選択）
 */

"use strict";

const fs = require("fs");
const path = require("path");
// 重い依存は使用時に読込（--import はネット系依存なしで動く）
const lazy = (name) => { let m; return () => (m ??= require(name)); };
const axios = lazy("axios");
const cheerio = lazy("cheerio");
const pdfParse = lazy("pdf-parse");

/* ============================== 設定 ============================== */

const CONFIG = {
  // 巡回対象サイト（必要に応じて追加）
  // ※長野県協会は結果PDFがトップではなく年度別「大会予定と結果」ページに掲載される
  targetSites: [
    {
      name: "長野県バドミントン協会 R8(2026年度) 大会予定と結果",
      url: "http://www.nagano-badminton.com/yotei-kekka/2026/R8taikai-kekka.html",
    },
    {
      name: "長野県バドミントン協会 R7(2025年度) 大会予定と結果",
      url: "http://www.nagano-badminton.com/yotei-kekka/2025/R7taikai-kekka.html",
    },
  ],
  // PDFリンクとして採用するキーワード（リンクテキスト or URL に含まれる語）
  // このサイトの結果PDFは URL 末尾が「-k.pdf」「-kekka.pdf」の命名が多い
  pdfKeywords: ["結果", "成績", "kekka", "-k.pdf", "-k-a.pdf"],
  // 1サイトあたり取得する最新PDFの最大数
  maxPdfPerSite: 5,
  // リクエスト間隔（相手サーバーへの負荷軽減。必ず1秒以上を推奨）
  requestDelayMs: 1500,
  timeoutMs: 20000,
  userAgent:
    "Mozilla/5.0 (compatible; BadmintonResultsCollector/1.0; +local-script)",

  pdfDir: path.join(__dirname, "pdfs"),
  outDir: path.join(__dirname, "output"),
  dataFile: path.join(__dirname, "output", "data.json"),
};

/* ============================ ユーティリティ ============================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDirs() {
  for (const d of [CONFIG.pdfDir, CONFIG.outDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function zenToHan(str) {
  // 全角数字・英字 → 半角
  return str
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
    .replace(/　/g, " ");
}

/* ========================= 1. サイトスクレイピング ========================= */

async function fetchHtml(url) {
  const res = await axios().get(url, {
    timeout: CONFIG.timeoutMs,
    responseType: "arraybuffer",
    headers: { "User-Agent": CONFIG.userAgent },
  });
  // 文字コードはサイトにより異なるため、まずUTF-8として解釈（必要ならiconv-lite導入）
  return res.data.toString("utf-8");
}

/** ページ内の <a href="*.pdf"> を収集し、キーワードで絞り込む */
function collectPdfLinks(html, baseUrl) {
  const $ = cheerio().load(html);
  const links = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!/\.pdf(\?.*)?$/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      return;
    }
    const text = $(el).text().trim();
    const hit = CONFIG.pdfKeywords.some(
      (kw) => text.includes(kw) || decodeURIComponent(abs).includes(kw)
    );
    links.push({ url: abs, text, keywordHit: hit });
  });
  // キーワード一致を優先し、ページ内出現順（新着が上にある想定）を維持
  const unique = [...new Map(links.map((l) => [l.url, l])).values()];
  unique.sort((a, b) => Number(b.keywordHit) - Number(a.keywordHit));
  return unique;
}

async function downloadPdf(url) {
  const res = await axios().get(url, {
    timeout: CONFIG.timeoutMs,
    responseType: "arraybuffer",
    headers: { "User-Agent": CONFIG.userAgent },
  });
  const fileName =
    decodeURIComponent(url.split("/").pop().split("?")[0]) || `dl_${Date.now()}.pdf`;
  const filePath = path.join(CONFIG.pdfDir, fileName);
  fs.writeFileSync(filePath, res.data);
  return { filePath, buffer: Buffer.from(res.data) };
}

/* =========================== 2. PDF解析ロジック =========================== */

/** 年度抽出: 「2025年度」「令和7年」等に対応 */
function extractYear(text) {
  const m1 = text.match(/(20\d{2})\s*年/);
  if (m1) return Number(m1[1]);
  const m2 = text.match(/令和\s*(元|\d+)\s*年/);
  if (m2) return 2018 + (m2[1] === "元" ? 1 : Number(m2[1]));
  return new Date().getFullYear();
}

/** 大会名抽出: 「大会」「選手権」等を含む最初の行を採用 */
function extractTournament(text) {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 4 && l.length <= 50 && /(大会|選手権|オープン|カップ|リーグ|新人戦)/.test(l));
  return line || "大会名不明";
}

// カテゴリ行: 例「中3男子シングルス」「小学5年女子」「一般男子ダブルス」
const CATEGORY_RE =
  /((?:小(?:学)?|中(?:学)?|高(?:校)?)\s*\d?\s*年?|一般|シニア)?\s*(男子|女子|混合)\s*(シングルス|ダブルス|単|複)?/;

// 順位表現: 優勝 / 準優勝 / 第3位 / 3位 / ベスト8
const RANK_RE = /(優勝|準優勝|第?\s*(\d{1,2})\s*位|ベスト\s*(\d{1,2}))/;

// 「氏名（チーム名）」の抽出
const NAME_TEAM_RE =
  /([一-龠々〆ヵヶぁ-んァ-ヴa-zA-Z]+(?:[ 　][一-龠々〆ヵヶぁ-んァ-ヴa-zA-Z]+)*)\s*[（(]([^（()）]+)[）)]/g;

function rankValue(rankText) {
  if (rankText.includes("優勝") && !rankText.includes("準")) return 1;
  if (rankText.includes("準優勝")) return 2;
  const pos = rankText.match(/(\d{1,2})\s*位/);
  if (pos) return Number(pos[1]);
  const best = rankText.match(/ベスト\s*(\d{1,2})/);
  if (best) return Number(best[1]);
  return 99;
}

function parseCategoryName(raw) {
  const name = zenToHan(raw).replace(/\s+/g, "");
  const gender = name.includes("男子")
    ? "男子"
    : name.includes("女子")
    ? "女子"
    : name.includes("混合")
    ? "混合"
    : "不明";
  const g = name.match(/(小|中|高)(?:学|校)?(\d)/);
  const grade = g ? `${g[1]}${g[2]}` : name.includes("一般") ? "一般" : "不明";
  return { name, gender, grade };
}

/** 行がカテゴリ見出しかどうか（順位語や氏名括弧を含まない短い行） */
function isCategoryLine(line) {
  return (
    line.length <= 20 &&
    /(男子|女子|混合)/.test(line) &&
    !RANK_RE.test(line) &&
    !/[（(]/.test(line)
  );
}

/**
 * PDFテキスト → { year, tournament, categories[] }
 * PDFのレイアウトは大会ごとに異なるため、ここはヒューリスティック。
 * 精度が足りない場合は CATEGORY_RE / RANK_RE を対象PDFに合わせて調整する。
 */
function extractResults(rawText, overrides = {}) {
  const text = zenToHan(rawText);
  const year = overrides.year || extractYear(text);
  const tournament = overrides.tournament || extractTournament(text);

  const categories = new Map();
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isCategoryLine(line) && CATEGORY_RE.test(line)) {
      const meta = parseCategoryName(line);
      if (!categories.has(meta.name)) {
        categories.set(meta.name, { ...meta, players: [] });
      }
      current = categories.get(meta.name);
      continue;
    }

    if (!current) continue;

    const rankMatch = line.match(RANK_RE);
    if (!rankMatch) continue;
    const rank = rankValue(rankMatch[0]);

    let m;
    NAME_TEAM_RE.lastIndex = 0;
    while ((m = NAME_TEAM_RE.exec(line)) !== null) {
      const name = m[1].replace(/\s+/g, " ").trim();
      const team = m[2].trim();
      if (name.length < 2 || /位|優勝|ベスト/.test(name)) continue;
      current.players.push({ name, team, tournament, rank });
    }
  }

  return {
    year,
    tournament,
    categories: [...categories.values()].filter((c) => c.players.length > 0),
  };
}

/* =========================== 3. data.json 統合 =========================== */

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.dataFile, "utf-8"));
  } catch {
    return [];
  }
}

/** 抽出結果を既存 data.json にマージ（年度→カテゴリ名でまとめ、重複選手は除外） */
function mergeIntoData(data, parsed) {
  let yearEntry = data.find((d) => d.year === parsed.year);
  if (!yearEntry) {
    yearEntry = { year: parsed.year, categories: [] };
    data.push(yearEntry);
  }
  for (const cat of parsed.categories) {
    let catEntry = yearEntry.categories.find((c) => c.name === cat.name);
    if (!catEntry) {
      catEntry = { name: cat.name, gender: cat.gender, grade: cat.grade, players: [] };
      yearEntry.categories.push(catEntry);
    }
    for (const p of cat.players) {
      const dup = catEntry.players.some(
        (q) => q.name === p.name && q.team === p.team && q.tournament === p.tournament
      );
      if (!dup) catEntry.players.push(p);
    }
  }
  data.sort((a, b) => b.year - a.year);
  return data;
}

function saveData(data) {
  fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2), "utf-8");
  console.log(`✅ 保存: ${CONFIG.dataFile}`);
}

/* ============================== 実行フロー ============================== */

async function parsePdfSmart(buffer) {
  // 1) 通常のテキスト抽出
  const pdf = await pdfParse()(buffer);
  if ((pdf.text || "").replace(/\s/g, "").length >= 50) return pdf.text;

  // 2) テキストがほぼ無い＝スキャン画像PDF → OCRフォールバック
  //    npm install tesseract.js pdf-to-img を実行しておくと自動で有効になる
  //    （tesseract.js は初回に日本語データ jpn.traineddata を自動DLする）
  console.log("    ℹ テキスト無しPDF。OCRを試行します…");
  try {
    const { pdf: pdfToImg } = await import("pdf-to-img");
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("jpn");
    let text = "";
    const doc = await pdfToImg(buffer, { scale: 3 }); // 高解像度化でOCR精度向上
    for await (const page of doc) {
      const { data } = await worker.recognize(page);
      text += data.text + "\n";
    }
    await worker.terminate();
    return text;
  } catch (e) {
    console.error(
      "    ⚠ OCR不可: `npm install tesseract.js pdf-to-img` を実行してください。" +
        ` (${e.message})`
    );
    return "";
  }
}

async function runScrapePipeline() {
  ensureDirs();
  const data = loadData();

  for (const site of CONFIG.targetSites) {
    console.log(`\n🔍 巡回: ${site.name} (${site.url})`);
    let html;
    try {
      html = await fetchHtml(site.url);
    } catch (e) {
      console.error(`  ⚠ サイト取得失敗: ${e.message}`);
      continue;
    }

    const links = collectPdfLinks(html, site.url).slice(0, CONFIG.maxPdfPerSite);
    console.log(`  📄 PDFリンク ${links.length} 件を検出`);

    for (const link of links) {
      await sleep(CONFIG.requestDelayMs);
      try {
        console.log(`  ⬇ ダウンロード: ${link.text || link.url}`);
        const { filePath, buffer } = await downloadPdf(link.url);
        const text = await parsePdfSmart(buffer);
        const parsed = extractResults(text);
        const count = parsed.categories.reduce((s, c) => s + c.players.length, 0);
        console.log(
          `    → ${parsed.year}年 / ${parsed.tournament} / カテゴリ${parsed.categories.length} / 選手${count}名 (${path.basename(filePath)})`
        );
        if (count > 0) mergeIntoData(data, parsed);
      } catch (e) {
        console.error(`    ⚠ 解析失敗: ${e.message}`);
      }
    }
  }

  saveData(data);
}

async function runImport(reviewPath) {
  const raw = JSON.parse(fs.readFileSync(reviewPath, "utf-8"));
  // review特有のメタキーを除去して確定データだけ取り込む
  const parsed = {
    year: raw.year,
    tournament: raw.tournament,
    categories: (raw.categories || [])
      .map((c) => ({
        name: c.name, gender: c.gender, grade: c.grade,
        players: (c.players || []).map(({ _evidence, ...p }) => p),
      }))
      .filter((c) => c.players.length > 0),
  };
  const count = parsed.categories.reduce((s, c) => s + c.players.length, 0);
  if (!count) { console.error("⚠ 取込対象0件（players が空）"); return; }
  ensureDirs();
  const data = mergeIntoData(loadData(), parsed);
  saveData(data);
  console.log(`✅ ${parsed.year}年 / ${parsed.tournament} / ${count}名を取込`);
}

async function runLocalPdf(pdfPath, overrides) {
  ensureDirs();
  const buffer = fs.readFileSync(pdfPath);
  const text = await parsePdfSmart(buffer);
  const parsed = extractResults(text, overrides);
  const data = mergeIntoData(loadData(), parsed);
  console.log(JSON.stringify(parsed, null, 2));
  saveData(data);
}

/* CLI */
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const getOpt = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  try {
    const importPath = getOpt("--import");
    if (importPath) { await runImport(importPath); return; }
    const pdfPath = getOpt("--pdf");
    if (pdfPath) {
      await runLocalPdf(pdfPath, {
        year: getOpt("--year") ? Number(getOpt("--year")) : undefined,
        tournament: getOpt("--tournament"),
      });
    } else {
      await runScrapePipeline();
    }
  } catch (e) {
    console.error("❌ エラー:", e);
    process.exit(1);
  }
})();

module.exports = {
  CONFIG, fetchHtml, collectPdfLinks, downloadPdf, parsePdfSmart,
  extractResults, loadData, mergeIntoData, saveData, ensureDirs, sleep,
};

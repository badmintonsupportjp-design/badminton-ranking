/**
 * auto.js — ワンコマンド全自動パイプライン
 * ------------------------------------------------------------
 *   node auto.js
 *
 * これ1本で全部やる:
 *   1. 対象サイト（R7/R8 大会予定と結果）を巡回し結果PDFを全取得
 *   2. PDFタイプを自動判定して処理
 *      - 一覧形式        → そのまま解析して取込
 *      - 画像スキャン     → OCR（tesseract.js日本語）して解析・取込
 *      - トーナメント表   → 座標解析（bracket.js）で優勝/3位を復元して取込
 *   3. カテゴリを区分（小学生/中学生/高校生/社会人/その他）に自動分類
 *   4. output/data.json に統合保存（小中学生を優先表示するサマリを出力）
 *
 * オプション:
 *   --safe            トーナメント座標解析の自動取込を止め、review出力のみにする
 *   --only 小中       小学生・中学生の大会だけ取込む（既定は全区分取込）
 *
 * 事前準備（初回のみ）:
 *   npm install                       … 必須依存（axios/cheerio/pdf-parse/pdf2json）
 *   npm i tesseract.js pdf-to-img     … 画像PDFのOCRを有効化（推奨）
 */

"use strict";

const fs = require("fs");
const path = require("path");
const core = require("./index.js");
const bracket = require("./bracket.js");
const { aiReadPdf } = require("./ai-reader.js");

/* ========================= 収集元レジストリ ========================= */

function loadSources() {
  const p = path.join(__dirname, "sources.json");
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, "utf-8"));
    return j.sources || [];
  }
  // フォールバック: index.js の CONFIG
  return core.CONFIG.targetSites.map((s) => ({ ...s, pref: "長野県", type: "pdf", depth: 0 }));
}

/** 同一ドメインの「結果/大会」系リンクを1階層たどる */
function collectSubPages(html, baseUrl) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const out = new Set();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    const text = $(el).text();
    if (/\.(pdf|xlsx?|docx?|jpe?g|png|zip)(\?|$)/i.test(href)) return;
    let abs;
    try { abs = new URL(href, baseUrl); } catch { return; }
    if (abs.hostname !== base.hostname) return;
    if (/(結果|大会|kekka|result|taikai|20\d{2})/i.test(text + abs.pathname)) out.add(abs.href);
  });
  return [...out].slice(0, 20); // 1サイトあたり上限
}

/** HTMLページ本文から「◆種目名 → 優勝/第N位: 名前」形式の結果を抽出 */
function htmlToLines(html) {
  try {
    const cheerio = require("cheerio");
    const $ = cheerio.load(html);
    $("script,style,nav,footer").remove();
    // ブロック要素境界を改行に
    return $("body").html()
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split(/\n/);
  } catch {
    // cheerio未導入でも動くフォールバック
    return html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .split(/\n/);
  }
}

function extractFromHtmlText(html, meta) {
  const rawLines = htmlToLines(html);
  const lines = rawLines.map((l) => l.replace(/&nbsp;|＆nbsp;/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  const text = lines.join("\n");

  const CAT = /(男子|女子|混合).{0,10}(シングルス|ダブルス|団体|単|複)|(シングルス|ダブルス|団体戦?)\s*(男子|女子)?/;
  const RANK = /^[・･\-*＊◦]?\s*(優\s*勝|準優勝|第?\s*([1-8１-８])\s*位)\s*[：:]\s*(.+)$/;

  const cats = new Map();
  let cur = null;
  const tournament = meta.tournament ||
    lines.find((l) => l.length >= 6 && l.length <= 60 && /(大会|選手権|カップ|予選)/.test(l)) || "大会名不明";

  for (const line of lines) {
    if (line.length <= 30 && /^[◆■▼<＜(（]?/.test(line) && CAT.test(line) && !RANK.test(line)) {
      const name = line.replace(/^[◆■▼<＜(（\s]+|[>＞)）\s]+$/g, "");
      if (!cats.has(name)) cats.set(name, { name, gender: /女子/.test(name) ? "女子" : /男子/.test(name) ? "男子" : "不明", grade: "不明", players: [] });
      cur = cats.get(name);
      continue;
    }
    const m = line.match(RANK);
    if (!m || !cur) continue;
    const rank = /優\s*勝/.test(m[1]) && !/準/.test(m[1]) ? 1 : /準優勝/.test(m[1]) ? 2 : Number(String(m[2]).replace(/[１-８]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
    // 「名前（所属）」or チーム名のみ の両対応。複数名は ・、/ 区切り
    for (const part of m[3].split(/[、,／/]|・(?=[^）)]*([（(]|$))/).filter(Boolean)) {
      if (typeof part !== "string" || part.length < 2 || part.length > 30) continue;
      const nm = part.match(/^(.{2,20}?)\s*[（(]([^（()）]+)[）)]/);
      cur.players.push(nm
        ? { name: nm[1].trim(), team: nm[2].trim(), tournament, rank }
        : { name: part.trim(), team: "", tournament, rank });
    }
  }
  return {
    year: meta.year || yearFromText(text),
    tournament,
    categories: [...cats.values()].filter((c) => c.players.length),
  };
}

/* ========================= 区分（部門）分類 ========================= */

function classifyDivision(categoryName, grade, tournament) {
  const s = `${categoryName}｜${grade || ""}｜${tournament || ""}`;
  if (/(中学|中\d|ジュニアオープン)/.test(s)) return "中学生";
  if (/(小学|エレメンタリー|学年別|若葉|ＡＢＣ|ABC|プレゴールデン|スポ少)/.test(s)) return "小学生";
  if (/(高校|少年|高\d|インターハイ|高等学校)/.test(s)) return "高校生";
  if (/(一般|社会人|レディース|マスター|シニア|実業団|県リーグ|クラブ対抗|都道府県対抗|全信州)/.test(s)) return "社会人";
  return "その他";
}

/* ================== セクション認識付きPDFリンク収集 ================== */
/**
 * ページをDOM順に走査し、各PDFリンクに直前の見出し(h1-h4)を「セクション」として付与。
 * 全競技混在サイト（中体連等）で「バドミントン」見出し配下のPDFだけ拾うために使う。
 */
function collectPdfLinksWithSections(html, baseUrl) {
  const out = [];
  let section = "";
  let pageTitle = "";
  // 見出しとリンクを出現順に抽出（cheerio不要の軽量実装）
  const re = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>|<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { // 見出し
      const h = strip(m[2]);
      if (m[1] === "1" && !pageTitle) pageTitle = h;
      else section = h;
      continue;
    }
    const href = (m[3] || "").trim();
    if (!/\.pdf(\?.*)?$/i.test(href)) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    out.push({ url: abs, text: strip(m[4] || ""), section, pageTitle });
  }
  // 重複URL除去（最初の出現＝正しいセクションを優先）
  const seen = new Set();
  return out.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
}

/* ============================ PDF1本の処理 ============================ */

async function processPdf(link, opts) {
  const { filePath, buffer } = await core.downloadPdf(link.url);
  const base = path.basename(filePath);

  // まずテキスト抽出（内部でOCRフォールバックあり）
  const text = await core.parsePdfSmart(buffer);
  if (text && text.replace(/\s/g, "").length >= 50) {
    // 一覧形式として解析
    const parsed = core.extractResults(text);
    const n = parsed.categories.reduce((s, c) => s + c.players.length, 0);
    if (n > 0) return { type: "一覧/OCR", parsed, base };

    // 一覧で拾えない＝トーナメント表の可能性 → 座標解析
    try {
      const pages = await bracketTokens(filePath);
      const result = bracket.analyze(pages);
      const review = bracket.toReview(result, {
        year: yearFromText(text),
        tournament: tournamentFromText(text) || base,
      });
      // 監査用に必ずreviewを保存
      const rvPath = path.join(core.CONFIG.outDir, `review-${base.replace(/\.pdf$/i, "")}.json`);
      fs.writeFileSync(rvPath, JSON.stringify(review, null, 2), "utf-8");

      const cnt = review.categories.reduce((s, c) => s + c.players.length, 0);
      if (cnt > 0 && !opts.safe) {
        const parsedB = {
          year: review.year,
          tournament: review.tournament,
          categories: review.categories
            .map((c) => ({ name: c.name, gender: c.gender, grade: c.grade,
              players: c.players.map(({ _evidence, ...p }) => p) }))
            .filter((c) => c.players.length),
        };
        return { type: "座標解析(自動)", parsed: parsedB, base, review: rvPath };
      }
      if (cnt > 0) return { type: "座標解析(review待ち)", parsed: null, base, review: rvPath };
      // ここまで全滅 → AI読取（ANTHROPIC_API_KEY設定時のみ）
      const ai = await tryAiRead(buffer, link, "順位情報なし");
      return ai || { type: "順位情報なし", parsed: null, base, review: rvPath };
    } catch (e) {
      const ai = await tryAiRead(buffer, link, `座標解析失敗(${e.message})`);
      return ai || { type: `座標解析失敗(${e.message})`, parsed: null, base };
    }
  }
  // テキスト無し（=スキャン画像でOCRも空振り or 未導入） → AI読取
  const ai = await tryAiRead(buffer, link, "テキスト無し");
  return ai || { type: "テキスト無し(OCR/AI読取とも不可)", parsed: null, base };

  async function tryAiRead(buf, lk, reason) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    try {
      console.log(`    🤖 ${reason} → AI読取を試行: ${base}`);
      const parsed = await aiReadPdf(buf, { hint: `${lk.pageTitle || ""}${lk.section ? "（" + lk.section + "）" : ""}`.trim() || undefined });
      if (parsed) return { type: "AI読取", parsed, base };
    } catch (e) {
      console.error(`    ⚠ AI読取失敗: ${e.message}`);
    }
    return null;
  }
}

async function bracketTokens(pdfPath) {
  // bracket.js の loadTokens を経由（pdf2json必須）
  const PDFParser = require("pdf2json");
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on("pdfParser_dataError", (e) => reject(e.parserError || e));
    parser.on("pdfParser_dataReady", (data) => {
      resolve((data.Pages || []).map((page, pi) =>
        (page.Texts || []).map((t) => ({
          page: pi, x: t.x, y: t.y,
          text: decodeURIComponent(t.R.map((r) => r.T).join("")).trim(),
        })).filter((t) => t.text)));
    });
    parser.loadPDF(pdfPath);
  });
}

const yearFromText = (t) => {
  const m1 = t.match(/(20\d{2})\s*年/); if (m1) return Number(m1[1]);
  const m2 = t.match(/令和\s*(元|\d+)\s*年/); if (m2) return 2018 + (m2[1] === "元" ? 1 : Number(m2[1]));
  return new Date().getFullYear();
};
const tournamentFromText = (t) =>
  t.split(/\r?\n/).map((l) => l.trim())
   .find((l) => l.length >= 4 && l.length <= 50 && /(大会|選手権|オープン|カップ|リーグ|新人戦)/.test(l));

/* =============================== メイン =============================== */

if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  const opts = {
    safe: args.includes("--safe"),
    only: args.includes("--only") ? args[args.indexOf("--only") + 1] : null, // 例: 小中
    minYear: args.includes("--all-years") ? 0
      : args.includes("--min-year") ? Number(args[args.indexOf("--min-year") + 1]) : 2024,
    append: args.includes("--append"), // 既定は毎回ゼロから再構築（県タグ等の誤りを自己修復）
  };
  const isOldLink = (url) => {
    if (!opts.minYear) return false;
    const m = decodeURIComponent(url).match(/(20\d{2})/g);
    if (!m) return false;
    return Math.max(...m.map(Number)) < opts.minYear; // URL中の最大年が閾値未満なら古い
  };

  core.ensureDirs();
  const data = opts.append ? core.loadData() : [];
  if (!opts.append) console.log("🧹 data.json をゼロから再構築します（--append で追記モード）");
  const summary = { 小学生: 0, 中学生: 0, 高校生: 0, 社会人: 0, その他: 0 };
  const skipped = [];

  const applyAndMerge = (parsed, srcTag, pref) => {
    parsed.categories = parsed.categories
      .map((c) => ({ ...c, pref, division: classifyDivision(c.name, c.grade, parsed.tournament) }))
      .filter((c) => {
        if (!opts.only) return true;
        if (opts.only === "小中") return c.division === "小学生" || c.division === "中学生";
        return c.division === opts.only;
      });
    const n = parsed.categories.reduce((s, c) => s + c.players.length, 0);
    if (!n) return 0;
    core.mergeIntoData(data, parsed);
    parsed.categories.forEach((c) => (summary[c.division] += c.players.length));
    console.log(`  ✅ [${srcTag}] ${parsed.tournament} → ${n}名取込`);
    return n;
  };

  for (const site of loadSources()) {
    console.log(`\n🔍 巡回: ${site.name}（${site.pref}）`);
    let html;
    try { html = await core.fetchHtml(site.url); }
    catch (e) { console.error(`  ⚠ サイト取得失敗: ${e.message}`); continue; }

    // 対象ページ一覧（入口 + 深さ1）
    const pages = [{ url: site.url, html }];
    if ((site.depth || 0) >= 1) {
      for (const sub of collectSubPages(html, site.url)) {
        await core.sleep(core.CONFIG.requestDelayMs);
        try { pages.push({ url: sub, html: await core.fetchHtml(sub) }); } catch {}
      }
    }
    console.log(`  🌐 対象ページ ${pages.length} 件`);

    for (const pg of pages) {
      // A) HTML本文から順位を直接抽出
      if (site.type === "html" || site.type === "both") {
        try {
          const parsed = extractFromHtmlText(pg.html, {});
          if (parsed.categories.length) applyAndMerge(parsed, "HTML", site.pref);
        } catch (e) { skipped.push(`${pg.url} … HTML解析エラー(${e.message})`); }
      }
      // B) リンクされた結果PDFを解析
      if (site.type === "pdf" || site.type === "both") {
        const sportRe = site.sportFilter ? new RegExp(site.sportFilter) : null;
        const resultRe = /(結果|成績|kekka|result)/i;
        const links = collectPdfLinksWithSections(pg.html, pg.url).filter((l) => {
          const hay = `${l.section}｜${l.text}｜${decodeURIComponent(l.url)}`;
          if (sportRe && !sportRe.test(hay)) return false;      // 競技フィルタ（見出し文脈込み）
          if (!resultRe.test(hay)) return false;                 // 結果もの限定
          if (isOldLink(l.url)) return false;                    // 古い年度は除外
          return true;
        });
        for (const link of links) {
          await core.sleep(core.CONFIG.requestDelayMs);
          try {
            const r = await processPdf(link, opts);
            if (!r.parsed) { skipped.push(`${r.base} … ${r.type}`); continue; }
            // PDF内から大会名が取れなかったら、掲載ページのタイトル＋セクションで補完
            if (/大会名不明/.test(r.parsed.tournament) && (link.pageTitle || link.section)) {
              const t = `${link.pageTitle || ""}${link.section ? "（" + link.section + "）" : ""}`.trim();
              r.parsed.tournament = t;
              r.parsed.categories.forEach((c) => c.players.forEach((p) => (p.tournament = t)));
            }
            if (!applyAndMerge(r.parsed, r.type, site.pref)) skipped.push(`${r.base} … 対象区分なし`);
          } catch (e) {
            skipped.push(`${link.url.split("/").pop()} … エラー(${e.message})`);
          }
        }
      }
    }
  }

  core.saveData(data);
  console.log("\n===== 取込サマリ（区分別） =====");
  console.log(`  小学生: ${summary["小学生"]}名 / 中学生: ${summary["中学生"]}名  ← メイン`);
  console.log(`  高校生: ${summary["高校生"]}名 / 社会人: ${summary["社会人"]}名 / その他: ${summary["その他"]}名`);
  if (skipped.length) {
    console.log("\n----- 未取込（要確認） -----");
    skipped.forEach((s) => console.log("  ・" + s));
    console.log("  ※ review-*.json があるものは中身を確認して `node index.js --import` で確定可");
  }
  console.log("\n📦 output/data.json をフロントHTMLと同じ場所に置くか、アプリの「data.json読込」で選択。");
})().catch((e) => { console.error("❌", e); process.exit(1); });

module.exports = { classifyDivision, extractFromHtmlText, collectSubPages, loadSources, collectPdfLinksWithSections };

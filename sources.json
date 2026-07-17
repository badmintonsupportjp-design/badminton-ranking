/**
 * bracket.js — トーナメント表PDFの座標解析エンジン
 * ------------------------------------------------------------
 * pdf2json でテキストの x,y 座標を取得し、トーナメント表から
 * 「優勝者ボックス」「三位決定戦勝者」を復元する。
 *
 * 原理（長野県協会の結果PDFの実レイアウトに基づく）:
 *   - 出場者は「氏名 (所属)」の組で表の外周に並ぶ
 *   - 優勝者は所属なしの氏名だけが決勝の先（中央付近）にもう一度現れる
 *   - 「三位決定戦」の直後に勝者名が現れる
 *   → 「所属付きで登場した氏名が、所属なしで再登場した位置」= 勝ち上がり先
 *
 * 精度最優先の設計: 自動で data.json に書き込まず、review ファイルを出力。
 * 人間が確認・修正してから `node index.js --import <review.json>` で確定する。
 *
 * 使い方:
 *   npm install pdf2json
 *   node bracket.js ./pdfs/2026-kokusopo-k.pdf --year 2026 --tournament "第80回国民スポーツ大会長野県予選会"
 *   → output/review-2026-kokusopo-k.json を確認・修正
 *   → node index.js --import output/review-2026-kokusopo-k.json
 */

"use strict";

const fs = require("fs");
const path = require("path");

/* ========================= 座標トークン抽出 ========================= */

function loadTokens(pdfPath) {
  const PDFParser = require("pdf2json");
  return new Promise((resolve, reject) => {
    const parser = new PDFParser();
    parser.on("pdfParser_dataError", (e) => reject(e.parserError || e));
    parser.on("pdfParser_dataReady", (data) => {
      const pages = (data.Pages || []).map((page, pi) =>
        (page.Texts || []).map((t) => ({
          page: pi,
          x: t.x,
          y: t.y,
          text: decodeURIComponent(t.R.map((r) => r.T).join("")).trim(),
        })).filter((t) => t.text)
      );
      resolve(pages);
    });
    parser.loadPDF(pdfPath);
  });
}

/* ============================ 解析ロジック ============================ */

const NAME_RE = /^[一-龠々〆ヵヶぁ-んァ-ヴーa-zA-Z]{2,8}([ 　][一-龠々〆ヵヶぁ-んァ-ヴーa-zA-Z]{1,8})?$/;
const CLUB_RE = /^[（(].+[）)]$/;
const CATEGORY_RE = /(男子|女子|混合).{0,6}(シングルス|ダブルス|団体)|(シングルス|ダブルス|団体)/;
const norm = (s) => s.replace(/[ 　]/g, "");

/**
 * 1ページ分のトークン列を解析。
 * @returns {categories:[{name, champions:[{name,team,evidence}], third:[...]}], warnings:[]}
 */
function analyzePage(tokens) {
  const warnings = [];

  // 1) セクション見出し（種目名）を y 座標順に取得
  const headers = tokens
    .filter((t) => CATEGORY_RE.test(t.text) && t.text.length <= 16 && !CLUB_RE.test(t.text))
    .sort((a, b) => a.y - b.y);

  const sectionOf = (tok) => {
    let cur = null;
    for (const h of headers) if (h.y <= tok.y + 0.01) cur = h; else break;
    return cur ? cur.text : headers[0] ? headers[0].text : "不明";
  };

  // 2) エントリ（氏名+所属が近接）を抽出
  //    club トークンから左右±8 / 上下±1.2 の氏名トークンを対応付ける
  const clubs = tokens.filter((t) => CLUB_RE.test(t.text));
  const names = tokens.filter((t) => NAME_RE.test(t.text) && !CLUB_RE.test(t.text));
  const entries = []; // {name, team, x, y, section}
  const usedName = new Set();
  for (const c of clubs) {
    const cand = names
      .filter((n) => !usedName.has(n) && Math.abs(n.y - c.y) < 1.2 && Math.abs(n.x - c.x) < 10)
      .sort((a, b) => Math.abs(a.x - c.x) - Math.abs(b.x - c.x))[0];
    if (cand) {
      usedName.add(cand);
      entries.push({
        name: norm(cand.name || cand.text),
        team: c.text.replace(/^[（(]|[）)]$/g, ""),
        x: cand.x, y: cand.y,
        section: sectionOf(cand),
      });
    }
  }

  // 3) 三位決定戦の勝者検出（先に確定し、優勝候補から除外する）
  const thirdMarkers = tokens.filter((t) => /三位決定戦/.test(t.text));
  const entryByName = new Map(entries.map((e) => [e.name, e]));
  const thirdTokens = [];
  for (const m of thirdMarkers) {
    const near = names
      .filter((n) => !usedName.has(n) && entryByName.has(norm(n.text)) &&
        Math.abs(n.y - m.y) < 3 && Math.abs(n.x - m.x) < 20)
      .sort((a, b) => (Math.abs(a.y - m.y) + Math.abs(a.x - m.x)) - (Math.abs(b.y - m.y) + Math.abs(b.x - m.x)));
    if (near[0]) thirdTokens.push(near[0]);
    else warnings.push(`三位決定戦マーカー(y=${m.y.toFixed(1)})の勝者名を特定できず`);
  }
  const thirdSet = new Set(thirdTokens);

  // 4) 優勝者ボックス検出: 所属なしで再登場したエントリ氏名（三位決定戦分を除く）
  const champTokens = names.filter((n) => {
    if (usedName.has(n) || thirdSet.has(n)) return false;  // エントリ側/3位側で消費済み
    const e = entryByName.get(norm(n.text));
    if (!e) return false;                                  // エントリに存在しない
    return Math.abs(n.y - e.y) > 1.2 || Math.abs(n.x - e.x) > 5; // 別位置での再登場
  });

  // 5) セクションごとに集約
  const sections = new Map();
  const put = (sec) => {
    if (!sections.has(sec)) sections.set(sec, { name: sec, champions: [], third: [] });
    return sections.get(sec);
  };
  for (const t of champTokens) {
    const e = entryByName.get(norm(t.text));
    put(sectionOf(t)).champions.push({
      name: e.name, team: e.team,
      evidence: `再登場位置 p${t.page} (${t.x.toFixed(1)},${t.y.toFixed(1)})`,
    });
  }
  for (const t of thirdTokens) {
    const e = entryByName.get(norm(t.text));
    put(sectionOf(t)).third.push({ name: e.name, team: e.team, evidence: "三位決定戦勝者" });
  }
  for (const e of entries) put(e.section); // 空セクションも列挙して漏れを可視化

  return { categories: [...sections.values()], entries, warnings };
}

function analyze(pages) {
  const out = { categories: [], warnings: [], entryCount: 0 };
  for (const tokens of pages) {
    const r = analyzePage(tokens);
    out.categories.push(...r.categories);
    out.warnings.push(...r.warnings);
    out.entryCount += r.entries.length;
  }
  return out;
}

/* ============================ review 出力 ============================ */

function toReview(result, meta) {
  return {
    _note: "champions/third を目視確認し、確定した順位を players[].rank に反映してから index.js --import で取込むこと。ダブルスは優勝ペア2名が champions に並ぶ。",
    year: meta.year || new Date().getFullYear(),
    tournament: meta.tournament || "大会名未設定",
    categories: result.categories.map((c) => ({
      name: c.name,
      gender: c.name.includes("女子") ? "女子" : c.name.includes("男子") ? "男子" : "不明",
      grade: /少年|高校/.test(c.name) ? "高校" : /中学/.test(c.name) ? "中学" : /小学/.test(c.name) ? "小学生" : "一般",
      players: [
        ...c.champions.map((p) => ({ name: p.name, team: p.team, tournament: meta.tournament, rank: 1, _evidence: p.evidence })),
        ...c.third.map((p) => ({ name: p.name, team: p.team, tournament: meta.tournament, rank: 3, _evidence: p.evidence })),
      ],
    })),
    _warnings: result.warnings,
  };
}

/* =============================== CLI =============================== */

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const pdfPath = args.find((a) => !a.startsWith("--"));
    const getOpt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
    if (!pdfPath) { console.error("使い方: node bracket.js <pdf> [--year 2026] [--tournament 名称]"); process.exit(1); }

    const pages = await loadTokens(pdfPath);
    const result = analyze(pages);
    const review = toReview(result, { year: Number(getOpt("--year")) || undefined, tournament: getOpt("--tournament") });

    const outDir = path.join(__dirname, "output");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `review-${path.basename(pdfPath, ".pdf")}.json`);
    fs.writeFileSync(outPath, JSON.stringify(review, null, 2), "utf-8");

    console.log(`エントリ検出: ${result.entryCount}名`);
    for (const c of review.categories) {
      console.log(`■ ${c.name}`);
      for (const p of c.players) console.log(`   rank${p.rank}: ${p.name} (${p.team})  [${p._evidence}]`);
      if (!c.players.length) console.log("   （自動特定なし → PDFを目視で補完）");
    }
    if (review._warnings.length) console.log("⚠ " + review._warnings.join(" / "));
    console.log(`\n✅ review出力: ${outPath}\n   確認後: node index.js --import ${outPath}`);
  })().catch((e) => { console.error("❌", e); process.exit(1); });
}

module.exports = { analyze, analyzePage, toReview };

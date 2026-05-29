/**
 * masters配下の xlsx を読み、製造所一覧を 1 つの JSON にまとめる。
 * 出力: public/data/breweries.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(
  ROOT,
  "masters/www.nta.go.jp/taxes/sake/menkyo/shinki/seizo/02/zenkoku",
);
const OUT_DIR = path.join(ROOT, "public/data");
const OUT_FILE = path.join(OUT_DIR, "breweries.json");

/** ファイル名 → 和暦オブジェクト */
function parseEra(filename: string): { era: "H" | "R"; eraYear: number; fiscalYear: number } | null {
  const m = filename.match(/^([hr])(\d{2})\.xlsx$/i);
  if (!m) return null;
  const prefix = m[1]!.toUpperCase() as "H" | "R";
  const eraYear = Number(m[2]);
  // 西暦への換算（年度ベース、平成は1989+x-1、令和は2019+x-1）
  const fiscalYear =
    prefix === "H" ? 1989 + eraYear - 1 : 2019 + eraYear - 1;
  return { era: prefix, eraYear, fiscalYear };
}

/** Excelシリアル値 → ISO日付 (YYYY-MM-DD) */
function excelSerialToISO(serial: unknown): string | null {
  if (typeof serial !== "number" || !Number.isFinite(serial)) return null;
  // Excel基準日 1899-12-30 (UTC)
  const ms = (serial - 25569) * 86400 * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export interface Brewery {
  /** ソースファイルの和暦識別 (例 "H26", "R06") */
  sourceEra: string;
  /** 年度（西暦） */
  fiscalYear: number;
  prefecture: string;
  taxOffice: string;
  /** 免許等年月日 */
  licenseDate: string | null;
  /** 申請等年月日 */
  applicationDate: string | null;
  /** 製造者氏名又は名称（改行は半角スペースに） */
  producer: string;
  /** 製造場所在地 */
  address: string;
  /** 免許等区分 */
  licenseCategory: string;
  /** 品目 */
  item: string;
  /** 処理区分（新規 / 法人成り等 など） */
  processingCategory: string;
}

function normalize(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/\r\n|\r|\n/g, " ").trim();
}

function parseFile(filePath: string): Brewery[] {
  const filename = path.basename(filePath);
  const era = parseEra(filename);
  if (!era) {
    console.warn(`skip (unknown filename): ${filename}`);
    return [];
  }
  const sourceEra = `${era.era}${String(era.eraYear).padStart(2, "0")}`;

  const wb = XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
  });

  // ヘッダー行を探す（「都道府県名」を含む行）
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i];
    if (Array.isArray(r) && r.some((c) => normalize(c) === "都道府県名")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    console.warn(`header not found in ${filename}`);
    return [];
  }

  const out: Brewery[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!Array.isArray(r)) continue;
    const prefecture = normalize(r[0]);
    if (!prefecture) continue; // 空行や注釈行スキップ
    const producer = normalize(r[4]);
    const address = normalize(r[5]);
    if (!producer && !address) continue;

    out.push({
      sourceEra,
      fiscalYear: era.fiscalYear,
      prefecture,
      taxOffice: normalize(r[1]),
      licenseDate: excelSerialToISO(r[2]),
      applicationDate: excelSerialToISO(r[3]),
      producer,
      address,
      licenseCategory: normalize(r[6]),
      item: normalize(r[7]),
      processingCategory: normalize(r[8]),
    });
  }
  return out;
}

function main(): void {
  if (!fs.existsSync(SRC_DIR)) {
    throw new Error(`source dir not found: ${SRC_DIR}`);
  }
  const files = fs
    .readdirSync(SRC_DIR)
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~"))
    .sort();

  const all: Brewery[] = [];
  for (const f of files) {
    const parsed = parseFile(path.join(SRC_DIR, f));
    console.log(`${f}: ${parsed.length} rows`);
    all.push(...parsed);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(all, null, 2), "utf8");
  console.log(`\nwrote ${all.length} records to ${path.relative(ROOT, OUT_FILE)}`);
}

main();

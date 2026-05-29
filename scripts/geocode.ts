/**
 * breweries.json の各レコードに緯度経度を付与する。
 *
 * - 国土地理院 (GSI) Address Search API を利用
 *     https://msearch.gsi.go.jp/address-search/AddressSearch?q=...
 *   無償・APIキー不要。レスポンスは GeoJSON 風の FeatureCollection。
 * - キャッシュ: data/geocode-cache.json（住所→[lon,lat]）
 *   再実行時はキャッシュ済みの住所はスキップする。
 * - レート配慮で 1リクエスト/300ms 待機。
 *
 * 出力: public/data/breweries.geo.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { Brewery } from "./parse.ts";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const IN_FILE = path.join(ROOT, "public/data/breweries.json");
const OUT_FILE = path.join(ROOT, "public/data/breweries.geo.json");
const CACHE_DIR = path.join(ROOT, "data");
const CACHE_FILE = path.join(CACHE_DIR, "geocode-cache.json");

const GSI_ENDPOINT = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const REQUEST_INTERVAL_MS = 300;

export interface BreweryGeo extends Brewery {
  lon: number | null;
  lat: number | null;
  /** ジオコーディングに使用した住所 */
  geocodedAddress?: string;
  /** 失敗理由 */
  geocodeError?: string;
}

type Cache = Record<string, { lon: number; lat: number } | { error: string }>;

interface GsiFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: { title?: string };
}

function loadCache(): Cache {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Cache;
  } catch {
    return {};
  }
}

function saveCache(cache: Cache): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** GSI に問い合わせ */
async function geocode(address: string): Promise<
  { lon: number; lat: number } | { error: string }
> {
  const q = encodeURIComponent(address);
  const res = await fetch(`${GSI_ENDPOINT}?q=${q}`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const json = (await res.json()) as GsiFeature[];
  if (!Array.isArray(json) || json.length === 0) {
    return { error: "no result" };
  }
  const coords = json[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) return { error: "no coordinates" };
  return { lon: coords[0]!, lat: coords[1]! };
}

/**
 * 住所の表記ゆれを少しでも吸収するため、末尾の枝番などを段階的に削った
 * バリエーションを返す。最初に当たったものを採用。
 */
function buildAddressVariants(address: string): string[] {
  const variants = new Set<string>();
  variants.add(address);
  // 「字○○」以下を削る
  variants.add(address.replace(/字[^\d０-９]+/, ""));
  // 末尾の「○番地○」「○番地の○」「○番○号」を削る
  variants.add(
    address
      .replace(/[\d０-９]+番地の[\d０-９]+.*$/, "")
      .replace(/[\d０-９]+番地[\d０-９]*.*$/, "")
      .replace(/[\d０-９]+番[\d０-９]*号?.*$/, ""),
  );
  return [...variants].map((v) => v.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  if (!fs.existsSync(IN_FILE)) {
    throw new Error(`run 'npm run parse' first: ${IN_FILE} not found`);
  }
  const breweries = JSON.parse(fs.readFileSync(IN_FILE, "utf8")) as Brewery[];
  const cache = loadCache();

  const result: BreweryGeo[] = [];
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let processed = 0;

  for (const b of breweries) {
    processed++;
    const address = b.address;
    if (!address) {
      result.push({ ...b, lon: null, lat: null, geocodeError: "empty address" });
      continue;
    }

    let geo: { lon: number; lat: number } | { error: string } | undefined;
    let usedAddress = address;

    const variants = buildAddressVariants(address);
    for (const v of variants) {
      const cached = cache[v];
      if (cached) {
        geo = cached;
        usedAddress = v;
        hits++;
        if ("lon" in cached) break;
        // エラーキャッシュは次のバリアントを試す
        continue;
      }
      // キャッシュにない → リクエスト
      try {
        geo = await geocode(v);
      } catch (e) {
        geo = { error: (e as Error).message };
      }
      cache[v] = geo;
      usedAddress = v;
      misses++;
      await sleep(REQUEST_INTERVAL_MS);
      if ("lon" in geo) break;
    }

    if (geo && "lon" in geo) {
      result.push({
        ...b,
        lon: geo.lon,
        lat: geo.lat,
        geocodedAddress: usedAddress,
      });
    } else {
      errors++;
      result.push({
        ...b,
        lon: null,
        lat: null,
        geocodedAddress: usedAddress,
        geocodeError: geo && "error" in geo ? geo.error : "unknown",
      });
    }

    if (processed % 25 === 0) {
      saveCache(cache);
      // 途中経過も書き出して、開発中でも地図でプレビューできるようにする
      fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), "utf8");
      console.log(
        `  progress ${processed}/${breweries.length} (cache hit=${hits} miss=${misses} err=${errors})`,
      );
    }
  }

  saveCache(cache);
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), "utf8");
  console.log(
    `\ndone. total=${result.length} hit=${hits} miss=${misses} err=${errors}`,
  );
  console.log(`wrote ${path.relative(ROOT, OUT_FILE)}`);
}

void main();

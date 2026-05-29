/**
 * 状態（フィルタ + お気に入り + POIセット）を URL ハッシュとしてシェアする。
 *
 * 形式: #s=<base64url(gzip(JSON))>&v=1
 *  - v: スキーマバージョン
 *  - s: 状態 JSON を gzip → base64url 化したもの
 *
 * gzip / 解凍は ブラウザ標準の CompressionStream / DecompressionStream を使う。
 */

export interface ShareableFilters {
  yearFrom: string;
  yearTo: string;
  license: string;
  item: string;
  prefecture: string;
  onlyGeocoded: boolean;
  onlyFavorites: boolean;
}

export interface ShareableState {
  v: 1;
  f: ShareableFilters;
  fav: string[];
  /** PoiPlugin が返す PoiSet[] をそのまま */
  poi: unknown[];
}

// ---------------------------------------------------------------- base64url
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- gzip
async function gzip(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(input as BufferSource);
  void writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}
async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  void writer.write(input as BufferSource);
  void writer.close();
  const ab = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(ab);
}

// ---------------------------------------------------------------- public
export async function encodeState(state: ShareableState): Promise<string> {
  const json = JSON.stringify(state);
  const compressed = await gzip(new TextEncoder().encode(json));
  return bytesToBase64Url(compressed);
}

export async function decodeState(s: string): Promise<ShareableState | null> {
  try {
    const bytes = base64UrlToBytes(s);
    const decoded = await gunzip(bytes);
    const json = new TextDecoder().decode(decoded);
    const obj = JSON.parse(json) as Partial<ShareableState>;
    if (obj.v !== 1 || !obj.f || !Array.isArray(obj.fav) || !Array.isArray(obj.poi)) {
      return null;
    }
    return obj as ShareableState;
  } catch {
    return null;
  }
}

/** 現在の URL からシェアされた状態を取り出す（あれば） */
export async function readStateFromUrl(): Promise<ShareableState | null> {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const s = params.get("s");
  if (!s) return null;
  return decodeState(s);
}

/** 与えられた状態を URL に変換 */
export async function buildShareUrl(state: ShareableState): Promise<string> {
  const encoded = await encodeState(state);
  const base = location.origin + location.pathname;
  return `${base}#s=${encoded}`;
}

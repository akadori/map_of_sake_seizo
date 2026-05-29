import { describe, expect, it } from "vitest";
import {
  buildShareUrl,
  decodeState,
  encodeState,
  readStateFromUrl,
  type ShareableState,
} from "./share";

const sampleState: ShareableState = {
  v: 1,
  f: {
    yearFrom: "2018",
    yearTo: "2024",
    license: "all",
    item: "all",
    prefecture: "13",
    onlyGeocoded: true,
    onlyFavorites: false,
  },
  fav: ["a:1", "b:2", "c:3"],
  poi: [
    {
      id: "poi_xyz",
      name: "山手線駅",
      radiusKm: 3,
      enabled: true,
      selectedGroups: null,
      points: [{ name: "東京", lat: 35.6812, lon: 139.7671 }],
    },
  ],
};

describe("encodeState / decodeState", () => {
  it("ラウンドトリップで等価", async () => {
    const enc = await encodeState(sampleState);
    const dec = await decodeState(enc);
    expect(dec).toEqual(sampleState);
  });

  it("base64url のみで構成される (=, +, / を含まない)", async () => {
    const enc = await encodeState(sampleState);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("gzip 圧縮で元 JSON より短くなる (圧縮可能なデータの場合)", async () => {
    const big: ShareableState = {
      ...sampleState,
      fav: Array.from({ length: 200 }, (_, i) => `key:${i}`),
    };
    const enc = await encodeState(big);
    const raw = JSON.stringify(big);
    expect(enc.length).toBeLessThan(raw.length);
  });

  it("壊れた文字列は null を返す", async () => {
    expect(await decodeState("not-a-valid-base64-or-gzip!!!")).toBeNull();
  });

  it("バージョン不一致 (v !== 1) は null", async () => {
    const bogus = { ...sampleState, v: 2 as unknown as 1 };
    const enc = await encodeState(bogus as ShareableState);
    expect(await decodeState(enc)).toBeNull();
  });

  it("必須フィールド欠落は null", async () => {
    // 手動で v だけの payload を作って通せないことを確認
    const enc = await encodeState({
      v: 1,
      // @ts-expect-error 故意に欠落
      f: undefined,
      fav: [],
      poi: [],
    });
    expect(await decodeState(enc)).toBeNull();
  });
});

describe("buildShareUrl / readStateFromUrl", () => {
  it("buildShareUrl は #s= を含む", async () => {
    const url = await buildShareUrl(sampleState);
    expect(url).toContain("#s=");
  });

  it("buildShareUrl で生成した URL の hash を読めば元の state に戻る", async () => {
    const url = await buildShareUrl(sampleState);
    const hash = new URL(url).hash;
    // happy-dom 環境で location.hash を上書き
    location.hash = hash;
    const restored = await readStateFromUrl();
    expect(restored).toEqual(sampleState);
  });

  it("hash が空なら null", async () => {
    location.hash = "";
    expect(await readStateFromUrl()).toBeNull();
  });

  it("hash に s= がなければ null", async () => {
    location.hash = "#other=foo";
    expect(await readStateFromUrl()).toBeNull();
  });
});

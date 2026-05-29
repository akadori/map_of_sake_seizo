import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FAV_STORAGE_KEY,
  FavoriteStore,
  breweryKey,
  escapeHtml,
  fillSelect,
  unique,
} from "./main";

describe("breweryKey", () => {
  it("年度|生産者|住所 を区切り | で連結", () => {
    expect(
      breweryKey({
        fiscalYear: 2020,
        producer: "蔵A",
        address: "東京都中央区1-1",
        // 残りは未使用
      } as Parameters<typeof breweryKey>[0]),
    ).toBe("2020|蔵A|東京都中央区1-1");
  });
});

describe("unique", () => {
  it("重複削除 + 空文字除去 + ja ソート", () => {
    expect(unique(["b", "a", "", "a", "c"])).toEqual(["a", "b", "c"]);
  });
  it("日本語の自然な並び (ja localeCompare)", () => {
    const sorted = unique(["東京都", "愛知県", "青森県"]);
    expect(sorted[0]).toBe("愛知県");
  });
  it("空配列はそのまま", () => {
    expect(unique([])).toEqual([]);
  });
});

describe("escapeHtml", () => {
  it("&<>\"' をエスケープ", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
  });
  it("通常文字はそのまま", () => {
    expect(escapeHtml("酒蔵 ABC")).toBe("酒蔵 ABC");
  });
});

describe("fillSelect", () => {
  it("（指定なし）を先頭に追加してオプションを生成", () => {
    const sel = document.createElement("select");
    fillSelect(sel, ["A", "B"]);
    expect(sel.options.length).toBe(3);
    expect(sel.options[0]!.value).toBe("");
    expect(sel.options[0]!.textContent).toBe("（指定なし）");
    expect(sel.options[1]!.value).toBe("A");
    expect(sel.options[2]!.value).toBe("B");
  });
  it("includeAny=false で先頭オプションなし", () => {
    const sel = document.createElement("select");
    fillSelect(sel, ["X", "Y"], false);
    expect(sel.options.length).toBe(2);
    expect(sel.options[0]!.value).toBe("X");
  });
  it("再呼び出しで前回の中身をクリア", () => {
    const sel = document.createElement("select");
    fillSelect(sel, ["A", "B"], false);
    fillSelect(sel, ["Z"], false);
    expect(sel.options.length).toBe(1);
    expect(sel.options[0]!.value).toBe("Z");
  });
});

describe("FavoriteStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("初期状態は空", () => {
    const s = new FavoriteStore();
    expect(s.keys()).toEqual([]);
    expect(s.has("x")).toBe(false);
  });

  it("toggle で追加→削除", () => {
    const s = new FavoriteStore();
    expect(s.toggle("a")).toBe(true);
    expect(s.has("a")).toBe(true);
    expect(s.toggle("a")).toBe(false);
    expect(s.has("a")).toBe(false);
  });

  it("localStorage に永続化される", () => {
    const s = new FavoriteStore();
    s.toggle("k1");
    s.toggle("k2");
    const raw = localStorage.getItem(FAV_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual(["k1", "k2"]);
  });

  it("新規インスタンスで永続化された値を復元", () => {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(["x", "y"]));
    const s = new FavoriteStore();
    expect(new Set(s.keys())).toEqual(new Set(["x", "y"]));
  });

  it("壊れた localStorage は無視して空で起動", () => {
    localStorage.setItem(FAV_STORAGE_KEY, "{not json");
    const s = new FavoriteStore();
    expect(s.keys()).toEqual([]);
  });

  it("非文字列要素は捨てる", () => {
    localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify(["ok", 1, null, "ok2"]));
    const s = new FavoriteStore();
    expect(new Set(s.keys())).toEqual(new Set(["ok", "ok2"]));
  });

  it("remove / clear / setAll", () => {
    const s = new FavoriteStore();
    s.setAll(["a", "b", "c"]);
    expect(new Set(s.keys())).toEqual(new Set(["a", "b", "c"]));
    s.remove("b");
    expect(new Set(s.keys())).toEqual(new Set(["a", "c"]));
    s.clear();
    expect(s.keys()).toEqual([]);
  });
});

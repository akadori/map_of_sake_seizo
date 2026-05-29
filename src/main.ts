import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { PoiPlugin } from "./poi-plugin";
import { buildShareUrl, readStateFromUrl, type ShareableState } from "./share";

/** scripts/geocode.ts の BreweryGeo と同じ shape */
interface BreweryGeo {
  sourceEra: string;
  fiscalYear: number;
  prefecture: string;
  taxOffice: string;
  licenseDate: string | null;
  applicationDate: string | null;
  producer: string;
  address: string;
  licenseCategory: string;
  item: string;
  processingCategory: string;
  lon: number | null;
  lat: number | null;
  geocodedAddress?: string;
  geocodeError?: string;
}

const ANY = "（指定なし）";
const FAV_STORAGE_KEY = "map_of_sake_seizo:favorites:v1";

function breweryKey(b: BreweryGeo): string {
  return `${b.fiscalYear}|${b.producer}|${b.address}`;
}
export { breweryKey };

class FavoriteStore {
  private set = new Set<string>();
  constructor() {
    try {
      const raw = localStorage.getItem(FAV_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) {
          this.set = new Set(arr.filter((x): x is string => typeof x === "string"));
        }
      }
    } catch {
      // ignore
    }
  }
  has(key: string): boolean { return this.set.has(key); }
  toggle(key: string): boolean {
    if (this.set.has(key)) this.set.delete(key);
    else this.set.add(key);
    this.persist();
    return this.set.has(key);
  }
  remove(key: string): void { this.set.delete(key); this.persist(); }
  clear(): void { this.set.clear(); this.persist(); }
  setAll(keys: string[]): void {
    this.set = new Set(keys);
    this.persist();
  }
  keys(): string[] { return [...this.set]; }
  private persist(): void {
    try { localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...this.set])); }
    catch { /* ignore */ }
  }
}

async function loadJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return (await res.json()) as T;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ja"),
  );
}
export { unique };

function fillSelect(
  el: HTMLSelectElement,
  options: string[],
  includeAny = true,
): void {
  el.innerHTML = "";
  if (includeAny) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = ANY;
    el.appendChild(o);
  }
  for (const v of options) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
export { escapeHtml, fillSelect, FavoriteStore, FAV_STORAGE_KEY };

/**
 * `<dialog closedby="any">` を Promise でラップし、cancel / 背景クリック /
 * Esc / 任意ボタン送信を統一的に扱う。Safari など closedby 未対応環境では
 * 背景クリックでのライト dismiss を JS で補完する。
 */
function openDialog(
  dialog: HTMLDialogElement,
): Promise<string> {
  return new Promise((resolve) => {
    const onClose = (): void => {
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("click", onLightDismiss);
      resolve(dialog.returnValue || "");
    };
    const onLightDismiss = (ev: MouseEvent): void => {
      // closedby="any" 未対応ブラウザ向けフォールバック
      if (ev.target === dialog) {
        const r = dialog.getBoundingClientRect();
        const inside =
          ev.clientX >= r.left &&
          ev.clientX <= r.right &&
          ev.clientY >= r.top &&
          ev.clientY <= r.bottom;
        if (!inside) dialog.close("");
      }
    };
    dialog.returnValue = "";
    dialog.addEventListener("close", onClose);
    dialog.addEventListener("click", onLightDismiss);
    dialog.showModal();
  });
}

function confirmDialog(message: string): Promise<boolean> {
  const dlg = document.getElementById("confirm-dialog") as HTMLDialogElement;
  const msgEl = dlg.querySelector<HTMLParagraphElement>("#confirm-message");
  if (msgEl) msgEl.textContent = message;
  return openDialog(dlg).then((v) => v === "ok");
}

function infoDialog(message: string): Promise<void> {
  const dlg = document.getElementById("info-dialog") as HTMLDialogElement;
  const msgEl = dlg.querySelector<HTMLParagraphElement>("#info-message");
  if (msgEl) msgEl.textContent = message;
  return openDialog(dlg).then(() => undefined);
}

let toastTimer: number | null = null;
function showToast(
  message: string,
  kind: "ok" | "warn" | "error" = "ok",
  duration = 4000,
): void {
  const toast = document.getElementById("toast") as HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  };
  toast.textContent = message;
  toast.classList.remove("is-ok", "is-warn", "is-error");
  toast.classList.add(`is-${kind}`);
  if (typeof toast.showPopover === "function") {
    try { toast.showPopover(); } catch { /* already open */ }
  } else {
    // popover 未対応フォールバック
    toast.style.display = "block";
  }
  if (toastTimer != null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    if (typeof toast.hidePopover === "function") {
      try { toast.hidePopover(); } catch { /* already closed */ }
    } else {
      toast.style.display = "none";
    }
    toastTimer = null;
  }, duration);
}

async function main(): Promise<void> {
  const breweries = await loadJSON<BreweryGeo[]>("./data/breweries.geo.json");

  const map = L.map("map").setView([35.65, 139.7], 6);
  L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
    attribution:
      '地図データ &copy; <a href="https://www.gsi.go.jp/">国土地理院</a>',
    maxZoom: 18,
  }).addTo(map);

  const markersLayer = L.layerGroup().addTo(map);

  const years = unique(breweries.map((b) => String(b.fiscalYear))).sort();
  const yearFrom = document.getElementById("filter-year-from") as HTMLSelectElement;
  const yearTo = document.getElementById("filter-year-to") as HTMLSelectElement;
  fillSelect(yearFrom, years, false);
  fillSelect(yearTo, years, false);
  yearFrom.value = years[0]!;
  yearTo.value = years[years.length - 1]!;

  const licenseSel = document.getElementById("filter-license") as HTMLSelectElement;
  fillSelect(licenseSel, unique(breweries.map((b) => b.licenseCategory)));
  const itemSel = document.getElementById("filter-item") as HTMLSelectElement;
  fillSelect(itemSel, unique(breweries.map((b) => b.item)));
  const prefSel = document.getElementById("filter-pref") as HTMLSelectElement;
  fillSelect(prefSel, unique(breweries.map((b) => b.prefecture)));

  const onlyGeocoded = document.getElementById("filter-only-geocoded") as HTMLInputElement;
  const onlyFavorites = document.getElementById("filter-only-favorites") as HTMLInputElement;
  const summary = document.getElementById("summary") as HTMLDivElement;
  const favListEl = document.getElementById("fav-list") as HTMLUListElement;
  const favCountEl = document.getElementById("fav-count") as HTMLSpanElement;
  const favClearBtn = document.getElementById("fav-clear") as HTMLButtonElement;
  const favExportBtn = document.getElementById("fav-export") as HTMLButtonElement;

  const favStore = new FavoriteStore();
  const breweryByKey = new Map<string, BreweryGeo>();
  for (const b of breweries) breweryByKey.set(breweryKey(b), b);
  const markerByKey = new Map<string, L.CircleMarker>();

  const poiContainer = document.getElementById("poi-plugin") as HTMLElement;
  const poi = new PoiPlugin({
    container: poiContainer,
    map,
    onChange: () => apply(),
  });

  // ----- シェアURLからの復元 -----
  const shared = await readStateFromUrl();
  if (shared) {
    const f = shared.f;
    if (years.includes(f.yearFrom)) yearFrom.value = f.yearFrom;
    if (years.includes(f.yearTo)) yearTo.value = f.yearTo;
    licenseSel.value = f.license;
    itemSel.value = f.item;
    prefSel.value = f.prefecture;
    onlyGeocoded.checked = !!f.onlyGeocoded;
    onlyFavorites.checked = !!f.onlyFavorites;
    favStore.setAll(shared.fav);
    poi.replaceSets(shared.poi);
    // URL からハッシュは消す（リロード時に二重復元しないため）
    history.replaceState(null, "", location.pathname + location.search);
  }

  function apply(): void {
    const yFrom = Number(yearFrom.value);
    const yTo = Number(yearTo.value);
    const lic = licenseSel.value;
    const item = itemSel.value;
    const pref = prefSel.value;

    markersLayer.clearLayers();
    markerByKey.clear();
    let shown = 0;
    let total = 0;
    const favOnly = onlyFavorites.checked;
    for (const b of breweries) {
      total++;
      const key = breweryKey(b);
      if (favOnly && !favStore.has(key)) continue;
      if (b.fiscalYear < yFrom || b.fiscalYear > yTo) continue;
      if (lic && b.licenseCategory !== lic) continue;
      if (item && b.item !== item) continue;
      if (pref && b.prefecture !== pref) continue;
      if (onlyGeocoded.checked && (b.lat == null || b.lon == null)) continue;

      const loc = b.lat != null && b.lon != null ? { lat: b.lat, lon: b.lon } : null;
      if (!poi.passes(loc)) continue;

      if (b.lat == null || b.lon == null) continue;

      const isFav = favStore.has(key);
      const marker = L.circleMarker([b.lat, b.lon], {
        radius: isFav ? 7 : 5,
        color: isFav ? "#d4a017" : "#c0392b",
        weight: isFav ? 2 : 1,
        fillColor: isFav ? "#ffd84a" : "#e74c3c",
        fillOpacity: 0.8,
      })
        .bindPopup(() => buildPopup(b, key))
        .addTo(markersLayer);
      markerByKey.set(key, marker);
      shown++;
    }
    summary.textContent = `表示中: ${shown} 件 / 全 ${total} 件`;
  }

  function buildPopup(b: BreweryGeo, key: string): HTMLElement {
    const div = document.createElement("div");
    div.className = "popup";
    const fav = favStore.has(key);
    div.innerHTML = `
      <h3>${escapeHtml(b.producer)}</h3>
      <dl>
        <dt>年度</dt><dd>${b.fiscalYear} (${b.sourceEra})</dd>
        <dt>所在地</dt><dd>${escapeHtml(b.address)}</dd>
        <dt>免許区分</dt><dd>${escapeHtml(b.licenseCategory)}</dd>
        <dt>品目</dt><dd>${escapeHtml(b.item)}</dd>
        <dt>処理区分</dt><dd>${escapeHtml(b.processingCategory)}</dd>
        <dt>免許日</dt><dd>${b.licenseDate ?? ""}</dd>
        <dt>税務署</dt><dd>${escapeHtml(b.taxOffice)}</dd>
      </dl>
      <button type="button" class="fav-btn" aria-pressed="${fav}">
        ${fav ? "★ お気に入り済み" : "☆ お気に入りに追加"}
      </button>`;
    const btn = div.querySelector<HTMLButtonElement>(".fav-btn")!;
    btn.addEventListener("click", () => {
      const nowFav = favStore.toggle(key);
      btn.setAttribute("aria-pressed", String(nowFav));
      btn.textContent = nowFav ? "★ お気に入り済み" : "☆ お気に入りに追加";
      renderFavorites();
      apply();
    });
    return div;
  }

  function renderFavorites(): void {
    const keys = favStore.keys();
    favCountEl.textContent = String(keys.length);
    favListEl.innerHTML = "";
    for (const key of keys) {
      const b = breweryByKey.get(key);
      const li = document.createElement("li");
      if (!b) {
        li.innerHTML = `<span class="fav-name" title="${escapeHtml(key)}">(不明) ${escapeHtml(key)}</span>`;
      } else {
        const name = document.createElement("span");
        name.className = "fav-name";
        name.textContent = `${b.producer} (${b.prefecture}/${b.fiscalYear})`;
        name.title = `${b.producer}\n${b.address}`;
        name.addEventListener("click", () => focusBrewery(b, key));
        li.appendChild(name);
      }
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "fav-remove";
      rm.textContent = "×";
      rm.title = "お気に入りから外す";
      rm.addEventListener("click", () => {
        // CSS の @starting-style / transition-behavior: allow-discrete で
        // 退出アニメーションが効くよう、まず hidden を立ててから remove する
        li.hidden = true;
        const finalize = (): void => {
          favStore.remove(key);
          renderFavorites();
          apply();
        };
        const onEnd = (ev: TransitionEvent): void => {
          if (ev.propertyName !== "opacity") return;
          li.removeEventListener("transitionend", onEnd);
          finalize();
        };
        li.addEventListener("transitionend", onEnd);
        // フォールバック（prefers-reduced-motion 等で transitionend が即時の場合の保険）
        window.setTimeout(() => {
          li.removeEventListener("transitionend", onEnd);
          if (li.isConnected) finalize();
        }, 400);
      });
      li.appendChild(rm);
      favListEl.appendChild(li);
    }
  }

  function focusBrewery(b: BreweryGeo, key: string): void {
    if (b.lat == null || b.lon == null) {
      void infoDialog("ジオコーディング失敗のため位置が不明です");
      return;
    }
    map.setView([b.lat, b.lon], Math.max(map.getZoom(), 13));
    const m = markerByKey.get(key);
    if (m) m.openPopup();
  }

  const inputs: (HTMLSelectElement | HTMLInputElement)[] = [
    yearFrom, yearTo, licenseSel, itemSel, prefSel, onlyGeocoded, onlyFavorites,
  ];
  for (const el of inputs) el.addEventListener("change", apply);

  favClearBtn.addEventListener("click", async () => {
    if (favStore.keys().length === 0) return;
    const ok = await confirmDialog("お気に入りを全クリアします。よろしいですか？");
    if (!ok) return;
    favStore.clear();
    renderFavorites();
    apply();
  });


  // ----- シェアURLコピー -----
  const shareCopyBtn = document.getElementById("share-copy") as HTMLButtonElement;
  shareCopyBtn.addEventListener("click", async () => {
    try {
      const state: ShareableState = {
        v: 1,
        f: {
          yearFrom: yearFrom.value,
          yearTo: yearTo.value,
          license: licenseSel.value,
          item: itemSel.value,
          prefecture: prefSel.value,
          onlyGeocoded: onlyGeocoded.checked,
          onlyFavorites: onlyFavorites.checked,
        },
        fav: favStore.keys(),
        poi: poi.exportSets(),
      };
      const url = await buildShareUrl(state);
      await navigator.clipboard.writeText(url);
      const len = url.length;
      if (len > 32000) {
        showToast(
          `URLをコピーしました (${len} 文字) — ⚠️ かなり長く、SNS等で使えない可能性があります`,
          "warn",
          6000,
        );
      } else if (len > 8000) {
        showToast(
          `URLをコピーしました (${len} 文字) — ⚠️ 長めです。SNSでの共有には不向きかも`,
          "warn",
          5000,
        );
      } else {
        showToast(`URLをコピーしました (${len} 文字)`, "ok");
      }
    } catch (e) {
      showToast(`失敗: ${(e as Error).message}`, "error", 5000);
    }
  });
  favExportBtn.addEventListener("click", () => {
    const items = favStore
      .keys()
      .map((k) => breweryByKey.get(k))
      .filter((b): b is BreweryGeo => !!b);
    const blob = new Blob([JSON.stringify(items, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sake-favorites-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  renderFavorites();
  apply();

  // ----- モバイルサイドバー開閉 -----
  const sidebarToggle = document.getElementById(
    "sidebar-toggle",
  ) as HTMLButtonElement | null;
  const sidebarBackdrop = document.getElementById("sidebar-backdrop");
  const sidebarEl = document.getElementById("sidebar");
  if (sidebarToggle && sidebarBackdrop && sidebarEl) {
    const setOpen = (open: boolean) => {
      document.body.classList.toggle("sidebar-open", open);
      sidebarToggle.setAttribute("aria-expanded", String(open));
      sidebarToggle.setAttribute(
        "aria-label",
        open ? "メニューを閉じる" : "メニューを開く",
      );
      sidebarToggle.textContent = open ? "✕" : "☰";
      sidebarBackdrop.hidden = !open;
    };
    sidebarToggle.addEventListener("click", () => {
      setOpen(!document.body.classList.contains("sidebar-open"));
    });
    sidebarBackdrop.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        document.body.classList.contains("sidebar-open")
      ) {
        setOpen(false);
      }
    });
    // 地図上のマーカーをタップしたら自動で閉じる（モバイルで地図が見やすいよう）
    sidebarEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest("#fav-list a, #fav-list button")) {
        if (window.matchMedia("(max-width: 768px)").matches) setOpen(false);
      }
    });
  }
}

// 自動起動はブラウザ実行時のみ。テスト等で import された場合はスキップ。
if (!import.meta.env?.VITEST) {
  void main().catch((e) => {
    console.error(e);
    const summary = document.getElementById("summary");
    if (summary) summary.textContent = `読み込みエラー: ${(e as Error).message}`;
  });
}

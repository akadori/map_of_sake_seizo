import L from "leaflet";

/**
 * 汎用「ノード距離フィルタ」プラグイン。
 *
 * ユーザーがブラウザで JSON をアップロードすると、サイドバーに
 * 「セット名 / 半径km / グループ別チェック / 削除」UI が動的に生える。
 * 製造所が「有効なすべてのセットそれぞれについて、半径km以内に
 * チェックされたいずれかのノードが存在する」場合に passes() が true。
 *
 * 永続化: localStorage キー POI_STORAGE_KEY に保存。
 */

const POI_STORAGE_KEY = "map_of_sake_seizo:poi-sets:v1";

export interface Poi {
  name: string;
  lat: number;
  lon: number;
  group?: string;
}

export interface PoiSet {
  id: string;
  /** ユーザー定義のセット名（既定: ファイル名） */
  name: string;
  /** km */
  radiusKm: number;
  enabled: boolean;
  /** null = 全グループ有効、配列 = 指定グループのみ。グループ無しの場合は無視。 */
  selectedGroups: string[] | null;
  points: Poi[];
}

export interface PoiPluginOptions {
  container: HTMLElement;
  map: L.Map;
  /** フィルタが変化した時に呼ばれる（main.ts から apply() を再実行） */
  onChange: () => void;
  /** サンプルプリセット: ボタン一発で読み込めるようにする */
  presets?: { label: string; url: string; defaultRadiusKm?: number }[];
}

/** 平面近似距離 (km)。日本国内程度の距離なら十分。 */
function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function genId(): string {
  return `poi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 入力 JSON を Poi[] に正規化する。
 * 受け付ける形式:
 *  1) Poi[] そのまま: [{name, lat, lon, group?}, ...]
 *  2) GeoJSON FeatureCollection of Point: features[].geometry.coordinates=[lon,lat],
 *     properties.name / properties.group
 */
function normalizePois(input: unknown): Poi[] {
  const out: Poi[] = [];
  const pushPoint = (
    name: unknown,
    lat: unknown,
    lon: unknown,
    group: unknown,
  ): void => {
    if (typeof lat !== "number" || typeof lon !== "number") return;
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    out.push({
      name: typeof name === "string" && name ? name : "(no name)",
      lat,
      lon,
      group: typeof group === "string" && group ? group : undefined,
    });
  };

  // GeoJSON
  if (
    input &&
    typeof input === "object" &&
    (input as { type?: string }).type === "FeatureCollection" &&
    Array.isArray((input as { features?: unknown }).features)
  ) {
    const features = (input as { features: unknown[] }).features;
    for (const f of features) {
      if (!f || typeof f !== "object") continue;
      const feat = f as {
        geometry?: { type?: string; coordinates?: number[] };
        properties?: Record<string, unknown>;
      };
      if (feat.geometry?.type !== "Point") continue;
      const coords = feat.geometry.coordinates;
      if (!coords || coords.length < 2) continue;
      const props = feat.properties ?? {};
      pushPoint(
        props["name"] ?? props["title"],
        coords[1],
        coords[0],
        props["group"],
      );
    }
    return out;
  }

  // Array
  if (Array.isArray(input)) {
    for (const e of input) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      pushPoint(o["name"], o["lat"], o["lon"], o["group"]);
    }
    return out;
  }

  throw new Error("対応していない形式です（配列 or GeoJSON FeatureCollection）");
}

export class PoiPlugin {
  private opts: PoiPluginOptions;
  private sets: PoiSet[] = [];
  private setsLayer: Map<string, L.LayerGroup> = new Map();
  private root: HTMLElement;
  private listEl: HTMLDivElement;

  constructor(opts: PoiPluginOptions) {
    this.opts = opts;
    this.root = opts.container;
    this.listEl = document.createElement("div");
    this.listEl.className = "poi-sets";
    this.buildHeader();
    this.root.appendChild(this.listEl);
    this.restore();
  }

  // ---------------------------------------------------------- header / import
  private buildHeader(): void {
    const header = document.createElement("div");
    header.className = "poi-header";
    header.innerHTML = `
      <h2>📍 距離フィルタ</h2>
      <p class="poi-help">
        ノードのJSONを取り込むと、そこから N km 以内で絞り込めます。
        <a href="./about.html#poi-json" target="_blank" rel="noopener noreferrer">JSON形式の説明 ↗</a>
      </p>
    `;
    const actions = document.createElement("div");
    actions.className = "poi-actions";

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json,application/geo+json";
    fileInput.multiple = true;
    fileInput.id = "poi-file";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files ?? []);
      for (const f of files) void this.importFile(f);
      fileInput.value = "";
    });

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.textContent = "📂 JSONを取り込む";
    importBtn.addEventListener("click", () => fileInput.click());

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "✏️ JSONを直接書く";
    editBtn.addEventListener("click", () => this.openEditor());

    actions.appendChild(importBtn);
    actions.appendChild(editBtn);
    actions.appendChild(fileInput);

    for (const preset of this.opts.presets ?? []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "poi-preset";
      b.textContent = `＋ ${preset.label}`;
      b.addEventListener("click", () => {
        void this.importUrl(preset.url, preset.label, preset.defaultRadiusKm);
      });
      actions.appendChild(b);
    }

    header.appendChild(actions);
    this.root.appendChild(header);
  }

  // ---------------------------------------------------------- inline editor
  /**
   * JSON 入力ダイアログを開く。
   * editingId を渡すと「編集モード」になり、保存時は新規追加ではなく既存セットを置き換える。
   */
  private openEditor(
    initialName = "",
    initialJson = "",
    editingId: string | null = null,
  ): void {
    const isEdit = editingId !== null;
    const dlg = document.createElement("dialog");
    dlg.className = "poi-editor-dialog";
    dlg.setAttribute("closedby", "any");
    dlg.innerHTML = `
      <form method="dialog" class="poi-editor-form">
        <h2>${isEdit ? "JSONを編集" : "JSONを直接書く"}</h2>
        <p class="poi-editor-hint">
          配列形式 または GeoJSON FeatureCollection。
          <a href="./about.html#poi-json" target="_blank" rel="noopener noreferrer">形式の説明 ↗</a>
        </p>
        <label class="poi-editor-name">
          <span>セット名</span>
          <input type="text" name="name" placeholder="(例) 山手線駅" />
        </label>
        <label class="poi-editor-body">
          <span>JSON</span>
          <textarea
            name="json"
            rows="14"
            spellcheck="false"
            placeholder='[\n  { "name": "東京駅", "lat": 35.6812, "lon": 139.7671 }\n]'
          ></textarea>
        </label>
        <p class="poi-editor-error" hidden></p>
        <menu class="dialog-actions">
          <button type="button" value="sample" class="poi-editor-sample">サンプル挿入</button>
          <button type="submit" value="cancel">キャンセル</button>
          <button type="submit" value="ok" class="primary">${isEdit ? "保存" : "取り込む"}</button>
        </menu>
      </form>
    `;

    const form = dlg.querySelector("form") as HTMLFormElement;
    const nameEl = form.elements.namedItem("name") as HTMLInputElement;
    const jsonEl = form.elements.namedItem("json") as HTMLTextAreaElement;
    const errEl = dlg.querySelector(".poi-editor-error") as HTMLParagraphElement;
    const sampleBtn = dlg.querySelector(".poi-editor-sample") as HTMLButtonElement;
    const okBtn = dlg.querySelector('button[value="ok"]') as HTMLButtonElement;

    nameEl.value = initialName;
    jsonEl.value = initialJson;

    sampleBtn.addEventListener("click", () => {
      jsonEl.value = JSON.stringify(
        [
          { name: "東京駅", lat: 35.6812, lon: 139.7671, group: "JR山手線" },
          { name: "新宿駅", lat: 35.6896, lon: 139.7006, group: "JR山手線" },
          { name: "渋谷駅", lat: 35.658, lon: 139.7016, group: "JR山手線" },
        ],
        null,
        2,
      );
      if (!nameEl.value) nameEl.value = "山手線サンプル";
    });

    okBtn.addEventListener("click", (e) => {
      // submit を一旦保留して検証
      const text = jsonEl.value.trim();
      if (!text) {
        e.preventDefault();
        this.showEditorError(errEl, "JSON を入力してください");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        e.preventDefault();
        this.showEditorError(errEl, `JSON 構文エラー: ${(err as Error).message}`);
        return;
      }
      let points;
      try {
        points = normalizePois(parsed);
      } catch (err) {
        e.preventDefault();
        this.showEditorError(errEl, (err as Error).message);
        return;
      }
      if (points.length === 0) {
        e.preventDefault();
        this.showEditorError(
          errEl,
          "有効なポイント (lat/lon が数値) が見つかりませんでした",
        );
        return;
      }
      // 成功
      if (isEdit && editingId) {
        // グループ集合が変わった場合、selectedGroups の存在しないグループは落とす
        const existing = this.sets.find((s) => s.id === editingId);
        const newGroups = new Set(
          points.map((p) => p.group).filter((g): g is string => !!g),
        );
        const selectedGroups =
          existing?.selectedGroups?.filter((g) => newGroups.has(g)) ?? null;
        this.updateSet(editingId, {
          name: nameEl.value.trim() || existing?.name || "手入力セット",
          points,
          selectedGroups,
        });
      } else {
        this.addSet({
          id: genId(),
          name: nameEl.value.trim() || "手入力セット",
          radiusKm: 2,
          enabled: true,
          selectedGroups: null,
          points,
        });
      }
    });

    dlg.addEventListener("close", () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    // 名前欄にフォーカス
    queueMicrotask(() => nameEl.focus());
  }

  private showEditorError(el: HTMLElement, message: string): void {
    el.textContent = message;
    el.hidden = false;
  }

  private async importFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const points = normalizePois(json);
      if (points.length === 0) {
        alert(`${file.name}: 有効なポイントが見つかりませんでした`);
        return;
      }
      this.addSet({
        id: genId(),
        name: file.name.replace(/\.[^.]+$/, ""),
        radiusKm: 2,
        enabled: true,
        selectedGroups: null,
        points,
      });
    } catch (e) {
      alert(`${file.name}: ${(e as Error).message}`);
    }
  }

  private async importUrl(
    url: string,
    label: string,
    defaultRadiusKm = 2,
  ): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const points = normalizePois(json);
      if (points.length === 0) {
        alert(`${label}: 有効なポイントが見つかりませんでした`);
        return;
      }
      this.addSet({
        id: genId(),
        name: label,
        radiusKm: defaultRadiusKm,
        enabled: true,
        selectedGroups: null,
        points,
      });
    } catch (e) {
      alert(`${label}: ${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------- set management
  private addSet(set: PoiSet): void {
    this.sets.push(set);
    this.persist();
    this.render();
    this.opts.onChange();
  }

  private removeSet(id: string): void {
    this.sets = this.sets.filter((s) => s.id !== id);
    const layer = this.setsLayer.get(id);
    if (layer) {
      this.opts.map.removeLayer(layer);
      this.setsLayer.delete(id);
    }
    this.persist();
    this.render();
    this.opts.onChange();
  }

  private updateSet(id: string, patch: Partial<PoiSet>): void {
    const i = this.sets.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.sets[i] = { ...this.sets[i]!, ...patch };
    this.persist();
    this.render();
    this.opts.onChange();
  }

  // ---------------------------------------------------------- render
  private render(): void {
    this.listEl.innerHTML = "";

    if (this.sets.length === 0) {
      const empty = document.createElement("p");
      empty.className = "poi-empty";
      empty.textContent = "（まだセットがありません）";
      this.listEl.appendChild(empty);
      this.refreshMapMarkers();
      return;
    }

    for (const set of this.sets) {
      const card = document.createElement("div");
      card.className = "poi-card";
      const groups = uniqueGroups(set.points);

      const header = document.createElement("div");
      header.className = "poi-card-header";

      const enable = document.createElement("input");
      enable.type = "checkbox";
      enable.checked = set.enabled;
      enable.addEventListener("change", () => {
        this.updateSet(set.id, { enabled: enable.checked });
      });

      const title = document.createElement("input");
      title.type = "text";
      title.value = set.name;
      title.className = "poi-name";
      title.addEventListener("change", () => {
        this.updateSet(set.id, { name: title.value });
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.className = "poi-remove";
      remove.title = "このセットを削除";
      remove.addEventListener("click", () => {
        if (confirm(`「${set.name}」を削除します`)) this.removeSet(set.id);
      });

      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "✏️";
      edit.className = "poi-edit";
      edit.title = "JSONを編集";
      edit.addEventListener("click", () => {
        const json = JSON.stringify(set.points, null, 2);
        this.openEditor(set.name, json, set.id);
      });

      header.appendChild(enable);
      header.appendChild(title);
      header.appendChild(edit);
      header.appendChild(remove);
      card.appendChild(header);

      const meta = document.createElement("div");
      meta.className = "poi-meta";
      meta.innerHTML = `<span>${set.points.length} pts</span>`;
      card.appendChild(meta);

      const radiusRow = document.createElement("label");
      radiusRow.className = "poi-radius";
      radiusRow.innerHTML = `<span>半径</span>`;
      const rIn = document.createElement("input");
      rIn.type = "number";
      rIn.min = "0.1";
      rIn.step = "0.5";
      rIn.value = String(set.radiusKm);
      rIn.addEventListener("change", () => {
        const v = Number(rIn.value);
        if (Number.isFinite(v) && v > 0) {
          this.updateSet(set.id, { radiusKm: v });
        }
      });
      radiusRow.appendChild(rIn);
      const km = document.createElement("span");
      km.textContent = "km";
      radiusRow.appendChild(km);
      card.appendChild(radiusRow);

      if (groups.length > 0) {
        const gWrap = document.createElement("div");
        gWrap.className = "poi-groups";
        const allOn = document.createElement("button");
        allOn.type = "button";
        allOn.className = "poi-all";
        allOn.textContent = "全部";
        allOn.addEventListener("click", () =>
          this.updateSet(set.id, { selectedGroups: null }),
        );
        gWrap.appendChild(allOn);
        const allOff = document.createElement("button");
        allOff.type = "button";
        allOff.className = "poi-all";
        allOff.textContent = "全部解除";
        allOff.addEventListener("click", () =>
          this.updateSet(set.id, { selectedGroups: [] }),
        );
        gWrap.appendChild(allOff);

        for (const g of groups) {
          const lab = document.createElement("label");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = set.selectedGroups == null || set.selectedGroups.includes(g);
          cb.addEventListener("change", () => {
            const current =
              set.selectedGroups == null ? [...groups] : [...set.selectedGroups];
            const next = cb.checked
              ? Array.from(new Set([...current, g]))
              : current.filter((x) => x !== g);
            this.updateSet(set.id, { selectedGroups: next });
          });
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(g));
          gWrap.appendChild(lab);
        }
        card.appendChild(gWrap);
      }

      this.listEl.appendChild(card);
    }

    this.refreshMapMarkers();
  }

  private refreshMapMarkers(): void {
    // 一旦全レイヤを削除
    for (const [, layer] of this.setsLayer) {
      this.opts.map.removeLayer(layer);
    }
    this.setsLayer.clear();

    for (const set of this.sets) {
      if (!set.enabled) continue;
      const layer = L.layerGroup().addTo(this.opts.map);
      for (const p of this.activePoints(set)) {
        L.circleMarker([p.lat, p.lon], {
          radius: 6,
          color: "#2266aa",
          weight: 2,
          fillColor: "#4a90d9",
          fillOpacity: 0.8,
        })
          .bindTooltip(`${set.name}${p.group ? " / " + p.group : ""} : ${p.name}`)
          .addTo(layer);
      }
      this.setsLayer.set(set.id, layer);
    }
  }

  private activePoints(set: PoiSet): Poi[] {
    if (set.selectedGroups == null) return set.points;
    const sel = new Set(set.selectedGroups);
    return set.points.filter(
      (p) => p.group == null || sel.has(p.group),
    );
  }

  // ---------------------------------------------------------- public API
  /**
   * 製造所が現在の有効セット全てを通過するか。
   * 緯度経度なしの製造所は、有効セットがあれば常に false。
   */
  passes(loc: { lat: number; lon: number } | null): boolean {
    const enabled = this.sets.filter((s) => s.enabled);
    if (enabled.length === 0) return true;
    if (!loc) return false;
    for (const set of enabled) {
      const pts = this.activePoints(set);
      if (pts.length === 0) return false;
      const r = set.radiusKm;
      const ok = pts.some((p) => distanceKm(loc, p) <= r);
      if (!ok) return false;
    }
    return true;
  }

  /** いずれかのセットが有効なら true（main.ts で「位置不明は除外」判定に使う） */
  hasActiveSet(): boolean {
    return this.sets.some((s) => s.enabled);
  }

  /** 現在の全セットをそのまま返す（シェアURL用） */
  exportSets(): PoiSet[] {
    return this.sets.map((s) => ({ ...s }));
  }

  /** 全セットを差し替える（シェアURL読み込み時用） */
  replaceSets(sets: unknown[]): void {
    const normalized: PoiSet[] = [];
    for (const s of sets) {
      if (!s || typeof s !== "object") continue;
      const o = s as Partial<PoiSet> & Record<string, unknown>;
      if (!Array.isArray(o.points)) continue;
      normalized.push({
        id: typeof o.id === "string" ? o.id : genId(),
        name: typeof o.name === "string" ? o.name : "(no name)",
        radiusKm:
          typeof o.radiusKm === "number" && o.radiusKm > 0 ? o.radiusKm : 2,
        enabled: o.enabled !== false,
        selectedGroups: Array.isArray(o.selectedGroups)
          ? (o.selectedGroups.filter((x) => typeof x === "string") as string[])
          : null,
        points: (o.points as unknown[]).filter(
          (p) =>
            !!p &&
            typeof p === "object" &&
            typeof (p as Poi).lat === "number" &&
            typeof (p as Poi).lon === "number",
        ) as Poi[],
      });
    }
    this.sets = normalized;
    this.persist();
    this.render();
    this.opts.onChange();
  }

  // ---------------------------------------------------------- persistence
  private persist(): void {
    try {
      localStorage.setItem(POI_STORAGE_KEY, JSON.stringify(this.sets));
    } catch {
      // ignore (quota etc.)
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(POI_STORAGE_KEY);
      if (!raw) {
        this.render();
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        this.render();
        return;
      }
      this.sets = parsed
        .filter((s): s is PoiSet => !!s && typeof s === "object")
        .map((s) => {
          const o = s as Partial<PoiSet> & Record<string, unknown>;
          return {
            id: typeof o.id === "string" ? o.id : genId(),
            name: typeof o.name === "string" ? o.name : "(no name)",
            radiusKm:
              typeof o.radiusKm === "number" && o.radiusKm > 0 ? o.radiusKm : 2,
            enabled: o.enabled !== false,
            selectedGroups: Array.isArray(o.selectedGroups)
              ? (o.selectedGroups.filter((x) => typeof x === "string") as string[])
              : null,
            points: Array.isArray(o.points)
              ? (o.points.filter(
                  (p) =>
                    p &&
                    typeof p === "object" &&
                    typeof (p as Poi).lat === "number" &&
                    typeof (p as Poi).lon === "number",
                ) as Poi[])
              : [],
          };
        });
    } catch {
      this.sets = [];
    }
    this.render();
  }
}

function uniqueGroups(points: Poi[]): string[] {
  const set = new Set<string>();
  for (const p of points) if (p.group) set.add(p.group);
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

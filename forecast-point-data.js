import { LIVE_ROOT, decodeLiveCSV, liveFile, liveSlots, utcTime } from "./live-temperature-data.js";
import { projectRiskField } from "./forecast-risk-data.js?v=20261110-risk-colors1";
import { lookupCell } from "./temperature-layer.js";

export const POINT_FORECAST_FIELDS = [
  ["weather3h", "天気"],
  ["temp3h", "気温（℃）"],
  ["precip3h", "3時間降水量（mm）"],
  ["snow3h", "3時間降雪量（cm）"],
];

const categories = {
  weather3h: {1:"晴れ", 2:"くもり", 3:"雨", 4:"雨または雪", 5:"雪"},
  precip3h: {0:"1未満", 1:"1〜4", 5:"5〜9", 10:"10〜14", 15:"15〜19", 20:"20以上"},
  snow3h: {0:"1未満", 1:"1〜2", 3:"3〜5", 6:"6以上"},
};

export function pointForecastCell(lng, lat) {
  if (lng < 122 || lng >= 150 || lat < 20 || lat >= 48 || !Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const col = Math.floor(lng * 16), row = Math.floor(lat * 20);
  return {col, row, center:[(col + .5) / 16, (row + .5) / 20]};
}

function pointForecastSlots(manifest, now) {
  const generated = Date.parse(manifest?.generated_at);
  if (!Number.isFinite(generated) || now - generated > 8 * 3600000 || generated - now > 5 * 60000) {
    throw new Error("予測データの更新時刻を確認できません");
  }
  const fields = new Map(POINT_FORECAST_FIELDS.map(([kind]) => {
    const slots = kind === "temp3h" ? liveSlots(manifest, kind) : manifest.layers?.[kind]?.slots;
    if (!Array.isArray(slots) || slots.length > 48) throw new Error("予測の対象時刻を確認できません");
    const available = slots.filter(slot => slot.status === "available").map(slot => {
      if (slot.id !== `${kind}_${slot.validtime}`) throw new Error("予測資料の参照が不正です");
      return {...slot, end:Date.parse(utcTime(slot.validtime)), issued:Date.parse(utcTime(slot.basetime))};
    });
    return [kind, available];
  }));
  const issued = Math.max(...[...fields.values()].flat().map(slot => slot.issued));
  const periods = new Map();
  for (const [kind, slots] of fields) {
    for (const slot of slots) {
      if (slot.issued !== issued || slot.end < now) continue;
      if (!periods.has(slot.end)) periods.set(slot.end, {end:slot.end, slots:{}});
      const period = periods.get(slot.end);
      if (Object.hasOwn(period.slots, kind)) throw new Error("予測の対象時刻が重複しています");
      period.slots[kind] = slot;
    }
  }
  if (!periods.size || periods.size > 48) throw new Error("表示できる予測期間がありません");
  return {issued, periods:[...periods.values()].sort((a, b) => a.end - b.end)};
}

export async function readPointForecast(cell, {signal, previous, fetchImpl = fetch, now = Date.now} = {}) {
  async function get(path, cache = "no-cache") {
    signal?.throwIfAborted();
    const response = await fetchImpl(LIVE_ROOT + path, {signal, cache, credentials:"omit", referrerPolicy:"no-referrer"});
    if (!response.ok) throw new Error("予測資料を取得できません");
    const text = await response.text();
    if (text.length > 5_000_000) throw new Error("予測資料のサイズが不正です");
    return text;
  }

  const readManifest = async () => JSON.parse(await get(`forecast_manifest.json?_=${now()}`, "no-store"));
  const manifest = await readManifest();
  const manifestKey = JSON.stringify(manifest);
  const {issued, periods} = pointForecastSlots(manifest, now());
  if (previous?.manifestKey === manifestKey && !previous.incomplete) {
    const firstEnd = periods[0].end;
    return {...previous, series:previous.series.filter(period => period.end >= firstEnd)};
  }
  const grid = {count:1, colScale:16, rowScale:20, rows:[cell.row], cols:[cell.col]};
  let incomplete = false;

  // Download one period at a time so a selection never starts dozens of simultaneous requests.
  const series = [];
  for (const {end, slots} of periods) {
    signal?.throwIfAborted();
    const values = await Promise.all(POINT_FORECAST_FIELDS.map(async ([kind]) => {
      const slot = slots[kind];
      if (!slot) return null;
      try {
        if (kind === "temp3h") {
          const text = await get(liveFile(kind, slot));
          const data = decodeLiveCSV(text, kind, slot);
          const value = data.values[lookupCell(data.grid, ...cell.center)];
          return Number.isFinite(value) ? value.toFixed(1) : null;
        }
        const collection = JSON.parse(await get(`forecast_${slot.id}_value.geojson`));
        const [category] = projectRiskField(collection, grid, kind);
        return categories[kind][category] ?? null;
      } catch {
        signal?.throwIfAborted();
        incomplete = true;
        return null;
      }
    }));
    series.push({end, values});
  }

  if (JSON.stringify(await readManifest()) !== manifestKey) {
    throw new Error("読み込み中に予報が更新されました");
  }
  return {issued, series, incomplete, manifestKey};
}

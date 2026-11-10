import { SNOW_BIN_STARTS, SNOW_MAX_BIN } from "./snow-display-data.js";

// 0 is unknown, 1 keeps the road's base color; greater values take priority.
export const ROAD_RISK_COLORS = Object.freeze([
  "#75838c", "#000000", "#b7d943", "#ffe032", "#ff8c24",
  "#f35ea7", "#e53232", "#8d38c9", "#000000",
]);
export const NORMAL_ROAD_RULES = Object.freeze([
  "資料不足", "該当なし", "2℃超〜5℃", "0℃超〜2℃", "0℃以下",
  "積雪現象あり・0cm", "積雪1〜2cm", "積雪3cm以上10cm未満", "積雪10cm以上",
]);

export function normalRoadClass(temperatureClass, snowBin) {
  if (!Number.isInteger(temperatureClass) || temperatureClass < 0 || temperatureClass > 4
    || !Number.isInteger(snowBin) || snowBin < 0 || snowBin > SNOW_MAX_BIN) {
    throw new Error("道路判定の気温・積雪階級が不正です");
  }
  if (snowBin >= 2) {
    const depth = snowBin === 2 ? 0 : SNOW_BIN_STARTS[snowBin - 3];
    return depth >= 10 ? 8 : depth >= 3 ? 7 : depth >= 1 ? 6 : 5;
  }
  // Missing snow is not evidence of no snow; do not show a complete judgment.
  return snowBin === 0 ? 0 : temperatureClass;
}

export function combineNormalRoadClasses(temperature, snow) {
  if (!(temperature instanceof Uint8Array) || !(snow instanceof Uint8Array)
    || temperature.length !== snow.length) throw new Error("道路判定の格子が一致しません");
  return temperature.map((value, i) => normalRoadClass(value, snow[i]));
}

export function createNormalRoadRisk(loadSnow, hooks = {}) {
  let request = 0, selected = null;
  async function setDay(temperature, day) {
    const token = ++request;
    selected = { temperature, day };
    hooks.onUnavailable?.("loading");
    try {
      const snow = await loadSnow(day);
      if (token !== request) return;
      const classes = combineNormalRoadClasses(temperature, snow);
      hooks.onData?.({ classes, snow, day });
    } catch {
      if (token === request) hooks.onUnavailable?.("error");
    }
  }
  return {
    setDay,
    retry() { if (selected) return setDay(selected.temperature, selected.day); },
    clear() { ++request; selected = null; },
  };
}

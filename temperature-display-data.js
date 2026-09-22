import { expandDay } from "./temperature-layer.js";

// Classes are computed from the source's 0.1-degree values, not inferred from
// the rounded display bands. The zero value remains exclusively missing.
export const ROAD_CLASSES = Object.freeze([
  { id: 0, meaning: "missing" },
  { id: 1, lower_exclusive_c: 5, upper_inclusive_c: null, color: "original" },
  { id: 2, lower_exclusive_c: 2, upper_inclusive_c: 5, color: "yellow" },
  { id: 3, lower_exclusive_c: 0, upper_inclusive_c: 2, color: "orange" },
  { id: 4, lower_exclusive_c: null, upper_inclusive_c: 0, color: "red" },
]);

export function validRoadClassContract(value) {
  return Array.isArray(value) && value.length === ROAD_CLASSES.length
    && value.every((entry, i) => entry && Object.keys(entry).length === Object.keys(ROAD_CLASSES[i]).length
      && Object.entries(ROAD_CLASSES[i]).every(([key, expected]) => entry[key] === expected));
}

export function roadClassLabel(value) {
  const labels = ["気温なし", "5℃超（従来色）", "2℃超〜5℃以下（黄）", "0℃超〜2℃以下（だいだい）", "0℃以下（赤）"];
  if (!Number.isInteger(value) || value < 0 || value > 4) throw new Error("道路の気温区分が不正です");
  return labels[value];
}

export function decodeDisplayDay(data, count) {
  const bins = expandDay(data, count);
  if (!Array.isArray(data.road_runs) || data.road_runs.length % 2) throw new Error("道路の気温区分がありません");
  // Four supported classes fit in two bits. Missing is already identified by
  // bins==0, so a year of cached road classes uses ~35 MB rather than ~142 MB.
  const roadCodes = new Uint8Array(Math.ceil(count / 4));
  let offset = 0;
  for (let r = 0; r < data.road_runs.length; r += 2) {
    const value = data.road_runs[r], length = data.road_runs[r + 1];
    if (!Number.isInteger(value) || value < 0 || value > 4 || !Number.isSafeInteger(length) || length < 1 || offset + length > count) throw new Error("道路の気温区分・格子数が不正です");
    for (let end = offset + length; offset < end; offset++) {
      const bin = bins[offset];
      const allowed = bin === 0 ? value === 0 : bin <= 40 ? value === 4
        : bin === 41 ? value === 3 || value === 4 : bin === 42 ? value === 3
        : bin === 43 ? value === 2 || value === 3 : bin <= 45 ? value === 2
        : bin === 46 ? value === 1 || value === 2 : value === 1;
      if (!allowed) throw new Error("道路の気温区分と気温面が一致しません");
      if (value) roadCodes[offset >>> 2] |= (value - 1) << ((offset & 3) * 2);
    }
  }
  if (offset !== count) throw new Error("道路の気温区分の格子数が一致しません");
  return { bins, roadCodes };
}

export function unpackRoadClasses(data) {
  const { bins, roadCodes } = data;
  if (!(bins instanceof Uint8Array) || !(roadCodes instanceof Uint8Array) || roadCodes.length !== Math.ceil(bins.length / 4)) throw new Error("道路の気温区分を展開できません");
  const result = new Uint8Array(bins.length);
  for (let i = 0; i < result.length; i++) result[i] = bins[i] ? ((roadCodes[i >>> 2] >>> ((i & 3) * 2)) & 3) + 1 : 0;
  return result;
}

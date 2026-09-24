export const SNOW_THRESHOLDS = Object.freeze([0, 1, 5, 10, 20, 50, 100]);
export const SNOW_BIN_STARTS = Object.freeze([
  ...Array.from({ length: 4 }, (_, i) => 1 + i),
  ...Array.from({ length: 5 }, (_, i) => 5 + i),
  ...Array.from({ length: 10 }, (_, i) => 10 + i),
  ...Array.from({ length: 15 }, (_, i) => 20 + i * 2),
  ...Array.from({ length: 10 }, (_, i) => 50 + i * 5),
  ...Array.from({ length: 20 }, (_, i) => 100 + Math.floor(i * 250 / 20)),
]);
export const SNOW_MAX_BIN = SNOW_BIN_STARTS.length + 2;

export const SNOW_COLORS = Object.freeze(Array.from({ length: 82 }, (_, bin) => {
  if (bin < 2) return "#000000"; // Fully transparent in the mesh renderer.
  const depth = bin === 2 ? 0 : SNOW_BIN_STARTS[Math.min(bin - 3, SNOW_BIN_STARTS.length - 1)];
  const shade = Math.max(0, Math.round(255 * (1 - depth / 337)));
  const hex = shade.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}));

export const CONTOUR_COLORS = Object.freeze([
  "#202020", "#353535", "#353535", "#353535", "#353535", "#353535", "#ffffff",
]);

export function snowBinLabel(bin) {
  if (!Number.isInteger(bin) || bin < 0 || bin > SNOW_MAX_BIN) throw new Error("積雪階級が不正です");
  if (bin === 0) return "判定不能・欠測";
  if (bin === 1) return "現象なし";
  if (bin === 2) return "現象あり・0cm";
  const index = bin - 3;
  const lower = SNOW_BIN_STARTS[index];
  const upper = SNOW_BIN_STARTS[index + 1];
  return upper === undefined ? `${lower}cm以上` : lower === upper - 1 ? `${lower}cm` : `${lower}〜${upper - 1}cm`;
}

export function checkedSnowManifest(manifest, count, temperatureGridSha, seasonDays) {
  if (manifest?.schema_version !== 1 || manifest.source_id !== "daily-snow-depth-normals-1km"
    || manifest.cell_count !== count || manifest.grid_sha256 !== temperatureGridSha
    || manifest.missing_bin !== 0 || manifest.absent_bin !== 1 || manifest.present_zero_bin !== 2
    || !Array.isArray(manifest.positive_bin_starts_cm)
    || manifest.positive_bin_starts_cm.length !== SNOW_BIN_STARTS.length
    || manifest.positive_bin_starts_cm.some((value, i) => value !== SNOW_BIN_STARTS[i])
    || !Array.isArray(manifest.days)
    || manifest.days.length !== seasonDays.length || manifest.days.some((day, i) => day !== seasonDays[i])
    || !Array.isArray(manifest.thresholds_cm) || manifest.thresholds_cm.some((value, i) => value !== SNOW_THRESHOLDS[i])
    || manifest.thresholds_cm.length !== SNOW_THRESHOLDS.length
    || !Array.isArray(manifest.files) || manifest.files.length !== seasonDays.length
    || manifest.files.some((file, i) => file.day !== seasonDays[i]
      || file.url !== `${seasonDays[i]}.json.gz`
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 500_000
      || !Number.isSafeInteger(file.uncompressed_bytes) || file.uncompressed_bytes < 1 || file.uncompressed_bytes > 4_000_000
      || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("積雪表示データの一覧が不正です");
  return manifest;
}

export function decodeSnowDay(data, count, expectedDay) {
  if (data?.day !== expectedDay || data.cell_count !== count || !Array.isArray(data.runs)
    || typeof data.contours !== "object" || data.contours === null || Array.isArray(data.contours)
    || data.runs.length % 2 || data.runs.length > count * 2) throw new Error("積雪の日付・格子数が不正です");
  const runs = new Uint32Array(data.runs.length);
  let position = 0;
  for (let i = 0; i < data.runs.length; i += 2) {
    const bin = data.runs[i], length = data.runs[i + 1];
    if (!Number.isInteger(bin) || bin < 0 || bin > SNOW_MAX_BIN || !Number.isSafeInteger(length)
      || length < 1 || position + length > count) throw new Error("積雪階級の並びが不正です");
    runs[i] = bin; runs[i + 1] = length; position += length;
  }
  if (position !== count || Object.keys(data.contours).length !== SNOW_THRESHOLDS.length) {
    throw new Error("積雪の格子数または等値線が一致しません");
  }
  const contours = [];
  for (const threshold of SNOW_THRESHOLDS) {
    const values = data.contours[String(threshold)];
    if (!Array.isArray(values) || values.length % 3 || values.length > 300_000) {
      throw new Error("積雪の等値線が不正です");
    }
    const packed = new Uint16Array(values.length);
    for (let i = 0; i < values.length; i += 3) {
      const row = values[i], col = values[i + 1], axis = values[i + 2];
      if (!Number.isInteger(row) || row < 0 || row > 10206
        || !Number.isInteger(col) || col < 0 || col > 14400
        || (axis !== 0 && axis !== 1)) throw new Error("積雪の等値線座標が不正です");
      packed[i] = row; packed[i + 1] = col; packed[i + 2] = axis;
    }
    contours.push(packed);
  }
  return { runs, contours };
}

export function expandSnowBins(compact, count) {
  const bins = new Uint8Array(count);
  let position = 0;
  for (let i = 0; i < compact.runs.length; i += 2) {
    const length = compact.runs[i + 1];
    bins.fill(compact.runs[i], position, position + length);
    position += length;
  }
  if (position !== count) throw new Error("積雪格子を復元できません");
  return bins;
}

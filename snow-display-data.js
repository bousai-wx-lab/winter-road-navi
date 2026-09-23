export const SNOW_THRESHOLDS = Object.freeze([1, 5, 10, 20, 50, 100]);

export const SNOW_COLORS = Object.freeze([
  "#000000", "#000000", "#d7f2f7", "#b5e2f1", "#88cbe8", "#58add9", "#327fbf", "#1e5595",
]);

export const CONTOUR_COLORS = Object.freeze([
  "#2b819e", "#276f9a", "#235d91", "#204b87", "#1c3978", "#182b68",
]);

export function snowBinLabel(bin) {
  const labels = ["欠測（推定できません）", "0cm", "1〜4cm", "5〜9cm", "10〜19cm", "20〜49cm", "50〜99cm", "100cm以上"];
  if (!Number.isInteger(bin) || bin < 0 || bin >= labels.length) throw new Error("積雪階級が不正です");
  return labels[bin];
}

export function checkedSnowManifest(manifest, count, temperatureGridSha, seasonDays) {
  if (manifest?.schema_version !== 1 || manifest.source_id !== "daily-snow-depth-normals-1km"
    || manifest.cell_count !== count || manifest.grid_sha256 !== temperatureGridSha
    || manifest.missing_bin !== 0 || !Array.isArray(manifest.days)
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
    if (!Number.isInteger(bin) || bin < 0 || bin > 7 || !Number.isSafeInteger(length)
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

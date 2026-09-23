import assert from "node:assert/strict";
import test from "node:test";
import { checkedSnowManifest, decodeSnowDay, expandSnowBins, snowBinLabel, SNOW_THRESHOLDS } from "../snow-display-data.js";
import { contourVertices, createSnowContourLayer } from "../snow-contour-layer.js";

test("snow classes retain missing, true zero and six positive threshold bands", () => {
  const runs = [0, 1, 1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1, 7, 1];
  const contours = Object.fromEntries(SNOW_THRESHOLDS.map((threshold) => [String(threshold), []]));
  const compact = decodeSnowDay({ day: "01-15", cell_count: 8, runs, contours }, 8, "01-15");
  assert.deepEqual([...expandSnowBins(compact, 8)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(snowBinLabel(0), "欠測（推定できません）");
  assert.equal(snowBinLabel(1), "0cm");
  assert.equal(snowBinLabel(7), "100cm以上");
  assert.throws(() => snowBinLabel(8));
});

test("snow manifest requires the exact shared display grid and season", () => {
  const season = ["09-15", "09-16"];
  const record = (day) => ({ day, url: `${day}.json.gz`, sha256: "a".repeat(64), bytes: 100, uncompressed_bytes: 200 });
  const base = { schema_version: 1, source_id: "daily-snow-depth-normals-1km", cell_count: 8,
    grid_sha256: "b".repeat(64), missing_bin: 0, days: season, thresholds_cm: SNOW_THRESHOLDS,
    files: season.map(record) };
  assert.equal(checkedSnowManifest(base, 8, base.grid_sha256, season), base);
  assert.throws(() => checkedSnowManifest({ ...base, grid_sha256: "c".repeat(64) }, 8, base.grid_sha256, season));
  assert.throws(() => checkedSnowManifest({ ...base, days: [...season].reverse() }, 8, base.grid_sha256, season));
  assert.throws(() => checkedSnowManifest({ ...base, thresholds_cm: [1, 5] }, 8, base.grid_sha256, season));
  assert.throws(() => checkedSnowManifest({ ...base, files: [record("09-15"), record("09-15")] }, 8, base.grid_sha256, season));
});

test("bad snow runs and contour coordinates fail before rendering", () => {
  const contours = Object.fromEntries(SNOW_THRESHOLDS.map((threshold) => [String(threshold), []]));
  const base = { day: "02-29", cell_count: 2, runs: [1, 1, 2, 1], contours };
  assert.throws(() => decodeSnowDay({ ...base, runs: [1, 2, 8, 1] }, 2, "02-29"));
  assert.throws(() => decodeSnowDay({ ...base, runs: [1, 1] }, 2, "02-29"));
  assert.throws(() => decodeSnowDay({ ...base, day: "02-28" }, 2, "02-29"));
  assert.throws(() => decodeSnowDay({ ...base, contours: { ...contours, 1: [100, 200, 2] } }, 2, "02-29"));
  assert.throws(() => decodeSnowDay({ ...base, contours: { ...contours, 1: [100, 200] } }, 2, "02-29"));
});

test("contour segments use exact original 1 km edges in Mercator", () => {
  const groups = SNOW_THRESHOLDS.map(() => new Uint16Array(0));
  groups[0] = new Uint16Array([4282, 11175, 0]);
  groups[1] = new Uint16Array([4282, 11175, 1]);
  const { vertices, ranges } = contourVertices(groups);
  const x = ((11175 + 1) / 80 + 180) / 360;
  const y = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
  assert.ok(Math.abs(vertices[0] - x) < 3e-8);
  assert.ok(Math.abs(vertices[2] - x) < 3e-8);
  assert.ok(Math.abs(vertices[1] - y(4282 / 120)) < 3e-8);
  assert.ok(Math.abs(vertices[3] - y(4283 / 120)) < 3e-8);
  assert.deepEqual(ranges.slice(0, 3), [[0, 2], [2, 2], [4, 0]]);
  const layer = createSnowContourLayer();
  assert.equal(layer.id, "snow-contours");
  layer.setContours(groups);
  layer.setVisible(true);
  layer.setOpacity(0.55);
  assert.throws(() => layer.setOpacity(2));
  assert.throws(() => layer.setVisible("yes"));
});

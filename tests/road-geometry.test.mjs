import test from "node:test";
import assert from "node:assert/strict";
import { expandGrid } from "../temperature-layer.js";
import { buildRoadGeometry, gridIndex, latitudeAt, mercatorPoint, roadKind, roadPixelWidth, splitSegment } from "../road-geometry.js";

const grid = expandGrid({ cell_count: 9, runs: [4282, 11175, 3, 4283, 11175, 3, 4284, 11175, 3] });
const centre = (row, col) => mercatorPoint((col + .5) / 80, (row + .5) / 120);
const line = (coordinates, properties = { ftCode: 2701 }) => ({ type: "Feature", properties, geometry: { type: "LineString", coordinates } });
const bounds = [11175 / 80, 4282 / 120, 11178 / 80, 4285 / 120];
const close = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);

test("Tokyo grid crossing splits precisely into three cells", () => {
  const a = centre(4282, 11175), b = centre(4282, 11177);
  const result = splitSegment(a, b, grid);
  assert.deepEqual(result.map((s) => s.cell), [0, 1, 2]);
  close(result[0].b[0], (11176 / 80 + 180) / 360);
  close(result[1].b[0], (11177 / 80 + 180) / 360);
  for (let i = 1; i < result.length; i++) assert.deepEqual(result[i - 1].b, result[i].a);
});

test("diagonal road is split at both native latitude and longitude edges", () => {
  const a = centre(4282, 11175), b = centre(4284, 11177);
  const result = splitSegment(a, b, grid);
  assert.ok(result.length >= 3 && result.length <= 5);
  assert.equal(result[0].cell, 0); assert.equal(result.at(-1).cell, 8);
  for (const item of result) {
    const midpoint = item.a.map((v, i) => (v + item.b[i]) / 2);
    assert.equal(item.cell, gridIndex(grid, ...midpoint));
    for (const fraction of [.01, .99]) {
      const p = item.a.map((v, i) => v + (item.b[i] - v) * fraction);
      assert.equal(gridIndex(grid, ...p), item.cell);
    }
  }
  for (let i = 1; i < result.length; i++) {
    const p = result[i].a;
    const col = (p[0] * 360 - 180) * 80, row = latitudeAt(p[1]) * 120;
    assert.ok(Math.abs(col - Math.round(col)) < 1e-7 || Math.abs(row - Math.round(row)) < 1e-7);
  }
});

test("a road lying exactly on a boundary belongs to the northern/eastern cell", () => {
  const a = mercatorPoint(11176 / 80, 4282.1 / 120), b = mercatorPoint(11176 / 80, 4282.9 / 120);
  assert.deepEqual(splitSegment(a, b, grid).map((s) => s.cell), [1]);
  const c = mercatorPoint(11175.1 / 80, 4283 / 120), d = mercatorPoint(11175.9 / 80, 4283 / 120);
  assert.deepEqual(splitSegment(c, d, grid).map((s) => s.cell), [3]);
  assert.deepEqual(splitSegment(a, a, grid), []);
});

test("missing or absent grid cells retain a zero texture index instead of a warm category", () => {
  const sparse = expandGrid({ cell_count: 2, runs: [4282, 11175, 1, 4282, 11177, 1] });
  const coordinates = [[11175.2 / 80, 4282.5 / 120], [11177.8 / 80, 4282.5 / 120]];
  const result = buildRoadGeometry([line(coordinates)], sparse, bounds);
  assert.equal(result.general.segmentCount, 3);
  assert.deepEqual([...result.general.cells.slice(0, 3)], [1, 0, 2]);
});

test("reversed copies and partially overlapping tile fragments do not duplicate line segments", () => {
  const y = 4282.5 / 120;
  const full = [[11175.1 / 80, y], [11177.9 / 80, y]];
  const partial = [[11175.7 / 80, y], [11177.3 / 80, y]];
  const result = buildRoadGeometry([line(full), line([...full].reverse()), line(partial)], grid, bounds);
  assert.equal(result.general.segmentCount, 3);
  assert.equal(result.highway.count, 0);
  const unknown = buildRoadGeometry([line(full, { ftCode: 99999 })], grid, bounds);
  assert.equal(unknown.general.count, 0);
});

test("nearby parallel roads remain separate and local float coordinates preserve precise placement", () => {
  const a = [[11175.2 / 80, 4282.5 / 120], [11175.8 / 80, 4282.5 / 120]];
  const b = a.map(([lng, lat]) => [lng, lat + .00001]);
  const result = buildRoadGeometry([line(a), line(b)], grid, bounds);
  assert.equal(result.general.segmentCount, 2);
  const expected = mercatorPoint(...a[0]);
  close(result.general.positions[0] + result.origin[0], expected[0]);
  close(result.general.positions[1] + result.origin[1], expected[1]);
});

test("road classification and zoom-dependent widths match the native style", () => {
  assert.equal(roadKind({ motorway: "1", ftCode: 2701 }), "highway");
  assert.equal(roadKind({ ftCode: 52704 }), "highway");
  assert.equal(roadKind({ ftCode: 2702 }), "general");
  assert.equal(roadKind({ ftCode: 99 }), null);
  assert.equal(roadPixelWidth("general", 5), .8);
  assert.equal(roadPixelWidth("general", 15), 4.2);
  assert.equal(roadPixelWidth("highway", 4), 2.2);
  assert.equal(roadPixelWidth("highway", 18), 6.3);
  close(roadPixelWidth("highway", 10), 4.25);
});

test("viewport clipping bounds processing to visible surroundings and preserves original joins", () => {
  const long = line([[130, 4282.5 / 120], [11175.5 / 80, 4282.5 / 120], [150, 4282.5 / 120]]);
  const result = buildRoadGeometry([long], grid, bounds);
  assert.equal(result.general.segmentCount, 3);
  assert.equal(result.general.jointCount, 1);
  assert.ok(result.general.count < 10);
});

test("original vertices on a mesh boundary use correctly coloured half/quarter joins", () => {
  const y = 4282.5 / 120;
  const boundary = line([[11175.3 / 80, y], [11176 / 80, y], [11176.7 / 80, y]]);
  const result = buildRoadGeometry([boundary], grid, bounds).general;
  const half = [...result.clips].map((clip, i) => ({ clip, cell: result.cells[i] })).filter((item) => item.clip);
  assert.deepEqual(half, [{ clip: 2, cell: 1 }, { clip: 1, cell: 2 }]);
  const corner = line([[11175.3 / 80, 4282.3 / 120], [11176 / 80, 4283 / 120], [11176.7 / 80, 4283.7 / 120]]);
  const quarters = buildRoadGeometry([corner], grid, bounds).general;
  const pieces = [...quarters.clips].map((clip, i) => ({ clip, cell: quarters.cells[i] })).filter((item) => item.clip);
  assert.deepEqual(pieces, [{ clip: 10, cell: 4 }, { clip: 6, cell: 1 }, { clip: 9, cell: 5 }, { clip: 5, cell: 2 }]);
  assert.equal(result.clips.length, result.count);
  assert.equal(quarters.clips.length, quarters.count);
});

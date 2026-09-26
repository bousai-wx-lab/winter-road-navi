import { createMapStyle } from "./road-style.js";

// Only currently loaded, nearby road features are processed here. Coordinates
// remain doubles until made relative to a local origin for GPU upload.
const EPSILON = 1e-12;
const POINT_SCALE = 1e10;
const GENERAL_CODES = new Set([2701, 2702, 2703, 2704, 52701, 52702]);
const WIDTHS = Object.fromEntries(createMapStyle().layers.filter((layer) => ["general-road", "highway"].includes(layer.id))
  .map((layer) => [layer.id === "highway" ? "highway" : "general", layer.paint["line-width"]]));

export function roadKind(properties = {}) {
  if (Number(properties.motorway) === 1 || Number(properties.rdCtg) === 3
    || [52703, 52704].includes(Number(properties.ftCode))) return "highway";
  return GENERAL_CODES.has(Number(properties.ftCode)) ? "general" : null;
}

export function mercatorPoint(lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) >= 85.05112878) throw new Error("道路座標が不正です");
  return [(lng + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2];
}

export function latitudeAt(y) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}

export function gridIndex(grid, x, y) {
  const row = Math.floor(latitudeAt(y) * (grid.rowScale ?? 120) + 1e-8);
  const col = Math.floor((x * 360 - 180) * (grid.colScale ?? 80) + 1e-8);
  let lo = 0, hi = grid.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (grid.rows[mid] < row || (grid.rows[mid] === row && grid.cols[mid] < col)) lo = mid + 1;
    else hi = mid;
  }
  return lo < grid.count && grid.rows[lo] === row && grid.cols[lo] === col ? lo : -1;
}

// Exact intersections with native longitude/latitude cell edges, in the same
// Mercator plane that MapLibre uses to draw each vector-tile line segment.
export function splitSegment(a, b, grid) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < EPSILON) return [];
  const cuts = [0, 1];
  const rowScale = grid.rowScale ?? 120, colScale = grid.colScale ?? 80;
  if (Math.abs(dx) > EPSILON) {
    const lo = (Math.min(a[0], b[0]) * 360 - 180) * colScale;
    const hi = (Math.max(a[0], b[0]) * 360 - 180) * colScale;
    for (let col = Math.floor(lo) + 1; col < hi; col++) {
      const t = (((col / colScale + 180) / 360) - a[0]) / dx;
      if (t > EPSILON && t < 1 - EPSILON) cuts.push(t);
    }
  }
  if (Math.abs(dy) > EPSILON) {
    const lo = Math.min(latitudeAt(a[1]), latitudeAt(b[1])) * rowScale;
    const hi = Math.max(latitudeAt(a[1]), latitudeAt(b[1])) * rowScale;
    for (let row = Math.floor(lo) + 1; row < hi; row++) {
      const edge = mercatorPoint(0, row / rowScale)[1];
      const t = (edge - a[1]) / dy;
      if (t > EPSILON && t < 1 - EPSILON) cuts.push(t);
    }
  }
  cuts.sort((x, y) => x - y);
  const unique = cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > EPSILON);
  return unique.slice(1).map((end, i) => {
    const start = unique[i];
    const p = [a[0] + start * dx, a[1] + start * dy];
    const q = [a[0] + end * dx, a[1] + end * dy];
    return { a: p, b: q, cell: gridIndex(grid, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2) };
  });
}

function clipSegment(a, b, bounds) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let lo = 0, hi = 1;
  for (const [p, q] of [[-dx, a[0] - bounds[0]], [dx, bounds[2] - a[0]], [-dy, a[1] - bounds[1]], [dy, bounds[3] - a[1]]]) {
    if (Math.abs(p) < EPSILON) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [[a[0] + lo * dx, a[1] + lo * dy], [a[0] + hi * dx, a[1] + hi * dy]];
}

function pointKey(p) { return `${Math.round(p[0] * POINT_SCALE)},${Math.round(p[1] * POINT_SCALE)}`; }

// Union collinear fragments within each cell, including reversed tile copies
// and tile-buffer fragments with different endpoints. Distinct parallel roads
// must never be merged: the perpendicular tolerance is below a centimetre.
function mergeFragments(segments) {
  const groups = new Map();
  for (const item of segments) {
    let [a, b] = [item.a, item.b];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) [a, b] = [b, a];
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < EPSILON) continue;
    const ux = dx / length, uy = dy / length;
    const distance = -uy * a[0] + ux * a[1];
    const key = `${item.cell}:${Math.round(ux * 1e8)}:${Math.round(uy * 1e8)}:${Math.round(distance * POINT_SCALE)}`;
    let group = groups.get(key);
    if (!group) { group = { ux, uy, distance, cell: item.cell, intervals: [] }; groups.set(key, group); }
    group.intervals.push([ux * a[0] + uy * a[1], ux * b[0] + uy * b[1]]);
  }
  const result = [];
  for (const group of groups.values()) {
    const { ux, uy, distance, cell, intervals } = group;
    intervals.sort((a, b) => a[0] - b[0]);
    let current = intervals[0].slice();
    const emit = () => result.push({
      a: [ux * current[0] - uy * distance, uy * current[0] + ux * distance],
      b: [ux * current[1] - uy * distance, uy * current[1] + ux * distance], cell,
    });
    for (let i = 1; i < intervals.length; i++) {
      if (intervals[i][0] <= current[1] + EPSILON) current[1] = Math.max(current[1], intervals[i][1]);
      else { emit(); current = intervals[i].slice(); }
    }
    emit();
  }
  return result;
}

function pack(segments, joints, origin) {
  const merged = mergeFragments(segments);
  const all = [...merged, ...joints.values()].map((item) => ({ ...item, cell: item.cell + 1 }));
  const positions = new Float32Array(all.length * 4), cells = new Uint32Array(all.length), clips = new Uint8Array(all.length);
  all.forEach((item, i) => {
    positions.set([item.a[0] - origin[0], item.a[1] - origin[1], item.b[0] - origin[0], item.b[1] - origin[1]], i * 4);
    cells[i] = item.cell;
    clips[i] = item.clip || 0;
  });
  return { positions, cells, clips, count: all.length, segmentCount: merged.length, jointCount: joints.size };
}

export function buildRoadGeometry(features, grid, geographicBounds) {
  if (!grid || grid.rows?.length !== grid.count || grid.cols?.length !== grid.count) throw new Error("道路用格子定義が不正です");
  const [west, south, east, north] = geographicBounds;
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) throw new Error("道路の表示範囲が不正です");
  const sw = mercatorPoint(west, south), ne = mercatorPoint(east, north);
  const bounds = [sw[0], ne[1], ne[0], sw[1]];
  const origin = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const groups = { general: { segments: [], joints: new Map() }, highway: { segments: [], joints: new Map() } };
  for (const feature of features) {
    const kind = roadKind(feature.properties);
    if (!kind || !feature.geometry) continue;
    const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates : [];
    const group = groups[kind];
    for (const line of lines) {
      if (line.length < 2) continue;
      const points = line.map(([lng, lat]) => mercatorPoint(lng, lat));
      for (let i = 1; i < points.length; i++) {
        const clipped = clipSegment(points[i - 1], points[i], bounds);
        if (clipped) group.segments.push(...splitSegment(clipped[0], clipped[1], grid));
      }
      for (const p of points) {
        if (p[0] < bounds[0] || p[0] > bounds[2] || p[1] < bounds[1] || p[1] > bounds[3]) continue;
        // Original vertices retain a round join. Newly inserted grid crossings
        // have no disc, so those colour transitions remain butt-ended.
        const col = (p[0] * 360 - 180) * (grid.colScale ?? 80), row = latitudeAt(p[1]) * (grid.rowScale ?? 120);
        const onColumn = Math.abs(col - Math.round(col)) < 1e-7;
        const onRow = Math.abs(row - Math.round(row)) < 1e-7;
        // A source vertex can itself coincide with a mesh edge. Partition its
        // round join into half-/quarter-discs rather than bleeding one cell's
        // colour over its neighbour. Bits: east=1, west=2, south=4, north=8.
        for (const xSide of onColumn ? [-1, 1] : [0]) {
          for (const ySide of onRow ? [-1, 1] : [0]) {
            const cell = gridIndex(grid, p[0] + xSide * 1e-10, p[1] + ySide * 1e-10);
            const clip = (xSide > 0 ? 1 : xSide < 0 ? 2 : 0) | (ySide > 0 ? 4 : ySide < 0 ? 8 : 0);
            group.joints.set(`${cell}:${clip}:${pointKey(p)}`, { a: p, b: p, cell, clip });
          }
        }
      }
    }
  }
  return { origin, general: pack(groups.general.segments, groups.general.joints, origin), highway: pack(groups.highway.segments, groups.highway.joints, origin) };
}

// Read the native line-width interpolate expression from the shared road style.
export function roadPixelWidth(kind, zoom) {
  const expression = WIDTHS[kind];
  if (!expression || !Number.isFinite(zoom)) throw new Error("道路の線幅が不正です");
  if (zoom <= expression[3]) return expression[4];
  for (let i = 5; i < expression.length; i += 2) {
    if (zoom <= expression[i]) {
      const t = (zoom - expression[i - 2]) / (expression[i] - expression[i - 2]);
      return expression[i - 1] + t * (expression[i + 1] - expression[i - 1]);
    }
  }
  return expression.at(-1);
}

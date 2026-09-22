import assert from "node:assert/strict";
import test from "node:test";
import { expandGrid, expandDay, lookupCell, binLabel, paletteColor, createTemperatureLayer } from "../temperature-layer.js";

const tokyo = { cell_count: 1, runs: [4282, 11175, 1] };
const y = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;

test("mesh 53394525 has its native geographic and Mercator boundaries", () => {
  const grid = expandGrid(tokyo);
  assert.equal(grid.count, 1);
  assert.equal(lookupCell(grid, 139.69375, 35.6875), 0);
  const expected = [(139.6875 + 180) / 360, y(35.68333333333333), (139.7 + 180) / 360, y(35.69166666666667)];
  grid.rects.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 3e-8));
  assert.ok(grid.rects[1] > grid.rects[3], "Mercator y decreases northward");
  assert.equal(lookupCell(grid, 139.6875, 4282 / 120), 0);
  assert.equal(lookupCell(grid, 139.7, 35.6875), -1);
  assert.equal(lookupCell(grid, 139.69, 4283 / 120), -1);
});

test("rows and columns expand in order and lookup respects holes and row boundaries", () => {
  const grid = expandGrid({ cell_count: 5, runs: [4282, 11174, 2, 4282, 11177, 1, 4283, 11174, 2] });
  assert.deepEqual([...grid.rows], [4282, 4282, 4282, 4283, 4283]);
  assert.deepEqual([...grid.cols], [11174, 11175, 11177, 11174, 11175]);
  for (let i = 0; i < grid.count; i++) assert.equal(lookupCell(grid, (grid.cols[i] + 0.5) / 80, (grid.rows[i] + 0.5) / 120), i);
  assert.equal(lookupCell(grid, 11176.5 / 80, 4282.5 / 120), -1);
  assert.equal(lookupCell(grid, NaN, 35), -1);
  assert.equal(lookupCell(grid, 140, -35), -1);
});

test("grid input rejects mismatched counts, overlap, reversed order and invalid coordinates", () => {
  for (const grid of [
    { cell_count: 2, runs: tokyo.runs }, { cell_count: 1, runs: [4282, 11175] },
    { cell_count: 2, runs: [4282, 11175, 1, 4282, 11175, 1] },
    { cell_count: 2, runs: [4283, 11175, 1, 4282, 11175, 1] },
    { cell_count: 1, runs: [11000, 11175, 1] }, { cell_count: 1, runs: [4282, 14400, 1] },
    { cell_count: 1, runs: [4282, 11175, 0] }, { cell_count: 0, runs: [] },
  ]) assert.throws(() => expandGrid(grid));
});

test("day runs preserve missing data and 1-degree intervals including negative values", () => {
  assert.deepEqual([...expandDay({ day: "02-29", cell_count: 5, runs: [0, 1, 40, 2, 41, 1, 81, 1] }, 5)], [0, 40, 40, 41, 81]);
  assert.equal(binLabel(0), "推定値なし");
  assert.equal(binLabel(1), "-40℃以上 -39℃未満");
  assert.equal(binLabel(40), "-1℃以上 0℃未満");
  assert.equal(binLabel(41), "0℃以上 1℃未満");
  assert.equal(binLabel(81), "40℃以上 41℃未満");
  assert.equal(paletteColor(0), "#00000000");
  for (let bin = 1; bin <= 81; bin++) assert.match(paletteColor(bin), /^#[0-9a-f]{6}$/);
  assert.notEqual(paletteColor(40), paletteColor(41));
});

test("day runs fail closed on bad bins, truncated payloads or another grid", () => {
  for (const day of [
    { cell_count: 2, runs: [41, 1] }, { cell_count: 1, runs: [82, 1] },
    { cell_count: 1, runs: [-1, 1] }, { cell_count: 1, runs: [41, 2] },
    { cell_count: 1, runs: [41, 0] }, { cell_count: 1, runs: [41] },
  ]) assert.throws(() => expandDay(day, 1));
  assert.throws(() => binLabel(82));
  assert.throws(() => paletteColor(2.5));
});

test("layer controls validate data and preserve custom layer contract", () => {
  const layer = createTemperatureLayer(expandGrid(tokyo));
  assert.equal(layer.id, "temperature-mesh");
  assert.equal(layer.type, "custom");
  assert.equal(layer.renderingMode, "2d");
  layer.setBins(new Uint8Array([41]));
  layer.setOpacity(0.55);
  layer.setVisible(false);
  assert.throws(() => layer.setBins(new Uint8Array([82])));
  assert.throws(() => layer.setBins(new Uint8Array(2)));
  assert.throws(() => layer.setOpacity(2));
  assert.throws(() => layer.setOpacity(NaN));
  assert.throws(() => layer.setVisible("false"));
  assert.throws(() => layer.onAdd({}, {}), /WebGL 2/);
});

function fakeGL({ compile = true } = {}) {
  const gl = { draws: [], uploads: 0, deleted: 0 };
  const constants = ["CURRENT_PROGRAM", "VERTEX_ARRAY_BINDING", "ARRAY_BUFFER_BINDING", "BLEND", "DEPTH_TEST", "CULL_FACE", "DEPTH_WRITEMASK", "BLEND_SRC_RGB", "BLEND_DST_RGB", "BLEND_SRC_ALPHA", "BLEND_DST_ALPHA", "BLEND_EQUATION_RGB", "BLEND_EQUATION_ALPHA", "VERTEX_SHADER", "FRAGMENT_SHADER", "COMPILE_STATUS", "LINK_STATUS", "ARRAY_BUFFER", "STATIC_DRAW", "DYNAMIC_DRAW", "FLOAT", "UNSIGNED_BYTE", "FUNC_ADD", "ONE", "ONE_MINUS_SRC_ALPHA", "TRIANGLES"];
  constants.forEach((name, i) => { gl[name] = i + 1; });
  const parameters = new Map(constants.map((name) => [gl[name], `original-${name}`]));
  const enabled = new Set([gl.DEPTH_TEST, gl.CULL_FACE]);
  gl.snapshot = () => ({ parameters: [...parameters], enabled: [...enabled].sort() });
  gl.getParameter = (key) => parameters.get(key);
  gl.isEnabled = (key) => enabled.has(key);
  gl.enable = (key) => enabled.add(key);
  gl.disable = (key) => enabled.delete(key);
  gl.useProgram = (value) => parameters.set(gl.CURRENT_PROGRAM, value);
  gl.bindVertexArray = (value) => parameters.set(gl.VERTEX_ARRAY_BINDING, value);
  gl.bindBuffer = (target, value) => parameters.set(gl.ARRAY_BUFFER_BINDING, value);
  gl.depthMask = (value) => parameters.set(gl.DEPTH_WRITEMASK, value);
  gl.blendFuncSeparate = (...values) => [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].forEach((key, i) => parameters.set(key, values[i]));
  gl.blendEquationSeparate = (rgb, alpha) => { parameters.set(gl.BLEND_EQUATION_RGB, rgb); parameters.set(gl.BLEND_EQUATION_ALPHA, alpha); };
  for (const name of ["createShader", "createProgram", "createBuffer", "createVertexArray"]) gl[name] = () => ({});
  for (const name of ["shaderSource", "compileShader", "attachShader", "linkProgram", "enableVertexAttribArray", "vertexAttribPointer", "vertexAttribIPointer", "vertexAttribDivisor", "uniform3fv", "uniform1f"]) gl[name] = () => {};
  for (const name of ["deleteShader", "deleteProgram", "deleteBuffer", "deleteVertexArray"]) gl[name] = () => { gl.deleted++; };
  gl.getShaderParameter = () => compile;
  gl.getShaderInfoLog = () => "test compile failure";
  gl.getProgramParameter = () => true;
  gl.getUniformLocation = (program, name) => name;
  gl.bufferData = () => { gl.uploads++; };
  gl.bufferSubData = () => { gl.uploads++; };
  gl.uniformMatrix4fv = (location, transpose, matrix) => { assert.equal(transpose, false); assert.equal(matrix.length, 16); };
  gl.drawArraysInstanced = (...args) => gl.draws.push(args);
  return gl;
}

test("custom renderer restores GL state, uploads new bins once, and recreates lost resources", () => {
  const gl = fakeGL();
  const initial = gl.snapshot();
  const handlers = new Map();
  const map = { on: (name, fn) => handlers.set(name, fn), off: (name) => handlers.delete(name), triggerRepaint() {} };
  const layer = createTemperatureLayer(expandGrid(tokyo));
  const options = { defaultProjectionData: { mainMatrix: new Float32Array(16) } };
  layer.onAdd(map, gl);
  assert.deepEqual(gl.snapshot(), initial);
  assert.equal(gl.uploads, 2);
  layer.setBins(new Uint8Array([41]));
  layer.render(gl, options);
  assert.deepEqual(gl.snapshot(), initial);
  assert.equal(gl.uploads, 3);
  assert.deepEqual(gl.draws[0], [gl.TRIANGLES, 0, 6, 1]);
  layer.render(gl, options);
  assert.equal(gl.uploads, 3);
  layer.setVisible(false);
  layer.render(gl, options);
  assert.equal(gl.draws.length, 2);
  layer.setVisible(true);
  handlers.get("webglcontextlost")();
  layer.render(gl, options);
  assert.equal(gl.draws.length, 2);
  handlers.get("webglcontextrestored")();
  layer.render(gl, options);
  assert.equal(gl.draws.length, 3);
  assert.deepEqual(gl.snapshot(), initial);
  assert.throws(() => layer.render(gl, {}), /投影行列/);
  layer.onRemove(map, gl);
  assert.equal(handlers.size, 0);
  assert.ok(gl.deleted >= 8);
});

test("shader compilation errors remain explicit and restore the map's GL state", () => {
  const gl = fakeGL({ compile: false });
  const initial = gl.snapshot();
  const layer = createTemperatureLayer(expandGrid(tokyo));
  assert.throws(() => layer.onAdd({}, gl), /test compile failure/);
  assert.deepEqual(gl.snapshot(), initial);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createRoadTemperature } from "../road-temperature.js";
import { expandGrid } from "../temperature-layer.js";
import { buildRoadGeometry } from "../road-geometry.js";

const grid = () => expandGrid({ cell_count: 3, runs: [4282, 11175, 3] });
const features = [{ type: "Feature", properties: { ftCode: 2701 }, geometry: { type: "LineString", coordinates: [[11175.2 / 80, 4282.5 / 120], [11177.8 / 80, 4282.5 / 120]] } }];
const options = { defaultProjectionData: { mainMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } };

function fakeGL({ compile = true } = {}) {
  const gl = { uploads: 0, textures: [], draws: [], widths: [], integerAttributes: [], deleted: 0, drawingBufferWidth: 800, drawingBufferHeight: 600 };
  const constants = ["CURRENT_PROGRAM", "VERTEX_ARRAY_BINDING", "ARRAY_BUFFER_BINDING", "ACTIVE_TEXTURE", "TEXTURE_BINDING_2D", "UNPACK_ALIGNMENT", "BLEND", "DEPTH_TEST", "CULL_FACE", "DEPTH_WRITEMASK", "BLEND_SRC_RGB", "BLEND_DST_RGB", "BLEND_SRC_ALPHA", "BLEND_DST_ALPHA", "BLEND_EQUATION_RGB", "BLEND_EQUATION_ALPHA", "VERTEX_SHADER", "FRAGMENT_SHADER", "COMPILE_STATUS", "LINK_STATUS", "ARRAY_BUFFER", "DYNAMIC_DRAW", "FLOAT", "UNSIGNED_INT", "UNSIGNED_BYTE", "FUNC_ADD", "ONE", "ONE_MINUS_SRC_ALPHA", "TRIANGLES", "TEXTURE_2D", "MAX_TEXTURE_SIZE", "TEXTURE_MIN_FILTER", "TEXTURE_MAG_FILTER", "TEXTURE_WRAP_S", "TEXTURE_WRAP_T", "NEAREST", "CLAMP_TO_EDGE", "R8UI", "RED_INTEGER"];
  constants.forEach((key, i) => { gl[key] = i + 1; }); gl.TEXTURE0 = 1000;
  const parameters = new Map(constants.map((name) => [gl[name], `original-${name}`]));
  parameters.set(gl.ACTIVE_TEXTURE, gl.TEXTURE0 + 7); parameters.set(gl.MAX_TEXTURE_SIZE, 4096); parameters.set(gl.UNPACK_ALIGNMENT, 4);
  const textures = new Map([[gl.TEXTURE0, { name: "old-unit-zero" }], [gl.TEXTURE0 + 7, { name: "old-unit-seven" }]]);
  const enabled = new Set([gl.DEPTH_TEST, gl.CULL_FACE]);
  gl.snapshot = () => ({ parameters: [...parameters], textures: [...textures], enabled: [...enabled].sort() });
  gl.getParameter = (key) => key === gl.TEXTURE_BINDING_2D ? textures.get(parameters.get(gl.ACTIVE_TEXTURE)) : parameters.get(key);
  gl.isEnabled = (key) => enabled.has(key); gl.enable = (key) => enabled.add(key); gl.disable = (key) => enabled.delete(key);
  gl.useProgram = (value) => parameters.set(gl.CURRENT_PROGRAM, value);
  gl.bindVertexArray = (value) => parameters.set(gl.VERTEX_ARRAY_BINDING, value);
  gl.bindBuffer = (_, value) => parameters.set(gl.ARRAY_BUFFER_BINDING, value);
  gl.activeTexture = (value) => parameters.set(gl.ACTIVE_TEXTURE, value);
  gl.bindTexture = (_, value) => textures.set(parameters.get(gl.ACTIVE_TEXTURE), value);
  gl.pixelStorei = (key, value) => parameters.set(key, value);
  gl.depthMask = (value) => parameters.set(gl.DEPTH_WRITEMASK, value);
  gl.blendFuncSeparate = (...values) => [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].forEach((key, i) => parameters.set(key, values[i]));
  gl.blendEquationSeparate = (rgb, alpha) => { parameters.set(gl.BLEND_EQUATION_RGB, rgb); parameters.set(gl.BLEND_EQUATION_ALPHA, alpha); };
  for (const name of ["createShader", "createProgram", "createBuffer", "createVertexArray", "createTexture"]) gl[name] = () => ({});
  for (const name of ["shaderSource", "compileShader", "attachShader", "linkProgram", "enableVertexAttribArray", "vertexAttribPointer", "vertexAttribIPointer", "vertexAttribDivisor", "uniform1i", "uniform2f", "texParameteri", "texStorage2D"]) gl[name] = () => {};
  gl.vertexAttribIPointer = (...values) => gl.integerAttributes.push(values);
  for (const name of ["deleteShader", "deleteProgram", "deleteBuffer", "deleteVertexArray", "deleteTexture"]) gl[name] = () => { gl.deleted++; };
  gl.uniform1f = (name, value) => { if (name === "u_halfWidth") gl.widths.push(value); };
  gl.getShaderParameter = () => compile; gl.getShaderInfoLog = () => "test compiler error";
  gl.getProgramParameter = () => true; gl.getUniformLocation = (_, name) => name;
  gl.bufferData = () => { gl.uploads++; };
  gl.texSubImage2D = (...args) => gl.textures.push([...args.at(-1).slice(0, 4)]);
  gl.uniformMatrix4fv = (_, transpose, matrix) => { assert.equal(transpose, false); assert.ok([...matrix].every(Number.isFinite)); };
  gl.drawArraysInstanced = (...args) => gl.draws.push(args);
  return gl;
}

function makeMap(gl = fakeGL(), roadFeatures = features) {
  const layers = new Map(), handlers = new Map();
  const map = {
    gl, layers, orders: [], errors: [], queries: 0, zoom: 10, container: { dataset: {} },
    on(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); },
    off(name, handler) { handlers.get(name)?.delete(handler); },
    emit(name, detail = {}) { for (const handler of [...(handlers.get(name) || [])]) handler({ type: name, ...detail }); },
    addLayer(layer, before) { layers.set(layer.id, layer); map.orders.push([layer.id, before]); layer.onAdd(map, gl); },
    getLayer(id) { return layers.get(id); },
    removeLayer(id) { layers.get(id)?.onRemove(map, gl); layers.delete(id); },
    triggerRepaint() {},
    fire(name, detail) { if (name === "error") map.errors.push(detail); },
    getZoom() { return map.zoom; },
    getCanvas() { return { width: 800, height: 600, clientWidth: 800, clientHeight: 600 }; },
    getContainer() { return map.container; },
    getBounds() { return { getWest: () => 11175 / 80, getEast: () => 11178 / 80, getSouth: () => 4282 / 120, getNorth: () => 4283 / 120 }; },
    queryRenderedFeatures(query) { map.queries++; assert.deepEqual(query.layers, ["general-road", "highway"]); return roadFeatures; },
    render() { for (const layer of layers.values()) layer.render(gl, options); },
  };
  return map;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 90));

test("insertion order, original-road fallback, class texture and date-only GPU updates", async () => {
  const map = makeMap(), initial = map.gl.snapshot(), states = [];
  const roads = createRoadTemperature(map, grid(), (state) => states.push(state));
  try {
    assert.deepEqual(map.orders, [["road-temperature-general", "highway-casing"], ["road-temperature-highway", undefined]]);
    assert.deepEqual(map.gl.snapshot(), initial);
    assert.deepEqual(map.gl.integerAttributes.filter(([location]) => location === 2), [[2, 1, map.gl.UNSIGNED_BYTE, 0, 0], [2, 1, map.gl.UNSIGNED_BYTE, 0, 0]]);
    roads.setClasses(new Uint8Array([4, 3, 2]), "01-15");
    assert.equal(states.at(-1), "loading");
    await settle(); assert.equal(states.at(-1), "ready");
    assert.equal(map.container.dataset.roadTemperatureDay, "01-15");
    assert.equal(map.container.dataset.roadGeneralSegments, "3");
    assert.equal(map.container.dataset.roadHighwaySegments, "0");
    assert.equal(map.container.dataset.roadTemperatureReady, "true");
    const version = map.container.dataset.roadGeometryVersion;
    map.render();
    assert.deepEqual(map.gl.textures.at(-1), [0, 4, 3, 2]);
    const uploads = map.gl.uploads, queries = map.queries, draws = map.gl.draws.length;
    roads.setClasses(new Uint8Array([0, 1, 4]), "02-29"); map.render();
    assert.equal(map.gl.uploads, uploads, "date changes must not rebuild/upload road geometry");
    assert.equal(map.queries, queries, "date changes must not query road tiles");
    assert.equal(map.container.dataset.roadGeometryVersion, version);
    assert.equal(map.container.dataset.roadTemperatureDay, "02-29");
    assert.deepEqual(map.gl.textures.at(-1), [0, 0, 1, 4], "missing is distinct from warm");
    assert.equal(map.gl.draws.length, draws + 1);
    assert.deepEqual(map.gl.snapshot(), initial);
    roads.clear(); map.render(); assert.equal(map.gl.draws.length, draws + 1, "clear leaves only original roads");
    assert.equal(map.container.dataset.roadTemperatureDay, undefined);
    assert.equal(map.container.dataset.roadTemperatureReady, "false");
    assert.equal(states.at(-1), "loading");
    roads.setClasses(new Uint8Array([4, 3, 2]), "03-01");
    assert.deepEqual(states.slice(-2), ["loading", "ready"], "clear then load must notify ready again");
    assert.equal(map.container.dataset.roadTemperatureDay, "03-01");
  } finally { roads.destroy(); }
  assert.equal(map.layers.size, 0);
});

test("zoom uses native pixel widths, invalidates old geometry, and road visibility is independent", async () => {
  const map = makeMap(), states = [];
  const roads = createRoadTemperature(map, grid(), (state) => states.push(state));
  try {
    roads.setClasses(new Uint8Array([4, 4, 4]), "01-15"); await settle(); map.render();
    assert.equal(map.gl.widths.at(-1), 1.25);
    const count = map.gl.draws.length;
    roads.setGeneralVisible(false); map.render(); assert.equal(map.gl.draws.length, count);
    roads.setGeneralVisible(true);
    map.emit("zoomstart"); map.zoom = 15; map.render();
    assert.equal(map.gl.draws.length, count); assert.equal(states.at(-1), "loading");
    map.emit("sourcedata", { sourceId: "roads" }); await settle(); assert.equal(map.gl.draws.length, count);
    map.emit("zoomend"); await settle(); map.render();
    assert.equal(map.gl.widths.at(-1), 2.1); assert.equal(states.at(-1), "ready");
    const queries = map.queries;
    map.emit("sourcedata", { sourceId: "background" }); await settle(); assert.equal(map.queries, queries);
  } finally { roads.destroy(); }
});

test("nationwide zoom draws temperature-colored highways but not general roads", async () => {
  const highway = [{ ...features[0], properties: { ftCode: 52703 } }];
  const highwayMap = makeMap(fakeGL(), highway);
  const highways = createRoadTemperature(highwayMap, grid());
  try {
    highwayMap.zoom = 4.7;
    highways.setClasses(new Uint8Array([1, 2, 3]), "01-22");
    await settle(); highwayMap.render();
    assert.ok(highwayMap.gl.draws.length > 0);
    assert.ok(Number(highwayMap.container.dataset.roadHighwaySegments) > 0);
  } finally { highways.destroy(); }
  const generalMap = makeMap();
  const general = createRoadTemperature(generalMap, grid());
  try {
    generalMap.zoom = 4.7;
    general.setClasses(new Uint8Array([1, 2, 3]), "01-22");
    await settle(); generalMap.render();
    assert.equal(generalMap.gl.draws.length, 0);
  } finally { general.destroy(); }
});

test("GL context restoration recreates buffers and texture and restores shared GL state", async () => {
  const map = makeMap(), initial = map.gl.snapshot();
  const roads = createRoadTemperature(map, grid());
  try {
    roads.setClasses(new Uint8Array([4, 3, 2]), "01-15"); await settle(); map.render();
    const uploads = map.gl.uploads, textures = map.gl.textures.length, draws = map.gl.draws.length;
    map.emit("webglcontextlost"); map.render(); assert.equal(map.gl.draws.length, draws);
    assert.equal(map.container.dataset.roadTemperatureReady, "false");
    map.emit("webglcontextrestored"); map.render();
    assert.ok(map.gl.uploads > uploads); assert.equal(map.gl.textures.length, textures + 1);
    assert.equal(map.container.dataset.roadTemperatureReady, "true");
    assert.deepEqual(map.gl.snapshot(), initial);
  } finally { roads.destroy(); }
});

test("invalid data and shader failures are explicit, and render failure falls back to original roads", async () => {
  assert.throws(() => createRoadTemperature(makeMap(fakeGL({ compile: false })), grid()), /compiler error/);
  const map = makeMap(), states = [];
  const roads = createRoadTemperature(map, grid(), (state) => states.push(state));
  try {
    assert.throws(() => roads.setClasses(new Uint8Array([5, 1, 1]), "01-15"));
    assert.throws(() => roads.setClasses(new Uint8Array([1]), "01-15"));
    roads.setClasses(new Uint8Array([4, 3, 2]), "01-15"); await settle();
    map.layers.get("road-temperature-general").render(map.gl, {});
    assert.equal(states.at(-1), "error"); assert.equal(map.errors.length, 1);
    map.render(); assert.equal(map.gl.draws.length, 0);
  } finally { roads.destroy(); }
  assert.throws(() => roads.setClasses(new Uint8Array([1, 1, 1]), "01-15"));
});

test("old Worker replies cannot restore pre-zoom geometry or replace the latest date", async () => {
  const originalWorker = globalThis.Worker;
  const workers = [];
  globalThis.Worker = class {
    constructor() { this.jobs = []; workers.push(this); }
    postMessage(message) { this.jobs.push(message); }
    terminate() { this.terminated = true; }
    finish(job) { this.onmessage({ data: { generation: job.generation, geometry: buildRoadGeometry(job.features, grid(), job.bounds) } }); }
  };
  const map = makeMap(), states = [];
  const roads = createRoadTemperature(map, grid(), (state) => states.push(state));
  try {
    roads.setClasses(new Uint8Array([4, 3, 2]), "01-15"); await settle();
    const worker = workers[0], oldJob = worker.jobs.at(-1);
    map.emit("zoomstart"); map.zoom = 15;
    roads.setClasses(new Uint8Array([0, 1, 4]), "02-29");
    worker.finish(oldJob); map.render();
    assert.equal(map.gl.draws.length, 0); assert.equal(states.at(-1), "loading");
    assert.equal(map.container.dataset.roadTemperatureDay, undefined);
    map.emit("zoomend"); await settle();
    worker.finish(worker.jobs.at(-1)); map.render();
    assert.equal(map.container.dataset.roadTemperatureDay, "02-29");
    assert.equal(map.container.dataset.roadGeometryVersion, "1");
    assert.deepEqual(map.gl.textures.at(-1), [0, 0, 1, 4]);
    assert.equal(states.at(-1), "ready");
  } finally { roads.destroy(); globalThis.Worker = originalWorker; }
  assert.equal(workers[0].terminated, true);
});

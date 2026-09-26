import { buildRoadGeometry, roadPixelWidth } from "./road-geometry.js";

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec4 a_position;
layout(location=1) in uint a_cell;
layout(location=2) in uint a_clip;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_halfWidth;
flat out uint v_cell;
flat out uint v_clip;
flat out float v_round;
out vec2 v_offset;
out vec2 v_gridSide;
const vec2 CORNERS[6] = vec2[6](vec2(0.,-1.),vec2(1.,-1.),vec2(0.,1.),vec2(0.,1.),vec2(1.,-1.),vec2(1.,1.));
void main() {
  vec2 corner = CORNERS[gl_VertexID];
  vec4 a = u_matrix * vec4(a_position.xy,0.,1.);
  vec4 b = u_matrix * vec4(a_position.zw,0.,1.);
  vec2 delta = (b.xy/b.w-a.xy/a.w)*u_viewport*.5;
  float size = length(delta);
  bool joint = all(equal(a_position.xy,a_position.zw));
  float extent = u_halfWidth+1.;
  vec2 normal = size > .00001 ? vec2(-delta.y,delta.x)/size : vec2(0.,1.);
  vec4 position = mix(a,b,corner.x);
  vec2 offset = joint ? vec2(corner.x*2.-1.,corner.y)*extent : normal*corner.y*extent;
  position.xy += offset*2./u_viewport*position.w;
  gl_Position = position;
  v_offset = joint ? offset : vec2(0.,corner.y*extent);
  v_round = joint ? 1. : 0.;
  v_cell = a_cell;
  v_clip = a_clip;
  v_gridSide = vec2(0.);
  if (joint && a_clip != 0u) {
    vec4 east = u_matrix * vec4(a_position.xy+vec2(.00001,0.),0.,1.);
    vec4 south = u_matrix * vec4(a_position.xy+vec2(0.,.00001),0.,1.);
    vec2 ex = (east.xy/east.w-a.xy/a.w)*u_viewport*.5;
    vec2 sy = (south.xy/south.w-a.xy/a.w)*u_viewport*.5;
    float determinant = ex.x*sy.y-ex.y*sy.x;
    // Signs of the inverse projected basis partition the disc along the
    // actual projected meridian/parallel, including bearing and pitch.
    v_gridSide = vec2(offset.x*sy.y-offset.y*sy.x,ex.x*offset.y-ex.y*offset.x)*sign(determinant);
  }
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_classes;
uniform int u_textureWidth;
uniform float u_halfWidth;
flat in uint v_cell;
flat in uint v_clip;
flat in float v_round;
in vec2 v_offset;
in vec2 v_gridSide;
out vec4 color;
void main() {
  if (((v_clip & 1u) != 0u && v_gridSide.x < 0.) || ((v_clip & 2u) != 0u && v_gridSide.x >= 0.)
    || ((v_clip & 4u) != 0u && v_gridSide.y <= 0.) || ((v_clip & 8u) != 0u && v_gridSide.y > 0.)) discard;
  uint category = texelFetch(u_classes,ivec2(int(v_cell)%u_textureWidth,int(v_cell)/u_textureWidth),0).r;
  if (category == 1u) discard;
  vec3 rgb = category == 4u ? vec3(218.,52.,52.)/255.
    : category == 3u ? vec3(240.,128.,32.)/255.
    : category == 2u ? vec3(232.,189.,32.)/255. : vec3(117.,131.,140.)/255.;
  float distance = v_round > .5 ? length(v_offset) : abs(v_offset.y);
  float alpha = 1.-smoothstep(max(0.,u_halfWidth-.5),u_halfWidth+.5,distance);
  if (alpha <= 0.) discard;
  color = vec4(rgb*alpha,alpha);
}`;

function captureGL(gl) {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE);
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.activeTexture(activeTexture);
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), activeTexture, texture,
    unpack: gl.getParameter(gl.UNPACK_ALIGNMENT),
    blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    srcRGB: gl.getParameter(gl.BLEND_SRC_RGB), dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA), dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    equationRGB: gl.getParameter(gl.BLEND_EQUATION_RGB), equationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
  };
}

function restoreGL(gl, state) {
  gl.useProgram(state.program); gl.bindVertexArray(state.vao); gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state.texture); gl.activeTexture(state.activeTexture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, state.unpack);
  for (const [flag, enabled] of [[gl.BLEND, state.blend], [gl.DEPTH_TEST, state.depth], [gl.CULL_FACE, state.cull]]) {
    if (enabled) gl.enable(flag); else gl.disable(flag);
  }
  gl.depthMask(state.depthMask);
  gl.blendFuncSeparate(state.srcRGB, state.dstRGB, state.srcAlpha, state.dstAlpha);
  gl.blendEquationSeparate(state.equationRGB, state.equationAlpha);
}

function shader(gl, type, text) {
  const result = gl.createShader(type);
  if (!result) throw new Error("道路着色シェーダーを作成できません");
  gl.shaderSource(result, text); gl.compileShader(result);
  if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(result); gl.deleteShader(result);
    throw new Error(`道路着色シェーダーを準備できません: ${reason || "詳細なし"}`);
  }
  return result;
}

function makeLayer(kind, shared) {
  let resources = null, lost = false, geometryVersion = -1, classVersion = -1;
  let context;
  const fail = (error) => shared.fail(error);
  function release(gl) {
    if (!resources) return;
    gl.deleteProgram(resources.program); gl.deleteVertexArray(resources.vao);
    gl.deleteBuffer(resources.positions); gl.deleteBuffer(resources.cells); gl.deleteBuffer(resources.clips); gl.deleteTexture(resources.texture);
    resources = null;
  }
  function initialize(gl) {
    if (typeof gl.createVertexArray !== "function" || typeof gl.texStorage2D !== "function") throw new Error("道路着色にはWebGL 2が必要です");
    const state = captureGL(gl);
    let vertex, fragment;
    const result = {};
    try {
      vertex = shader(gl, gl.VERTEX_SHADER, VERTEX); fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
      result.program = gl.createProgram();
      if (!result.program) throw new Error("道路着色GPUプログラムを作成できません");
      gl.attachShader(result.program, vertex); gl.attachShader(result.program, fragment); gl.linkProgram(result.program);
      if (!gl.getProgramParameter(result.program, gl.LINK_STATUS)) throw new Error(`道路着色GPUプログラムを準備できません: ${gl.getProgramInfoLog(result.program) || "詳細なし"}`);
      result.vao = gl.createVertexArray(); result.positions = gl.createBuffer(); result.cells = gl.createBuffer(); result.clips = gl.createBuffer(); result.texture = gl.createTexture();
      if (!result.vao || !result.positions || !result.cells || !result.clips || !result.texture) throw new Error("道路着色用GPUメモリーを確保できません");
      gl.bindVertexArray(result.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, result.positions); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(0, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, result.cells); gl.bufferData(gl.ARRAY_BUFFER, new Uint32Array(), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0); gl.vertexAttribDivisor(1, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, result.clips); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_BYTE, 0, 0); gl.vertexAttribDivisor(2, 1);
      const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      result.width = Math.min(1024, limit); result.height = Math.ceil((shared.count + 1) / result.width);
      if (result.height > limit) throw new Error("道路着色の格子数がGPU容量を超えています");
      result.data = new Uint8Array(result.width * result.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, result.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8UI, result.width, result.height);
      result.uniforms = Object.fromEntries(["matrix", "viewport", "halfWidth", "classes", "textureWidth"].map((name) => [name, gl.getUniformLocation(result.program, `u_${name}`)]));
      if (Object.values(result.uniforms).some((value) => value === null)) throw new Error("道路着色のGPU変数が見つかりません");
      resources = result; geometryVersion = -1; classVersion = -1;
    } catch (error) {
      if (result.program) gl.deleteProgram(result.program); if (result.vao) gl.deleteVertexArray(result.vao);
      if (result.positions) gl.deleteBuffer(result.positions); if (result.cells) gl.deleteBuffer(result.cells); if (result.clips) gl.deleteBuffer(result.clips); if (result.texture) gl.deleteTexture(result.texture);
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment);
      restoreGL(gl, state);
    }
  }
  function onLost() { lost = true; resources = null; shared.gpu[kind] = false; shared.report(); }
  function onRestored() {
    lost = false;
    try { initialize(context); shared.gpu[kind] = true; shared.failed = false; shared.report(); shared.map.triggerRepaint(); }
    catch (error) { fail(error); }
  }
  return {
    id: `road-temperature-${kind}`, type: "custom", renderingMode: "2d",
    onAdd(map, gl) {
      context = gl; initialize(gl); shared.gpu[kind] = true;
      map.on("webglcontextlost", onLost); map.on("webglcontextrestored", onRestored);
    },
    render(gl, options) {
      const zoom = shared.map.getZoom();
      if (lost || shared.failed || !shared.active || !shared.geometry || !shared.visible[kind]
        || zoom < 4.7 || (kind === "general" && zoom < 5)) return;
      const geometry = shared.geometry[kind];
      if (!geometry.count) return;
      const state = captureGL(gl);
      try {
        if (!resources) throw new Error("道路着色GPUの準備が完了していません");
        const sourceMatrix = options?.defaultProjectionData?.mainMatrix;
        if (!sourceMatrix || sourceMatrix.length !== 16) throw new Error("道路着色の投影行列が不正です");
        const matrix = new Float32Array(sourceMatrix);
        const [x, y] = shared.geometry.origin;
        for (let i = 0; i < 4; i++) matrix[12 + i] = sourceMatrix[12 + i] + sourceMatrix[i] * x + sourceMatrix[4 + i] * y;
        gl.useProgram(resources.program); gl.bindVertexArray(resources.vao);
        if (geometryVersion !== shared.geometryVersion) {
          gl.bindBuffer(gl.ARRAY_BUFFER, resources.positions); gl.bufferData(gl.ARRAY_BUFFER, geometry.positions, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, resources.cells); gl.bufferData(gl.ARRAY_BUFFER, geometry.cells, gl.DYNAMIC_DRAW);
          gl.bindBuffer(gl.ARRAY_BUFFER, resources.clips); gl.bufferData(gl.ARRAY_BUFFER, geometry.clips, gl.DYNAMIC_DRAW);
          geometryVersion = shared.geometryVersion;
        }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, resources.texture);
        if (classVersion !== shared.classVersion) {
          resources.data.fill(0); resources.data.set(shared.classes, 1);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, resources.width, resources.height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, resources.data);
          classVersion = shared.classVersion;
        }
        const canvas = shared.map.getCanvas();
        const ratio = canvas.width / Math.max(1, canvas.clientWidth || canvas.width);
        gl.uniformMatrix4fv(resources.uniforms.matrix, false, matrix);
        gl.uniform2f(resources.uniforms.viewport, canvas.width, canvas.height);
        gl.uniform1f(resources.uniforms.halfWidth, roadPixelWidth(kind, shared.map.getZoom()) * ratio / 2);
        gl.uniform1i(resources.uniforms.classes, 0); gl.uniform1i(resources.uniforms.textureWidth, resources.width);
        gl.enable(gl.BLEND); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, geometry.count);
      } catch (error) { fail(error); }
      finally { restoreGL(gl, state); }
    },
    onRemove(map, gl) {
      map.off("webglcontextlost", onLost); map.off("webglcontextrestored", onRestored);
      if (!lost) release(gl);
      context = null;
    },
  };
}

export function createRoadTemperature(map, grid, onState = () => {}) {
  if (!grid || !(grid.rows instanceof Uint16Array) || !(grid.cols instanceof Uint16Array)
    || !Number.isSafeInteger(grid.count) || grid.count < 1 || grid.rows.length !== grid.count || grid.cols.length !== grid.count) {
    throw new Error("道路着色の格子定義が不正です");
  }
  let destroyed = false, timer = null, worker = null, busy = false, queued = false, zooming = false, generation = 0, state;
  const shared = {
    map, count: grid.count, active: false, failed: false, classes: null, day: null, classVersion: 0,
    geometry: null, geometryVersion: 0, visible: { general: true, highway: true }, gpu: { general: false, highway: false },
    notify(next) { if (!destroyed && next !== state) { state = next; onState(next); } },
    observe() {
      const data = map.getContainer?.()?.dataset;
      if (!data) return;
      const ready = Boolean(shared.geometry && shared.active && !shared.failed && shared.gpu.general && shared.gpu.highway);
      data.roadTemperatureReady = String(ready);
      if (ready) data.roadTemperatureDay = shared.day; else delete data.roadTemperatureDay;
      data.roadGeneralSegments = String(shared.geometry?.general.segmentCount || 0);
      data.roadHighwaySegments = String(shared.geometry?.highway.segmentCount || 0);
      data.roadGeometryVersion = String(shared.geometryVersion);
    },
    report() {
      shared.observe();
      if (shared.failed) shared.notify("error");
      else if (shared.active) shared.notify(shared.geometry && shared.gpu.general && shared.gpu.highway ? "ready" : "loading");
    },
    fail(error) {
      shared.failed = true; shared.report(); map.triggerRepaint();
      map.fire?.("error", { error: error instanceof Error ? error : new Error(String(error)), sourceId: "road-temperature" });
    },
  };
  const layers = [makeLayer("general", shared), makeLayer("highway", shared)];
  try {
    map.addLayer(layers[0], "highway-casing"); map.addLayer(layers[1]);
  } catch (error) {
    for (const layer of layers) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    throw error;
  }

  function finish(message) {
    busy = false;
    if (destroyed) return;
    if (message.generation === generation) {
      if (message.error) shared.fail(new Error(message.error));
      else {
        shared.geometry = message.geometry; shared.geometryVersion++; shared.failed = false;
        shared.report(); map.triggerRepaint();
      }
    }
    if (queued) { queued = false; rebuild(); }
  }
  if (typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./road-geometry-worker.js", import.meta.url), { type: "module" });
      worker.postMessage({ type: "init", grid: { rows: grid.rows, cols: grid.cols, count: grid.count, rowScale: grid.rowScale, colScale: grid.colScale } });
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = () => { busy = false; queued = false; shared.fail(new Error("道路着色の分割処理を実行できません")); };
    } catch (error) { worker?.terminate(); worker = null; shared.fail(error); }
  }

  function rebuild() {
    if (destroyed || zooming) return;
    timer = null;
    if (busy) { queued = true; return; }
    try {
      const bounds = map.getBounds();
      const west = bounds.getWest(), east = bounds.getEast(), south = bounds.getSouth(), north = bounds.getNorth();
      const dx = (east - west) * 0.1, dy = (north - south) * 0.1;
      const padded = [Math.max(-180, west - dx), Math.max(-84, south - dy), Math.min(180, east + dx), Math.min(84, north + dy)];
      // Query the two original native layers, not every loaded parent/child
      // source tile: overlays must follow the geometry MapLibre renders now.
      const features = map.queryRenderedFeatures({ layers: ["general-road", "highway"] })
        .map(({ geometry, properties }) => ({ geometry, properties }));
      const job = { type: "build", generation, features, bounds: padded };
      busy = true;
      if (worker) worker.postMessage(job);
      else finish({ generation, geometry: buildRoadGeometry(features, grid, padded) });
    } catch (error) { busy = false; shared.fail(error); }
  }
  function schedule(event) {
    if (destroyed || (event?.type === "sourcedata" && event.sourceId !== "roads")) return;
    generation++;
    if (timer !== null) clearTimeout(timer);
    if (zooming) { timer = null; return; }
    timer = setTimeout(rebuild, 70);
  }
  function onZoomStart() {
    zooming = true; generation++; queued = false;
    if (timer !== null) clearTimeout(timer);
    timer = null; shared.geometry = null; shared.report(); map.triggerRepaint();
  }
  function onZoomEnd() { zooming = false; schedule(); }
  map.on("moveend", schedule); map.on("zoomend", onZoomEnd); map.on("sourcedata", schedule); map.on("zoomstart", onZoomStart);
  schedule();
  return {
    setClasses(classes, day) {
      if (destroyed) throw new Error("道路着色は終了しています");
      if (!(classes instanceof Uint8Array) || classes.length !== grid.count || classes.some((value) => value > 4)
        || typeof day !== "string" || !/^\d{2}-\d{2}$/.test(day)) throw new Error("道路着色の日付・区分が不正です");
      shared.classes = classes; shared.day = day; shared.classVersion++; shared.active = true; shared.report(); map.triggerRepaint();
    },
    clear() {
      shared.active = false; shared.classes = null; shared.day = null;
      shared.observe(); shared.notify("loading"); map.triggerRepaint();
    },
    setHighwayVisible(value) {
      if (typeof value !== "boolean") throw new Error("高速道路の表示設定が不正です");
      shared.visible.highway = value; if (value) schedule(); map.triggerRepaint();
    },
    setGeneralVisible(value) {
      if (typeof value !== "boolean") throw new Error("一般道路の表示設定が不正です");
      shared.visible.general = value; if (value) schedule(); map.triggerRepaint();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; generation++;
      if (timer !== null) clearTimeout(timer);
      worker?.terminate();
      map.off("moveend", schedule); map.off("zoomend", onZoomEnd); map.off("sourcedata", schedule); map.off("zoomstart", onZoomStart);
      for (const layer of layers) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      shared.geometry = null; shared.classes = null; shared.active = false; shared.observe();
    },
  };
}

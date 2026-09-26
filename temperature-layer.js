// Native mesh rectangles, drawn in Mercator coordinates without spatial smoothing.
const MAX_CELLS = 1_000_000;
const MAX_BIN = 81;
const MAX_LATITUDE = 85.0511287798066;

function requireCount(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CELLS) {
    throw new Error("気温メッシュの格子数が不正です");
  }
}

function mercatorY(latitude) {
  const radians = latitude * Math.PI / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
}

export function expandGrid(grid) {
  requireCount(grid?.cell_count);
  if (!Array.isArray(grid.runs) || grid.runs.length % 3 !== 0) {
    throw new Error("気温メッシュの格子定義が不正です");
  }
  const count = grid.cell_count;
  const rects = new Float32Array(count * 4);
  const rows = new Uint16Array(count);
  const cols = new Uint16Array(count);
  let offset = 0;
  let previousRow = -1;
  let previousEnd = -1;
  for (let r = 0; r < grid.runs.length; r += 3) {
    const [row, start, length] = grid.runs.slice(r, r + 3);
    if (![row, start, length].every(Number.isSafeInteger) || row < 0 || start < 0 || length < 1
      || (row + 1) / 120 > MAX_LATITUDE || (start + length) / 80 > 180
      || row < previousRow || (row === previousRow && start <= previousEnd)
      || offset + length > count) {
      throw new Error("気温メッシュの格子順序・座標・長さが不正です");
    }
    const south = mercatorY(row / 120);
    const north = mercatorY((row + 1) / 120);
    for (let col = start; col < start + length; col++, offset++) {
      rows[offset] = row;
      cols[offset] = col;
      rects.set([(col / 80 + 180) / 360, south, ((col + 1) / 80 + 180) / 360, north], offset * 4);
    }
    previousRow = row;
    previousEnd = start + length - 1;
  }
  if (offset !== count) throw new Error("気温メッシュの格子数が一致しません");
  return { rects, rows, cols, count };
}

export function expandDay(day, count) {
  requireCount(count);
  if (day?.cell_count !== count || !Array.isArray(day.runs) || day.runs.length % 2 !== 0) {
    throw new Error("日別気温と格子定義が一致しません");
  }
  const bins = new Uint8Array(count);
  let offset = 0;
  for (let r = 0; r < day.runs.length; r += 2) {
    const bin = day.runs[r];
    const length = day.runs[r + 1];
    if (!Number.isInteger(bin) || bin < 0 || bin > MAX_BIN
      || !Number.isSafeInteger(length) || length < 1 || offset + length > count) {
      throw new Error("日別気温の階級・長さが不正です");
    }
    bins.fill(bin, offset, offset + length);
    offset += length;
  }
  if (offset !== count) throw new Error("日別気温の格子数が一致しません");
  return bins;
}

function requireBin(bin) {
  if (!Number.isInteger(bin) || bin < 0 || bin > MAX_BIN) throw new Error("気温階級が不正です");
}

export function binLabel(bin) {
  requireBin(bin);
  if (bin === 0) return "推定値なし";
  return `${bin - 41}℃以上 ${bin - 40}℃未満`;
}

const COLOR_STOPS = [
  [-40, "#45206e"], [-25, "#3b4cc0"], [-15, "#2b83ba"], [-5, "#63b8d1"],
  [0, "#b8dfd0"], [5, "#e4ecb4"], [15, "#f8ce69"], [25, "#ec793f"], [40, "#ac243b"],
].map(([temperature, hex]) => [temperature, [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))]);

export function paletteColor(bin) {
  requireBin(bin);
  if (bin === 0) return "#00000000";
  const temperature = bin - 41;
  const right = COLOR_STOPS.findIndex(([stop]) => stop >= temperature);
  const [toTemperature, to] = COLOR_STOPS[right];
  const [fromTemperature, from] = COLOR_STOPS[Math.max(0, right - 1)];
  const fraction = toTemperature === fromTemperature ? 0 : (temperature - fromTemperature) / (toTemperature - fromTemperature);
  return "#" + from.map((value, i) => Math.round(value + fraction * (to[i] - value)).toString(16).padStart(2, "0")).join("");
}

export function lookupCell(expanded, lng, lat) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < 0 || lng >= 180 || lat < 0 || lat >= MAX_LATITUDE) return -1;
  // A boundary belongs to its northern/eastern cell; the tolerance only removes
  // floating-point noise from converting an exact mesh edge back to degrees.
  const row = Math.floor(lat * (expanded.rowScale ?? 120) + 1e-9);
  const col = Math.floor(lng * (expanded.colScale ?? 80) + 1e-9);
  let low = 0;
  let high = expanded.count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const before = expanded.rows[mid] < row || (expanded.rows[mid] === row && expanded.cols[mid] < col);
    if (before) low = mid + 1;
    else high = mid;
  }
  return low < expanded.count && expanded.rows[low] === row && expanded.cols[low] === col ? low : -1;
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_rect;
layout(location = 1) in uint a_bin;
uniform mat4 u_matrix;
flat out uint v_bin;
const vec2 corners[6] = vec2[6](vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1));
void main() {
  vec2 corner = corners[gl_VertexID];
  vec2 position = vec2(mix(a_rect.x, a_rect.z, corner.x), mix(a_rect.y, a_rect.w, corner.y));
  gl_Position = u_matrix * vec4(position, 0.0, 1.0);
  v_bin = a_bin;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
flat in uint v_bin;
uniform vec3 u_palette[82];
uniform float u_opacity;
out vec4 fragment;
void main() {
  if (v_bin == 0u) discard;
  fragment = vec4(u_palette[int(v_bin)] * u_opacity, u_opacity);
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("気温メッシュ用シェーダーを作成できません");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const reason = gl.getShaderInfoLog(shader) || "詳細なし";
    gl.deleteShader(shader);
    throw new Error(`気温メッシュ用シェーダーのコンパイルに失敗しました: ${reason}`);
  }
  return shader;
}

function captureState(gl) {
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), blend: gl.isEnabled(gl.BLEND),
    depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK),
    srcRGB: gl.getParameter(gl.BLEND_SRC_RGB), dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA), dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    equationRGB: gl.getParameter(gl.BLEND_EQUATION_RGB), equationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
  };
}

function restoreState(gl, state) {
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  for (const [capability, enabled] of [[gl.BLEND, state.blend], [gl.DEPTH_TEST, state.depth], [gl.CULL_FACE, state.cull]]) {
    if (enabled) gl.enable(capability);
    else gl.disable(capability);
  }
  gl.depthMask(state.depthMask);
  gl.blendFuncSeparate(state.srcRGB, state.dstRGB, state.srcAlpha, state.dstAlpha);
  gl.blendEquationSeparate(state.equationRGB, state.equationAlpha);
}

export function createTemperatureLayer(expanded, options = {}) {
  requireCount(expanded?.count);
  if (!(expanded.rects instanceof Float32Array) || expanded.rects.length !== expanded.count * 4) {
    throw new Error("気温メッシュの描画座標が不正です");
  }
  let map = null;
  let context = null;
  let resources = null;
  let lost = false;
  let dirty = true;
  let bins = new Uint8Array(expanded.count);
  let opacity = 0.7;
  let visible = true;
  const layerId = options.id ?? "temperature-mesh";
  const colorForBin = options.colorForBin ?? paletteColor;
  const palette = new Float32Array(82 * 3);
  for (let bin = 1; bin <= MAX_BIN; bin++) {
    const hex = colorForBin(bin);
    palette.set([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), bin * 3);
  }

  function release(gl) {
    if (!resources) return;
    gl.deleteBuffer(resources.rectBuffer);
    gl.deleteBuffer(resources.binBuffer);
    gl.deleteVertexArray(resources.vao);
    gl.deleteProgram(resources.program);
    resources = null;
  }

  function initialize(gl) {
    if (typeof gl.createVertexArray !== "function" || typeof gl.drawArraysInstanced !== "function") {
      throw new Error("気温メッシュの表示にはWebGL 2が必要です");
    }
    const saved = captureState(gl);
    let vertex = null;
    let fragment = null;
    let program = null;
    let vao = null;
    let rectBuffer = null;
    let binBuffer = null;
    try {
      vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
      fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
      program = gl.createProgram();
      if (!program) throw new Error("気温メッシュ用GPUプログラムを作成できません");
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`気温メッシュ用GPUプログラムのリンクに失敗しました: ${gl.getProgramInfoLog(program) || "詳細なし"}`);
      }
      vao = gl.createVertexArray();
      rectBuffer = gl.createBuffer();
      binBuffer = gl.createBuffer();
      if (!vao || !rectBuffer || !binBuffer) throw new Error("気温メッシュ用GPUメモリーを確保できません");
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, rectBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, expanded.rects, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(0, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, binBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, bins, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_BYTE, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      const matrix = gl.getUniformLocation(program, "u_matrix");
      const colors = gl.getUniformLocation(program, "u_palette[0]");
      const alpha = gl.getUniformLocation(program, "u_opacity");
      if (matrix === null || colors === null || alpha === null) throw new Error("気温メッシュのGPU変数が見つかりません");
      gl.useProgram(program);
      gl.uniform3fv(colors, palette);
      resources = { program, vao, rectBuffer, binBuffer, matrix, alpha };
      dirty = false;
    } catch (error) {
      if (rectBuffer) gl.deleteBuffer(rectBuffer);
      if (binBuffer) gl.deleteBuffer(binBuffer);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      throw error;
    } finally {
      if (vertex) gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
      restoreState(gl, saved);
    }
  }

  function contextLost() {
    lost = true;
    resources = null;
  }

  function contextRestored() {
    lost = false;
    initialize(context);
    map.triggerRepaint();
  }

  return {
    id: layerId,
    type: "custom",
    renderingMode: "2d",
    setBins(next) {
      if (!(next instanceof Uint8Array) || next.length !== expanded.count || next.some((bin) => bin > MAX_BIN)) {
        throw new Error("描画する日別気温の階級・格子数が不正です");
      }
      bins = next.slice();
      dirty = true;
      map?.triggerRepaint();
    },
    setOpacity(next) {
      if (!Number.isFinite(next) || next < 0 || next > 1) throw new Error("気温メッシュの不透明度が不正です");
      opacity = next;
      map?.triggerRepaint();
    },
    setVisible(next) {
      if (typeof next !== "boolean") throw new Error("気温メッシュの表示設定が不正です");
      visible = next;
      map?.triggerRepaint();
    },
    onAdd(nextMap, gl) {
      map = nextMap;
      context = gl;
      lost = false;
      initialize(gl);
      map.on("webglcontextlost", contextLost);
      map.on("webglcontextrestored", contextRestored);
    },
    render(gl, options) {
      if (lost || !visible || opacity === 0) return;
      if (!resources) throw new Error("気温メッシュのGPU初期化が完了していません");
      const matrix = options?.defaultProjectionData?.mainMatrix;
      if (!matrix || matrix.length !== 16) throw new Error("気温メッシュの地図投影行列が不正です");
      const saved = captureState(gl);
      try {
        gl.useProgram(resources.program);
        gl.bindVertexArray(resources.vao);
        if (dirty) {
          gl.bindBuffer(gl.ARRAY_BUFFER, resources.binBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, bins);
          dirty = false;
        }
        gl.uniformMatrix4fv(resources.matrix, false, matrix);
        gl.uniform1f(resources.alpha, opacity);
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, expanded.count);
      } finally {
        restoreState(gl, saved);
      }
    },
    onRemove(nextMap, gl) {
      nextMap.off("webglcontextlost", contextLost);
      nextMap.off("webglcontextrestored", contextRestored);
      if (!lost) release(gl);
      map = null;
      context = null;
      resources = null;
    },
  };
}

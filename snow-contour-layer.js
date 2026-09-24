import { CONTOUR_COLORS, SNOW_THRESHOLDS } from "./snow-display-data.js";

const VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_position;
uniform mat4 u_matrix;
void main() { gl_Position = u_matrix * vec4(a_position, 0.0, 1.0); }`;
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragment;
void main() { fragment = u_color; }`;

function mercatorY(latitude) {
  const radians = latitude * Math.PI / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
}

function compile(gl, type, code) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("等値線シェーダーを確保できません");
  gl.shaderSource(shader, code);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "詳細なし";
    gl.deleteShader(shader);
    throw new Error(`等値線シェーダーを作成できません: ${message}`);
  }
  return shader;
}

function savedState(gl) {
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), blend: gl.isEnabled(gl.BLEND),
    depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
    depthMask: gl.getParameter(gl.DEPTH_WRITEMASK), lineWidth: gl.getParameter(gl.LINE_WIDTH),
    srcRGB: gl.getParameter(gl.BLEND_SRC_RGB), dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
    srcAlpha: gl.getParameter(gl.BLEND_SRC_ALPHA), dstAlpha: gl.getParameter(gl.BLEND_DST_ALPHA),
    equationRGB: gl.getParameter(gl.BLEND_EQUATION_RGB), equationAlpha: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
  };
}

function restore(gl, state) {
  gl.useProgram(state.program);
  gl.bindVertexArray(state.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  for (const [capability, enabled] of [[gl.BLEND, state.blend], [gl.DEPTH_TEST, state.depth], [gl.CULL_FACE, state.cull]]) {
    if (enabled) gl.enable(capability);
    else gl.disable(capability);
  }
  gl.depthMask(state.depthMask);
  gl.lineWidth(state.lineWidth);
  gl.blendFuncSeparate(state.srcRGB, state.dstRGB, state.srcAlpha, state.dstAlpha);
  gl.blendEquationSeparate(state.equationRGB, state.equationAlpha);
}

export function contourVertices(contours) {
  if (!Array.isArray(contours) || contours.length !== SNOW_THRESHOLDS.length
    || contours.some((group) => !(group instanceof Uint16Array) || group.length % 3)) {
    throw new Error("積雪等値線の配列が不正です");
  }
  const total = contours.reduce((sum, group) => sum + group.length / 3, 0);
  const vertices = new Float32Array(total * 4);
  const ranges = [];
  let segment = 0;
  for (const group of contours) {
    const start = segment * 2;
    for (let i = 0; i < group.length; i += 3, segment++) {
      const row = group[i], col = group[i + 1], axis = group[i + 2];
      if (axis === 0) {
        const x = ((col + 1) / 80 + 180) / 360;
        vertices.set([x, mercatorY(row / 120), x, mercatorY((row + 1) / 120)], segment * 4);
      } else {
        const y = mercatorY((row + 1) / 120);
        vertices.set([(col / 80 + 180) / 360, y, ((col + 1) / 80 + 180) / 360, y], segment * 4);
      }
    }
    ranges.push([start, segment * 2 - start]);
  }
  return { vertices, ranges };
}

export function createSnowContourLayer() {
  let map = null;
  let resources = null;
  let geometry = { vertices: new Float32Array(0), ranges: SNOW_THRESHOLDS.map(() => [0, 0]) };
  let visible = false;
  let opacity = 0.55;
  let dirty = true;
  const colors = CONTOUR_COLORS.map((hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255));

  return {
    id: "snow-contours",
    type: "custom",
    renderingMode: "2d",
    setContours(groups) {
      geometry = contourVertices(groups);
      dirty = true;
      map?.triggerRepaint();
    },
    setOpacity(value) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("積雪等値線の濃さが不正です");
      opacity = value;
      map?.triggerRepaint();
    },
    setVisible(value) {
      if (typeof value !== "boolean") throw new Error("積雪等値線の表示状態が不正です");
      visible = value;
      map?.triggerRepaint();
    },
    onAdd(nextMap, gl) {
      map = nextMap;
      const state = savedState(gl);
      let vertex, fragment, program, vao, buffer;
      try {
        vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
        fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
        program = gl.createProgram();
        if (!program) throw new Error("積雪等値線のGPUプログラムを作成できません");
        gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("積雪等値線のGPU接続に失敗しました");
        vao = gl.createVertexArray(); buffer = gl.createBuffer();
        if (!vao || !buffer) throw new Error("積雪等値線のGPUメモリーを確保できません");
        gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const matrix = gl.getUniformLocation(program, "u_matrix");
        const color = gl.getUniformLocation(program, "u_color");
        if (matrix === null || color === null) throw new Error("積雪等値線のGPU変数が見つかりません");
        resources = { program, vao, buffer, matrix, color };
        dirty = false;
      } catch (error) {
        if (buffer) gl.deleteBuffer(buffer);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
        throw error;
      } finally {
        if (vertex) gl.deleteShader(vertex);
        if (fragment) gl.deleteShader(fragment);
        restore(gl, state);
      }
    },
    render(gl, options) {
      if (!visible || opacity === 0 || geometry.vertices.length === 0) return;
      if (!resources) throw new Error("積雪等値線のGPU準備が未完了です");
      const matrix = options?.defaultProjectionData?.mainMatrix;
      if (!matrix || matrix.length !== 16) throw new Error("積雪等値線の投影行列が不正です");
      const state = savedState(gl);
      try {
        gl.useProgram(resources.program); gl.bindVertexArray(resources.vao);
        if (dirty) {
          gl.bindBuffer(gl.ARRAY_BUFFER, resources.buffer);
          gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.DYNAMIC_DRAW);
          dirty = false;
        }
        gl.uniformMatrix4fv(resources.matrix, false, matrix);
        gl.enable(gl.BLEND); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
        gl.lineWidth(1);
        for (let i = 0; i < geometry.ranges.length; i++) {
          const [first, count] = geometry.ranges[i];
          if (!count) continue;
          gl.uniform4f(resources.color, ...colors[i], Math.sqrt(opacity));
          gl.drawArrays(gl.LINES, first, count);
        }
      } finally {
        restore(gl, state);
      }
    },
    onRemove(_map, gl) {
      if (resources) {
        gl.deleteBuffer(resources.buffer);
        gl.deleteVertexArray(resources.vao);
        gl.deleteProgram(resources.program);
      }
      resources = null; map = null;
    },
  };
}

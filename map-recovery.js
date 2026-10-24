const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function waitFor(map, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); map.off(event, ready); map.off("remove", removed);
      if (error) reject(error); else resolve();
    };
    const ready = () => finish();
    const removed = () => finish(new Error("地図の読み込みを中断しました"));
    const timer = setTimeout(() => finish(new Error("地図の読み込みが時間内に終わりませんでした")), timeoutMs);
    map.on(event, ready); map.on("remove", removed);
  });
}

// MapLibre v6 discards custom layers when its WebGL context is lost.
// Keep the actual layer objects (including their CPU-side data) and order;
// a serialized style alone cannot restore temperature, snow, or road colours.
export function watchMapRecovery(map, {onState = () => {}, timeoutMs = 15000, maxRecoveries = 3} = {}) {
  const custom = new Map();
  let order = [], restoring = false, recovering = false, disposed = false;
  let timer = null, generation = 0, recoveries = 0, afterRestore = () => {};
  const addLayer = map.addLayer, removeLayer = map.removeLayer;
  const rememberOrder = () => { if (!restoring) order = map.getLayersOrder(); };
  map.addLayer = function(layer, before) {
    const result = addLayer.call(this, layer, before);
    if (layer.type === "custom") custom.set(layer.id, layer);
    rememberOrder(); return result;
  };
  map.removeLayer = function(id) {
    const result = removeLayer.call(this, id);
    custom.delete(id); rememberOrder(); return result;
  };
  const fail = () => onState("error", "地図の描画を復旧できませんでした。「地図を再試行」で読み直せます。");
  function lost() {
    if (disposed) return;
    recovering = true; ++generation; ++recoveries; clearTimeout(timer);
    if (recoveries > maxRecoveries) { fail(); return; }
    onState("recovering", "地図の描画が中断しました。自動復旧を待っています。");
    timer = setTimeout(fail, timeoutMs);
  }
  async function restored() {
    if (!recovering || disposed || recoveries > maxRecoveries) return;
    const current = generation;
    try {
      if (!map.isStyleLoaded()) await waitFor(map, "style.load", timeoutMs);
      if (disposed || current !== generation) return;
      restoring = true;
      for (let i = order.length - 1; i >= 0; i--) {
        const id = order[i], layer = custom.get(id);
        if (!layer || map.getLayer(id)) continue;
        const before = order.slice(i + 1).find(next => map.getLayer(next));
        addLayer.call(map, layer, before);
      }
      restoring = false;
      await afterRestore();
      if (disposed || current !== generation) return;
      const rendered = waitFor(map, "render", timeoutMs);
      map.triggerRepaint(); await rendered;
      if (disposed || current !== generation) return;
      clearTimeout(timer); recovering = false; onState("ready", "地図の描画を復旧しました");
    } catch {
      restoring = false;
      if (!disposed && current === generation) { clearTimeout(timer); fail(); }
    }
  }
  function error(event) {
    if (recovering && event?.error?.name === "GPUInitializationError") { clearTimeout(timer); fail(); }
  }
  function dispose() {
    disposed = true; ++generation; clearTimeout(timer);
    map.off("webglcontextlost", lost); map.off("webglcontextrestored", restored); map.off("error", error); map.off("remove", dispose);
    map.addLayer = addLayer; map.removeLayer = removeLayer;
  }
  map.on("webglcontextlost", lost); map.on("webglcontextrestored", restored);
  map.on("error", error); map.on("remove", dispose);
  return {onRestored(callback) { afterRestore = callback; }, dispose};
}

export async function startMap(createMap, {onState = () => {}, attempts = 3, timeoutMs = 15000, retryDelayMs = 1000, sleep = pause} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let map;
    onState("starting", `地図を起動しています（${attempt}/${attempts}回）`);
    try {
      map = createMap();
      if (!map.loaded()) await waitFor(map, "load", timeoutMs);
      const recovery = watchMapRecovery(map, {onState, timeoutMs});
      onState("ready", "地図を表示しました");
      return {map, recovery};
    } catch {
      try { map?.remove(); } catch { /* A failed context may already be destroyed. */ }
      if (attempt < attempts) {
        onState("retrying", `地図を起動できなかったため、自動で再試行します（次は${attempt + 1}/${attempts}回）`);
        await sleep(retryDelayMs * attempt);
      }
    }
  }
  onState("error", "地図を起動できませんでした。描画機能の初期化または地図の読み込みに失敗しました。「地図を再試行」で読み直せます。");
  return null;
}

export function showMapState(state, message) {
  const map = document.getElementById("map"), panel = document.getElementById("mapRecovery");
  const ready = state === "ready";
  map.dataset.recoveryState = state;
  map.setAttribute("aria-busy", String(!ready && state !== "error"));
  document.querySelector(".control-panel").inert = !ready;
  document.getElementById("forecastTimeline").inert = !ready;
  document.getElementById("mapTemperatureLabel").hidden = !ready;
  document.getElementById("meshTooltip").hidden = true;
  panel.hidden = ready;
  document.getElementById("mapRecoveryMessage").textContent = message;
  document.getElementById("mapRetry").hidden = state !== "error";
  if (!ready) {
    document.getElementById("mapStatus").textContent = message;
    for (const id of ["temperatureStatus", "seasonPreparationStatus", "snowStatus", "roadTemperatureStatus"]) {
      const element = document.getElementById(id);
      if (element) element.textContent = state === "error" ? "地図を表示できないため利用できません" : message;
    }
  } else {
    document.getElementById("mapStatus").textContent = message;
  }
}

import { expandGrid, createTemperatureLayer, lookupCell, binLabel, paletteColor } from "./temperature-layer.js";
import { decodeDisplayDay, unpackRoadClasses, roadClassLabel, validRoadClassContract } from "./temperature-display-data.js";

const $ = (id) => document.getElementById(id);
const ROOT = "./data/temperature/";
export const TEMPERATURE_MODES = Object.freeze({
  tmin: Object.freeze({ root: ROOT, label: "平均最低気温", source: "daily-tmin-normals-1km" }),
  tmax: Object.freeze({ root: "./data/temperature-max/", label: "平均最高気温", source: "daily-climate-normals-1km" }),
});
const SEASON_START = "09-15";
const SEASON_END = "06-15";

export function winterSeasonDays(calendarDays) {
  const expected = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(5, 10));
  if (calendarDays.length !== expected.length || calendarDays.some((day, i) => day !== expected[i])) throw new Error("Invalid calendar");
  const first = calendarDays.indexOf(SEASON_START);
  const last = calendarDays.indexOf(SEASON_END);
  const days = [...calendarDays.slice(first), ...calendarDays.slice(0, last + 1)];
  if (days.length !== 275) throw new Error("Invalid winter season");
  return days;
}

export async function checkedJSON(record, root = ROOT) {
  if (!Object.values(TEMPERATURE_MODES).some((mode) => mode.root === root)) throw new Error("Invalid data root");
  if (!/^(?:grid\.json|\d{2}-\d{2}\.json\.gz)$/.test(record.url)) throw new Error("Invalid data path");
  const response = await fetch(root + record.url, { cache: "no-cache" });
  if (!response.ok) throw new Error("Data unavailable");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== record.bytes) throw new Error("Data size mismatch");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (v) => v.toString(16).padStart(2, "0")).join("");
  if (hash !== record.sha256) throw new Error("Data verification failed");
  const decoded = record.url.endsWith(".gz")
    ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()
    : bytes;
  if (decoded.byteLength > 2_000_000 || (record.uncompressed_bytes && decoded.byteLength !== record.uncompressed_bytes)) throw new Error("Expanded data size mismatch");
  return JSON.parse(new TextDecoder().decode(decoded));
}

export function initTemperature(map, hooks = {}) {
  const legend = document.querySelector(".legend-gradient").getContext("2d");
  for (let bin = 1; bin <= 81; bin++) {
    legend.fillStyle = paletteColor(bin); legend.fillRect((bin - 1) * 4, 0, 4, 18);
  }
  const date = $("dateSlider"), month = $("monthSelect"), day = $("daySelect");
  const status = $("temperatureStatus"), preparationStatus = $("seasonPreparationStatus");
  const label = $("mapTemperatureLabel"), point = $("temperaturePoint");
  const controls = [date, month, day, $("previousDay"), $("nextDay"), $("playYear")];
  const sources = Object.fromEntries(Object.keys(TEMPERATURE_MODES).map((mode) => [mode,
    { mode, manifest: null, cache: new Map(), pending: new Map(), prefetchPromise: null }]));
  let source = sources.tmin, cache = source.cache, pending = source.pending;
  let selectedMode = "tmin", displayedMode = "tmin", modeLoading = false;
  const modeSelect = $("temperatureMode");
  let manifest, grid, layer, bins, roadClasses, selected = 0, displayed = -1, request = 0;
  let playing = false, preparing = false, animation = 0, selectedPoint = null, playbackGeneration = 0;
  let playbackCancelResolve = null;
  let loadState = "loading";
  const showStatus = (text, state = "ready") => { status.textContent = text; status.dataset.state = state; };
  const stop = () => {
    playbackGeneration++;
    playing = false; preparing = false; cancelAnimationFrame(animation);
    playbackCancelResolve?.(false);
    playbackCancelResolve = null;
    $("playYear").textContent = "▶ 冬季を再生";
    $("playYear").setAttribute("aria-pressed", "false");
  };
  const dayText = (index) => `${manifest.days[index].replace("-", "月")}日`;
  const modeText = (mode) => TEMPERATURE_MODES[mode].label;
  function syncModeLabels() {
    $("temperatureTitleText").textContent = `日別の${modeText(selectedMode)}`;
    document.querySelector(".temperature-legend").setAttribute("aria-label", `${modeText(displayedMode)}の色の凡例`);
    document.querySelector(".road-temperature-legend").setAttribute("aria-label", `道路の${modeText(displayedMode)}の色分け`);
    $("map").setAttribute("aria-label", `日別の${modeText(displayedMode)}、日最深積雪の平年推定値と全国の道路を表示する地図`);
  }
  async function loadManifest(context) {
    if (context.manifest) return context.manifest;
    const config = TEMPERATURE_MODES[context.mode];
    const response = await fetch(config.root + "manifest.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("Manifest unavailable");
    const value = await response.json();
    if (value.schema_version !== 1 || value.source_id !== config.source || value.baseline !== "1991-2020" || value.unit !== "degC"
      || (context.mode === "tmax" && value.element !== "tmax") || value.cell_count !== 387717 || value.bin_min !== -40
      || value.bin_step !== 1 || value.bin_count !== 81 || value.missing_bin !== 0 || !validRoadClassContract(value.road_classes)) throw new Error("Invalid manifest");
    const seasonDays = winterSeasonDays(value.days);
    if (value.files.length !== 366 || value.files.some((f, i) => f.day !== value.days[i])) throw new Error("Invalid calendar");
    if (context.mode === "tmax") {
      const reference = sources.tmin.manifest.grid;
      if (value.grid.sha256 !== reference.sha256 || value.grid.bytes !== reference.bytes) throw new Error("Temperature grid mismatch");
      // Verify the maximum-mode grid bytes too, even though geometry is shared.
      expandGrid(await checkedJSON(value.grid, config.root));
    }
    const filesByDay = new Map(value.files.map((file) => [file.day, file]));
    context.manifest = { ...value, days: seasonDays, files: seasonDays.map((day) => filesByDay.get(day)) };
    return context.manifest;
  }
  function updateMapLabel() {
    if (displayed < 0) { label.textContent = `${dayText(selected)} · ${modeText(selectedMode)}を読み込み中`; return; }
    const shown = `${dayText(displayed)} · ${modeText(displayedMode)}（独自算出）`;
    label.textContent = displayed === selected && displayedMode === selectedMode ? shown
      : `${dayText(displayed)}の${modeText(displayedMode)}を表示中 · ${dayText(selected)}の${modeText(selectedMode)}を準備中`;
    if (!$("temperatureToggle").checked) label.textContent += " · 気温面は非表示";
  }
  function refreshPoint() {
    if (!selectedPoint) return;
    if (loadState === "error") { point.textContent = "選択地点：通信またはデータ確認に失敗しました"; return; }
    if (displayed !== selected || displayedMode !== selectedMode || !bins) {
      point.textContent = displayed < 0 ? "選択地点：気温を読み込み中" : `選択地点：地図は${dayText(displayed)}の${modeText(displayedMode)}のまま。${dayText(selected)}の${modeText(selectedMode)}を準備中`;
      return;
    }
    const index = lookupCell(grid, selectedPoint.lng, selectedPoint.lat);
    point.textContent = `選択地点（${manifest.days[displayed].replace("-", "/")}・${modeText(displayedMode)}）：${index < 0 ? "未収録の格子です" : bins[index] === 0 ? "欠測（推定に必要な観測が不足）" : binLabel(bins[index])}。道路着色：${roadClassLabel(index < 0 ? 0 : roadClasses[index])}。独自内挿の参考値です。`;
  }
  function syncDate() {
    const [m, d] = manifest.days[selected].split("-").map(Number);
    month.value = String(m);
    const available = manifest.days.filter((entry) => Number(entry.slice(0, 2)) === m).map((entry) => Number(entry.slice(3)));
    if (day.options.length !== available.length || Number(day.options[0]?.value) !== available[0]) {
      day.replaceChildren(...available.map((value) => new Option(String(value), String(value))));
    }
    day.value = String(d); date.value = String(selected);
    date.setAttribute("aria-valuetext", `${m}月${d}日`);
    $("previousDay").disabled = selected === 0;
    $("nextDay").disabled = selected === manifest.days.length - 1;
  }
  async function loadDay(index, context = source) {
    const { cache, pending, manifest } = context;
    if (cache.has(index)) return cache.get(index);
    if (pending.has(index)) return pending.get(index);
    const task = checkedJSON(manifest.files[index], TEMPERATURE_MODES[context.mode].root).then((data) => {
      if (data.day !== manifest.days[index]) throw new Error("Date mismatch");
      const decoded = decodeDisplayDay(data, grid.count);
      cache.set(index, decoded);
      if (context === source && cache.size === manifest.days.length && !context.prefetchPromise) {
        preparationStatus.textContent = `${modeText(context.mode)}・${manifest.days.length}日分の準備完了`;
        preparationStatus.dataset.state = "ready";
      }
      return decoded;
    }).finally(() => pending.delete(index));
    pending.set(index, task);
    return task;
  }
  function show(index, data) {
    loadState = "ready";
    bins = data.bins; roadClasses = unpackRoadClasses(data); displayed = index;
    displayedMode = selectedMode;
    layer.setBins(bins); layer.setVisible($("temperatureToggle").checked);
    syncModeLabels();
    hooks.onDay?.(roadClasses, manifest.days[index], bins, displayedMode);
    updateMapLabel();
    $("map").dataset.temperatureDay = manifest.days[index];
    $("map").dataset.temperatureMode = displayedMode;
    $("map").dataset.temperatureCells = String(grid.count);
    refreshPoint();
  }
  async function select(index, manual = true, delay = 0) {
    if (manual) stop();
    selected = Math.max(0, Math.min(index, manifest.days.length - 1));
    syncDate();
    const token = ++request;
    $("retryTemperature").hidden = true;
    if (!cache.has(selected)) {
      loadState = "loading";
      if (displayed < 0) { layer.setVisible(false); bins = null; roadClasses = null; hooks.onUnavailable?.("loading", selectedMode); }
      updateMapLabel();
      showStatus(displayed < 0 ? `選択日の${modeText(selectedMode)}を読み込んでいます` : `地図は${dayText(displayed)}の${modeText(displayedMode)}のまま。${dayText(selected)}の${modeText(selectedMode)}を準備しています`, "loading");
      refreshPoint();
    }
    try {
      if (delay && !cache.has(selected)) await new Promise((resolve) => setTimeout(resolve, delay));
      if (token !== request) return;
      const result = await loadDay(selected);
      if (token !== request) return;
      show(selected, result);
      showStatus("1km格子・独自内挿。クリック／タップで気温帯を確認");
    } catch {
      if (token !== request) return;
      stop(); layer.setVisible(false); bins = null; roadClasses = null; hooks.onUnavailable?.("error", selectedMode);
      loadState = "error";
      label.textContent = "気温データを表示できません";
      showStatus("気温を読み込めません。道路は引き続き操作できます", "error");
      $("retryTemperature").hidden = false;
      if (selectedPoint) point.textContent = "選択地点：通信またはデータ確認に失敗しました";
    }
  }
  async function prepareSeason() {
    const context = source;
    const { cache, manifest } = context;
    if (cache.size === manifest.days.length) {
      preparationStatus.textContent = `${modeText(context.mode)}・${manifest.days.length}日分の準備完了`;
      preparationStatus.dataset.state = "ready";
      return true;
    }
    if (context.prefetchPromise) return context.prefetchPromise;
    const scheduled = new Set();
    const bytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
    const updateProgress = () => {
      if (context !== source) return;
      preparationStatus.textContent = `${modeText(context.mode)}の冬季データを裏で準備中：${cache.size}/${manifest.days.length}日（最大${(bytes / 1e6).toFixed(1)}MB）`;
      preparationStatus.dataset.state = "loading";
    };
    const nextIndex = () => {
      for (let distance = 0; distance < manifest.days.length; distance++) {
        for (const index of [selected + distance, selected - distance]) {
          if (index >= 0 && index < manifest.days.length && !cache.has(index) && !scheduled.has(index)) {
            scheduled.add(index); return index;
          }
        }
      }
      return -1;
    };
    updateProgress();
    context.prefetchPromise = Promise.all(Array.from({ length: 3 }, async () => {
      while (!document.hidden && context === source) {
        const index = nextIndex();
        if (index < 0) return;
        try { await loadDay(index, context); } catch { /* Keep other dates usable; a later selection can retry. */ }
        if (cache.size % 10 === 0 || cache.size === manifest.days.length) updateProgress();
      }
    })).then(() => {
      const ready = cache.size === manifest.days.length;
      if (context !== source) return false;
      preparationStatus.textContent = ready ? `${modeText(context.mode)}・${manifest.days.length}日分の準備完了` : document.hidden
        ? `冬季データの準備を一時停止中：${cache.size}/${manifest.days.length}日`
        : `一部のデータを準備できませんでした：${cache.size}/${manifest.days.length}日。選択時に再試行できます`;
      preparationStatus.dataset.state = ready ? "ready" : document.hidden ? "loading" : "error";
      return ready;
    }).finally(() => { context.prefetchPromise = null; });
    return context.prefetchPromise;
  }
  async function changeMode(mode) {
    if (!Object.hasOwn(TEMPERATURE_MODES, mode)) return;
    stop();
    const token = ++request;
    selectedMode = mode; source = sources[mode]; cache = source.cache; pending = source.pending;
    modeLoading = true;
    controls.forEach((control) => { control.disabled = true; });
    syncModeLabels(); updateMapLabel(); refreshPoint();
    preparationStatus.textContent = `${modeText(mode)}のデータを準備しています`;
    preparationStatus.dataset.state = "loading";
    showStatus(`${modeText(mode)}へ切り替えています`, "loading");
    $("retryTemperature").hidden = true;
    try {
      const nextManifest = await loadManifest(source);
      if (token !== request) return;
      manifest = nextManifest; modeLoading = false;
      controls.forEach((control) => { control.disabled = false; });
      await select(selected, false);
      if (selectedMode !== mode) return;
      // Let paused requests from the same mode finish before resuming prefetch.
      const active = source.prefetchPromise;
      if (active) await active;
      if (selectedMode === mode && !document.hidden) void prepareSeason();
    } catch {
      if (token !== request) return;
      modeLoading = false; loadState = "error";
      layer.setVisible(false); bins = null; roadClasses = null;
      hooks.onUnavailable?.("error", selectedMode);
      label.textContent = `${modeText(mode)}を表示できません`;
      showStatus(`${modeText(mode)}を読み込めません。再読込または別のモードへ切り替えられます`, "error");
      preparationStatus.textContent = "冬季データの準備を開始できませんでした";
      preparationStatus.dataset.state = "error";
      $("retryTemperature").hidden = false; refreshPoint();
    }
  }
  async function retrySelection() {
    // Background preparation may still own a failing request for this day.
    // Let it settle, then make a fresh selection rather than reusing failure.
    const context = source, index = selected, token = ++request;
    await context.pending.get(index)?.catch(() => {});
    if (context !== source || index !== selected || token !== request) return;
    return select(index);
  }
  async function play() {
    if (playing || preparing) { stop(); showStatus("再生を停止しました"); return; }
    preparing = true;
    const generation = ++playbackGeneration;
    $("playYear").textContent = "■ 再生を中止";
    $("playYear").setAttribute("aria-pressed", "true");
    showStatus("冬季データの準備完了後に再生します", "loading");
    try {
      let cancelWait;
      const canceled = new Promise((resolve) => { cancelWait = resolve; });
      playbackCancelResolve = cancelWait;
      const ready = await Promise.race([
        Promise.all([prepareSeason(), hooks.preparePlayback?.() ?? true]).then((results) => results.every(Boolean)),
        canceled,
      ]);
      if (playbackCancelResolve === cancelWait) playbackCancelResolve = null;
      if (!preparing || generation !== playbackGeneration) return;
      if (!ready) { stop(); showStatus("再生に必要な日付を準備できませんでした。再生ボタンで再試行できます", "error"); return; }
      preparing = false; playing = true;
      $("playYear").textContent = "■ 停止";
      ++request;
      selected = 0; syncDate(); show(selected, cache.get(selected));
      showStatus("9月15日から6月15日まで再生中。遅い端末では再生時間が長くなります");
      let last = 0;
      const step = (time) => {
        if (!playing || generation !== playbackGeneration) return;
        try {
          const interval = Number($("playSpeed").value) / (manifest.days.length - 1);
          if (time - last >= interval) {
            selected++;
            syncDate(); show(selected, cache.get(selected)); last = time;
            if (selected === manifest.days.length - 1) { stop(); showStatus("冬季の再生が終わりました"); return; }
          }
          animation = requestAnimationFrame(step);
        } catch {
          stop(); showStatus("再生を停止しました。日付を選び直してください", "error");
        }
      };
      animation = requestAnimationFrame(step);
    } catch {
      if (generation !== playbackGeneration) return;
      stop(); showStatus("再生データを準備できませんでした。再生ボタンで再試行できます", "error");
    }
  }
  async function start() {
    modeSelect.disabled = true;
    controls.forEach((control) => { control.disabled = true; });
    $("retryTemperature").hidden = true;
    const started = performance.now();
    try {
      manifest = await loadManifest(source);
      grid = expandGrid(await checkedJSON(manifest.grid));
      hooks.onGrid?.(grid);
      layer = createTemperatureLayer(grid);
      map.addLayer(layer, "general-road-casing");
      layer.setOpacity(Number($("temperatureOpacity").value) / 100);
      hooks.onLayerReady?.(grid, manifest);
      const seasonMonths = [...new Set(manifest.days.map((entry) => Number(entry.slice(0, 2))))];
      month.replaceChildren(...seasonMonths.map((value) => new Option(String(value), String(value))));
      date.max = String(manifest.days.length - 1);
      controls.forEach((control) => { control.disabled = false; });
      modeSelect.value = selectedMode; syncModeLabels();
      await select(selected, false);
      modeSelect.disabled = false;
      $("map").dataset.temperatureReadyMs = String(Math.round(performance.now() - started));
      void prepareSeason();
    } catch {
      if (map.getLayer("temperature-mesh")) map.removeLayer("temperature-mesh");
      layer = null;
      bins = null; roadClasses = null; hooks.onUnavailable?.("error", selectedMode);
      loadState = "error";
      showStatus("気温を準備できませんでした。道路は引き続き操作できます", "error");
      label.textContent = "気温は未表示"; $("retryTemperature").hidden = false;
    }
  }
  date.addEventListener("input", () => select(Number(date.value), true, 70));
  $("previousDay").addEventListener("click", () => select(selected - 1, true, 70));
  $("nextDay").addEventListener("click", () => select(selected + 1, true, 70));
  const fromSelects = () => {
    const m = Number(month.value);
    const available = manifest.days.filter((entry) => Number(entry.slice(0, 2)) === m).map((entry) => Number(entry.slice(3)));
    const d = Math.max(available[0], Math.min(Number(day.value), available.at(-1)));
    select(manifest.days.indexOf(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
  };
  month.addEventListener("change", fromSelects); day.addEventListener("change", fromSelects);
  $("playYear").addEventListener("click", play);
  modeSelect.addEventListener("change", () => changeMode(modeSelect.value));
  $("retryTemperature").addEventListener("click", () => layer ? source.manifest ? retrySelection() : changeMode(selectedMode) : start());
  $("temperatureToggle").addEventListener("change", () => {
    if (layer && bins) {
      layer.setVisible($("temperatureToggle").checked);
      updateMapLabel();
    }
  });
  $("temperatureOpacity").addEventListener("input", (event) => {
    $("opacityValue").textContent = `${event.target.value}%`;
    layer?.setOpacity(Number(event.target.value) / 100);
  });
  $("clearTemperaturePoint").addEventListener("click", () => {
    selectedPoint = null; $("clearTemperaturePoint").hidden = true;
    point.textContent = "地図をクリックすると、その格子の気温帯を確認できます。";
  });
  map.on("click", (event) => {
    if (!grid || !layer) return;
    selectedPoint = event.lngLat; $("clearTemperaturePoint").hidden = false; refreshPoint();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (layer && source.manifest && !modeLoading && cache.size < manifest.days.length) {
      const active = source.prefetchPromise;
      if (active) void active.then(() => {
        if (!document.hidden && layer && cache.size < manifest.days.length) void prepareSeason();
      });
      else void prepareSeason();
    }
  });
  start();
}

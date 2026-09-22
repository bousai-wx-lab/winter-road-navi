import { expandGrid, expandDay, createTemperatureLayer, lookupCell, binLabel, paletteColor } from "./temperature-layer.js";

const $ = (id) => document.getElementById(id);
const ROOT = "./data/temperature/";

export async function checkedJSON(record) {
  if (!/^(?:grid\.json|\d{2}-\d{2}\.json\.gz)$/.test(record.url)) throw new Error("Invalid data path");
  const response = await fetch(ROOT + record.url);
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

export function initTemperature(map) {
  const legend = document.querySelector(".legend-gradient").getContext("2d");
  for (let bin = 1; bin <= 81; bin++) {
    legend.fillStyle = paletteColor(bin); legend.fillRect((bin - 1) * 4, 0, 4, 18);
  }
  const date = $("dateSlider"), month = $("monthSelect"), day = $("daySelect");
  const status = $("temperatureStatus"), label = $("mapTemperatureLabel"), point = $("temperaturePoint");
  const controls = [date, month, day, $("previousDay"), $("nextDay"), $("playYear")];
  const cache = new Map(), pending = new Map();
  let manifest, grid, layer, bins, selected = 14, displayed = -1, request = 0;
  let playing = false, preparing = false, animation = 0, selectedPoint = null, playbackGeneration = 0;
  let loadState = "loading";
  const showStatus = (text, state = "ready") => { status.textContent = text; status.dataset.state = state; };
  const stop = () => {
    playbackGeneration++;
    playing = false; preparing = false; cancelAnimationFrame(animation);
    for (const index of cache.keys()) {
      if (cache.size <= 40) break;
      if (index !== selected) cache.delete(index);
    }
    $("playYear").textContent = "▶ 1年を再生";
    $("playYear").setAttribute("aria-pressed", "false");
  };
  function refreshPoint() {
    if (!selectedPoint) return;
    if (loadState === "error") { point.textContent = "選択地点：通信またはデータ確認に失敗しました"; return; }
    if (displayed !== selected || !bins) { point.textContent = "選択地点：気温を読み込み中"; return; }
    const index = lookupCell(grid, selectedPoint.lng, selectedPoint.lat);
    point.textContent = `選択地点（${manifest.days[displayed].replace("-", "/")}）：${index < 0 ? "未収録の格子です" : bins[index] === 0 ? "欠測（推定に必要な観測が不足）" : binLabel(bins[index])}。独自内挿の参考値です。`;
  }
  function syncDate() {
    const [m, d] = manifest.days[selected].split("-").map(Number);
    month.value = String(m);
    const count = new Date(Date.UTC(2000, m, 0)).getUTCDate();
    if (day.options.length !== count) {
      day.replaceChildren(...Array.from({ length: count }, (_, i) => new Option(String(i + 1), String(i + 1))));
    }
    day.value = String(d); date.value = String(selected);
    date.setAttribute("aria-valuetext", `${m}月${d}日`);
  }
  async function loadDay(index) {
    if (cache.has(index)) return cache.get(index);
    if (pending.has(index)) return pending.get(index);
    const task = checkedJSON(manifest.files[index]).then((data) => {
      if (data.day !== manifest.days[index]) throw new Error("Date mismatch");
      const decoded = expandDay(data, grid.count);
      cache.set(index, decoded);
      // Normal browsing retains only a month. Playback explicitly loads all days.
      if (!preparing && !playing && cache.size > 40) cache.delete(cache.keys().next().value);
      return decoded;
    }).finally(() => pending.delete(index));
    pending.set(index, task);
    return task;
  }
  function show(index, data) {
    loadState = "ready";
    bins = data; displayed = index;
    layer.setBins(data); layer.setVisible($("temperatureToggle").checked);
    label.textContent = `${manifest.days[index].replace("-", "月")}日 · 平均最低気温（独自算出）`;
    if (!$("temperatureToggle").checked) label.textContent += " · 非表示";
    $("map").dataset.temperatureDay = manifest.days[index];
    $("map").dataset.temperatureCells = String(grid.count);
    refreshPoint();
  }
  async function select(index, manual = true) {
    if (manual) stop();
    selected = (index + manifest.days.length) % manifest.days.length;
    syncDate();
    const token = ++request;
    $("retryTemperature").hidden = true;
    if (!cache.has(selected)) {
      loadState = "loading";
      layer.setVisible(false); bins = null;
      label.textContent = `${manifest.days[selected].replace("-", "月")}日 · 読み込み中`;
      showStatus("選択日の気温を読み込んでいます", "loading"); refreshPoint();
    }
    try {
      const result = await loadDay(selected);
      if (token !== request) return;
      show(selected, result);
      showStatus("1km格子・独自内挿。クリック／タップで気温帯を確認");
    } catch {
      if (token !== request) return;
      stop(); layer.setVisible(false); bins = null;
      loadState = "error";
      label.textContent = "気温データを表示できません";
      showStatus("気温を読み込めません。道路は引き続き操作できます", "error");
      $("retryTemperature").hidden = false;
      if (selectedPoint) point.textContent = "選択地点：通信またはデータ確認に失敗しました";
    }
  }
  async function play() {
    if (playing || preparing) { stop(); showStatus("再生を停止しました"); return; }
    preparing = true;
    const generation = ++playbackGeneration;
    $("playYear").textContent = "■ 準備を中止";
    $("playYear").setAttribute("aria-pressed", "true");
    let cursor = 0, done = 0;
    const bytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
    try {
      await Promise.all(Array.from({ length: 6 }, async () => {
        while (preparing && generation === playbackGeneration && cursor < manifest.days.length) {
          await loadDay(cursor++); done++;
          if (preparing && generation === playbackGeneration) showStatus(`再生準備 ${done}/${manifest.days.length}日（初回最大${(bytes / 1e6).toFixed(1)}MB）`, "loading");
        }
      }));
      if (!preparing || generation !== playbackGeneration) return;
      preparing = false; playing = true;
      $("playYear").textContent = "■ 停止";
      showStatus("1年を再生中。遅い端末では再生時間が長くなります");
      ++request;
      let last = 0, frames = 0;
      const step = (time) => {
        if (!playing || generation !== playbackGeneration) return;
        try {
        const interval = Number($("playSpeed").value) / manifest.days.length;
        if (time - last >= interval) {
          selected = (selected + 1) % manifest.days.length;
          syncDate(); show(selected, cache.get(selected)); frames++; last = time;
          if (frames === manifest.days.length) { stop(); showStatus("1年分の再生が終わりました"); return; }
        }
        animation = requestAnimationFrame(step);
        } catch {
          stop(); showStatus("再生を停止しました。日付を選び直してください", "error");
        }
      };
      animation = requestAnimationFrame(step);
    } catch {
      if (generation !== playbackGeneration) return;
      stop(); showStatus("再生データを読み込めませんでした。再生ボタンで再試行できます", "error");
    }
  }
  async function start() {
    controls.forEach((control) => { control.disabled = true; });
    $("retryTemperature").hidden = true;
    const started = performance.now();
    try {
      const response = await fetch(ROOT + "manifest.json");
      if (!response.ok) throw new Error("Manifest unavailable");
      manifest = await response.json();
      if (manifest.schema_version !== 1 || manifest.cell_count !== 387717 || manifest.bin_min !== -40 || manifest.bin_step !== 1 || manifest.bin_count !== 81 || manifest.missing_bin !== 0 || manifest.days.length !== 366) throw new Error("Invalid manifest");
      if (manifest.files.length !== 366 || manifest.files.some((f, i) => f.day !== manifest.days[i])) throw new Error("Invalid calendar");
      grid = expandGrid(await checkedJSON(manifest.grid));
      layer = createTemperatureLayer(grid);
      map.addLayer(layer, "general-road-casing");
      layer.setOpacity(Number($("temperatureOpacity").value) / 100);
      month.replaceChildren(...Array.from({ length: 12 }, (_, i) => new Option(String(i + 1), String(i + 1))));
      controls.forEach((control) => { control.disabled = false; });
      await select(selected);
      $("map").dataset.temperatureReadyMs = String(Math.round(performance.now() - started));
    } catch {
      if (map.getLayer("temperature-mesh")) map.removeLayer("temperature-mesh");
      layer = null;
      loadState = "error";
      showStatus("気温を準備できませんでした。道路は引き続き操作できます", "error");
      label.textContent = "気温は未表示"; $("retryTemperature").hidden = false;
    }
  }
  date.addEventListener("input", () => select(Number(date.value)));
  $("previousDay").addEventListener("click", () => select(selected - 1));
  $("nextDay").addEventListener("click", () => select(selected + 1));
  const fromSelects = () => {
    const m = Number(month.value), count = new Date(Date.UTC(2000, m, 0)).getUTCDate();
    const d = Math.min(Number(day.value), count);
    select(manifest.days.indexOf(`${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`));
  };
  month.addEventListener("change", fromSelects); day.addEventListener("change", fromSelects);
  $("playYear").addEventListener("click", play);
  $("retryTemperature").addEventListener("click", () => layer ? select(selected) : start());
  $("temperatureToggle").addEventListener("change", () => {
    if (layer && bins) show(displayed, bins);
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
    if (!grid || !layer || !$("temperatureToggle").checked) return;
    selectedPoint = event.lngLat; $("clearTemperaturePoint").hidden = false; refreshPoint();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  start();
}

import { createTemperatureLayer, lookupCell } from "./temperature-layer.js";
import { checkedSnowManifest, decodeSnowDay, expandSnowBins, snowFillBins, SNOW_COLORS, snowBinLabel } from "./snow-display-data.js?v=20260924-snow2";
import { createSnowContourLayer } from "./snow-contour-layer.js?v=20260924-snow2";

const ROOT = "./data/snow/";
const $ = (id) => document.getElementById(id);

async function checkedSnowDay(record, count) {
  const response = await fetch(ROOT + record.url, { cache: "no-cache" });
  if (!response.ok) throw new Error("積雪表示データを取得できません");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== record.bytes) throw new Error("積雪表示データの長さが一致しません");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  if (hash !== record.sha256) throw new Error("積雪表示データの検証に失敗しました");
  const decoded = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  if (decoded.byteLength !== record.uncompressed_bytes || decoded.byteLength > 4_000_000) {
    throw new Error("積雪表示データを展開できません");
  }
  return decodeSnowDay(JSON.parse(new TextDecoder().decode(decoded)), count, record.day);
}

export function initSnow(map, grid, temperatureManifest, onTooltipChange = () => {}) {
  const toggle = $("snowToggle"), opacity = $("snowOpacity"), opacityValue = $("snowOpacityValue");
  const positiveOnly = $("snowPositiveOnly"), scaleStart = $("snowScaleStart");
  const contourCaption = $("snowContourCaption"), zeroContourLegend = $("snowZeroContourLegend");
  const status = $("snowStatus"), preparation = $("snowPreparationStatus"), point = $("snowPoint");
  const retry = $("retrySnow");
  const cache = new Map(), pending = new Map();
  let manifest = null, layer = null, contours = null, selectedDay = null, displayedDay = null;
  let bins = null, tooltipBins = null, tooltipDay = null, tooltipEnabled = false, tooltipError = false;
  let selectedPoint = null, request = 0, prefetchPromise = null;
  let startPromise = null;

  function showStatus(message, state = "ready") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function hide() {
    layer?.setVisible(false);
    contours?.setVisible(false);
    delete $("map").dataset.snowDay;
  }

  function refreshPoint() {
    if (!selectedPoint) return;
    if (!toggle.checked) { point.textContent = "選択地点：積雪表示はOFFです"; return; }
    if (displayedDay !== selectedDay || !bins) { point.textContent = "選択地点：積雪を準備中です"; return; }
    const index = lookupCell(grid, selectedPoint.lng, selectedPoint.lat);
    const label = index < 0 ? "格子未収録" : snowBinLabel(bins[index]);
    const excluded = index >= 0 && positiveOnly.getAttribute("aria-pressed") === "true" && bins[index] === 2;
    point.textContent = `選択地点（${displayedDay.replace("-", "/")}）：${label}${excluded ? "（0cm除外中のため無色）" : ""}。日最深積雪の平年推定値で、現在の道路上の雪ではありません。`;
  }

  function updateMode() {
    const active = positiveOnly.getAttribute("aria-pressed") === "true";
    scaleStart.textContent = active ? "1cm・白" : "現象あり0cm・白";
    contourCaption.textContent = active ? "細い実線：現象あり格子間の1・5・10・20・50・100cm境界" : "細い実線：積雪域の境界と各深さ以上の境界";
    zeroContourLegend.hidden = active;
    contours?.setPositiveOnly(active);
    if (bins && displayedDay === selectedDay && layer) layer.setBins(snowFillBins(bins, active));
    refreshPoint();
  }

  function display(day, compact) {
    const decoded = expandSnowBins(compact, grid.count);
    layer.setBins(snowFillBins(decoded, positiveOnly.getAttribute("aria-pressed") === "true"));
    contours.setContours(compact.contours);
    layer.setVisible(toggle.checked);
    contours.setVisible(toggle.checked);
    bins = decoded;
    displayedDay = day;
    tooltipBins = decoded;
    tooltipDay = day;
    $("map").dataset.snowDay = day;
    showStatus(`${day.replace("-", "月")}日の積雪平年値を表示中`);
    refreshPoint();
    onTooltipChange();
  }

  async function loadDay(day) {
    if (cache.has(day)) return cache.get(day);
    if (pending.has(day)) return pending.get(day);
    const record = manifest.files[manifest.days.indexOf(day)];
    if (!record) throw new Error("積雪の表示期間外です");
    const task = checkedSnowDay(record, grid.count).then((compact) => {
      cache.set(day, compact);
      return compact;
    }).finally(() => pending.delete(day));
    pending.set(day, task);
    return task;
  }

  async function setDay(day) {
    selectedDay = day;
    const token = ++request;
    tooltipBins = null; tooltipDay = null; tooltipError = false;
    onTooltipChange();
    if (!toggle.checked && !tooltipEnabled) { hide(); refreshPoint(); return; }
    if (!manifest) { showStatus("積雪データの一覧を確認中", "loading"); return; }
    if (toggle.checked) retry.hidden = true;
    if (toggle.checked && !cache.has(day)) {
      hide(); bins = null; displayedDay = null;
      showStatus(`${day.replace("-", "月")}日の積雪を準備中`, "loading");
      refreshPoint();
    }
    try {
      const compact = await loadDay(day);
      if (token !== request) return;
      if (toggle.checked) display(day, compact);
      else {
        tooltipBins = expandSnowBins(compact, grid.count);
        tooltipDay = day;
        onTooltipChange();
      }
    } catch {
      if (token !== request) return;
      hide(); bins = null; displayedDay = null; tooltipError = true;
      tooltipBins = null; tooltipDay = null; onTooltipChange();
      if (toggle.checked) {
        showStatus("積雪を表示できません。気温と道路は引き続き操作できます", "error");
        retry.hidden = false;
      }
      refreshPoint();
    }
  }

  async function prepareSeason() {
    await startPromise;
    if (!toggle.checked) return true;
    if (!manifest) return false;
    if (cache.size === manifest.days.length) {
      preparation.textContent = `${cache.size}日分の積雪データを準備済み`;
      preparation.dataset.state = "ready";
      return true;
    }
    if (prefetchPromise) return prefetchPromise;
    const scheduled = new Set();
    const bytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
    function progress() {
      preparation.textContent = `積雪を裏で準備中：${cache.size}/${manifest.days.length}日（最大${(bytes / 1e6).toFixed(1)}MB）`;
      preparation.dataset.state = "loading";
    }
    function nextDay() {
      const center = Math.max(0, manifest.days.indexOf(selectedDay));
      for (let distance = 0; distance < manifest.days.length; distance++) {
        for (const index of [center + distance, center - distance]) {
          const day = manifest.days[index];
          if (day && !cache.has(day) && !scheduled.has(day)) { scheduled.add(day); return day; }
        }
      }
      return null;
    }
    progress();
    prefetchPromise = Promise.all(Array.from({ length: 3 }, async () => {
      while (toggle.checked && !document.hidden) {
        const day = nextDay();
        if (!day) return;
        try { await loadDay(day); } catch { /* A selected day can retry independently. */ }
        if (cache.size % 10 === 0 || cache.size === manifest.days.length) progress();
      }
    })).then(() => {
      const ready = cache.size === manifest.days.length;
      preparation.textContent = ready ? `${cache.size}日分の積雪データを準備済み`
        : document.hidden || !toggle.checked ? `積雪の裏準備を一時停止：${cache.size}/${manifest.days.length}日`
          : `一部の積雪データを準備できませんでした：${cache.size}/${manifest.days.length}日`;
      preparation.dataset.state = ready ? "ready" : document.hidden || !toggle.checked ? "loading" : "error";
      return ready;
    }).finally(() => { prefetchPromise = null; });
    return prefetchPromise;
  }

  async function start() {
    toggle.disabled = true;
    try {
      const response = await fetch(ROOT + "manifest.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("積雪データの一覧を取得できません");
      manifest = checkedSnowManifest(await response.json(), grid.count,
        temperatureManifest.grid.sha256, temperatureManifest.days);
      layer = createTemperatureLayer(grid, {
        id: "snow-mesh",
        colorForBin: (bin) => SNOW_COLORS[Math.min(bin, SNOW_COLORS.length - 1)],
      });
      contours = createSnowContourLayer();
      contours.setPositiveOnly(positiveOnly.getAttribute("aria-pressed") === "true");
      map.addLayer(layer, "general-road-casing");
      map.addLayer(contours, "general-road-casing");
      const value = Number(opacity.value) / 100;
      layer.setOpacity(value); contours.setOpacity(value);
      toggle.disabled = false;
      showStatus("積雪表示はOFFです。ONにすると選択日の雪域と等値線を表示します");
      if (selectedDay && (toggle.checked || tooltipEnabled)) void setDay(selectedDay);
      if (toggle.checked) void prepareSeason();
    } catch {
      hide();
      if (map.getLayer("snow-contours")) map.removeLayer("snow-contours");
      if (map.getLayer("snow-mesh")) map.removeLayer("snow-mesh");
      layer = null; contours = null; manifest = null;
      showStatus("積雪表示を準備できません。気温と道路は引き続き操作できます", "error");
      retry.hidden = false;
      onTooltipChange();
    }
  }

  toggle.addEventListener("change", () => {
    if (!toggle.checked) {
      ++request; hide(); showStatus("積雪表示はOFFです"); refreshPoint();
      if (tooltipEnabled && selectedDay) void setDay(selectedDay);
      return;
    }
    if (selectedDay) void setDay(selectedDay);
    void prepareSeason();
  });
  positiveOnly.addEventListener("click", () => {
    positiveOnly.setAttribute("aria-pressed", String(positiveOnly.getAttribute("aria-pressed") !== "true"));
    updateMode();
  });
  opacity.addEventListener("input", () => {
    opacityValue.textContent = `${opacity.value}%`;
    const value = Number(opacity.value) / 100;
    layer?.setOpacity(value); contours?.setOpacity(value);
  });
  retry.addEventListener("click", () => {
    retry.hidden = true;
    if (manifest && selectedDay) void setDay(selectedDay);
    else startPromise = start();
  });
  map.on("click", (event) => { selectedPoint = event.lngLat; refreshPoint(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && toggle.checked && manifest && cache.size < manifest.days.length) {
      const active = prefetchPromise;
      if (active) void active.then(() => { if (!document.hidden && toggle.checked) void prepareSeason(); });
      else void prepareSeason();
    }
  });
  startPromise = start();
  return {
    setDay,
    preparePlayback: async () => toggle.checked ? prepareSeason() : true,
    setTooltipEnabled(enabled) {
      tooltipEnabled = Boolean(enabled);
      if (!tooltipEnabled) { tooltipBins = null; tooltipDay = null; return; }
      if (selectedDay) void setDay(selectedDay);
    },
    tooltipAt(lng, lat) {
      if (!manifest) return { state: "unavailable", label: "積雪データなし" };
      if (tooltipError) return { state: "error", label: "積雪データを確認できません" };
      if (!selectedDay || tooltipDay !== selectedDay || !tooltipBins) return { state: "loading", label: "積雪を準備中" };
      const index = lookupCell(grid, lng, lat);
      return { state: "ready", label: index < 0 ? "格子未収録" : snowBinLabel(tooltipBins[index]) };
    },
    clear() {
      ++request; hide(); bins = null; displayedDay = null;
      tooltipBins = null; tooltipDay = null; tooltipError = false; selectedDay = null; onTooltipChange();
      if (toggle.checked) showStatus("気温の日付を確認できないため積雪は非表示です", "error");
      refreshPoint();
    },
  };
}

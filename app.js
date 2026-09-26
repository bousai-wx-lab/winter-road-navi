import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { JAPAN_VIEW, classifyRoad, createMapStyle } from "./road-style.js?v=20260926-live1";
import { initTemperature, TEMPERATURE_MODES } from "./temperature-control.js?v=20260926-live1";
import { createRoadTemperature } from "./road-temperature.js?v=20260926-live1";
import { initSnow } from "./snow-control.js?v=20260926-live1";
import { initLiveTemperature } from "./live-temperature-control.js?v=20260926-live1";
import { lookupCell, binLabel } from "./temperature-layer.js";

maplibregl.setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);

const status = document.querySelector("#mapStatus");
const mapElement = document.querySelector("#map");
const details = document.querySelector("#roadDetails");
const roadType = document.querySelector("#roadType");
const roadNote = document.querySelector("#roadNote");
const interactiveLayers = ["highway", "general-road"];
let roadTemperature = null;
let normalTemperature = null, liveTemperature = null, displayMode = "normal";
let snow = null;
let temperatureGrid = null, temperatureBins = null, tooltipDay = null, hovered = null;
let tooltipMode = "tmin";
let tooltipTemperatureState = "loading";
const tooltip = document.querySelector("#meshTooltip");
const tooltipToggle = document.querySelector("#meshTooltipToggle");
function refreshTooltip() {
  if (!tooltipToggle.checked || !hovered) { tooltip.hidden = true; return; }
  const index = temperatureGrid ? lookupCell(temperatureGrid, hovered.lng, hovered.lat) : -1;
  const temperature = tooltipTemperatureState === "error" ? "気温を表示できません"
    : !tooltipDay || !temperatureBins ? "気温を準備中"
    : index < 0 ? "格子未収録" : temperatureBins[index] === 0 ? "欠測" : binLabel(temperatureBins[index]);
  const live = displayMode === "live";
  const liveValue = liveTemperature?.tooltipAt(hovered.lng, hovered.lat);
  const snowValue = snow?.tooltipAt(hovered.lng, hovered.lat) ?? { label: "積雪を準備中" };
  document.querySelector("#meshTooltipDate").textContent = live ? liveTemperature.label() : tooltipDay ? `${tooltipDay.replace("-", "月")}日` : "表示日を準備中";
  document.querySelector("#meshTooltipTemperature").textContent = live ? `${liveTemperature.title()}：${liveValue.label}` : `${TEMPERATURE_MODES[tooltipMode].label}：${temperature}`;
  document.querySelector("#meshTooltipSnow").textContent = live ? "積雪平年値は平年値モードで表示" : `日最深積雪：${snowValue.label}`;
  tooltip.dataset.day = tooltipDay || "";
  tooltip.dataset.temperature = live ? liveValue.label : temperature;
  tooltip.dataset.temperatureMode = live ? "live" : tooltipMode;
  tooltip.dataset.snow = live ? "平年値モードのみ" : snowValue.label;
  document.querySelector("#meshTooltipNote").textContent = live ? "約5km数値メッシュ・路面状態ではありません" : "1km格子の独自推定・表示階級";
  tooltip.hidden = false;
  const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(8, Math.min(hovered.x + 14, mapElement.clientWidth - width - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(hovered.y + 16, mapElement.clientHeight - height - 8))}px`;
}
const roadTemperatureStatus = document.querySelector("#roadTemperatureStatus");
function setRoadTemperatureState(state) {
  roadTemperatureStatus.dataset.state = state;
  roadTemperatureStatus.textContent = state === "ready" ? displayMode === "live" ? "選択時刻の約5km気温で路線を着色しています" : "選択日の格子気温で路線を着色しています"
    : state === "loading" ? "道路の着色を準備中（未準備の区間は従来色）"
    : "道路の気温着色を表示できません。従来色の道路を表示します";
}

if (window.matchMedia("(max-width: 760px)").matches) {
  const panel = document.querySelector(".control-panel");
  const toggle = document.querySelector("#panelToggle");
  panel.classList.add("is-collapsed");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "詳細を開く";
}

const map = new maplibregl.Map({
  container: "map",
  style: createMapStyle(),
  center: JAPAN_VIEW.center,
  zoom: JAPAN_VIEW.zoom,
  minZoom: 4.7,
  maxZoom: 17.5,
  maxBounds: [[120, 18], [156, 49]],
  attributionControl: true,
  cooperativeGestures: false,
  antialias: false,
  refreshExpiredTiles: false,
  validateStyle: true,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), "top-right");
map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: "metric" }), "bottom-right");

function setStatus(message, state) {
  status.textContent = message;
  if (state) {
    status.dataset.state = state;
  } else {
    status.removeAttribute("data-state");
  }
}

function setLayerGroup(ids, visible) {
  const visibility = visible ? "visible" : "none";
  for (const id of ids) {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visibility);
    }
  }
}

document.querySelector("#panelToggle").addEventListener("click", (event) => {
  const panel = document.querySelector(".control-panel");
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  event.currentTarget.textContent = expanded ? "詳細を開く" : "詳細を閉じる";
  panel.classList.toggle("is-collapsed", expanded);
});

document.querySelector("#highwayToggle").addEventListener("change", (event) => {
  setLayerGroup(["highway-casing", "highway"], event.currentTarget.checked);
  roadTemperature?.setHighwayVisible(event.currentTarget.checked);
});

document.querySelector("#generalToggle").addEventListener("change", (event) => {
  setLayerGroup(["general-road-casing", "general-road"], event.currentTarget.checked);
  roadTemperature?.setGeneralVisible(event.currentTarget.checked);
});

tooltipToggle.addEventListener("change", () => {
  snow?.setTooltipEnabled(tooltipToggle.checked);
  refreshTooltip();
});

document.querySelector("#resetView").addEventListener("click", () => {
  map.easeTo({ center: JAPAN_VIEW.center, zoom: JAPAN_VIEW.zoom, duration: 450 });
});

document.querySelector("#closeDetails").addEventListener("click", () => {
  details.hidden = true;
});

function useGrid(grid) {
  if (temperatureGrid === grid && roadTemperature) return;
  temperatureGrid = grid;
  try {
    roadTemperature?.destroy();
    roadTemperature = createRoadTemperature(map, grid, setRoadTemperatureState);
    roadTemperature.setHighwayVisible(document.querySelector("#highwayToggle").checked);
    roadTemperature.setGeneralVisible(document.querySelector("#generalToggle").checked);
  } catch { roadTemperature = null; setRoadTemperatureState("error"); }
}
function switchDisplayMode(mode) {
  if (!normalTemperature || !liveTemperature) return;
  displayMode = mode;
  roadTemperature?.clear(); temperatureBins = null; tooltipDay = null;
  document.querySelector("#normalControls").hidden = mode !== "normal";
  document.querySelector("#liveControls").hidden = mode !== "live";
  document.querySelector(".snow-section").hidden = mode !== "normal";
  document.querySelector("#normalMode").setAttribute("aria-pressed", String(mode === "normal"));
  document.querySelector("#liveMode").setAttribute("aria-pressed", String(mode === "live"));
  document.querySelector("#panelHeading").textContent = mode === "live" ? "実況・予想気温と道路" : "平年の寒さ・雪と道路";
  document.querySelector(".road-temperature-note").textContent = mode === "live"
    ? "線の色は約5km数値メッシュの気温区分です。路面凍結の判定ではありません。"
    : "線の色は1km格子の気温区分です。路面凍結の判定ではありません。";
  document.querySelector("#map").dataset.displayMode = mode;
  document.querySelector("#dataMeaning").textContent = mode === "live" ? "実況・予想の格子気温です。路面温度・凍結・通行可否を示しません。" : "気温・積雪とも平年の推定分布です。予報・実況・路面状態ではありません。";
  document.querySelector(".road-section .road-temperature-legend").setAttribute("aria-label", mode === "live" ? "道路の実況・予想気温の色分け" : "道路の平年気温の色分け");
  document.querySelector("#map-heading").textContent = mode === "live" ? "実況・予想気温と全国の道路地図" : "全国の1km気温・積雪平年メッシュと道路地図";
  snow?.setActive(mode === "normal");
  liveTemperature.setActive(mode === "live");
  normalTemperature.setActive(mode === "normal");
  if (mode === "live") document.querySelector("#map").setAttribute("aria-label", "実況・予想気温と道路を表示する地図");
  refreshTooltip();
}
document.querySelector("#normalMode").addEventListener("click", () => switchDisplayMode("normal"));
document.querySelector("#liveMode").addEventListener("click", () => switchDisplayMode("live"));
map.on("load", () => {
  setStatus("道路を表示中。細い一般道路は地図を拡大すると現れます", "ready");
  liveTemperature = initLiveTemperature(map, {
    onData(shown) {
      if (displayMode !== "live") return;
      useGrid(shown.data.grid); tooltipDay = shown.day; tooltipTemperatureState = "ready";
      try { roadTemperature?.setClasses(shown.data.classes, shown.day); }
      catch { roadTemperature?.clear(); setRoadTemperatureState("error"); }
      refreshTooltip();
    },
    onUnavailable(state) {
      if (displayMode !== "live") return;
      roadTemperature?.clear(); setRoadTemperatureState(state); refreshTooltip();
    },
  });
  normalTemperature = initTemperature(map, {
    onGrid(grid) { if (displayMode === "normal") useGrid(grid); },
    onLayerReady(grid, manifest) {
      snow = initSnow(map, grid, manifest, refreshTooltip);
      snow.setActive(displayMode === "normal");
      snow.setTooltipEnabled(tooltipToggle.checked);
    },
    onDay(classes, day, bins, mode) {
      if (displayMode !== "normal") return;
      temperatureBins = bins; tooltipDay = day; tooltipMode = mode;
      tooltipTemperatureState = "ready";
      try { roadTemperature?.setClasses(classes, day); }
      catch { roadTemperature?.clear(); setRoadTemperatureState("error"); }
      void snow?.setDay(day); refreshTooltip();
    },
    onUnavailable(state, mode) {
      if (displayMode !== "normal") return;
      tooltipMode = mode; tooltipTemperatureState = state;
      temperatureBins = null; tooltipDay = null;
      roadTemperature?.clear(); setRoadTemperatureState(state); snow?.clear(); refreshTooltip();
    },
    preparePlayback() { return snow?.preparePlayback() ?? true; },
  });
  document.querySelector("#normalMode").disabled = false;
  document.querySelector("#liveMode").disabled = false;
});

map.on("idle", () => {
  const visibleRoads = map.queryRenderedFeatures({ layers: interactiveLayers });
  const highwayCount = visibleRoads.filter((feature) => feature.layer.id === "highway").length;
  const generalCount = visibleRoads.filter((feature) => feature.layer.id === "general-road").length;
  mapElement.dataset.highwayFeatures = String(highwayCount);
  mapElement.dataset.generalRoadFeatures = String(generalCount);
});

map.on("error", (event) => {
  if (event?.sourceId === "roads" || event?.sourceId === "background") {
    setStatus("地図データの一部を読み込めません。通信を確認して再読み込みしてください", "error");
  }
});

map.on("mousemove", (event) => {
  const features = map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
  map.getCanvas().style.cursor = features.length ? "pointer" : "";
  hovered = { lng: event.lngLat.lng, lat: event.lngLat.lat, x: event.point.x, y: event.point.y };
  refreshTooltip();
});

map.on("mouseleave", () => { hovered = null; refreshTooltip(); });

map.on("click", (event) => {
  if (tooltipToggle.checked) {
    hovered = { lng: event.lngLat.lng, lat: event.lngLat.lat, x: event.point.x, y: event.point.y };
    refreshTooltip();
  }
  const feature = map.queryRenderedFeatures(event.point, { layers: interactiveLayers })[0];
  if (!feature) {
    details.hidden = true;
    return;
  }
  const kind = classifyRoad(feature.properties);
  roadType.textContent = kind === "highway" ? "高速道路" : "一般道路";
  roadNote.textContent = kind === "highway"
    ? "高速道路として区分された道路です。現在の通行可否や規制は示していません。"
    : "一般道路として区分された道路です。車両通行の可否や道路名は保証していません。";
  details.hidden = false;
});

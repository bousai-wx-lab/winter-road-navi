import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { JAPAN_VIEW, classifyRoad, createMapStyle } from "./road-style.js";
import { TEMPERATURE_DAY_COUNT } from "./temperature-data.js";
import {
  TEMPERATURE_LAYER_IDS,
  buildTemperatureFeatures,
  decodeTemperatureValues,
  formatCalendarDate,
  normalizeDayIndex,
} from "./temperature-layer.js";

maplibregl.setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);

const status = document.querySelector("#mapStatus");
const mapElement = document.querySelector("#map");
const details = document.querySelector("#roadDetails");
const roadType = document.querySelector("#roadType");
const roadNote = document.querySelector("#roadNote");
const interactiveLayers = ["highway", "general-road"];
const dateSlider = document.querySelector("#dateSlider");
const dateLabel = document.querySelector("#dateLabel");
const playButton = document.querySelector("#playButton");
const speedSelect = document.querySelector("#speedSelect");
const temperatureValues = decodeTemperatureValues();
let currentDay = 0;
let animationFrame = 0;
let playStartedAt = 0;
let playStartedDay = 0;

if (window.matchMedia("(max-width: 760px)").matches) {
  const panel = document.querySelector(".control-panel");
  const toggle = document.querySelector("#panelToggle");
  panel.classList.add("is-collapsed");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "詳細を開く";
}

const map = new maplibregl.Map({
  container: "map",
  style: createMapStyle(buildTemperatureFeatures(temperatureValues, currentDay)),
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

function updateTemperatureLayer(dayIndex) {
  currentDay = normalizeDayIndex(dayIndex);
  const label = formatCalendarDate(currentDay);
  dateSlider.value = String(currentDay);
  dateSlider.setAttribute("aria-valuetext", label);
  dateLabel.textContent = label;
  document.querySelector(".control-panel").dataset.dayIndex = String(currentDay);
  const source = map.getSource("temperatureNormals");
  if (source) {
    source.setData(buildTemperatureFeatures(temperatureValues, currentDay));
  }
}

function pausePlayback() {
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
  playButton.dataset.playing = "false";
  playButton.setAttribute("aria-label", "一年を自動再生");
  playButton.querySelector(".play-icon").textContent = "▶";
  playButton.querySelector(".play-label").textContent = "再生";
}

function playbackTick(now) {
  if (!animationFrame) {
    return;
  }
  const cycleMilliseconds = Number(speedSelect.value) * 1000;
  const elapsedDays = Math.floor((now - playStartedAt) * TEMPERATURE_DAY_COUNT / cycleMilliseconds);
  updateTemperatureLayer(playStartedDay + elapsedDays);
  animationFrame = requestAnimationFrame(playbackTick);
}

function startPlayback() {
  pausePlayback();
  playStartedAt = performance.now();
  playStartedDay = currentDay;
  playButton.dataset.playing = "true";
  playButton.setAttribute("aria-label", "自動再生を一時停止");
  playButton.querySelector(".play-icon").textContent = "Ⅱ";
  playButton.querySelector(".play-label").textContent = "停止";
  animationFrame = requestAnimationFrame(playbackTick);
}

function stepDay(amount) {
  pausePlayback();
  updateTemperatureLayer(currentDay + amount);
}

dateSlider.addEventListener("input", (event) => {
  pausePlayback();
  updateTemperatureLayer(event.currentTarget.value);
});

document.querySelector("#previousDay").addEventListener("click", () => stepDay(-1));
document.querySelector("#nextDay").addEventListener("click", () => stepDay(1));
playButton.addEventListener("click", () => {
  if (animationFrame) {
    pausePlayback();
  } else {
    startPlayback();
  }
});

speedSelect.addEventListener("change", () => {
  if (animationFrame) {
    startPlayback();
  }
});

document.querySelector("#temperatureToggle").addEventListener("change", (event) => {
  setLayerGroup(TEMPERATURE_LAYER_IDS, event.currentTarget.checked);
});

document.querySelector("#temperatureOpacity").addEventListener("input", (event) => {
  const opacity = Number(event.currentTarget.value) / 100;
  document.querySelector("#temperatureOpacityValue").textContent = `${event.currentTarget.value}%`;
  if (map.getLayer("temperature-normal-halo")) {
    map.setPaintProperty("temperature-normal-halo", "circle-opacity", opacity * 0.72);
    map.setPaintProperty("temperature-normal-core", "circle-opacity", opacity * 0.92);
  }
});

document.querySelector("#panelToggle").addEventListener("click", (event) => {
  const panel = document.querySelector(".control-panel");
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  event.currentTarget.textContent = expanded ? "詳細を開く" : "詳細を閉じる";
  panel.classList.toggle("is-collapsed", expanded);
});

document.querySelector("#highwayToggle").addEventListener("change", (event) => {
  setLayerGroup(["highway-casing", "highway"], event.currentTarget.checked);
});

document.querySelector("#generalToggle").addEventListener("change", (event) => {
  setLayerGroup(["general-road-casing", "general-road"], event.currentTarget.checked);
});

document.querySelector("#resetView").addEventListener("click", () => {
  map.easeTo({ center: JAPAN_VIEW.center, zoom: JAPAN_VIEW.zoom, duration: 450 });
});

document.querySelector("#closeDetails").addEventListener("click", () => {
  details.hidden = true;
});

map.on("load", () => {
  updateTemperatureLayer(currentDay);
  setStatus("日別平年値と道路を表示中。細い一般道路は拡大すると現れます", "ready");
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
});

map.on("click", (event) => {
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

document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLButtonElement) {
    return;
  }
  if (event.key === "ArrowLeft") {
    stepDay(-1);
  } else if (event.key === "ArrowRight") {
    stepDay(1);
  } else if (event.key === " ") {
    event.preventDefault();
    animationFrame ? pausePlayback() : startPlayback();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pausePlayback();
  }
});

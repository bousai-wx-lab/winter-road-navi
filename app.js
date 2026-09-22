import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { JAPAN_VIEW, classifyRoad, createMapStyle } from "./road-style.js";

maplibregl.setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);

const status = document.querySelector("#mapStatus");
const mapElement = document.querySelector("#map");
const details = document.querySelector("#roadDetails");
const roadType = document.querySelector("#roadType");
const roadNote = document.querySelector("#roadNote");
const interactiveLayers = ["highway", "general-road"];

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
  setStatus("道路を表示中。細い一般道路は地図を拡大すると現れます", "ready");
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

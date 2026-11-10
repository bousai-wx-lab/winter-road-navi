import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { JAPAN_VIEW, classifyRoad, createMapStyle } from "./road-style.js?v=20261110-coast-only1";
import { initTemperature, TEMPERATURE_MODES } from "./temperature-control.js?v=20261110-outline1";
import { createRoadTemperature } from "./road-temperature.js?v=20261023-zoomcolor1";
import { initSnow } from "./snow-control.js?v=20261110-outline1";
import { initLiveTemperature } from "./live-temperature-control.js?v=20261110-daily-diff1";
import { initWeather } from "./weather-control.js?v=20261110-outline1";
import { initLiveSnow } from "./live-snow-control.js?v=20261109-panel1";
import { initForecastRisk } from "./forecast-risk-control.js?v=20261109-panel2";
import { RISK_RULES } from "./forecast-risk-data.js?v=20261109-panel2";
import { initForecastTimeline } from "./forecast-timeline.js?v=20261005-timeline1";
import { timeLabel } from "./live-temperature-data.js";
import { lookupCell, binLabel } from "./temperature-layer.js";
import { startMap, showMapState } from "./map-recovery.js?v=20261024-recovery1";

maplibregl.setWorkerUrl(new URL("./vendor/maplibre-gl-worker.mjs", import.meta.url).href);
document.getElementById("mapRetry").addEventListener("click", () => window.location.reload());

async function startApplication() {
const status = document.querySelector("#mapStatus");
const mapElement = document.querySelector("#map");
const details = document.querySelector("#roadDetails");
const roadType = document.querySelector("#roadType");
const roadNote = document.querySelector("#roadNote");
const interactiveLayers = ["highway", "general-road"];
let roadTemperature = null;
let normalTemperature = null, liveTemperature = null, displayMode = "normal";
let weather = null, liveSnow = null, risk = null, roadPalette = "temperature", displayView = "temperature";
let forecastTimeline = null;
const selectedViews = {observed:"temperature",forecast:"risk"};
const isDistributionView = view => ["weather","precipitation","snowfall"].includes(view);
let snow = null;
let temperatureGrid = null, temperatureBins = null, tooltipDay = null, hovered = null;
let tooltipMode = "tmin";
let tooltipTemperatureState = "loading";
const tooltip = document.querySelector("#meshTooltip");
const tooltipToggle = document.querySelector("#meshTooltipToggle");
function refreshTiming() {
  const isRisk = displayMode === "forecast" && displayView === "risk";
  const distribution = isDistributionView(displayView) || isRisk;
  const issued = displayMode !== "forecast" ? null : distribution ? weather?.current()?.base : liveTemperature?.timing()?.issued;
  const observed = displayMode === "normal" ? null : isRisk || displayView === "snow" ? liveSnow?.observationTime() : displayMode === "observed" ? distribution ? weather?.current()?.end : liveTemperature?.timing()?.observed : null;
  document.querySelector("#dataTiming").hidden = !issued && !observed;
  document.querySelector("#issueTimeRow").hidden = !issued;
  document.querySelector("#observationTimeRow").hidden = !observed;
  document.querySelector("#issueTime").textContent = issued ? timeLabel(issued) : "";
  document.querySelector("#observationTimeLabel").textContent = isRisk ? "積雪の基準実況" : "実況の対象";
  document.querySelector("#observationTime").textContent = observed ? /^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed.replaceAll("-", "/") : timeLabel(observed) : "";
}
function refreshTooltip() {
  refreshTiming();
  if (!tooltipToggle.checked || !hovered) { tooltip.hidden = true; return; }
  const index = temperatureGrid ? lookupCell(temperatureGrid, hovered.lng, hovered.lat) : -1;
  const temperature = tooltipTemperatureState === "error" ? "気温を表示できません"
    : !tooltipDay || !temperatureBins ? "気温を準備中"
    : index < 0 ? "格子未収録" : temperatureBins[index] === 0 ? "欠測" : binLabel(temperatureBins[index]);
  const live = displayMode !== "normal";
  const view = live ? displayView : "temperature";
  const liveValue = liveTemperature?.tooltipAt(hovered.lng, hovered.lat);
  const snowValue = snow?.tooltipAt(hovered.lng, hovered.lat) ?? { label: "積雪を準備中" };
  document.querySelector("#meshTooltipDate").textContent = view==="risk" || isDistributionView(view) ? weather.label() : view === "snow" ? liveSnow.label() : live ? liveTemperature.label() : tooltipDay ? `${tooltipDay.replace("-", "月")}日` : "表示日を準備中";
  document.querySelector("#meshTooltipTemperature").textContent = view==="risk" ? `道路：${risk.tooltipAt(hovered.lng,hovered.lat)}` : isDistributionView(view) ? `${weather.title()}：地図の色と凡例を参照` : view === "snow" ? `積雪深：${liveSnow.tooltipAt(hovered.lng,hovered.lat)}` : live ? `${liveTemperature.title()}：${liveValue.label}` : `${TEMPERATURE_MODES[tooltipMode].label}：${temperature}`;
  document.querySelector("#meshTooltipSnow").textContent = view==="risk" ? `積雪予測：${liveSnow.tooltipAt(hovered.lng,hovered.lat)}` : view !== "temperature" ? "" : live ? "" : `日最深積雪：${snowValue.label}`;
  tooltip.dataset.day = tooltipDay || "";
  tooltip.dataset.temperature = view === "temperature" ? live ? liveValue.label : temperature : "";
  tooltip.dataset.temperatureMode = live ? displayMode : tooltipMode;
  tooltip.dataset.snow = live ? "平年値モードのみ" : snowValue.label;

  tooltip.hidden = false;
  const width = tooltip.offsetWidth, height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(8, Math.min(hovered.x + 14, mapElement.clientWidth - width - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(hovered.y + 16, mapElement.clientHeight - height - 8))}px`;
}
const roadTemperatureStatus = document.querySelector("#roadTemperatureStatus");
function setRoadTemperatureState(state) {
  if(state === "off") { roadTemperatureStatus.dataset.state="off"; roadTemperatureStatus.textContent=""; return; }
  // The road section's riskStatus owns forecast loading and error messages.
  if(displayMode==="forecast" && displayView==="risk" && state!=="error") {
    roadTemperatureStatus.dataset.state="off";
    roadTemperatureStatus.textContent="";
    return;
  }
  if(displayMode !== "normal" && displayView !== "temperature" && state!=="error") {
    roadTemperatureStatus.dataset.state = "off";
    roadTemperatureStatus.textContent = "気温以外の表示中は道路を従来色で表示しています";
    return;
  }
  roadTemperatureStatus.dataset.state = state;
  roadTemperatureStatus.textContent = state === "ready" ? displayMode !== "normal" ? "選択時刻の約5km気温で路線を着色しています" : "選択日の格子気温で路線を着色しています"
    : state === "loading" ? "道路の着色を準備中（未準備の区間は従来色）"
    : "道路の気温着色を表示できません。従来色の道路を表示します";
}

if (window.matchMedia("(max-width: 760px)").matches) {
  const panel = document.querySelector(".control-panel");
  const toggle = document.querySelector("#panelToggle");
  panel.classList.add("is-collapsed");
  toggle.setAttribute("aria-expanded", "false");
  toggle.textContent = "設定を開く";
}

const started = await startMap(() => new maplibregl.Map({
  container: "map",
  style: createMapStyle(),
  bounds: JAPAN_VIEW.bounds,
  fitBoundsOptions: { padding: JAPAN_VIEW.padding },
  minZoom: 2.5,
  maxZoom: 17.5,
  renderWorldCopies: false,
  attributionControl: true,
  cooperativeGestures: false,
  antialias: false,
  refreshExpiredTiles: false,
  validateStyle: true,
}), {onState: showMapState});
if (!started) return;
const {map, recovery} = started;

// Fit the default extent to the available map area, including after the
// forecast bar opens. A user's pan/zoom keeps their chosen view on resize.
let usingDefaultView = true;
map.on("movestart", event => { if (event.originalEvent) usingDefaultView = false; });
function showJapan(duration = 0) {
  map.fitBounds(JAPAN_VIEW.bounds, { padding: JAPAN_VIEW.padding, duration });
}
map.on("resize", () => { if (usingDefaultView) showJapan(); });

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
  event.currentTarget.textContent = expanded ? "設定を開く" : "設定を閉じる";
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

document.querySelector("#snowRoadOrder").addEventListener("change", event => {
  liveSnow?.setAboveRoads(event.target.value === "snow");
});

tooltipToggle.addEventListener("change", () => {
  snow?.setTooltipEnabled(tooltipToggle.checked);
  refreshTooltip();
});

document.querySelector("#resetView").addEventListener("click", () => {
  usingDefaultView = true;
  showJapan(450);
});

document.querySelector("#closeDetails").addEventListener("click", () => {
  details.hidden = true;
});

function useGrid(grid,palette="temperature") {
  if (temperatureGrid === grid && roadTemperature && roadPalette===palette) return;
  roadPalette=palette;
  temperatureGrid = grid;
  try {
    roadTemperature?.destroy();
    roadTemperature = createRoadTemperature(map, grid, setRoadTemperatureState,palette==="risk"?{colors:RISK_RULES.map(r=>r.color)}:{});
    roadTemperature.setHighwayVisible(document.querySelector("#highwayToggle").checked);
    roadTemperature.setGeneralVisible(document.querySelector("#generalToggle").checked);
    liveSnow?.setAboveRoads(document.querySelector("#snowRoadOrder").value === "snow");
  } catch { roadTemperature = null; setRoadTemperatureState("error"); }
}
function applyDisplay() {
  const mode = displayMode, live = mode !== "normal", label = mode === "observed" ? "実況" : "予測";
  const riskView=mode==="forecast" && displayView==="risk";
  const temperature = !live || displayView === "temperature", distribution = live && (isDistributionView(displayView) || riskView);
  const viewName = {risk:"天気・積雪・道路",weather:"天気",snow:"積雪深",precipitation:"降水量",snowfall:"降雪量",temperature:"気温"}[displayView];
  roadTemperature?.clear(); temperatureBins = null; tooltipDay = null;
  document.querySelector("#normalControls").hidden = mode !== "normal";
  document.querySelector("#liveViewControls").hidden = !live;
  document.querySelector("#liveControls").hidden = !live || !temperature;
  document.querySelector("#weatherControls").hidden = !distribution;
  document.querySelector("#riskControls").hidden = !riskView;
  const snowControls=document.querySelector("#liveSnowControls");
  document.querySelector("#snowRoadOrderControl").hidden = !(riskView || mode === "observed" && displayView === "snow");
  snowControls.hidden = !riskView && (mode !== "observed" || displayView !== "snow");
  document.querySelector("#liveSnowTitle").textContent=riskView?"積雪深の予測":"実況積雪深";
  document.querySelector("#liveSnowTimeSelection").hidden=riskView;
  document.querySelector("#liveSnowModeNote").hidden=!riskView;
  const appearance = document.querySelector(".temperature-options");
  document.querySelector(live ? "#liveAppearance" : "#normalAppearance").append(appearance);
  appearance.hidden = !temperature;
  document.querySelector(".control-panel").dataset.mode = mode;
  for (const help of document.querySelectorAll("[data-help]")) {
    help.hidden = !({normal:!live,temperature:live && temperature,weather:distribution,risk:riskView,snow:riskView || mode === "observed" && displayView === "snow"}[help.dataset.help]);
  }
  document.querySelector(".road-section .road-temperature-legend").hidden = !temperature;
  for(const small of document.querySelectorAll(".road-section small"))small.hidden = !temperature;
  document.querySelector(".snow-section").hidden = mode !== "normal";
  document.querySelector("#normalMode").setAttribute("aria-pressed", String(mode === "normal"));
  document.querySelector("#liveMode").setAttribute("aria-pressed", String(mode === "observed"));
  document.querySelector("#forecastMode").setAttribute("aria-pressed", String(mode === "forecast"));
  document.querySelector("#panelHeading").textContent = "地図の表示";
  document.querySelector(".road-temperature-note").textContent = riskView?"道路の色は約5kmの予測気象から作る独自区分です。路面状態・凍結・通行可否の判定ではありません。":!temperature ? "道路の色は道路区分です。気象情報による通行可否は判定しません。" : live
    ? "線の色は約5km数値メッシュの気温区分です。路面凍結の判定ではありません。"
    : "線の色は1km格子の気温区分です。路面凍結の判定ではありません。";
  document.querySelector("#map").dataset.displayMode = mode;
  document.querySelector("#map").dataset.displayView = live ? displayView : "temperature";
  document.querySelector("#dataMeaning").textContent = !live ? "気温・積雪とも平年の推定分布です。予報・実況・路面状態ではありません。" : displayView === "snow" ? "白縁の丸は積雪深の観測点です。点のない場所の積雪深は推定しません。道路上の積雪ではありません。" : displayView === "precipitation" ? "予測降水量は約5kmメッシュ内の平均3時間降水量（mm）です。" : displayView === "snowfall" ? "予測降雪量は約5kmメッシュ内の平均3時間降雪量（cm）です。積雪深ではありません。" : displayView === "weather" ? mode === "observed" ? "実況天気は気象庁の推計気象分布です。各地点の実測値ではありません。" : "予測天気は気象庁の3時間の代表的な天気です。" : `${label}の格子気温です。路面温度・凍結・通行可否を示しません。`;
  if(riskView)document.querySelector("#dataMeaning").textContent="色付きの線は道路の独自リスク区分、背景は予測天気です。白縁の丸は最新実況に選択時刻までの予想降雪を足した簡易目安です。融雪・沈降は計算しません。";
  document.querySelector(".road-section .road-temperature-legend").setAttribute("aria-label", live ? `道路の${label}気温の色分け` : "道路の平年気温の色分け");
  document.querySelector("#map-heading").textContent = live ? `${label}${viewName}と全国の道路地図` : "全国の1km気温・積雪平年メッシュと道路地図";
  snow?.setActive(mode === "normal");
  if (live) liveTemperature.setMode(mode);
  liveTemperature.setActive(live && temperature);
  risk.setActive(riskView);
  weather.setActive(distribution,live ? mode : undefined,distribution && !riskView ? displayView : "weather");
  liveSnow.setActive(riskView || mode === "observed" && displayView === "snow",riskView);
  normalTemperature.setActive(mode === "normal");
  if (live) document.querySelector("#map").setAttribute("aria-label", `${label}${viewName}と道路を表示する地図`);
  if(!temperature && !riskView)setRoadTemperatureState("off");
  forecastTimeline?.setVisible(mode === "forecast");
  refreshTooltip();
}
function switchDisplayMode(mode) {
  if(!normalTemperature || !liveTemperature || mode === displayMode)return;
  if(displayMode !== "normal")selectedViews[displayMode]=displayView;
  displayMode=mode;
  if(mode !== "normal") {
    displayView=selectedViews[mode];
    const options=mode === "observed" ? [["temperature","気温"],["weather","天気"],["snow","積雪深"]] : [["risk","天気・積雪・道路"],["temperature","気温"],["weather","天気"],["precipitation","3時間降水量"],["snowfall","3時間降雪量"]];
    document.querySelector("#liveView").replaceChildren(...options.map(([value,label])=>new Option(label,value)));
    document.querySelector("#liveView").value=displayView;
  }
  applyDisplay();
}
document.querySelector("#liveView").addEventListener("change",event=>{
  if(displayMode === "normal" || !["temperature","weather",...(displayMode === "observed" ? ["snow"] : ["risk","precipitation","snowfall"])].includes(event.target.value))return;
  displayView=event.target.value;selectedViews[displayMode]=displayView;applyDisplay();
});
document.querySelector("#normalMode").addEventListener("click", () => switchDisplayMode("normal"));
document.querySelector("#liveMode").addEventListener("click", () => switchDisplayMode("observed"));
document.querySelector("#forecastMode").addEventListener("click", () => switchDisplayMode("forecast"));
function initializeControllers() {
  setStatus("道路を表示中。細い一般道路は地図を拡大すると現れます", "ready");
  forecastTimeline = initForecastTimeline(map,()=>displayMode === "forecast" ? displayView==="risk" || isDistributionView(displayView) ? weather : liveTemperature : null);
  risk=initForecastRisk({
    onData(data,target){if(displayMode!=="forecast" || displayView!=="risk")return;useGrid(data.grid,"risk");roadTemperature?.setClasses(data.classes,new Date(Date.parse(target.end)+9*3600000).toISOString().slice(5,10));refreshTooltip();},
    onUnavailable(state){if(displayMode!=="forecast" || displayView!=="risk")return;roadTemperature?.clear();setRoadTemperatureState(state);},
    onChange:refreshTooltip,
  });
  liveSnow = initLiveSnow(map,{onChange:refreshTooltip});
  weather = initWeather(map,{onChange(){if(displayMode==="forecast" && displayView==="risk"){risk.setTarget(weather?.current());liveSnow?.setForecastTarget(weather?.current());}refreshTooltip();forecastTimeline.render();}});
  liveTemperature = initLiveTemperature(map, {
    onChange(){refreshTooltip();forecastTimeline.render();},
    onData(shown) {
      if (displayMode === "normal" || displayView !== "temperature") return;
      useGrid(shown.data.grid); tooltipDay = shown.day; tooltipTemperatureState = "ready";
      try { roadTemperature?.setClasses(shown.data.classes, shown.day); }
      catch { roadTemperature?.clear(); setRoadTemperatureState("error"); }
      refreshTooltip();
    },
    onUnavailable(state) {
      if (displayMode === "normal" || displayView !== "temperature") return;
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
  document.querySelector("#forecastMode").disabled = false;
}
initializeControllers();
recovery.onRestored(() => applyDisplay());

map.on("idle", () => {
  const visibleRoads = map.queryRenderedFeatures({ layers: interactiveLayers });
  const highwayCount = visibleRoads.filter((feature) => feature.layer.id === "highway").length;
  const generalCount = visibleRoads.filter((feature) => feature.layer.id === "general-road").length;
  mapElement.dataset.highwayFeatures = String(highwayCount);
  mapElement.dataset.generalRoadFeatures = String(generalCount);
});

map.on("error", (event) => {
  if (mapElement.dataset.recoveryState !== "ready") return;
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

}
void startApplication().catch(() => showMapState("error", "地図の初期化を完了できませんでした。「地図を再試行」で読み直せます。"));

import { initDrive } from "./drive-control.js?v=20261118-drive-roundtrip1";
import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { JAPAN_VIEW, classifyRoad, createMapStyle } from "./road-style.js?v=20261110-coast-only1";
import { initTemperature, TEMPERATURE_MODES } from "./temperature-control.js?v=20261110-drive4";
import { createRoadTemperature } from "./road-temperature.js?v=20261023-zoomcolor1";
import { initSnow } from "./snow-control.js?v=20261118-observed-snow2";
import { initLiveTemperature } from "./live-temperature-control.js?v=20261119-dawn1";
import { initWeather } from "./weather-control.js?v=20261119-dawn1";
import { initLiveSnow } from "./live-snow-control.js?v=20261118-observed-snow2";
import { initSnowAnalysis } from "./snow-analysis-control.js?v=20261118-observed-snow2";
import { initObservedRoadRisk, OBSERVED_ROAD_RULES } from "./observed-road-risk.js?v=20261118-observed-snow2";
import { initForecastRisk } from "./forecast-risk-control.js?v=20261110-risk-colors1";
import { ROAD_RISK_COLORS, NORMAL_ROAD_RULES, createNormalRoadRisk } from "./road-risk-data.js?v=20261110-risk-colors1";
import { RISK_RULES } from "./forecast-risk-data.js?v=20261110-risk-colors1";
import { initForecastPoint } from "./forecast-point-control.js?v=20261118-drive-profile1";
import { initForecastTimeline } from "./forecast-timeline.js?v=20261118-point-time1";
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
let forecastTimeline = null, forecastPoint = null, drive = null;
let driveSample = null, driveBackground = null, driveBackgroundTimer = null;
const temperatureAppearance = Object.fromEntries(["normal","observed","forecast"].map(mode => [mode,{checked:true,opacity:"65"}]));
function saveTemperatureAppearance(mode) {
  if(mode === "drive")return;
  temperatureAppearance[mode] = {checked:document.querySelector("#temperatureToggle").checked,opacity:document.querySelector("#temperatureOpacity").value};
}
function restoreTemperatureAppearance(mode) {
  const {checked,opacity}=temperatureAppearance[mode];
  document.querySelector("#temperatureToggle").checked=checked;
  document.querySelector("#temperatureOpacity").value=opacity;
  document.querySelector("#opacityValue").textContent=`${opacity}%`;
}
function showing(mode,view) {
  const current=displayMode === "drive" ? driveBackground : {mode:displayMode,view:displayView};
  return current?.mode === mode && (!view || current.view === view);
}
function refreshDriveBackgroundStatus() {
  if(displayMode!=="drive")return;
  const output=document.querySelector("#driveBackgroundStatus");
  if(!document.querySelector("#driveBackgroundToggle").checked)output.textContent="地図の重ね表示はOFFです。";
  else if(!driveSample)output.textContent="解析後に重ねて表示できます。";
  else if(!driveBackground)output.textContent="この通過時刻は資料を確認できず、背景を表示できません。";
  else {
    const time=timeLabel(new Date(driveSample.time).toISOString());
    const normal=driveBackground.mode==="normal", temperature=driveBackground.view==="temperature";
    const source=normal ? "平年値" : "予測値";
    const state=document.querySelector(normal ? "#temperatureStatus" : temperature ? "#liveStatus" : "#weatherStatus");
    const target=normal ? `${new Date(driveSample.time+9*3600000).toISOString().slice(5,10).replace("-","月")}日` : temperature ? liveTemperature?.label() : weather?.label();
    output.textContent=`通過 ${time} → 背景：${source} · ${target || "準備中"}${state?.dataset.state==="error" || state?.dataset.state==="unavailable" ? " · 資料を表示できません" : state?.dataset.state==="loading" ? " · 読込中" : ""}`;
  }
}
function stopDriveBackground() {
  driveBackground=null;
  delete mapElement.dataset.driveBackgroundMode;delete mapElement.dataset.driveBackgroundTime;
  normalTemperature?.setActive(false);normalTemperature?.setFollowDay(null);
  liveTemperature?.setActive(false);liveTemperature?.setFollowTime(null);
  weather?.setActive(false);weather?.setFollowTime(null);
  snow?.setActive(false);risk?.setActive(false);liveSnow?.setActive(false);
  normalRisk?.clear();normalRoadData=null;roadTemperature?.clear();
}
function syncDriveBackground() {
  clearTimeout(driveBackgroundTimer);
  if(displayMode!=="drive")return;
  const mode=driveSample?.source, enabled=document.querySelector("#driveBackgroundToggle").checked;
  if(!enabled || !["forecast","normal"].includes(mode)) {
    if(driveBackground)stopDriveBackground();
    document.querySelector("#mapTemperatureLabel").textContent="ドライブ · A 始点 → B 終点";
    refreshDriveBackgroundStatus();return;
  }
  const view=mode==="normal" ? "temperature" : selectedViews.forecast;
  const changed=driveBackground?.mode!==mode || driveBackground?.view!==view;
  if(changed) {
    stopDriveBackground();driveBackground={mode,view};restoreTemperatureAppearance(mode);
  }
  mapElement.dataset.driveBackgroundMode=mode;
  mapElement.dataset.driveBackgroundTime=new Date(driveSample.time).toISOString();
  if(mode==="normal") {
    normalTemperature.setFollowDay(new Date(driveSample.time+9*3600000).toISOString().slice(5,10));
    if(changed){snow?.setActive(true);normalTemperature.setActive(true);}
  }else if(view==="temperature") {
    if(changed)liveTemperature.setMode("forecast");
    liveTemperature.setFollowTime(driveSample.time);
    if(changed)liveTemperature.setActive(true);
  }else {
    weather.setFollowTime(driveSample.time);
    if(changed) {
      const riskView=view==="risk";
      risk.setActive(riskView);liveSnow.setActive(riskView,riskView);
      weather.setActive(true,"forecast",riskView ? "weather" : view);
    }
  }
  drive?.bringToFront();refreshDriveBackgroundStatus();
}
const selectedViews = {observed:"temperature",forecast:"risk"};
const forecastRiskViewLabel = "天気・実況積雪・道路リスク";
const isDistributionView = view => ["weather","precipitation","snowfall","snowdepth"].includes(view);
let snow = null, normalRisk = null, normalRoadData = null;
let observedRisk = null, snowAnalysis = null;
const snowFormat = document.querySelector("#observedSnowFormat");
const observedSnowView = () => displayMode === "observed" && ["snow","observedRisk"].includes(displayView);
const showingAnalysisSnow = () => observedSnowView() && snowFormat.value === "surface";
function fillRoadLegend(id,rules) {
  document.querySelector(id).replaceChildren(...rules.slice(2).map((label, i) => {
    const item = document.createElement("span"), color = document.createElement("i");
    color.style.backgroundColor = ROAD_RISK_COLORS[i + 2];
    item.dataset.riskClass = String(i + 2);
    item.append(color, document.createTextNode(label));
    return item;
  }));
}
fillRoadLegend("#normalRoadLegend",NORMAL_ROAD_RULES);
fillRoadLegend("#observedRiskLegend",OBSERVED_ROAD_RULES);
document.querySelector("#normalRoadRetry").addEventListener("click", () => void normalRisk?.retry());
let temperatureGrid = null, temperatureBins = null, tooltipDay = null, hovered = null;
let tooltipMode = "tmin";
let tooltipTemperatureState = "loading";
const tooltip = document.querySelector("#meshTooltip");
const tooltipToggle = document.querySelector("#meshTooltipToggle");
function refreshTiming() {
  const isRisk = displayMode === "forecast" && displayView === "risk";
  const distribution = isDistributionView(displayView) || isRisk || displayView === "observedRisk";
  const issued = displayMode !== "forecast" ? null : distribution ? weather?.current()?.base : liveTemperature?.timing()?.issued;
  const observed = displayMode === "normal" ? null : isRisk || displayView === "snow"
    ? (showingAnalysisSnow() ? snowAnalysis?.current()?.time : liveSnow?.observationTime())
    : displayMode === "observed" ? distribution ? weather?.current()?.end : liveTemperature?.timing()?.observed : null;
  document.querySelector("#dataTiming").hidden = !issued && !observed;
  document.querySelector("#issueTimeRow").hidden = !issued;
  document.querySelector("#observationTimeRow").hidden = !observed;
  document.querySelector("#issueTime").textContent = issued ? timeLabel(issued) : "";
  document.querySelector("#issueTimeRow span").textContent = displayView === "snowdepth" ? "予報の基準時刻" : "気象庁発表";
  document.querySelector("#observationTimeLabel").textContent = isRisk ? "積雪の観測時刻" : displayView === "observedRisk" ? "推計天気の時刻" : "実況の対象";
  document.querySelector("#observationTime").textContent = observed ? /^\d{4}-\d{2}-\d{2}$/.test(observed) ? observed.replaceAll("-", "/") : timeLabel(observed) : "";
}
function refreshTooltip() {
  if(displayMode === "drive") { tooltip.hidden = true; document.querySelector("#dataTiming").hidden = true; refreshDriveBackgroundStatus(); return; }
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
  document.querySelector("#meshTooltipSnow").textContent = view==="risk" ? `実況積雪深：${liveSnow.tooltipAt(hovered.lng,hovered.lat)}` : view !== "temperature" ? "" : live ? "" : `日最深積雪：${snowValue.label} · 道路：${index < 0 ? "対象範囲外" : normalRoadData ? NORMAL_ROAD_RULES[normalRoadData.classes[index]] : "準備中・取得不能"}`;
  tooltip.dataset.day = tooltipDay || "";
  if (view === "observedRisk") {
    document.querySelector("#meshTooltipDate").textContent = weather.label();
    document.querySelector("#meshTooltipTemperature").textContent = `道路リスク：${observedRisk.tooltipAt(hovered.lng,hovered.lat)}`;
    document.querySelector("#meshTooltipSnow").textContent = showingAnalysisSnow()
      ? "解析積雪深：気象庁の凡例を参照" : `実況積雪深：${liveSnow.tooltipAt(hovered.lng,hovered.lat)}`;
  } else if (view === "snow" && showingAnalysisSnow()) {
    const analysis = snowAnalysis.current();
    document.querySelector("#meshTooltipDate").textContent = analysis ? timeLabel(analysis.time) : "解析積雪深を準備中";
    document.querySelector("#meshTooltipTemperature").textContent = "解析積雪深：気象庁の凡例を参照";
  }
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
  roadTemperatureStatus.textContent = state === "ready" ? displayMode !== "normal" ? "選択時刻の約5km気温で路線を着色しています" : "選択日の気温・積雪平年値で、より悪い条件の色を道路に表示しています"
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
map.on("resize", () => { if (usingDefaultView && displayMode !== "drive") showJapan(); });

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
    roadTemperature = createRoadTemperature(map, grid, setRoadTemperatureState,palette==="risk" || palette==="normal-risk"?{colors:ROAD_RISK_COLORS}:{});
    roadTemperature.setHighwayVisible(document.querySelector("#highwayToggle").checked);
    roadTemperature.setGeneralVisible(document.querySelector("#generalToggle").checked);
    liveSnow?.setAboveRoads(document.querySelector("#snowRoadOrder").value === "snow");
    drive?.bringToFront();
  } catch { roadTemperature = null; setRoadTemperatureState("error"); }
}
function applyDisplay() {
  const driving = displayMode === "drive";
  document.querySelector(".control-panel").dataset.mode = displayMode;
  document.querySelector(".tool-layout").dataset.mode = displayMode;
  document.querySelector("#driveMode").setAttribute("aria-pressed", String(driving));
  clearTimeout(driveBackgroundTimer);
  if(driveBackground)stopDriveBackground();
  if(driving) {
    observedRisk?.setActive(false); snowAnalysis?.setActive(false);
    delete mapElement.dataset.observedRiskCounts;
    normalRisk?.clear(); normalRoadData = null; roadTemperature?.clear();
    normalTemperature.setActive(false); liveTemperature.setActive(false); snow?.setActive(false);
    weather.setActive(false); risk.setActive(false); liveSnow.setActive(false); forecastTimeline?.setVisible(false);
    for(const id of ["normalMode","liveMode","forecastMode"])document.getElementById(id).setAttribute("aria-pressed","false");
    document.querySelector("#panelHeading").textContent="ドライブのそなえ";
    document.querySelector("#mapTemperatureLabel").textContent="ドライブ · A 始点 → B 終点";
    document.querySelector("#map").dataset.displayMode="drive";
    document.querySelector("#map-heading").textContent="ドライブの経路と通過時刻の気象";
    document.querySelector("#map").setAttribute("aria-label","ドライブの始点と終点を選ぶ地図");
    document.querySelector("#dataMeaning").textContent="通過予定時刻の予測、期間外は平年値を使う気象の目安です。所要時間は渋滞・積雪による遅れを含みません。";
    for (const help of document.querySelectorAll("[data-help]")) help.hidden = help.dataset.help !== "drive";
    document.querySelector(".road-temperature-note").textContent = "気象条件による参考色です。実際の路面状態・通行可否は判定しません。";
    drive?.setActive(true);
    details.hidden=true; syncDriveBackground(); refreshTooltip(); return;
  }

  drive?.setActive(false);
  const mode = displayMode, live = mode !== "normal", label = mode === "observed" ? "実況" : "予測";
  const riskView=mode==="forecast" && displayView==="risk";
  const observedRiskView=mode==="observed" && displayView==="observedRisk";
  const analysisSurface=showingAnalysisSnow();
  const temperature = !live || displayView === "temperature", distribution = live && (isDistributionView(displayView) || riskView || observedRiskView);
  const viewName = {risk:forecastRiskViewLabel,observedRisk:forecastRiskViewLabel,weather:"天気",snow:"積雪深",precipitation:"降水量",snowfall:"降雪量",snowdepth:"積雪深",temperature:"気温"}[displayView];
  normalRisk?.clear(); normalRoadData = null;
  delete mapElement.dataset.normalRiskDay; delete mapElement.dataset.normalRiskCounts;
  document.querySelector("#normalRoadRetry").hidden = true;
  roadTemperature?.clear(); temperatureBins = null; tooltipDay = null;
  document.querySelector("#normalControls").hidden = mode !== "normal";
  document.querySelector("#liveViewControls").hidden = !live;
  document.querySelector("#forecastPointHint").hidden = mode !== "forecast";
  document.querySelector("#liveControls").hidden = !live || !temperature;
  document.querySelector("#weatherControls").hidden = !distribution;
  document.querySelector("#weatherControls .forecast-time-selection").hidden = observedRiskView;
  document.querySelector("#riskControls").hidden = !riskView;
  document.querySelector("#observedRiskControls").hidden = !observedRiskView;
  const snowControls=document.querySelector("#liveSnowControls");
  document.querySelector("#snowRoadOrderControl").hidden = !(riskView || observedSnowView() && !analysisSurface);
  snowControls.hidden = !riskView && (!observedSnowView() || analysisSurface);
  document.querySelector("#observedSnowFormatRow").hidden = !observedSnowView();
  document.querySelector("#snowAnalysisControls").hidden = !analysisSurface;
  document.querySelector("#snowAnalysisTimeRow").hidden = observedRiskView;
  document.querySelector("#liveSnowTimeSelection").hidden=riskView || observedRiskView;
  document.querySelector("#liveSnowModeNote").hidden=!riskView;
  const appearance = document.querySelector(".temperature-options");
  document.querySelector(live ? "#liveAppearance" : "#normalAppearance").append(appearance);
  appearance.hidden = !temperature;
  document.querySelector(".control-panel").dataset.mode = mode;
  for (const help of document.querySelectorAll("[data-help]")) {
    help.hidden = !({normal:!live,temperature:live && temperature,weather:distribution,forecastPoint:mode === "forecast",risk:riskView,observedRisk:observedRiskView,snow:riskView || observedSnowView(),liveSources:live,observedSources:mode === "observed",forecastSources:mode === "forecast",drive:false}[help.dataset.help]);
  }
  document.querySelector(".road-section .road-temperature-legend").hidden = !live || !temperature;
  document.querySelector("#normalRoadControls").hidden = live;
  for(const small of document.querySelectorAll(".road-section small"))small.hidden = !temperature;
  document.querySelector(".snow-section").hidden = mode !== "normal";
  document.querySelector("#normalMode").setAttribute("aria-pressed", String(mode === "normal"));
  document.querySelector("#liveMode").setAttribute("aria-pressed", String(mode === "observed"));
  document.querySelector("#forecastMode").setAttribute("aria-pressed", String(mode === "forecast"));
  document.querySelector("#panelHeading").textContent = "地図の表示";
  document.querySelector(".road-temperature-note").textContent = riskView?"道路の色は約5kmの予測気象から作る独自区分です。路面状態・凍結・通行可否の判定ではありません。":!temperature ? "道路の色は道路区分です。気象情報による通行可否は判定しません。" : live
    ? "線の色は約5km数値メッシュの気温区分です。路面凍結の判定ではありません。"
    : "線の色は1km格子の気温・積雪平年値による独自区分です。積雪面の表示と独立し、より悪い条件を優先します。現在の路面状態ではありません。";
  document.querySelector("#map").dataset.displayMode = mode;
  document.querySelector("#map").dataset.displayView = live ? displayView : "temperature";
  document.querySelector("#dataMeaning").textContent = !live ? "気温・積雪とも平年の推定分布です。予報・実況・路面状態ではありません。" : displayView === "snow" ? "白縁の丸は積雪深の観測点です。点のない場所の積雪深は推定しません。道路上の積雪ではありません。" : displayView === "precipitation" ? "予測降水量は約5kmメッシュ内の平均3時間降水量（mm）です。" : displayView === "snowfall" ? "予測降雪量は約5kmメッシュ内の平均3時間降雪量（cm）です。積雪深ではありません。" : displayView === "weather" ? mode === "observed" ? "実況天気は気象庁の推計気象分布です。各地点の実測値ではありません。" : "予測天気は気象庁の3時間の代表的な天気です。" : `${label}の格子気温です。路面温度・凍結・通行可否を示しません。`;
  if(riskView)document.querySelector("#dataMeaning").textContent="色付きの線は道路の独自リスク区分、背景は予測天気です。白縁の丸は最新の実況積雪深です。";
  if(mode === "forecast" && displayView === "snowdepth") document.querySelector("#dataMeaning").textContent="気象庁の約5km格子の予想積雪深です。予報の基準時刻から6時間先まで、1時間ごとの公式画像を表示します。";
  if (observedRiskView) {
    document.querySelector("#dataMeaning").textContent="背景は最新の推計天気、線は実況気温と前12時間降水・前3時間降雪による道路の参考色です。";
    document.querySelector(".road-temperature-note").textContent="実況による道路の参考色です。路面状態は道路管理者の情報で確認してください。";
  }
  if (analysisSurface && !observedRiskView) document.querySelector("#dataMeaning").textContent="面は気象庁が約5km格子で推定した解析積雪深です。";
  document.querySelector(".road-section .road-temperature-legend").setAttribute("aria-label", live ? `道路の${label}気温の色分け` : "道路の平年気温の色分け");
  document.querySelector("#map-heading").textContent = live ? `${label}${viewName}と全国の道路地図` : "全国の1km気温・積雪平年メッシュと道路地図";
  snow?.setActive(mode === "normal");
  if (live) liveTemperature.setMode(mode);
  liveTemperature.setActive(live && temperature);
  risk.setActive(riskView);
  observedRisk.setActive(observedRiskView);
  if (!observedRiskView) delete mapElement.dataset.observedRiskCounts;
  weather.setActive(distribution,live ? mode : undefined,distribution && !riskView && !observedRiskView ? displayView : "weather",observedRiskView);
  liveSnow.setDisplayPoints(!analysisSurface);
  liveSnow.setActive(riskView || observedRiskView || observedSnowView() && !analysisSurface,riskView || observedRiskView);
  snowAnalysis.setActive(analysisSurface,observedRiskView && analysisSurface);
  normalTemperature.setActive(mode === "normal");
  if (live) document.querySelector("#map").setAttribute("aria-label", `${label}${viewName}と道路を表示する地図`);
  if(!temperature && !riskView && !observedRiskView)setRoadTemperatureState("off");
  forecastTimeline?.setVisible(mode === "forecast");
  refreshTooltip();
}
function switchDisplayMode(mode) {
  if(!normalTemperature || !liveTemperature || mode === displayMode)return;
  if(["observed","forecast"].includes(displayMode))selectedViews[displayMode]=displayView;
  saveTemperatureAppearance(displayMode);
  if (displayMode === "forecast") forecastPoint?.dismiss();
  displayMode=mode;
  if(mode!=="drive")restoreTemperatureAppearance(mode);
  if(["observed","forecast"].includes(mode)) {
    displayView=selectedViews[mode];
    const options=mode === "observed" ? [["temperature","気温"],["weather","天気"],["snow","積雪深"],["observedRisk",forecastRiskViewLabel]] : [["risk",forecastRiskViewLabel],["temperature","気温"],["weather","天気"],["precipitation","3時間降水量"],["snowfall","3時間降雪量"],["snowdepth","積雪深（6時間先まで）"]];
    document.querySelector("#liveView").replaceChildren(...options.map(([value,label])=>new Option(label,value)));
    document.querySelector("#liveView").value=displayView;
  }
  applyDisplay();
}
document.querySelector("#liveView").addEventListener("change",event=>{
  if(displayMode === "normal" || !["temperature","weather",...(displayMode === "observed" ? ["snow","observedRisk"] : ["risk","precipitation","snowfall","snowdepth"])].includes(event.target.value))return;
  displayView=event.target.value;selectedViews[displayMode]=displayView;applyDisplay();
});
snowFormat.addEventListener("change",()=>{if (observedSnowView()) applyDisplay();});
document.querySelector("#normalMode").addEventListener("click", () => switchDisplayMode("normal"));
document.querySelector("#liveMode").addEventListener("click", () => switchDisplayMode("observed"));
document.querySelector("#forecastMode").addEventListener("click", () => switchDisplayMode("forecast"));
document.querySelector("#driveMode").addEventListener("click", () => switchDisplayMode("drive"));
function initializeControllers() {
  forecastPoint = initForecastPoint(map, maplibregl.Marker, end => forecastTimeline.chooseTime(end));
  drive=initDrive(map,{onSelection(sample){
    driveSample=sample;clearTimeout(driveBackgroundTimer);
    if(!sample)syncDriveBackground();
    else driveBackgroundTimer=setTimeout(syncDriveBackground,80);
  }});
  document.querySelector("#driveBackgroundToggle").addEventListener("change",syncDriveBackground);
  document.querySelector("#driveMode").disabled=false;
  setStatus("道路を表示中。細い一般道路は地図を拡大すると現れます", "ready");
  forecastTimeline = initForecastTimeline(
    map,
    () => displayMode === "forecast" ? (displayView === "risk" || isDistributionView(displayView) ? weather : liveTemperature) : null,
    forecastPoint.syncTime,
  );
  risk=initForecastRisk({
    onData(data,target){if(!showing("forecast","risk"))return;useGrid(data.grid,"risk");roadTemperature?.setClasses(data.classes,new Date(Date.parse(target.end)+9*3600000).toISOString().slice(5,10));refreshTooltip();},
    onUnavailable(state){if(!showing("forecast","risk"))return;roadTemperature?.clear();setRoadTemperatureState(state);},
    onChange:refreshTooltip,
  });
  observedRisk = initObservedRoadRisk({
    weatherSlot:()=>weather?.current(),
    onData(data) {
      if (!showing("observed","observedRisk")) return;
      useGrid(data.grid,"risk");
      roadTemperature?.setClasses(data.classes,new Date(data.snowTime+9*3600000).toISOString().slice(5,10));
      mapElement.dataset.observedRiskCounts = Array.from(data.classes.reduce((counts,value)=>{counts[value]++;return counts;},new Uint32Array(9))).join(",");
      refreshTooltip();
    },
    onState(state,message) {
      if (!showing("observed","observedRisk")) return;
      const status=document.querySelector("#observedRiskStatus");
      status.textContent=message || (state==="waiting" ? "正時の観測を準備中" : "直前の降水・降雪を照合中");
      status.dataset.state=state;
      document.querySelector("#observedRiskRetry").hidden=state!=="error";
      if (state!=="ready") { delete mapElement.dataset.observedRiskCounts; roadTemperature?.clear(); }
    },
  });
  document.querySelector("#observedRiskRetry").addEventListener("click",()=>observedRisk.retry());
  liveSnow = initLiveSnow(map,{onChange:refreshTooltip,onData:snapshot=>observedRisk.setSnow(snapshot)});
  weather = initWeather(map,{onChange(){if(showing("forecast","risk"))risk.setTarget(weather?.current());refreshTooltip();forecastTimeline.render();},onLayersReady(){drive?.bringToFront();if(showing("observed","observedRisk"))observedRisk.retry();}});
  snowAnalysis = initSnowAnalysis(map,refreshTooltip);
  liveTemperature = initLiveTemperature(map, {
    onChange(){refreshTooltip();forecastTimeline.render();},
    onData(shown) {
      if (!showing("forecast","temperature") && !showing("observed","temperature")) return;
      useGrid(shown.data.grid); tooltipDay = shown.day; tooltipTemperatureState = "ready";
      try { roadTemperature?.setClasses(shown.data.classes, shown.day); }
      catch { roadTemperature?.clear(); setRoadTemperatureState("error"); }
      refreshTooltip();
    },
    onUnavailable(state) {
      if (!showing("forecast","temperature") && !showing("observed","temperature")) return;
      roadTemperature?.clear(); setRoadTemperatureState(state); refreshTooltip();
    },
  });
  normalTemperature = initTemperature(map, {
    onChange:refreshTooltip,
    onGrid(grid) { if (showing("normal")) useGrid(grid,"normal-risk"); },
    onLayerReady(grid, manifest) {
      snow = initSnow(map, grid, manifest, refreshTooltip);
      normalRisk = createNormalRoadRisk(day => snow.roadBins(day), {
        onData(data) {
          if (!showing("normal")) return;
          normalRoadData = data;
          roadTemperature?.setClasses(data.classes, data.day);
          mapElement.dataset.normalRiskDay = data.day;
          mapElement.dataset.normalRiskCounts = Array.from(data.classes.reduce((counts, value) => { counts[value]++; return counts; }, new Uint32Array(ROAD_RISK_COLORS.length))).join(",");
          refreshTooltip();
        },
        onUnavailable(state) {
          if (!showing("normal")) return;
          normalRoadData = null; roadTemperature?.clear();
          delete mapElement.dataset.normalRiskDay; delete mapElement.dataset.normalRiskCounts;
          document.querySelector("#normalRoadRetry").hidden = state !== "error";
          roadTemperatureStatus.dataset.state = state;
          roadTemperatureStatus.textContent = state === "error"
            ? "気温・積雪を確認できず道路判定を表示できません。再読込できます。"
            : "同じ日付の気温・積雪から道路判定を準備しています";
          refreshTooltip();
        },
      });
      snow.setActive(showing("normal"));
      snow.setTooltipEnabled(tooltipToggle.checked);
    },
    onDay(classes, day, bins, mode) {
      if (!showing("normal")) return;
      temperatureBins = bins; tooltipDay = day; tooltipMode = mode;
      tooltipTemperatureState = "ready";
      void normalRisk?.setDay(classes, day);
      void snow?.setDay(day); refreshTooltip();
    },
    onUnavailable(state, mode) {
      if (!showing("normal")) return;
      normalRisk?.clear(); normalRoadData = null;
      delete mapElement.dataset.normalRiskDay; delete mapElement.dataset.normalRiskCounts;
      document.querySelector("#normalRoadRetry").hidden = true;
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
  if(displayMode === "drive") { map.getCanvas().style.cursor=drive?.isPicking()?"crosshair":"pointer"; return; }
  const features = map.queryRenderedFeatures(event.point, { layers: interactiveLayers });
  map.getCanvas().style.cursor = features.length ? "pointer" : "";
  hovered = { lng: event.lngLat.lng, lat: event.lngLat.lat, x: event.point.x, y: event.point.y };
  refreshTooltip();
});

map.on("mouseleave", () => { hovered = null; refreshTooltip(); });

map.on("click", (event) => {
  if(displayMode === "drive") return;
  if (displayMode === "forecast") {
    usingDefaultView = false;
    forecastPoint?.select(event.lngLat);
  }
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

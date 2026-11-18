import {utcTime,timeLabel,LIVE_POLL_MS} from "./live-temperature-data.js";
import {WEATHER_ROOT} from "./weather-data.js";
import {MAP_OUTLINE_LAYER} from "./road-style.js";

const root = WEATHER_ROOT+"snow/";
const $ = id => document.getElementById(id);

export function analysisSnowSlots(records) {
  if (!Array.isArray(records) || records.length > 96) throw new Error("解析積雪深の時刻一覧が不正です");
  const valid = records.filter(row => row.basetime === row.validtime && row.elements?.includes("snowd"))
    .map(row => ({key:row.validtime,time:utcTime(row.validtime)})).sort((a,b)=>a.key.localeCompare(b.key));
  if (!valid.length || new Set(valid.map(row=>row.key)).size !== valid.length) throw new Error("解析積雪深の時刻が重複・欠落しています");
  return valid;
}

export function initSnowAnalysis(map, onChange = () => {}) {
  const ids = new Map(), select = $("snowAnalysisSlot"), opacity = $("snowAnalysisOpacity");
  let active=false, latestOnly=false, chosen=null, current=null, request=null, timer=null;
  function status(message,state) {
    $("snowAnalysisStatus").textContent=message;
    $("snowAnalysisStatus").dataset.state=state;
    $("snowAnalysisRetry").hidden=state!=="error";
    onChange();
  }
  function clear() {
    for (const id of ids.keys()) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    ids.clear(); current=null; delete $("map").dataset.snowAnalysisTime;
  }
  function paint() {
    for (const id of ids.keys()) map.setPaintProperty(id,"raster-opacity",Number(opacity.value)/100);
    $("snowAnalysisOpacityValue").textContent=`${opacity.value}%`;
  }
  async function load() {
    request?.abort();
    if (!active) return;
    const controller = new AbortController(), {signal} = controller;
    request=controller;
    try {
      const response = await fetch(root+"targetTimes.json",{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
      if (!response.ok) throw new Error("解析積雪深の時刻を取得できません");
      const text = await response.text();
      if (text.length > 100000) throw new Error("解析積雪深の時刻一覧が不正です");
      const slots = analysisSnowSlots(JSON.parse(text));
      if (signal.aborted) return;
      const slot = (!latestOnly && slots.find(row=>row.key===chosen)) || slots.at(-1);
      select.replaceChildren(...slots.map(row=>new Option(timeLabel(row.time),row.key)));
      select.value=slot.key;
      if (slot.key===current?.key) return;
      clear();
      for (const z of [4,6,8,10]) {
        const id=`snow-analysis-${z}`;
        ids.set(id,z);
        map.addSource(id,{type:"raster",tiles:[`${root}${slot.key}/none/${slot.key}/surf/snowd/${z}/{x}/{y}.png`],
          tileSize:256,minzoom:z,maxzoom:z,bounds:[122,20,154,48],
          attribution:'<a href="https://www.jma.go.jp/bosai/snow/" target="_blank" rel="noopener noreferrer">気象庁・解析積雪深</a>'});
        map.addLayer({id,type:"raster",source:id,minzoom:z===4?0:z-1,...(z<10?{maxzoom:z+1}:{}),
          paint:{"raster-opacity":Number(opacity.value)/100,"raster-resampling":"nearest","raster-fade-duration":0}},MAP_OUTLINE_LAYER);
      }
      current=slot;
      $("map").dataset.snowAnalysisTime=slot.time;
      if (!latestOnly) $("mapTemperatureLabel").textContent=`${timeLabel(slot.time)} · 解析積雪深`;
      const age=Date.now()-Date.parse(slot.time);
      status(`${timeLabel(slot.time)} · 気象庁の解析積雪深（約5km）${age>2*3600000?" · 更新遅れ":""}`,"ready");
    } catch (error) {
      if (signal.aborted) return;
      clear();status("解析積雪深を取得できません。再試行できます。","error");
    }
  }
  select.addEventListener("change",()=>{chosen=select.value;void load();});
  opacity.addEventListener("input",paint);
  $("snowAnalysisRetry").addEventListener("click",()=>void load());
  document.addEventListener("visibilitychange",()=>{if (active && !document.hidden) void load();});
  map.on("error",event=>{
    if (active && ids.has(event.sourceId)) {
      request?.abort();clear();status("解析積雪深の画像を取得できません。再試行できます。","error");
    }
  });
  return {
    setActive(value,latest=value&&latestOnly) {
      if (active===value && latestOnly===latest) return;
      active=value;latestOnly=latest;
      request?.abort();clearInterval(timer);clear();
      select.disabled=latestOnly;
      if (!active) return;
      status("解析積雪深を読み込んでいます","loading");
      void load();
      timer=setInterval(()=>{if (!document.hidden) void load();},LIVE_POLL_MS);
    },
    current: () => current,
  };
}

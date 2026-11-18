import * as maplibregl from "./vendor/maplibre-gl.mjs";
import {AMEDAS_ROOT,LIVE_SNOW_BANDS,LIVE_SNOW_LABEL_ZOOM,snowHour,snowMapKey,decodeSnowStations,snowStationValue,snowStationLabel} from "./live-snow-data.js?v=20261109-marker1";
import {timeLabel} from "./live-temperature-data.js";

const $=id=>document.getElementById(id),EMPTY={type:"FeatureCollection",features:[]};
const POINT_SIZES={observed:{radius:[2.5,6,10],halo:[5.7,10.2,14.2],stroke:1.2},forecast:{radius:[2,3.5,6],halo:[4.5,6,8.5],stroke:1}};
const zoomSize=values=>["interpolate",["linear"],["zoom"],3,values[0],5,values[1],9,values[2]];
const MISSING_FILL="#eef2f5";
function missingHatch() {
  const canvas=document.createElement("canvas");
  canvas.width=canvas.height=48;
  const ctx=canvas.getContext("2d");
  ctx.beginPath();
  ctx.arc(24,24,18.8,0,Math.PI*2);
  ctx.clip();
  ctx.strokeStyle="#445c6e";
  ctx.lineWidth=3.2;
  ctx.beginPath();
  for(const offset of [-13,0,13]) {
    ctx.moveTo(offset,0);
    ctx.lineTo(48+offset,48);
  }
  ctx.stroke();
  return canvas;
}
export function initLiveSnow(map,hooks={}) {
  let active=false,overlay=false,observedSelection=null,token=0,abort=null,timer=null,stations=[],selected=null,latest=null,popup=null,selectedStation=null;
  const mapLabel=text=>{if(!overlay)$("mapTemperatureLabel").textContent=text;};
  map.addSource("live-snow-points",{type:"geojson",data:EMPTY});
  const hatch=missingHatch();
  map.addImage("live-snow-missing-hatch",hatch.getContext("2d").getImageData(0,0,hatch.width,hatch.height),{pixelRatio:2});
  const layers=["live-snow-point-halos","live-snow-points","live-snow-missing","live-snow-values"];
  // Default to roads in front; the user can move the whole marker group together.
  const beforeRoads="general-road-casing";
  map.addLayer({id:layers[0],type:"circle",source:"live-snow-points",layout:{visibility:"none"},paint:{"circle-radius":zoomSize(POINT_SIZES.observed.halo),"circle-color":"#ffffff"}},beforeRoads);
  const colors=["step",["get","value"],LIVE_SNOW_BANDS[0].color,...LIVE_SNOW_BANDS.slice(1).flatMap(band=>[band.min,band.color])];
  map.addLayer({id:layers[1],type:"circle",source:"live-snow-points",layout:{visibility:"none"},paint:{"circle-radius":zoomSize(POINT_SIZES.observed.radius),"circle-color":["case",["get","available"],colors,MISSING_FILL],"circle-stroke-color":"#213e53","circle-stroke-width":1.2}},beforeRoads);
  map.addLayer({id:layers[2],type:"symbol",source:"live-snow-points",filter:["!",["get","available"]],layout:{visibility:"none","icon-image":"live-snow-missing-hatch","icon-size":zoomSize(POINT_SIZES.observed.radius.map(r=>r/10)),"icon-allow-overlap":true,"icon-ignore-placement":true}},beforeRoads);
  map.addLayer({id:layers[3],type:"symbol",source:"live-snow-points",minzoom:LIVE_SNOW_LABEL_ZOOM,filter:["get","available"],layout:{visibility:"none","text-field":["to-string",["get","value"]],"text-font":["sans-serif"],"text-size":12,"text-anchor":"top","text-offset":[0,1.25],"text-padding":2},paint:{"text-color":"#143c54","text-halo-color":"#ffffff","text-halo-width":2}},beforeRoads);
  const legend=$("liveSnowPointLegend");
  for(const band of [{label:"資料なし",color:null},...LIVE_SNOW_BANDS]) {
    const item=document.createElement("span"),key=document.createElement("i"),label=document.createElement("span");
    key.className="live-snow-point-key"+(band.color?"":" missing");
    key.setAttribute("aria-hidden","true");
    key.style.backgroundColor=band.color ?? MISSING_FILL;
    if(!band.color)key.append(hatch);
    label.textContent=band.label;item.append(key,label);legend.append(item);
  }
  function renderPoints() {
    const features=stations.map(station=>({
      type:"Feature",
      properties:{id:station.id,available:station.value!==null,value:station.value ?? -1},
      geometry:{type:"Point",coordinates:[station.lng,station.lat]},
    }));
    map.getSource("live-snow-points").setData({type:"FeatureCollection",features});
    $("liveSnowStation").replaceChildren(new Option("地点を選択",""),...stations.map(station=>new Option(`${station.name} · ${snowStationValue(station)}`,station.id)));
    $("liveSnowStation").disabled=!stations.length;
    $("liveSnowStation").value=selectedStation ?? "";
  }
  function updateMetadata() {
    $("liveSnowUpdated").textContent=selected?`${timeLabel(selected)}時点の実況 · 気象庁アメダス等`:"";
  }
  function status(message,state) {$("liveSnowStatus").textContent=message;$("liveSnowStatus").dataset.state=state;$("liveSnowRefresh").hidden=state!=="error";hooks.onChange?.();}
  function paint() {
    const size=POINT_SIZES[overlay?"forecast":"observed"];
    map.setPaintProperty(layers[0],"circle-radius",zoomSize(size.halo));
    map.setPaintProperty(layers[1],"circle-radius",zoomSize(size.radius));
    map.setPaintProperty(layers[1],"circle-stroke-width",size.stroke);
    map.setLayoutProperty(layers[2],"icon-size",zoomSize(size.radius.map(r=>r/10)));
    for(const id of layers)map.setLayoutProperty(id,"visibility",active && $("liveSnowPoints").checked?"visible":"none");
    if(!active || !$("liveSnowPoints").checked)popup?.remove();
  }
  function clear() {
    stations=[];popup?.remove();popup=null;
    map.getSource("live-snow-points").setData(EMPTY);
    $("liveSnowStation").disabled=true;
    $("liveSnowSlot").disabled=true;
    $("liveSnowUpdated").textContent="";$("liveSnowNotice").textContent="";$("liveSnowNotice").hidden=true;
    for(const key of ["liveSnowTime","liveSnowValid","liveSnowMissing","liveSnowPoints"])delete $("map").dataset[key];
  }
  function reportStations() {
    const valid=stations.filter(s=>s.usable).length,reference=stations.filter(s=>s.value!==null && !s.usable).length,missing=stations.filter(s=>s.value===null).length;
    $("map").dataset.liveSnowValid=String(valid);$("map").dataset.liveSnowMissing=String(missing);$("map").dataset.liveSnowPoints=String(stations.length);
    status(`積雪観測点 ${stations.length}地点：有効 ${valid}・参考 ${reference}・資料なし ${missing}。丸は観測点の値です。`,"ready");
  }
  async function get(path,json,signal) {
    const response=await fetch(AMEDAS_ROOT+path+`?_=${Date.now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
    if(!response.ok)throw new Error("積雪を取得できません");
    const text=await response.text();if(text.length>2500000)throw new Error("積雪データが大きすぎます");return json?JSON.parse(text):text.trim();
  }
  async function load(refresh=false) {
    if(!active)return;
    const request=++token;abort?.abort();abort=new AbortController();const signal=abort.signal;clear();
    status("積雪深の観測時刻と観測点を読み込んでいます","loading");mapLabel("実況積雪深を準備中");
    try {
      const nextLatest=snowHour(await get("data/latest_time.txt",false,signal));
      if(!active || request!==token)return;
      const following=!selected || selected===latest;
      if(overlay || refresh && following || !selected)selected=nextLatest;
      latest=nextLatest;
      const slots=Array.from({length:24},(_,i)=>new Date(Date.parse(latest)-i*3600000+9*3600000).toISOString().slice(0,19)+"+09:00").reverse();
      if(!slots.includes(selected))throw new Error("選択した積雪時刻は配信範囲外です");
      const [table,data]=await Promise.all([get("const/amedastable.json",true,signal),get(`data/map/${snowMapKey(selected)}.json`,true,signal)]);
      const decoded=decodeSnowStations(table,data,selected);
      if(!active || request!==token)return;
      stations=decoded;$("liveSnowSlot").replaceChildren(...slots.map(s=>new Option(timeLabel(s),s)));$("liveSnowSlot").value=selected;$("liveSnowSlot").disabled=overlay;
      renderPoints();paint();updateMetadata();
      $("liveSnowNotice").textContent=Date.now()-Date.parse(latest)>95*60000?"積雪深の更新が遅れています。表示時刻を確認してください。":"";$("liveSnowNotice").hidden=!$("liveSnowNotice").textContent;
      reportStations();
      mapLabel(`${timeLabel(selected)} · 実況積雪深（観測点）`);
      $("map").dataset.liveSnowTime=selected;
      const station=stations.find(s=>s.id===selectedStation);
      if(station && $("liveSnowPoints").checked)showStation(station);
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      clear();status("積雪深を取得・確認できません。再読込できます。","error");mapLabel("実況積雪深を表示できません");
    }
  }
  function showStation(station) {
    selectedStation=station.id;$("liveSnowStation").value=station.id;
    const content=document.createElement("div"),title=document.createElement("strong"),value=document.createElement("p"),date=document.createElement("small");
    title.textContent=`${station.name} · 観測点`;
    value.textContent=`実況積雪深：${snowStationLabel(station)}`;
    date.textContent=`${timeLabel(station.hour)}時点の実況（気象庁）`;
    content.append(title,value,date);popup?.remove();popup=new maplibregl.Popup({maxWidth:"250px"}).setLngLat([station.lng,station.lat]).setDOMContent(content).addTo(map);
  }
  map.on("click",event=>{if(!active || $("map").dataset.displayMode==="drive" || !$("liveSnowPoints").checked)return;const id=map.queryRenderedFeatures(event.point,{layers:["live-snow-point-halos"]})[0]?.properties.id;const station=stations.find(s=>s.id===id);if(station)showStation(station);});
  $("liveSnowStation").addEventListener("change",()=>{const station=stations.find(s=>s.id===$("liveSnowStation").value);if(station){map.easeTo({center:[station.lng,station.lat],zoom:Math.max(map.getZoom(),8),duration:0});showStation(station);}else{selectedStation=null;popup?.remove();}});
  $("liveSnowPoints").addEventListener("change",paint);$("liveSnowRefresh").addEventListener("click",()=>void load(true));
  $("liveSnowSlot").addEventListener("change",()=>{selected=$("liveSnowSlot").value;void load();});
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden)void load(true);});
  return {setAboveRoads(above){
    for(const id of layers)map.moveLayer(id,above?undefined:beforeRoads);
  },setActive(value,latestOnly=false){if(active && !overlay)observedSelection=selected;overlay=latestOnly;selected=overlay?null:observedSelection;active=value;++token;abort?.abort();clearInterval(timer);clear();paint();if(value){void load(true);timer=setInterval(()=>{if(!document.hidden)void load(true);},600000);}},
    tooltipAt(lng,lat){
      if(!stations.length)return "積雪深を表示できません";
      if(!$("liveSnowPoints").checked)return "観測点は非表示です";
      const pixel=map.project([lng,lat]),zoom=Math.max(3,Math.min(9,map.getZoom())),r=POINT_SIZES[overlay?"forecast":"observed"].halo;
      const radius=zoom<=5?r[0]+(r[1]-r[0])*(zoom-3)/2:r[1]+(r[2]-r[1])*(zoom-5)/4;
      let station=null,distance=Infinity;
      for(const s of stations){const p=map.project([s.lng,s.lat]),d=Math.hypot(p.x-pixel.x,p.y-pixel.y);if(d<=radius && d<distance){station=s;distance=d;}}
      if(!station)return "観測点なし";
      const value=snowStationValue(station);
      const quality=station.quality!==0 && station.value!==null?"（参考値）":"";
      return `${timeLabel(station.hour)}時点 · ${station.name} ${value}${quality}`;
    },observationTime:()=>stations.length?selected:null,label:()=>stations.length?timeLabel(selected):"積雪時刻を準備中"};
}

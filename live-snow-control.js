import * as maplibregl from "./vendor/maplibre-gl.mjs";
import {createTemperatureLayer} from "./temperature-layer.js";
import {AMEDAS_ROOT,snowHour,snowMapKey,decodeSnowStations,snowStationLabel,makeSnowSurface,snowColor,snowSurfaceLabel} from "./live-snow-data.js";
import {timeLabel} from "./live-temperature-data.js";

const $=id=>document.getElementById(id),EMPTY={type:"FeatureCollection",features:[]};
export function initLiveSnow(map,hooks={}) {
  let active=false,token=0,abort=null,timer=null,grid=null,layer=null,stations=[],surface=null,selected=null,latest=null,popup=null,selectedStation=null;
  map.addSource("live-snow-points",{type:"geojson",data:EMPTY});
  map.addSource("live-snow-lines",{type:"geojson",data:EMPTY});
  map.addLayer({id:"live-snow-lines",type:"line",source:"live-snow-lines",layout:{visibility:"none"},paint:{"line-color":"#355277","line-width":1.4,"line-opacity":.9}});
  map.addLayer({id:"live-snow-points",type:"circle",source:"live-snow-points",layout:{visibility:"none"},paint:{"circle-radius":["interpolate",["linear"],["zoom"],5,3.5,9,6],"circle-color":["case",["get","available"],["case",[">",["get","value"],0],"#247db3","#ffffff"],"#777777"],"circle-stroke-color":"#153c5a","circle-stroke-width":1}});
  function status(message,state) {$("liveSnowStatus").textContent=message;$("liveSnowStatus").dataset.state=state;hooks.onChange?.();}
  function paint() {
    layer?.setVisible(active && $("liveSnowSurface").checked && !!surface?.count);layer?.setOpacity(Number($("liveSnowOpacity").value)/100);
    map.setLayoutProperty("live-snow-points","visibility",active && $("liveSnowPoints").checked?"visible":"none");
    map.setLayoutProperty("live-snow-lines","visibility",active && $("liveSnowContours").checked?"visible":"none");
    $("liveSnowOpacityValue").textContent=`${$("liveSnowOpacity").value}%`;
    if(!active || !$("liveSnowPoints").checked)popup?.remove();
  }
  function clear() {
    stations=[];surface=null;layer?.setVisible(false);popup?.remove();popup=null;
    map.getSource("live-snow-points").setData(EMPTY);map.getSource("live-snow-lines").setData(EMPTY);
    $("liveSnowStation").disabled=true;
    $("liveSnowSlot").disabled=true;
    for(const key of ["liveSnowTime","liveSnowValid","liveSnowMissing","liveSnowCells","liveSnowTriangles"])delete $("map").dataset[key];
  }
  function renderSurface() {
    if(!active || !grid || !stations.length)return;
    surface=makeSnowSurface(stations,grid);
    if(!layer){layer=createTemperatureLayer(grid,{id:"live-snow-surface",colorForBin:snowColor});map.addLayer(layer,"general-road-casing");}
    layer.setBins(surface.bins);map.getSource("live-snow-lines").setData(surface.contours);
    $("map").dataset.liveSnowCells=String(surface.count);$("map").dataset.liveSnowTriangles=String(surface.triangleCount);paint();reportStations();hooks.onChange?.();
  }
  function reportStations() {
    const valid=stations.filter(s=>s.usable).length,reference=stations.filter(s=>s.value!==null && !s.usable).length,missing=stations.filter(s=>s.value===null).length;
    status(`積雪観測点 ${stations.length}地点：有効 ${valid}・参考 ${reference}・資料なし ${missing}${valid===0?"。有効な値がないため面・等値線は表示しません。":!grid?"。推定面の陸域を準備中です。":!surface?.count?"。補間できる観測範囲がありません。":"。観測点と独自推定の面・等値線を表示中。"}`,"ready");
    $("map").dataset.liveSnowValid=String(valid);$("map").dataset.liveSnowMissing=String(missing);
  }
  async function get(path,json,signal) {
    const response=await fetch(AMEDAS_ROOT+path+`?_=${Date.now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
    if(!response.ok)throw new Error("積雪を取得できません");
    const text=await response.text();if(text.length>2500000)throw new Error("積雪データが大きすぎます");return json?JSON.parse(text):text.trim();
  }
  async function load(refresh=false) {
    if(!active)return;
    const request=++token;abort?.abort();abort=new AbortController();const signal=abort.signal;clear();
    status("積雪深の観測時刻と観測点を読み込んでいます","loading");$("mapTemperatureLabel").textContent="実況積雪深を準備中";
    try {
      const nextLatest=snowHour(await get("data/latest_time.txt",false,signal));
      if(!active || request!==token)return;
      const following=!selected || selected===latest;
      if(refresh && following || !selected)selected=nextLatest;
      latest=nextLatest;
      const slots=Array.from({length:24},(_,i)=>new Date(Date.parse(latest)-i*3600000+9*3600000).toISOString().slice(0,19)+"+09:00").reverse();
      if(!slots.includes(selected))throw new Error("選択した積雪時刻は配信範囲外です");
      const [table,data]=await Promise.all([get("const/amedastable.json",true,signal),get(`data/map/${snowMapKey(selected)}.json`,true,signal)]);
      const decoded=decodeSnowStations(table,data,selected);
      if(!active || request!==token)return;
      stations=decoded;$("liveSnowSlot").replaceChildren(...slots.map(s=>new Option(timeLabel(s),s)));$("liveSnowSlot").value=selected;$("liveSnowSlot").disabled=false;
      $("liveSnowStation").replaceChildren(new Option("地図の点、または地点名から選択",""),...stations.map(s=>new Option(`${s.name} · ${s.value===null?"資料なし":`${s.value}cm`}`,s.id)));
      $("liveSnowStation").disabled=false;$("liveSnowStation").value=selectedStation ?? "";
      const features=stations.map(s=>({type:"Feature",properties:{id:s.id,available:s.value!==null,value:s.value ?? -1},geometry:{type:"Point",coordinates:[s.lng,s.lat]}}));
      map.getSource("live-snow-points").setData({type:"FeatureCollection",features});
      renderSurface();paint();
      $("liveSnowUpdated").textContent=`${timeLabel(selected)}の正時観測 · 気象庁アメダス等`;
      $("liveSnowNotice").textContent=Date.now()-Date.parse(latest)>95*60000?"積雪深の更新が遅れています。表示時刻を確認してください。":"";$("liveSnowNotice").hidden=!$("liveSnowNotice").textContent;
      reportStations();
      $("mapTemperatureLabel").textContent=`${timeLabel(selected)} · 実況積雪深（点：観測／面：独自推定）`;
      $("map").dataset.liveSnowTime=selected;
      const station=stations.find(s=>s.id===selectedStation);if(station && $("liveSnowPoints").checked)showStation(station);
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      clear();status("積雪深を取得・確認できません。再読込できます。","error");$("mapTemperatureLabel").textContent="実況積雪深を表示できません";
    }
  }
  function showStation(station) {
    selectedStation=station.id;$("liveSnowStation").value=station.id;
    const content=document.createElement("div"),title=document.createElement("strong"),value=document.createElement("p"),date=document.createElement("small");
    title.textContent=`${station.name} · 観測点`;value.textContent=`積雪深：${snowStationLabel(station)}`;date.textContent=`${timeLabel(station.hour)} · 気象庁`;
    content.append(title,value,date);popup?.remove();popup=new maplibregl.Popup({maxWidth:"250px"}).setLngLat([station.lng,station.lat]).setDOMContent(content).addTo(map);
  }
  map.on("click",event=>{if(!active || !$("liveSnowPoints").checked)return;const id=map.queryRenderedFeatures(event.point,{layers:["live-snow-points"]})[0]?.properties.id;const station=stations.find(s=>s.id===id);if(station)showStation(station);});
  $("liveSnowStation").addEventListener("change",()=>{const station=stations.find(s=>s.id===$("liveSnowStation").value);if(station){map.easeTo({center:[station.lng,station.lat],zoom:Math.max(map.getZoom(),8),duration:0});showStation(station);}else{selectedStation=null;popup?.remove();}});
  for(const id of ["liveSnowSurface","liveSnowPoints","liveSnowContours"])$(id).addEventListener("change",paint);
  $("liveSnowOpacity").addEventListener("input",paint);$("liveSnowRefresh").addEventListener("click",()=>void load(true));
  $("liveSnowSlot").addEventListener("change",()=>{selected=$("liveSnowSlot").value;void load();});
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden)void load(true);});
  return {setGrid(value){grid=value;renderSurface();},setActive(value){active=value;++token;abort?.abort();clearInterval(timer);clear();paint();if(value){void load(true);timer=setInterval(()=>{if(!document.hidden)void load(true);},600000);}},
    tooltipAt(lng,lat){
      if(!stations.length)return "積雪深を表示できません";
      const pixel=map.project([lng,lat]),station=stations.find(s=>{const p=map.project([s.lng,s.lat]);return Math.hypot(p.x-pixel.x,p.y-pixel.y)<=8;});
      if(station && $("liveSnowPoints").checked)return `${station.name}（観測）：${snowStationLabel(station)}`;
      return grid?snowSurfaceLabel(surface,grid,lng,lat):"推定面を準備中";
    },label:()=>selected?timeLabel(selected):"積雪時刻を準備中"};
}

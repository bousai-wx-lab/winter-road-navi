import * as maplibregl from "./vendor/maplibre-gl.mjs";
import {AMEDAS_ROOT,LIVE_SNOW_BANDS,LIVE_SNOW_LABEL_ZOOM,snowHour,snowMapKey,decodeSnowStations,snowStationValue,snowStationLabel} from "./live-snow-data.js?v=20261109-marker1";
import {createSnowForecastLoader} from "./forecast-snow-data.js?v=20261109-panel2";
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
  let target=null,targetSignature="",forecastToken=0,forecastAbort=null,forecastState="waiting",forecastResult=null,forecastError="";
  const forecastValues=new Map(),loadForecast=createSnowForecastLoader();
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
  function pointFor(s) {
    if(!overlay)return {value:s.value,added:0,reason:s.value===null?"実況が資料なし":""};
    return forecastValues.get(s.id) ?? {value:null,added:null,reason:s.value===null?"実況が資料なし":forecastError || "予測加算を準備中"};
  }
  function pointLabel(s) {
    if(!overlay)return snowStationLabel(s);
    const p=pointFor(s);
    return p.value===null?`計算不能（${p.reason}${s.value!==null?`・実況${snowStationLabel(s)}`:""}）`:`${p.value}cm（実況${snowStationValue(s)}＋予報加算${p.added}cm）${s.quality!==0?"・参考値":""}`;
  }
  function renderPoints() {
    const ready=!overlay || ["ready","error"].includes(forecastState);
    const features=ready?stations.map(s=>{const p=pointFor(s);return {type:"Feature",properties:{id:s.id,available:p.value!==null,value:p.value ?? -1,observed:s.value ?? -1,added:p.added ?? -1},geometry:{type:"Point",coordinates:[s.lng,s.lat]}};}):[];
    map.getSource("live-snow-points").setData({type:"FeatureCollection",features});
    $("liveSnowStation").replaceChildren(new Option("地点を選択",""),...stations.map(s=>new Option(`${s.name} · ${overlay?pointLabel(s):snowStationValue(s)}`,s.id)));
    $("liveSnowStation").disabled=!stations.length || !ready;$("liveSnowStation").value=selectedStation ?? "";
  }
  function updateMetadata() {
    $("liveSnowControls").setAttribute("aria-label",overlay?"積雪深の予測の設定":"実況積雪深の設定");
    $("liveSnowDisplayHelp").textContent="拡大すると数値を表示。丸を押すと地点の詳細。";
    legend.firstElementChild.lastElementChild.textContent=overlay?"資料なし・計算不能":"資料なし";
    $("liveSnowForecastNotice").hidden=!overlay;
    let note="最初の3時間枠も全量加算（時間按分なし）。融雪・沈降は未考慮です。";
    const plan=forecastResult?.plan;
    if(plan?.overlapHours)note+=` 最初の枠には実況前${plan.overlapHours}時間分も含みます。`;
    if(plan?.gapHours)note+=` ${timeLabel(selected)}〜${timeLabel(plan.start)}は予報がないため加算外です。`;
    $("liveSnowForecastNotice").textContent=note;
    if(selected)$("liveSnowUpdated").textContent=overlay?`基準実況：${timeLabel(selected)} · 気象庁アメダス等${plan?` ／ 予報発表：${timeLabel(plan.base)} · 加算対象：${timeLabel(plan.start)}〜${timeLabel(plan.end)}`:""}`:`${timeLabel(selected)}の正時観測 · 気象庁アメダス等`;
  }
  function cancelForecast() {
    ++forecastToken;forecastAbort?.abort();forecastState="waiting";forecastResult=null;forecastError="";forecastValues.clear();
    for(const key of ["snowForecastTarget","snowForecastBase","snowForecastCount"])delete $("map").dataset[key];
  }
  async function projectForecast() {
    cancelForecast();popup?.remove();renderPoints();updateMetadata();
    if(!active || !overlay || !stations.length)return;
    if(!target){status("積雪加算の予測時刻を準備中です","loading");return;}
    const request=forecastToken,chosen=target,hour=selected,input=stations;
    forecastAbort=new AbortController();forecastState="loading";status("実況に加算する3時間降雪予報を読み込んでいます","loading");
    try {
      const result=await loadForecast(input,hour,chosen,forecastAbort.signal);
      if(!active || !overlay || request!==forecastToken)return;
      forecastResult=result;forecastState="ready";for(const p of result.points)forecastValues.set(p.id,p);
      $("map").dataset.snowForecastTarget=result.plan.end;$("map").dataset.snowForecastBase=result.plan.base;$("map").dataset.snowForecastCount=String(result.plan.slots.length);
      renderPoints();updateMetadata();reportStations();
      const station=stations.find(s=>s.id===selectedStation);if(station && $("liveSnowPoints").checked)showStation(station);
    }catch(error) {
      if(!active || !overlay || request!==forecastToken || error.name==="AbortError")return;
      forecastState="error";forecastError=/^[\u3040-\u30ff\u3400-\u9fff]/.test(error.message)?error.message:"降雪予報を取得・確認できません";
      renderPoints();updateMetadata();status(`${forecastError}。積雪深の予測は計算できません。実況モードで観測値を確認できます。`,"error");
    }
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
    cancelForecast();stations=[];popup?.remove();popup=null;
    map.getSource("live-snow-points").setData(EMPTY);
    $("liveSnowStation").disabled=true;
    $("liveSnowSlot").disabled=true;
    $("liveSnowUpdated").textContent="";$("liveSnowNotice").textContent="";$("liveSnowNotice").hidden=true;
    for(const key of ["liveSnowTime","liveSnowValid","liveSnowMissing","liveSnowPoints"])delete $("map").dataset[key];
  }
  function reportStations() {
    const valid=stations.filter(s=>s.usable).length,reference=stations.filter(s=>s.value!==null && !s.usable).length,missing=stations.filter(s=>s.value===null).length;
    $("map").dataset.liveSnowValid=String(valid);$("map").dataset.liveSnowMissing=String(missing);$("map").dataset.liveSnowPoints=String(stations.length);
    if(overlay){if(forecastState==="ready"){const count=stations.filter(s=>pointFor(s).value!==null).length;status(`積雪深の予測 ${count}地点 · 実況が資料なし ${missing}地点 · 予報が資料不足 ${stations.length-count-missing}地点。実況＋予報階級の累積です。`,"ready");}}
    else status(`積雪観測点 ${stations.length}地点：有効 ${valid}・参考 ${reference}・資料なし ${missing}。丸は観測点の値です。`,"ready");
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
      if(overlay)void projectForecast();
      else {const station=stations.find(s=>s.id===selectedStation);if(station && $("liveSnowPoints").checked)showStation(station);}
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      clear();status("積雪深を取得・確認できません。再読込できます。","error");mapLabel("実況積雪深を表示できません");
    }
  }
  function showStation(station) {
    selectedStation=station.id;$("liveSnowStation").value=station.id;
    const content=document.createElement("div"),title=document.createElement("strong"),value=document.createElement("p"),date=document.createElement("small");
    title.textContent=`${station.name} · ${overlay?"観測点位置の簡易予測":"観測点"}`;value.textContent=`${overlay?"積雪深の予測":"積雪深"}：${pointLabel(station)}`;
    date.textContent=overlay?`基準実況 ${timeLabel(station.hour)} · 対象 ${timeLabel(forecastResult?.plan.end || target?.end)} · 気象庁の観測・降雪予報から簡易加算`:`${timeLabel(station.hour)} · 気象庁`;
    content.append(title,value,date);popup?.remove();popup=new maplibregl.Popup({maxWidth:"250px"}).setLngLat([station.lng,station.lat]).setDOMContent(content).addTo(map);
  }
  map.on("click",event=>{if(!active || !$("liveSnowPoints").checked)return;const id=map.queryRenderedFeatures(event.point,{layers:["live-snow-point-halos"]})[0]?.properties.id;const station=stations.find(s=>s.id===id);if(station)showStation(station);});
  $("liveSnowStation").addEventListener("change",()=>{const station=stations.find(s=>s.id===$("liveSnowStation").value);if(station){map.easeTo({center:[station.lng,station.lat],zoom:Math.max(map.getZoom(),8),duration:0});showStation(station);}else{selectedStation=null;popup?.remove();}});
  $("liveSnowPoints").addEventListener("change",paint);$("liveSnowRefresh").addEventListener("click",()=>void load(true));
  $("liveSnowSlot").addEventListener("change",()=>{selected=$("liveSnowSlot").value;void load();});
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden)void load(true);});
  return {setAboveRoads(above){
    for(const id of layers)map.moveLayer(id,above?undefined:beforeRoads);
  },setActive(value,latestOnly=false){if(active && !overlay)observedSelection=selected;overlay=latestOnly;selected=overlay?null:observedSelection;active=value;++token;abort?.abort();clearInterval(timer);clear();paint();updateMetadata();if(value){void load(true);timer=setInterval(()=>{if(!document.hidden)void load(true);},600000);}},
    setForecastTarget(value){const signature=value?`${value.basetime}:${value.validtime}`:"";if(signature===targetSignature)return;targetSignature=signature;target=value;if(active && overlay)void projectForecast();else cancelForecast();},
    tooltipAt(lng,lat){
      if(!stations.length)return "積雪深を表示できません";
      if(!$("liveSnowPoints").checked)return "観測点は非表示です";
      const pixel=map.project([lng,lat]),zoom=Math.max(3,Math.min(9,map.getZoom())),r=POINT_SIZES[overlay?"forecast":"observed"].halo;
      const radius=zoom<=5?r[0]+(r[1]-r[0])*(zoom-3)/2:r[1]+(r[2]-r[1])*(zoom-5)/4;
      let station=null,distance=Infinity;
      for(const s of stations){const p=map.project([s.lng,s.lat]),d=Math.hypot(p.x-pixel.x,p.y-pixel.y);if(d<=radius && d<distance){station=s;distance=d;}}
      if(!station)return "観測点なし";
      const value=pointFor(station).value;
      return `${station.name} ${value===null?"資料なし":`${value}cm`}${station.quality!==0 && value!==null?"（参考値）":""}`;
    },observationTime:()=>stations.length?selected:null,title:()=>overlay?"積雪深の予測":"実況積雪深",label:()=>overlay && target?timeLabel(target.end):selected?timeLabel(selected):"積雪時刻を準備中"};
}

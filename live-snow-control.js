import * as maplibregl from "./vendor/maplibre-gl.mjs";
import {AMEDAS_ROOT,LIVE_SNOW_BANDS,LIVE_SNOW_LABEL_ZOOM,snowHour,snowMapKey,decodeSnowStations,snowStationValue,snowStationLabel} from "./live-snow-data.js?v=20261107-points2";
import {timeLabel} from "./live-temperature-data.js";

const $=id=>document.getElementById(id),EMPTY={type:"FeatureCollection",features:[]};
const POINT_SIZES={observed:{radius:[2.5,6,10],halo:[5.7,10.2,14.2],stroke:1.2},forecast:{radius:[2,3.5,6],halo:[4.5,6,8.5],stroke:1}};
const zoomSize=values=>["interpolate",["linear"],["zoom"],3,values[0],5,values[1],9,values[2]];
function missingHatch() {
  const canvas=document.createElement("canvas");canvas.width=canvas.height=48;
  const ctx=canvas.getContext("2d");ctx.beginPath();ctx.arc(24,24,18.8,0,Math.PI*2);ctx.clip();
  ctx.strokeStyle="#445c6e";ctx.lineWidth=3.2;
  for(let x=-48;x<96;x+=9){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x+48,48);ctx.stroke();}
  return ctx.getImageData(0,0,48,48);
}
export function initLiveSnow(map,hooks={}) {
  let active=false,overlay=false,observedSelection=null,token=0,abort=null,timer=null,stations=[],selected=null,latest=null,popup=null,selectedStation=null;
  const mapLabel=text=>{if(!overlay)$("mapTemperatureLabel").textContent=text;};
  map.addSource("live-snow-points",{type:"geojson",data:EMPTY});
  map.addImage("live-snow-missing-hatch",missingHatch(),{pixelRatio:2});
  const layers=["live-snow-point-halos","live-snow-points","live-snow-missing","live-snow-values"];
  map.addLayer({id:layers[0],type:"circle",source:"live-snow-points",layout:{visibility:"none"},paint:{"circle-radius":zoomSize(POINT_SIZES.observed.halo),"circle-color":"#ffffff"}});
  const colors=["step",["get","value"],LIVE_SNOW_BANDS[0].color,...LIVE_SNOW_BANDS.slice(1).flatMap(band=>[band.min,band.color])];
  map.addLayer({id:layers[1],type:"circle",source:"live-snow-points",layout:{visibility:"none"},paint:{"circle-radius":zoomSize(POINT_SIZES.observed.radius),"circle-color":["case",["get","available"],colors,"#c1cbd2"],"circle-stroke-color":"#213e53","circle-stroke-width":1.2}});
  map.addLayer({id:layers[2],type:"symbol",source:"live-snow-points",filter:["!",["get","available"]],layout:{visibility:"none","icon-image":"live-snow-missing-hatch","icon-size":zoomSize(POINT_SIZES.observed.radius.map(r=>r/10)),"icon-allow-overlap":true,"icon-ignore-placement":true}});
  map.addLayer({id:layers[3],type:"symbol",source:"live-snow-points",minzoom:LIVE_SNOW_LABEL_ZOOM,filter:["get","available"],layout:{visibility:"none","text-field":["to-string",["get","value"]],"text-font":["sans-serif"],"text-size":12,"text-anchor":"top","text-offset":[0,1.25],"text-padding":2},paint:{"text-color":"#143c54","text-halo-color":"#ffffff","text-halo-width":2}});
  const legend=$("liveSnowPointLegend");
  for(const band of [{label:"資料なし",color:null},...LIVE_SNOW_BANDS]) {
    const item=document.createElement("span"),key=document.createElement("i"),label=document.createElement("span");
    key.className="live-snow-point-key"+(band.color?"":" missing");key.setAttribute("aria-hidden","true");if(band.color)key.style.backgroundColor=band.color;
    label.textContent=band.label;item.append(key,label);legend.append(item);
  }
  function status(message,state) {$("liveSnowStatus").textContent=message;$("liveSnowStatus").dataset.state=state;hooks.onChange?.();}
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
    status(`積雪観測点 ${stations.length}地点：有効 ${valid}・参考 ${reference}・資料なし ${missing}。丸は観測点の値です。`,"ready");
    $("map").dataset.liveSnowValid=String(valid);$("map").dataset.liveSnowMissing=String(missing);$("map").dataset.liveSnowPoints=String(stations.length);
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
      $("liveSnowStation").replaceChildren(new Option("地図の点、または地点名から選択",""),...stations.map(s=>new Option(`${s.name} · ${snowStationValue(s)}`,s.id)));
      $("liveSnowStation").disabled=false;$("liveSnowStation").value=selectedStation ?? "";
      const features=stations.map(s=>({type:"Feature",properties:{id:s.id,available:s.value!==null,value:s.value ?? -1},geometry:{type:"Point",coordinates:[s.lng,s.lat]}}));
      map.getSource("live-snow-points").setData({type:"FeatureCollection",features});
      paint();
      $("liveSnowUpdated").textContent=`${timeLabel(selected)}の正時観測 · 気象庁アメダス等`;
      $("liveSnowNotice").textContent=Date.now()-Date.parse(latest)>95*60000?"積雪深の更新が遅れています。表示時刻を確認してください。":"";$("liveSnowNotice").hidden=!$("liveSnowNotice").textContent;
      reportStations();
      mapLabel(`${timeLabel(selected)} · 実況積雪深（観測点）`);
      $("map").dataset.liveSnowTime=selected;
      const station=stations.find(s=>s.id===selectedStation);if(station && $("liveSnowPoints").checked)showStation(station);
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      clear();status("積雪深を取得・確認できません。再読込できます。","error");mapLabel("実況積雪深を表示できません");
    }
  }
  function showStation(station) {
    selectedStation=station.id;$("liveSnowStation").value=station.id;
    const content=document.createElement("div"),title=document.createElement("strong"),value=document.createElement("p"),date=document.createElement("small");
    title.textContent=`${station.name} · 観測点`;value.textContent=`積雪深：${snowStationLabel(station)}`;date.textContent=`${timeLabel(station.hour)} · 気象庁`;
    content.append(title,value,date);popup?.remove();popup=new maplibregl.Popup({maxWidth:"250px"}).setLngLat([station.lng,station.lat]).setDOMContent(content).addTo(map);
  }
  map.on("click",event=>{if(!active || !$("liveSnowPoints").checked)return;const id=map.queryRenderedFeatures(event.point,{layers:["live-snow-point-halos"]})[0]?.properties.id;const station=stations.find(s=>s.id===id);if(station)showStation(station);});
  $("liveSnowStation").addEventListener("change",()=>{const station=stations.find(s=>s.id===$("liveSnowStation").value);if(station){map.easeTo({center:[station.lng,station.lat],zoom:Math.max(map.getZoom(),8),duration:0});showStation(station);}else{selectedStation=null;popup?.remove();}});
  $("liveSnowPoints").addEventListener("change",paint);$("liveSnowRefresh").addEventListener("click",()=>void load(true));
  $("liveSnowSlot").addEventListener("change",()=>{selected=$("liveSnowSlot").value;void load();});
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden)void load(true);});
  return {setActive(value,latestOnly=false){if(active && !overlay)observedSelection=selected;overlay=latestOnly;selected=overlay?null:observedSelection;active=value;++token;abort?.abort();clearInterval(timer);clear();paint();if(value){void load(true);timer=setInterval(()=>{if(!document.hidden)void load(true);},600000);}},
    tooltipAt(lng,lat){
      if(!stations.length)return "積雪深を表示できません";
      if(!$("liveSnowPoints").checked)return "観測点は非表示です";
      const pixel=map.project([lng,lat]),zoom=Math.max(3,Math.min(9,map.getZoom())),r=POINT_SIZES[overlay?"forecast":"observed"].halo;
      const radius=zoom<=5?r[0]+(r[1]-r[0])*(zoom-3)/2:r[1]+(r[2]-r[1])*(zoom-5)/4;
      let station=null,distance=Infinity;
      for(const s of stations){const p=map.project([s.lng,s.lat]),d=Math.hypot(p.x-pixel.x,p.y-pixel.y);if(d<=radius && d<distance){station=s;distance=d;}}
      return station?`${station.name}（観測）：${snowStationLabel(station)}`:"観測点のない場所（積雪深は推定しません）";
    },label:()=>selected?timeLabel(selected):"積雪時刻を準備中"};
}

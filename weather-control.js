import {WEATHER_ROOT,WEATHER_PRODUCTS,weatherSlots,weatherTile,weatherNotice} from "./weather-data.js";
import {timeLabel} from "./live-temperature-data.js";

const $=id=>document.getElementById(id);
export function initWeather(map,hooks={}) {
  let active=false,mode="observed",slots=[],selected=null,token=0,abort=null,timer=null,current=null;
  const saved={observed:null,forecast:null},sources=[],layers=[];
  function clear() {
    for(const id of layers.splice(0)) if(map.getLayer(id))map.removeLayer(id);
    for(const id of sources.splice(0)) if(map.getSource(id))map.removeSource(id);
    current=null;delete $("map").dataset.weatherTarget;delete $("map").dataset.weatherReady;
  }
  function status(message,state) {$("weatherStatus").textContent=message;$("weatherStatus").dataset.state=state;hooks.onChange?.();}
  function controls() {
    const index=slots.findIndex(s=>s.id===selected);
    $("weatherPrevious").disabled=index<=0;$("weatherNext").disabled=index<0 || index>=slots.length-1;$("weatherSlot").disabled=!slots.length;
  }
  function paint() {
    for(const id of layers) if(map.getLayer(id))map.setPaintProperty(id,"raster-opacity",Number($("weatherOpacity").value)/100);
    $("weatherOpacityValue").textContent=`${$("weatherOpacity").value}%`;
  }
  function loaded() {
    if(!active || !current || !sources.length || !sources.every(id=>map.getSource(id) && map.isSourceLoaded(id)))return;
    $("map").dataset.weatherReady="true";
    status(`${current.label} · ${WEATHER_PRODUCTS[mode].label}を表示中`,"ready");
  }
  async function load(refresh=false) {
    if(!active)return;
    const request=++token;abort?.abort();abort=new AbortController();clear();
    status("天気の対象時刻と画像を読み込んでいます","loading");$("mapTemperatureLabel").textContent="天気を準備中";
    try {
      const response=await fetch(`${WEATHER_ROOT}${WEATHER_PRODUCTS[mode].family}/targetTimes.json?_=${Date.now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal:abort.signal});
      if(!response.ok)throw new Error("時刻情報を取得できません");
      const text=await response.text();if(text.length>50000)throw new Error("時刻情報が大きすぎます");
      const next=weatherSlots(JSON.parse(text),mode);
      if(!active || request!==token)return;
      const following=mode==="observed" && (!selected || selected===slots.at(-1)?.id);
      slots=next;
      const slot=(!refresh || !following) && slots.find(s=>s.id===selected)
        || (mode==="observed"?slots.at(-1):slots.find(s=>Date.parse(s.end)>Date.now()) || slots.at(-1));
      selected=slot.id;current=slot;saved[mode]=selected;
      $("weatherSlot").replaceChildren(...slots.map(s=>new Option(s.label,s.id)));$("weatherSlot").value=selected;controls();
      $("weatherUpdated").textContent=`${WEATHER_PRODUCTS[mode].label} · ${WEATHER_PRODUCTS[mode].resolution}${mode==="forecast"?` · 発表：${timeLabel(slot.base)}`:" · 毎時の推計"}`;
      $("weatherNotice").textContent=weatherNotice(mode,slot);$("weatherNotice").hidden=!$("weatherNotice").textContent;
      for(const z of [4,6,8,10]) {
        const tile=weatherTile(mode,slot,z),id=`weather-${request}-${z}`;sources.push(id);layers.push(id);
        map.addSource(id,{type:"raster",tiles:[tile.url],tileSize:tile.tileSize,minzoom:tile.nativeZoom,maxzoom:tile.nativeZoom,bounds:[122,20,154,48],attribution:'<a href="https://www.jma.go.jp/bosai/'+(mode==="observed"?'suikei':'wdist')+'/" target="_blank" rel="noopener noreferrer">気象庁の天気</a>'});
        map.addLayer({id,type:"raster",source:id,minzoom:z===4?0:z-1,...(z<10?{maxzoom:z+1}:{}),paint:{"raster-opacity":Number($("weatherOpacity").value)/100,"raster-resampling":"nearest","raster-fade-duration":0}},"general-road-casing");
      }
      $("map").dataset.weatherMode=mode;$("map").dataset.weatherTarget=slot.end;$("map").dataset.weatherBase=slot.base;
      $("mapTemperatureLabel").textContent=`${slot.label} · ${WEATHER_PRODUCTS[mode].label}`;
      loaded();
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      clear();status("天気を取得・確認できません。再読込できます。","error");$("mapTemperatureLabel").textContent="天気を表示できません";
    }
  }
  function choose(id) {selected=id;saved[mode]=id;void load();}
  $("weatherSlot").addEventListener("change",()=>choose($("weatherSlot").value));
  $("weatherPrevious").addEventListener("click",()=>choose(slots[Math.max(0,slots.findIndex(s=>s.id===selected)-1)]?.id));
  $("weatherNext").addEventListener("click",()=>choose(slots[Math.min(slots.length-1,slots.findIndex(s=>s.id===selected)+1)]?.id));
  $("weatherRefresh").addEventListener("click",()=>void load(true));$("weatherOpacity").addEventListener("input",paint);
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden)void load(true);});
  map.on("sourcedata",loaded);
  map.on("error",event=>{if(active && sources.includes(event.sourceId)){++token;abort?.abort();clear();status("天気画像の一部を取得できません。再読込してください。","error");$("mapTemperatureLabel").textContent="天気を表示できません";}});
  return {setActive(value,nextMode=mode) {
    saved[mode]=selected;active=value;++token;abort?.abort();clearInterval(timer);clear();
    if(nextMode!==mode){mode=nextMode;selected=saved[mode];slots=[];}
    if(value){void load(true);timer=setInterval(()=>{if(!document.hidden)void load(true);},600000);}
  },label:()=>current?.label || "天気を準備中"};
}

import {WEATHER_ROOT,weatherProduct,weatherSlots,weatherTile,weatherNotice} from "./weather-data.js?v=20261010-amounts1";
import {timeLabel} from "./live-temperature-data.js";
import {forecastTickLabel} from "./forecast-timeline.js";

const $=id=>document.getElementById(id);
export function initWeather(map,hooks={}) {
  let active=false,mode="observed",view="weather",slots=[],selected=null,token=0,abort=null,timer=null,current=null;
  const saved={observed:null,forecast:null},sources=[],layers=[];
  const product=()=>weatherProduct(mode,view);
  function metadata() {
    const {name,label}=product();
    $("weatherControls").setAttribute("aria-label",`${name}の設定`);
    $("weatherTitle").textContent=label;$("weatherSlotLabel").textContent=`${name}の対象時刻・期間`;
    $("weatherOpacityLabelText").textContent=`${name}の濃さ `;
    $("weatherLegend").hidden=view!=="weather";$("precipitationLegend").hidden=view!=="precipitation";$("snowfallLegend").hidden=view!=="snowfall";
    $("weatherDescription").textContent=view==="weather"
      ? "気象庁の天気画像をそのまま表示。無色は海域・資料なしです。10分ごと・タブ復帰時に更新を確認します。"
      : `気象庁の約5kmメッシュ・3時間の合計を公式画像のまま表示。${view==="snowfall"?"降雪量は期間中に新たに降る雪の量で、積雪深ではありません。":""}無色は${view==="snowfall"?"降雪":"降水"}なし・海域・資料なしを含み、無色だけで資料の有無は判別できません。10分ごと・タブ復帰時に更新を確認します。`;
  }
  function clear() {
    for(const id of layers.splice(0)) if(map.getLayer(id))map.removeLayer(id);
    for(const id of sources.splice(0)) if(map.getSource(id))map.removeSource(id);
    current=null;delete $("map").dataset.weatherTarget;delete $("map").dataset.weatherReady;delete $("map").dataset.weatherElement;delete $("map").dataset.weatherBase;
  }
  function status(message,state) {$("weatherStatus").textContent=message;$("weatherStatus").dataset.state=state;hooks.onChange?.();}
  function controls() {
    const index=slots.findIndex(s=>s.id===selected);
    $("weatherPrevious").disabled=index<=0;$("weatherNext").disabled=index<0 || index>=slots.length-1;$("weatherSlot").disabled=!slots.length;
    hooks.onChange?.();
  }
  function paint() {
    for(const id of layers) if(map.getLayer(id))map.setPaintProperty(id,"raster-opacity",Number($("weatherOpacity").value)/100);
    $("weatherOpacityValue").textContent=`${$("weatherOpacity").value}%`;
  }
  function loaded() {
    if(!active || !current || !sources.length || !sources.every(id=>map.getSource(id) && map.isSourceLoaded(id)))return;
    $("map").dataset.weatherReady="true";
    status(`${current.label} · ${product().label}を表示中`,"ready");
  }
  async function load(refresh=false) {
    if(!active)return;
    const request=++token,requestMode=mode,requestView=view,requestProduct=product();abort?.abort();abort=new AbortController();clear();
    status(`${requestProduct.name}の対象時刻と画像を読み込んでいます`,"loading");$("mapTemperatureLabel").textContent=`${requestProduct.name}を準備中`;
    try {
      const response=await fetch(`${WEATHER_ROOT}${requestProduct.family}/targetTimes.json?_=${Date.now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal:abort.signal});
      if(!response.ok)throw new Error("時刻情報を取得できません");
      const text=await response.text();if(text.length>50000)throw new Error("時刻情報が大きすぎます");
      const next=weatherSlots(JSON.parse(text),requestMode,requestView);
      if(!active || request!==token)return;
      const following=mode==="observed" && (!selected || selected===slots.at(-1)?.id);
      slots=next;
      const slot=(!refresh || !following) && slots.find(s=>s.id===selected)
        || (mode==="observed"?slots.at(-1):slots.find(s=>Date.parse(s.end)>Date.now()) || slots.at(-1));
      selected=slot.id;current=slot;saved[mode]=selected;
      $("weatherSlot").replaceChildren(...slots.map(s=>new Option(s.label,s.id)));$("weatherSlot").value=selected;controls();
      $("weatherUpdated").textContent=`${requestProduct.label} · ${requestProduct.resolution}${requestProduct.unit?` · ${requestProduct.unit}`:""}${mode==="forecast"?` · 発表：${timeLabel(slot.base)}`:" · 毎時の推計"}`;
      $("weatherNotice").textContent=weatherNotice(mode,slot);$("weatherNotice").hidden=!$("weatherNotice").textContent;
      for(const z of [4,6,8,10]) {
        const tile=weatherTile(mode,slot,z,view),id=`weather-${request}-${z}`;sources.push(id);layers.push(id);
        map.addSource(id,{type:"raster",tiles:[tile.url],tileSize:tile.tileSize,minzoom:tile.nativeZoom,maxzoom:tile.nativeZoom,bounds:[122,20,154,48],attribution:'<a href="https://www.jma.go.jp/bosai/'+(mode==="observed"?'suikei':'wdist')+'/" target="_blank" rel="noopener noreferrer">気象庁の'+requestProduct.name+'</a>'});
        map.addLayer({id,type:"raster",source:id,minzoom:z===4?0:z-1,...(z<10?{maxzoom:z+1}:{}),paint:{"raster-opacity":Number($("weatherOpacity").value)/100,"raster-resampling":"nearest","raster-fade-duration":0}},"general-road-casing");
      }
      $("map").dataset.weatherMode=mode;$("map").dataset.weatherElement=requestProduct.element;$("map").dataset.weatherTarget=slot.end;$("map").dataset.weatherBase=slot.base;
      $("mapTemperatureLabel").textContent=`${slot.label} · ${requestProduct.label}`;
      loaded();
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      clear();status(`${requestProduct.name}を取得・確認できません。再読込できます。`,"error");$("mapTemperatureLabel").textContent=`${requestProduct.name}を表示できません`;
    }
  }
  function choose(id) {if(!active || !slots.some(s=>s.id===id))return;selected=id;saved[mode]=id;$("weatherSlot").value=id;controls();void load();}
  $("weatherSlot").addEventListener("change",()=>choose($("weatherSlot").value));
  $("weatherPrevious").addEventListener("click",()=>choose(slots[Math.max(0,slots.findIndex(s=>s.id===selected)-1)]?.id));
  $("weatherNext").addEventListener("click",()=>choose(slots[Math.min(slots.length-1,slots.findIndex(s=>s.id===selected)+1)]?.id));
  $("weatherRefresh").addEventListener("click",()=>void load(true));$("weatherOpacity").addEventListener("input",paint);
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden)void load(true);});
  map.on("sourcedata",loaded);
  map.on("error",event=>{if(active && sources.includes(event.sourceId)){++token;abort?.abort();clear();status(`${product().name}画像の一部を取得できません。再読込してください。`,"error");$("mapTemperatureLabel").textContent=`${product().name}を表示できません`;}});
  return {setActive(value,nextMode=mode,nextView=view) {
    weatherProduct(nextMode,nextView);
    saved[mode]=selected;active=value;++token;abort?.abort();clearInterval(timer);clear();
    if(nextMode!==mode || nextView!==view){mode=nextMode;view=nextView;selected=saved[mode];slots=[];}
    if(value)metadata();
    if(value){void load(true);timer=setInterval(()=>{if(!document.hidden)void load(true);},600000);}
    controls();
  },choose,title:()=>product().name,timeline:()=>({selected,slots:mode==="forecast"?slots.map(s=>({id:s.id,label:s.label,shortLabel:forecastTickLabel(s.end)})):[]}),label:()=>current?.label || `${product().name}を準備中`};
}

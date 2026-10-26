import {LIVE_ROOT,decodeLiveCSV,liveFile,timeLabel,utcTime} from "./live-temperature-data.js";
import {riskSlots,projectRiskField,buildRiskData,RISK_RULES} from "./forecast-risk-data.js?v=20261026-risk-colors1";
import {lookupCell} from "./temperature-layer.js";

const $=id=>document.getElementById(id);
export function initForecastRisk(hooks={}) {
  let active=false,token=0,abort=null,target=null,shown=null,signature="",generation=null;
  const cache=new Map();
  const legend=$("riskLegend");
  legend.replaceChildren(...RISK_RULES.slice(2).map((rule,i)=>{
    const item=document.createElement("span"),color=document.createElement("i");
    color.style.backgroundColor=rule.color;item.append(color,document.createTextNode(rule.short));item.setAttribute("aria-label",rule.label);item.title=rule.label;item.dataset.riskClass=String(i+2);return item;
  }));
  function status(text,state) {$("riskStatus").textContent=text;$("riskStatus").dataset.state=state;hooks.onChange?.();}
  function clear(state="loading") {
    shown=null;hooks.onUnavailable?.(state);
    for(const key of ["riskReady","riskTarget","riskBase","riskCounts","riskTemperatureThrough","riskPrecipitationFrom"])delete $("map").dataset[key];
  }
  async function get(file,json,signal) {
    if(!/^[a-z0-9_]+\.(json|csv|geojson)$/.test(file))throw new Error("リスクのデータ参照が不正です");
    const response=await fetch(`${LIVE_ROOT}${file}?_=${Date.now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
    if(!response.ok)throw new Error("道路判定用のデータを取得できません");
    const text=await response.text();if(text.length>5000000)throw new Error("道路判定用のデータが大きすぎます");
    return json?JSON.parse(text):text;
  }
  async function load() {
    if(!active || !target)return;
    const request=++token,selected=target;abort?.abort();abort=new AbortController();const signal=abort.signal;clear();
    $("riskUpdated").textContent="";status("対象時刻の気温・降雪と、前12時間の降水を読み込んでいます","loading");
    try {
      let result,manifest,slots;
      for(let attempt=0;attempt<3;attempt++) {
        manifest=await get("forecast_manifest.json",true,signal);
        if(!Number.isFinite(Date.parse(manifest.generated_at)) || Date.now()-Date.parse(manifest.generated_at)>8*3600000)throw new Error("道路判定用の予報更新が遅れています");
        slots=riskSlots(manifest,selected);
        if(generation!==manifest.generated_at){cache.clear();generation=manifest.generated_at;}
        const inflight=new Map();
        const cached=async(file,json)=>{
          if(cache.has(file))return cache.get(file);
          if(inflight.has(file))return inflight.get(file);
          const pending=get(file,json,signal).then(value=>{
            if(request===token && !signal.aborted){cache.set(file,value);if(cache.size>64)cache.delete(cache.keys().next().value);}
            return value;
          });
          inflight.set(file,pending);return pending;
        };
        const [geometries,temperature,history]=await Promise.all([
          Promise.all(["weather3h","precip3h","snow3h"].map(kind=>cached(`forecast_${slots[kind].id}_value.geojson`,true))),
          cached(liveFile("temp3h",slots.temperature),false).then(text=>decodeLiveCSV(text,"temp3h",slots.temperature)),
          Promise.all(slots.history.map(period=>Promise.all(["weather3h","precip3h"].map(kind=>period[kind]?cached(`forecast_${period[kind].id}_value.geojson`,true):null)))),
        ]);
        const grid=temperature.grid;
        const after=await get("forecast_manifest.json",true,signal);
        if(JSON.stringify(after)!==JSON.stringify(manifest)){cache.clear();continue;}
        result=buildRiskData(grid,...geometries.map((g,i)=>projectRiskField(g,grid,["weather3h","precip3h","snow3h"][i])),temperature.values,history.map(pair=>({weather:pair[0]?projectRiskField(pair[0],grid,"weather3h"):null,precipitation:pair[1]?projectRiskField(pair[1],grid,"precip3h"):null})));break;
      }
      if(!result)throw new Error("予報データが更新中です");
      if(!active || request!==token)return;
      shown=result;
      const through=utcTime(slots.temperature.validtime),from=new Date(Date.parse(through)-12*3600000).toISOString();
      const missing=slots.history.some(s=>!s.weather3h || !s.precip3h);
      $("riskUpdated").textContent=`予報発表：${timeLabel(selected.base)} · 気温：${timeLabel(through)} · 降水：${timeLabel(from)}〜${timeLabel(through)}${missing?"（前12時間に未配信のコマあり。降水を確認できない低温格子は資料不足）":"（3時間分×4コマ）"}`;
      const total=result.counts.slice(2).reduce((a,b)=>a+b,0);
      status(`指定条件あり ${total.toLocaleString()}格子 · 資料不足 ${result.counts[0].toLocaleString()}格子。色は道路だけに適用します。`,"ready");
      $("map").dataset.riskReady="true";$("map").dataset.riskTarget=selected.end;$("map").dataset.riskBase=selected.base;
      $("map").dataset.riskCounts=result.counts.join(",");$("map").dataset.riskTemperatureThrough=through;$("map").dataset.riskPrecipitationFrom=from;
      hooks.onData?.(result,selected);hooks.onChange?.();
    }catch(error) {
      if(!active || request!==token || error.name==="AbortError")return;
      cache.clear();
      const message=/^[\u3040-\u30ff\u3400-\u9fff]/.test(error.message)?error.message:"道路判定用のデータを取得・確認できません";
      clear("error");status(`${message}。道路のリスク色は表示できません。再読込できます。`,"error");
    }
  }
  $("riskRefresh").addEventListener("click",()=>void load());
  return {
    setActive(value){active=value;++token;abort?.abort();signature="";target=null;clear();},
    setTarget(value){
      if(!active)return;
      const next=value?`${value.basetime}:${value.validtime}`:"";
      if(signature===next)return;
      signature=next;target=value;
      if(value)void load();else{++token;abort?.abort();clear();status("天気の予測期間を準備中","loading");}
    },
    tooltipAt(lng,lat) {
      if(!shown)return "道路の判定資料を準備中・取得不能";
      const i=lookupCell(shown.grid,lng,lat);if(i<0)return "判定対象の格子なし";
      const label=RISK_RULES[shown.classes[i]].label;
      const temperature=Number.isFinite(shown.temperature[i])?` · 対象時刻の気温 ${shown.temperature[i].toFixed(1)}℃`:"";
      return label+temperature;
    },
  };
}

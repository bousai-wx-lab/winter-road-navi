import {LIVE_ROOT,decodeLiveCSV,liveFile,timeLabel,utcTime} from "./live-temperature-data.js";
import {riskSlots,projectRiskField,buildRiskData,RISK_RULES} from "./forecast-risk-data.js";
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
    for(const key of ["riskReady","riskTarget","riskBase","riskCounts","riskTemperatureThrough"])delete $("map").dataset[key];
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
    $("riskUpdated").textContent="";status("道路用の天気・降水・降雪と12時間先までの気温を読み込んでいます","loading");
    try {
      let result,manifest,slots;
      for(let attempt=0;attempt<3;attempt++) {
        manifest=await get("forecast_manifest.json",true,signal);
        if(!Number.isFinite(Date.parse(manifest.generated_at)) || Date.now()-Date.parse(manifest.generated_at)>8*3600000)throw new Error("道路判定用の予報更新が遅れています");
        slots=riskSlots(manifest,selected);
        if(generation!==manifest.generated_at){cache.clear();generation=manifest.generated_at;}
        const cached=async(file,json)=>{
          if(cache.has(file))return cache.get(file);
          const value=await get(file,json,signal);
          if(request===token && !signal.aborted){cache.set(file,value);if(cache.size>36)cache.delete(cache.keys().next().value);}
          return value;
        };
        const [geometries,temperatures]=await Promise.all([
          Promise.all(["weather3h","precip3h","snow3h"].map(kind=>cached(`forecast_${slots[kind].id}_value.geojson`,true))),
          Promise.all(slots.temperatures.map(s=>s?cached(liveFile("temp3h",s),false).then(text=>decodeLiveCSV(text,"temp3h",s)):null)),
        ]);
        const grid=temperatures.find(Boolean).grid;
        for(const data of temperatures.filter(Boolean))if(data.grid.count!==grid.count || data.grid.rows.some((row,i)=>row!==grid.rows[i] || data.grid.cols[i]!==grid.cols[i]))throw new Error("予想気温の格子が一致しません");
        const after=await get("forecast_manifest.json",true,signal);
        if(JSON.stringify(after)!==JSON.stringify(manifest)){cache.clear();continue;}
        result=buildRiskData(grid,...geometries.map((g,i)=>projectRiskField(g,grid,["weather3h","precip3h","snow3h"][i])),temperatures.map(d=>d?.values ?? null));break;
      }
      if(!result)throw new Error("予報データが更新中です");
      if(!active || request!==token)return;
      shown=result;
      const available=slots.temperatures.filter(Boolean),through=utcTime(available.at(-1).validtime);
      $("riskUpdated").textContent=`予報発表：${timeLabel(selected.base)} · 気温：期間終端〜${timeLabel(through)}${available.length<5?"（12時間先まで未配信のため一部判定不可）":"（12時間先まで・3時間刻み）"}`;
      const total=result.counts.slice(2).reduce((a,b)=>a+b,0);
      status(`指定条件あり ${total.toLocaleString()}格子 · 資料不足 ${result.counts[0].toLocaleString()}格子。色は道路だけに適用します。`,"ready");
      $("map").dataset.riskReady="true";$("map").dataset.riskTarget=selected.end;$("map").dataset.riskBase=selected.base;
      $("map").dataset.riskCounts=result.counts.join(",");$("map").dataset.riskTemperatureThrough=through;
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
      const temperature=Number.isFinite(shown.minimum[i])?` · ${shown.complete[i]?"12時間内":"配信範囲内"}の最低気温 ${shown.minimum[i].toFixed(1)}℃`:"";
      return label+temperature;
    },
  };
}

import {LIVE_ROOT,utcTime} from "./live-temperature-data.js";
import {snowMapKey} from "./live-snow-data.js?v=20261108-addition1";
import {projectRiskField} from "./forecast-risk-data.js?v=20261026-risk-colors1";

const STEP=3*3600000;
export function forecastSnowSlots(manifest,target,hour) {
  snowMapKey(hour);
  const observed=Date.parse(hour),end=Date.parse(utcTime(target?.validtime)),base=utcTime(target?.basetime);
  if(end<observed)throw new Error("対象時刻が基準の実況より前です");
  if(end%STEP || end-observed>24*STEP)throw new Error("積雪加算の対象期間が不正です");
  const source=manifest?.layers?.snow3h?.slots;
  if(!Array.isArray(source) || !source.length || source.length>48)throw new Error("降雪予報の時刻一覧が不正です");
  const available=source.map(s=>({...s,end:Date.parse(utcTime(s.validtime))})).sort((a,b)=>a.end-b.end);
  if(new Set(available.map(s=>s.validtime)).size!==available.length)throw new Error("降雪予報の時刻が重複しています");
  const selected=available.find(s=>s.validtime===target.validtime);
  if(!selected || selected.basetime!==target.basetime || selected.status!=="available" || selected.id!==`snow3h_${target.validtime}`)throw new Error("天気と降雪予報の発表・対象時刻が一致しません");
  const slots=available.filter(s=>s.end>observed && s.end<=end);
  if(end>observed && (!slots.length || slots.at(-1).end!==end))throw new Error("対象時刻までの降雪予報がありません");
  for(let i=0;i<slots.length;i++) {
    const s=slots[i];
    if(s.status!=="available" || s.basetime!==target.basetime || s.id!==`snow3h_${s.validtime}` || s.end%STEP)throw new Error("同じ発表回の降雪予報がそろいません");
    if(i && s.end-slots[i-1].end!==STEP)throw new Error("途中の3時間降雪予報が欠けています");
  }
  const start=slots.length?slots[0].end-STEP:observed;
  if(start-observed>=STEP)throw new Error("実況と降雪予報の間に3時間以上の欠落があります");
  return {slots,base,end:new Date(end).toISOString(),start:new Date(start).toISOString(),hour,
    overlapHours:Math.max(0,(observed-start)/3600000),gapHours:Math.max(0,(start-observed)/3600000)};
}

export function forecastSnowGrid(stations) {
  if(!Array.isArray(stations) || !stations.length || stations.length>1000)throw new Error("積雪観測点の数が不正です");
  if(stations.some(s=>!Number.isFinite(s.lat+s.lng) || s.lat<20 || s.lat>48 || s.lng<122 || s.lng>154))throw new Error("積雪観測点の位置が不正です");
  return {count:stations.length,rowScale:20,colScale:16,
    rows:Uint16Array.from(stations,s=>Math.floor(s.lat*20)),cols:Uint16Array.from(stations,s=>Math.floor(s.lng*16))};
}

export function addForecastSnow(stations,fields) {
  if(!Array.isArray(fields) || fields.length>24 || fields.some(a=>a.length!==stations.length || Array.from(a).some(n=>![0,1,3,6,-1].includes(n))))throw new Error("降雪予報の階級・地点数が不正です");
  return stations.map((station,i)=>{
    if(station.value===null)return {id:station.id,value:null,added:null,reason:"実況が資料なし"};
    if(!Number.isFinite(station.value) || station.value<0 || station.value>1500)throw new Error("基準の実況積雪深が不正です");
    if(fields.some(a=>a[i]<0))return {id:station.id,value:null,added:null,reason:"途中の降雪予報が資料なし"};
    const added=fields.reduce((sum,a)=>sum+a[i],0);
    return {id:station.id,value:station.value+added,added,reason:""};
  });
}

export function createSnowForecastLoader({fetchImpl=fetch,now=Date.now}={}) {
  let generation="";
  const cache=new Map();
  async function get(file,signal) {
    const response=await fetchImpl(`${LIVE_ROOT}${file}?_=${now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
    if(!response.ok)throw new Error("積雪加算用の降雪予報を取得できません");
    const text=await response.text();if(text.length>5000000)throw new Error("降雪予報が大きすぎます");return JSON.parse(text);
  }
  return async function load(stations,hour,target,signal) {
    const grid=forecastSnowGrid(stations);
    try {
    for(let attempt=0;attempt<3;attempt++) {
      const manifest=await get("forecast_manifest.json",signal),date=Date.parse(manifest.generated_at);
      if(!Number.isFinite(date) || now()-date>8*3600000 || date-now()>5*60000)throw new Error("降雪予報の更新時刻を確認できません");
      const plan=forecastSnowSlots(manifest,target,hour),key=`${manifest.generated_at}:${target.basetime}`;
      if(key!==generation){cache.clear();generation=key;}
      const geometries=[];
      for(let i=0;i<plan.slots.length;i+=4)geometries.push(...await Promise.all(plan.slots.slice(i,i+4).map(async slot=>{
        const file=`forecast_${slot.id}_value.geojson`,cached=cache.get(file);
        if(cached)return cached;
        const value=await get(file,signal);
        if(!signal?.aborted && generation===key){cache.set(file,value);if(cache.size>32)cache.delete(cache.keys().next().value);}
        return value;
      })));
      const after=await get("forecast_manifest.json",signal);
      if(JSON.stringify(after)!==JSON.stringify(manifest)){cache.clear();continue;}
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      const fields=geometries.map(g=>projectRiskField(g,grid,"snow3h"));
      return {plan,points:addForecastSnow(stations,fields)};
    }
    throw new Error("降雪予報が更新中です。再読込してください");
    }catch(error) {
      if(!signal?.aborted && error.name!=="AbortError")cache.clear();
      throw error;
    }
  };
}

import { LIVE_ROOT, utcTime, liveFile, decodeLiveCSV, timeLabel } from "./live-temperature-data.js";
import { riskSlots, projectRiskField, riskClass, RISK_RULES } from "./forecast-risk-data.js?v=20261110-risk-colors1";
import { normalRoadClass, NORMAL_ROAD_RULES } from "./road-risk-data.js?v=20261110-risk-colors1";
import { expandGrid, lookupCell, binLabel } from "./temperature-layer.js";
import { decodeDisplayDay, unpackRoadClasses, validRoadClassContract } from "./temperature-display-data.js";
import { checkedSnowManifest, decodeSnowDay, expandSnowBins, snowBinLabel } from "./snow-display-data.js";
import { AMEDAS_ROOT, snowHour, snowMapKey, decodeSnowStations } from "./live-snow-data.js";
import { forecastSnowSlots, forecastSnowGrid, addForecastSnow } from "./forecast-snow-data.js";
import { estimateSnow } from "./drive-route-data.js";

const STEP=3*3600000, WEATHER=["資料なし","晴れ","くもり","雨","雨または雪","雪"];
export function forecastPeriods(manifest,now=Date.now()) {
  const generated=Date.parse(manifest?.generated_at),slots=manifest?.layers?.weather3h?.slots;
  if(!Number.isFinite(generated)||now-generated>8*3600000||generated-now>5*60000||!Array.isArray(slots)||!slots.length||slots.length>48)throw new Error("予測の対象期間・更新時刻を確認できません");
  const periods=slots.map(slot=>({...slot,end:Date.parse(utcTime(slot.validtime)),base:utcTime(slot.basetime)})).sort((a,b)=>a.end-b.end);
  if(new Set(periods.map(s=>s.end)).size!==periods.length)throw new Error("予測期間が重複しています");
  return periods;
}
export function sourceForTime(time,periods) {
  const from=periods[0].end-STEP,to=periods.at(-1).end;
  if(time<from||time>to)return {source:"normal",day:new Date(time+9*3600000).toISOString().slice(5,10)};
  const target=periods.find(s=>time<=s.end && time>=s.end-STEP);
  return {source:"forecast",target:target?.status==="available"?target:null};
}
const unknown=(sample,source,note)=>({...sample,source,rank:0,riskLabel:"資料不足",temperature:"資料なし",snow:"資料なし",weather:source==="normal"?null:"資料なし",note});

export function createDriveWeather({fetchImpl=fetch,now=Date.now}={}) {
  return async function analyze(samples,signal,onProgress=()=>{}) {
    const memo=new Map();
    async function get(url,json=true){
      if(memo.has(url))return memo.get(url);
      const pending=(async()=>{const response=await fetchImpl(url,{signal,cache:"no-cache",credentials:"omit",referrerPolicy:"no-referrer"});if(!response.ok)throw new Error("気象データを取得できません");const text=await response.text();if(text.length>5000000)throw new Error("気象データが大きすぎます");return json?JSON.parse(text):text;})();memo.set(url,pending);return pending;
    }
    async function manifestNow(){const r=await fetchImpl(LIVE_ROOT+"forecast_manifest.json?_="+now(),{signal,cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});if(!r.ok)throw new Error("予測期間を取得できません");const text=await r.text();if(text.length>500000)throw new Error("予測期間が不正です");return JSON.parse(text);}
    async function packed(record,root){
      if(!record || !/^(grid\.json|\d{2}-\d{2}\.json\.gz)$/.test(record.url)||!Number.isInteger(record.bytes)||record.bytes>500000||! /^[a-f0-9]{64}$/.test(record.sha256))throw new Error("平年値の参照が不正です");
      const response=await fetchImpl(root+record.url,{signal,cache:"no-cache"});if(!response.ok)throw new Error("平年値を取得できません");const bytes=await response.arrayBuffer();
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),n=>n.toString(16).padStart(2,"0")).join("");
      if(bytes.byteLength!==record.bytes||hash!==record.sha256)throw new Error("平年値の整合性を確認できません");
      const decoded=record.url.endsWith(".gz")?await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer():bytes;
      if(decoded.byteLength>4000000 || record.uncompressed_bytes && decoded.byteLength!==record.uncompressed_bytes)throw new Error("平年値を展開できません");return JSON.parse(new TextDecoder().decode(decoded));
    }
    let manifest,periods;
    try{manifest=await manifestNow();periods=forecastPeriods(manifest,now());}catch(error){if(signal?.aborted)throw error;return {samples:samples.map(s=>unknown(s,"unknown","予測期間を確認できないため、平年値への自動切替を止めました")),notices:["予測期間を取得できませんでした。再解析してください。"]};}
    const groups=new Map(),result=new Array(samples.length),notices=[];
    samples.forEach((sample,i)=>{const context=sourceForTime(sample.time,periods),key=context.source+":"+(context.day||context.target?.validtime||"missing");if(!groups.has(key))groups.set(key,{context,items:[]});groups.get(key).items.push({...sample,index:i});});
    let normalPromise,stationPromise;
    function normals(){return normalPromise??=(async()=>{
      const roots=["./data/temperature/","./data/temperature-max/","./data/snow/"],list=await Promise.all(roots.map(root=>get(root+"manifest.json"))),[minimum,maximum,snow]=list;
      if(list.slice(0,2).some(m=>m.cell_count!==387717||m.baseline!=="1991-2020"||m.bin_min!==-40||m.bin_step!==1||m.bin_count!==81||m.files?.length!==366||!validRoadClassContract(m.road_classes)) || maximum.grid.sha256!==minimum.grid.sha256)throw new Error("平年気温の定義を確認できません");
      const grid=expandGrid(await packed(minimum.grid,roots[0]));
      const days=minimum.days.filter(d=>d>="09-15"||d<="06-15").sort((a,b)=>(a>="09-15"?0:1)-(b>="09-15"?0:1)||a.localeCompare(b));
      checkedSnowManifest(snow,grid.count,minimum.grid.sha256,days);return {roots,list,grid};
    })();}
    function stations(){return stationPromise??=(async()=>{
      const hour=snowHour(await get(AMEDAS_ROOT+"data/latest_time.txt",false));
      if(now()-Date.parse(hour)>95*60000||Date.parse(hour)-now()>5*60000)throw new Error("積雪の基準実況が古いか不正です");
      const [table,data]=await Promise.all([get(AMEDAS_ROOT+"const/amedastable.json"),get(AMEDAS_ROOT+`data/map/${snowMapKey(hour)}.json`)]);
      return {hour,points:decodeSnowStations(table,data,hour)};
    })();}
    async function normalGroup(group){
      const {grid,list,roots}=await normals(),day=group.context.day;
      const records=list.map(m=>m.files.find(f=>f.day===day));
      const [low,high,snow]=await Promise.all(records.map((r,i)=>r?packed(r,roots[i]):null));
      if(low?.day!==day||high?.day!==day)throw new Error("平年気温の日付が一致しません");
      const minimum=decodeDisplayDay(low,grid.count),maximum=decodeDisplayDay(high,grid.count),classes=unpackRoadClasses(minimum),snowBins=snow?expandSnowBins(decodeSnowDay(snow,grid.count,day),grid.count):null;
      for(const s of group.items){const i=lookupCell(grid,...s.coordinate),rank=i<0?0:normalRoadClass(classes[i],snowBins?.[i]??0);
        result[s.index]={...s,source:"normal",rank,riskLabel:NORMAL_ROAD_RULES[rank],weather:null,
          temperature:i<0?"資料なし":`最低 ${binLabel(minimum.bins[i])}／最高 ${binLabel(maximum.bins[i])}`,
          snow:i<0?"資料なし":snowBins?snowBinLabel(snowBins[i]):"平年積雪の収録期間外",note:"1991〜2020年の平年推定。気温の判定は日最低。時刻別の予報ではありません。"};
      }
    }
    async function forecastGroup(group){
      const target=group.context.target;if(!target)throw new Error("この予測期間は資料がありません");
      const plan=riskSlots(manifest,target),points=group.items;
      const grid={count:points.length,rowScale:20,colScale:16,rows:Uint16Array.from(points,s=>Math.floor(s.coordinate[1]*20)),cols:Uint16Array.from(points,s=>Math.floor(s.coordinate[0]*16))};
      const field=async(slot,kind,targetGrid=grid)=>slot?projectRiskField(await get(LIVE_ROOT+`forecast_${slot.id}_value.geojson`),targetGrid,kind):new Int16Array(targetGrid.count);
      const [weather,precip,snowfall,temperature,history]=await Promise.all([
        field(plan.weather3h,"weather3h"),field(plan.precip3h,"precip3h"),field(plan.snow3h,"snow3h"),
        get(LIVE_ROOT+liveFile("temp3h",plan.temperature),false).then(text=>decodeLiveCSV(text,"temp3h",plan.temperature)),
        Promise.all(plan.history.map(async p=>({weather:await field(p.weather3h,"weather3h"),precipitation:await field(p.precip3h,"precip3h")}))),
      ]);
      let snowStations=null,snowNote="積雪深は取得できません";
      try{
        const baseline=await stations(),snowPlan=forecastSnowSlots(manifest,target,baseline.hour),stationGrid=forecastSnowGrid(baseline.points),fields=[];
        for(const slot of snowPlan.slots)fields.push(slot.missing?new Int16Array(stationGrid.count):await field(slot,"snow3h",stationGrid));
        const added=addForecastSnow(baseline.points,fields);snowStations=baseline.points.map((s,i)=>({...s,value:added[i].value}));snowNote=`基準実況 ${baseline.hour}。100km以内の最大4観測点から距離加重で推定。降雪予報を加算、融雪・沈降・標高差は未考慮。`;
      }catch(error){if(signal?.aborted)throw error;notices.push("積雪深を推定できない区間があります。気温・降雪のリスク色とは別に「資料なし」と表示します。");}
      points.forEach((s,i)=>{
        const cell=lookupCell(temperature.grid,...s.coordinate),value=cell<0?NaN:temperature.values[cell];
        const rank=riskClass(weather[i],precip[i],snowfall[i],value,history.map(h=>({weather:h.weather[i],precipitation:h.precipitation[i]}))),depth=snowStations?estimateSnow(snowStations,s.coordinate):null;
        result[s.index]={...s,source:"forecast",rank,riskLabel:RISK_RULES[rank].short||RISK_RULES[rank].label,weather:WEATHER[weather[i]]||"資料なし",temperature:Number.isFinite(value)?`${value.toFixed(1)}℃`:"資料なし",snow:depth?`推定 約${Math.round(depth.value)}cm`:"資料なし",forecastEnd:target.end,note:`予測対象 ${timeLabel(target.end-STEP)}〜${timeLabel(target.end)}。枠の終端の気温・同じ枠の天気と降雪を使用。${snowNote}${depth?` 最寄り約${Math.round(depth.distance)}km、${depth.count}地点。`:""}`};
      });
    }
    let done=0;
    for(const group of groups.values()){
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      onProgress(`通過時刻の気象を照合中 ${++done}/${groups.size}`);
      try{await (group.context.source==="normal"?normalGroup(group):forecastGroup(group));}
      catch(error){if(signal?.aborted)throw error;for(const s of group.items)result[s.index]=unknown(s,group.context.source,error.message);notices.push("一部の気象資料を取得・照合できないため、灰色の区間があります。");}
    }
    if([...groups.values()].some(g=>g.context.source==="forecast")){
      try{if(JSON.stringify(await manifestNow())!==JSON.stringify(manifest))throw new Error("更新中");}
      catch(error){if(signal?.aborted)throw error;result.forEach((s,i)=>{if(s.source==="forecast")result[i]=unknown(s,"forecast","予報が更新されたため再解析が必要です");});notices.push("予報の発表回を照合できませんでした。再解析してください。");}
    }
    return {samples:result,notices:[...new Set(notices)],generated:manifest.generated_at};
  };
}

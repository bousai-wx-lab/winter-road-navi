import {utcTime,liveSlots} from "./live-temperature-data.js";

export const RISK_RULES=Object.freeze([
  {color:"#75838c",label:"判定資料不足"},
  {color:"#000000",label:"指定条件に該当なし"},
  {color:"#ffe032",label:"降水＋12時間以内に2℃以下",short:"降水→2℃以下"},
  {color:"#ff8c24",label:"降水＋12時間以内に0℃以下",short:"降水→0℃以下"},
  {color:"#ffb5b5",label:"雪の予報・降雪量1cm未満",short:"雪・降雪1cm未満"},
  {color:"#e53232",label:"3時間降雪量1cm以上3cm未満",short:"3時間降雪1〜2cm"},
  {color:"#f35ea7",label:"3時間降雪量3cm以上6cm未満",short:"3時間降雪3〜5cm"},
  {color:"#8d38c9",label:"3時間降雪量6cm以上",short:"3時間降雪6cm以上"},
]);
export const RISK_LEVELS=Object.freeze({
  weather3h:{Clear:1,Cloudy:2,Rain:3,"Rain/snow":4,Snow:5,NoData:-1},
  precip3h:{"1<=mm<5":1,"5<=mm<10":5,"10<=mm<15":10,"15<=mm<20":15,"20<=mm":20,NoData:-1},
  snow3h:{"1<=cm<3":1,"3<=cm<6":3,"6<=cm":6,NoData:-1},
});

// Temperature samples cover the period end itself and +3, +6, +9, +12 h.
// A missing later sample must not turn a wet road into a reassuring category.
export function riskClass(weather,precipitation,snowfall,temperatures) {
  if(snowfall>=6)return 7;
  if(snowfall>=3)return 6;
  if(snowfall>=1)return 5;
  if(weather===5 && snowfall===0)return 4;
  if([weather,precipitation,snowfall].some(v=>!Number.isFinite(v)) || weather<1 || precipitation<0 || snowfall<0)return 0;
  const wet=precipitation>=1 || [3,4,5].includes(weather);
  if(!wet)return 1;
  if(temperatures.some(t=>Number.isFinite(t) && t<=0))return 3;
  if(temperatures.length!==5 || temperatures.some(t=>!Number.isFinite(t)))return 0;
  return Math.min(...temperatures)<=2?2:1;
}

export function riskSlots(manifest,target) {
  if(!target || !/^\d{14}$/.test(target.validtime) || !/^\d{14}$/.test(target.basetime))throw new Error("リスクの対象時刻が不正です");
  const end=Date.parse(utcTime(target.validtime));utcTime(target.basetime);
  const result={};
  for(const kind of Object.keys(RISK_LEVELS)) {
    const slots=manifest?.layers?.[kind]?.slots;
    if(!Array.isArray(slots) || slots.length>48)throw new Error("降水・降雪の対象一覧が不正です");
    const matches=slots.filter(s=>s.validtime===target.validtime && s.basetime===target.basetime && s.status==="available" && s.id===`${kind}_${target.validtime}`);
    if(matches.length!==1)throw new Error("天気と道路判定の予報発表・対象時刻が一致しません");
    result[kind]=matches[0];
  }
  const temperatures=liveSlots(manifest,"temp3h");
  result.temperatures=Array.from({length:5},(_,i)=>temperatures.find(s=>s.status!=="unavailable" && s.basetime===target.basetime && Date.parse(utcTime(s.validtime))===end+i*3*3600000) ?? null);
  if(!result.temperatures.some(Boolean))throw new Error("同じ発表の予想気温がありません");
  return result;
}

function ringsOf(geometry) {
  if(geometry?.type==="Polygon" && Array.isArray(geometry.coordinates))return geometry.coordinates;
  if(geometry?.type==="MultiPolygon" && Array.isArray(geometry.coordinates))return geometry.coordinates.flat();
  throw new Error("気象分布の図形が不正です");
}

// Scan the original polygon edges at native 5 km cell centres. Even-odd
// crossings preserve disconnected parts and holes in JMA's category polygons.
// NoData is an explicit mask; transparency is never used to infer zero.
export function projectRiskField(collection,grid,kind) {
  const levels=RISK_LEVELS[kind];
  if(!levels || collection?.type!=="FeatureCollection" || !Array.isArray(collection.features) || collection.features.length!==Object.keys(levels).length)throw new Error("気象区分の数が不正です");
  if(grid.rowScale!==20 || grid.colScale!==16 || grid.rows.length!==grid.count || grid.cols.length!==grid.count)throw new Error("リスクの約5km格子が不正です");
  const rows=new Map(),seen=new Set();
  for(let i=0;i<grid.count;i++) {
    const row=grid.rows[i];if(!rows.has(row))rows.set(row,[]);rows.get(row).push(i);
  }
  const rowMin=Math.min(...rows.keys()),rowMax=Math.max(...rows.keys());
  const fields=[];
  let vertices=0;
  for(const feature of collection.features) {
    const name=feature?.properties?.level;
    if(!Object.hasOwn(levels,name) || seen.has(name))throw new Error("未知・重複した気象区分です");
    seen.add(name);
    const crossings=new Map();
    for(const ring of ringsOf(feature.geometry)) {
      if(!Array.isArray(ring) || ring.length<4 || vertices+ring.length>300000)throw new Error("気象区分の境界が不正です");
      vertices+=ring.length;
      // JMA's global NoData outer ring uses an unwrapped -45..315° span.
      // Keep that continuous ring; wrapping vertices would invert its mask.
      for(const p of ring)if(!Array.isArray(p) || p.length!==2 || p.some(n=>!Number.isFinite(n)) || p[0]<-180 || p[0]>(name==="NoData"?360:180) || Math.abs(p[1])>90)throw new Error("気象区分の座標が不正です");
      let points=ring;
      if(ring[0].some((n,i)=>n!==ring.at(-1)[i])) {
        // The upstream NoData world rectangle omits its repeated last point.
        // Accept only those four known corners; other open rings still fail.
        if(name!=="NoData" || ring.length!==4 || new Set(ring.map(p=>p.join(","))).size!==4 || ring.some(([x,y])=>![-45,315].includes(x) || ![-85,85].includes(y)))throw new Error("気象区分の境界が閉じていません");
        points=[...ring,ring[0]];
      }
      for(let i=1;i<points.length;i++) {
        const [ax,ay]=points[i-1],[bx,by]=points[i];if(ay===by)continue;
        const first=Math.max(rowMin,Math.ceil(Math.min(ay,by)*20-.5)),last=Math.min(rowMax,Math.ceil(Math.max(ay,by)*20-.5)-1);
        for(let row=first;row<=last;row++) {
          if(!rows.has(row))continue;
          const latitude=(row+.5)/20,x=ax+(latitude-ay)*(bx-ax)/(by-ay);
          if(!crossings.has(row))crossings.set(row,[]);crossings.get(row).push(x);
        }
      }
    }
    for(const xs of crossings.values()){xs.sort((a,b)=>a-b);if(xs.length%2)throw new Error("気象区分の境界を照合できません");}
    fields.push({value:levels[name],crossings});
  }
  const values=new Int16Array(grid.count);if(kind==="weather3h")values.fill(-1);
  // Apply NoData last, regardless of feature ordering.
  for(const {value,crossings} of fields.sort((a,b)=>(a.value===-1)-(b.value===-1)))for(const [row,xs] of crossings) {
    for(const index of rows.get(row)) {
      const longitude=(grid.cols[index]+.5)/16;
      let lo=0,hi=xs.length;
      while(lo<hi){const mid=(lo+hi)>>1;if(xs[mid]<=longitude)lo=mid+1;else hi=mid;}
      if(lo%2)values[index]=value;
    }
  }
  return values;
}

export function buildRiskData(grid,weather,precipitation,snowfall,samples) {
  const count=grid.count;
  if([weather,precipitation,snowfall].some(a=>a.length!==count) || samples.length!==5 || samples.some(a=>a && a.length!==count))throw new Error("リスクの格子数が一致しません");
  const classes=new Uint8Array(count),minimum=new Float32Array(count),complete=new Uint8Array(count),counts=Array(8).fill(0);
  for(let i=0;i<count;i++) {
    const temperatures=samples.map(a=>a?.[i] ?? NaN),valid=temperatures.filter(Number.isFinite);
    minimum[i]=valid.length?Math.min(...valid):NaN;complete[i]=valid.length===5?1:0;
    classes[i]=riskClass(weather[i],precipitation[i],snowfall[i],temperatures);counts[classes[i]]++;
  }
  return {grid,classes,minimum,complete,weather,precipitation,snowfall,counts};
}

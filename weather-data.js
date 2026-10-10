import {utcTime,timeLabel} from "./live-temperature-data.js";

export const WEATHER_ROOT="https://www.jma.go.jp/bosai/jmatile/data/";
export const WEATHER_PRODUCTS=Object.freeze({
  observed:{family:"suikeikishou",element:"wthr",name:"天気",label:"推計気象分布（天気）",resolution:"約1km",tileSize:512},
  forecast:{family:"wdist",element:"wm",name:"天気",label:"天気分布予報（天気）",resolution:"約5km",tileSize:256},
  precipitation:{family:"wdist",element:"r3",name:"3時間降水量",label:"天気分布予報（3時間降水量）",resolution:"約5km",tileSize:256,unit:"mm/3h"},
  snowfall:{family:"wdist",element:"s3",name:"3時間降雪量",label:"天気分布予報（3時間降雪量）",resolution:"約5km",tileSize:256,unit:"cm/3h"},
});
export const WEATHER_COLORS=["#ffaa00","#aaaaaa","#0041ff","#a0d2ff","#f2f2ff"];
export function weatherProduct(mode,view="weather") {
  if(!["observed","forecast"].includes(mode) || !["weather","precipitation","snowfall"].includes(view) || mode==="observed" && view!=="weather") throw new Error("気象分布の種類が不正です");
  return WEATHER_PRODUCTS[view==="weather"?mode:view];
}
export function weatherSlots(records,mode,view="weather") {
  const product=weatherProduct(mode,view);
  if(!product || !Array.isArray(records) || !records.length || records.length>96) throw new Error("天気の時刻情報が不正です");
  const slots=records.filter(row=>Array.isArray(row.elements) && row.elements.includes(product.element)).map(row=>{
    const base=utcTime(row.basetime),end=utcTime(row.validtime);
    if(row.member && row.member!=="none" || mode==="observed" && base!==end) throw new Error("天気の対象が不正です");
    const start=mode==="forecast"?new Date(Date.parse(end)-3*3600000).toISOString():end;
    if(mode==="forecast" && Date.parse(end)<=Date.parse(base)) throw new Error("天気の予報期間が不正です");
    return {basetime:row.basetime,validtime:row.validtime,base,start,end,id:row.validtime,
      label:mode==="observed"?timeLabel(end):`${timeLabel(start)}〜${timeLabel(end)}の予想`};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  if(!slots.length || new Set(slots.map(s=>s.id)).size!==slots.length) throw new Error("天気の対象が重複・欠落しています");
  return slots;
}
export function weatherTile(mode,slot,jmaZoom,view="weather") {
  const product=weatherProduct(mode,view);
  if(!product || ![4,6,8,10].includes(jmaZoom)) throw new Error("天気画像の指定が不正です");
  utcTime(slot.basetime);utcTime(slot.validtime);
  // JMA's 512-pixel observed tiles use half as many x/y tiles as its
  // 256-pixel forecast tiles at the same advertised zoom. Preserve both
  // native grids; an ordinary XYZ z substitution would shift observations.
  return {url:`${WEATHER_ROOT}${product.family}/${slot.basetime}/none/${slot.validtime}/surf/${product.element}/${jmaZoom}/{x}/{y}.png`,
    nativeZoom:jmaZoom-(mode==="observed"?1:0),tileSize:product.tileSize};
}
export function weatherNotice(mode,slot,now=Date.now()) {
  if(mode==="observed") return now-Date.parse(slot.end)>2*3600000?"実況天気の更新が遅れています。表示時刻を確認してください。":"";
  if(Date.parse(slot.end)<=now) return "この予想期間は過ぎています。実況値も確認してください。";
  return now-Date.parse(slot.base)>14*3600000?"予報発表から時間が経っています。発表時刻を確認してください。":"";
}

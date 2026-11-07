export const AMEDAS_ROOT="https://www.jma.go.jp/bosai/amedas/";
export const LIVE_SNOW_LABEL_ZOOM=7;
export const LIVE_SNOW_BANDS=Object.freeze([
  {min:0,label:"0cm",color:"#d6dadd"},
  {min:1,label:"1〜4cm",color:"#9fd2ff"},
  {min:5,label:"5〜19cm",color:"#228cff"},
  {min:20,label:"20〜49cm",color:"#0041ff"},
  {min:50,label:"50〜99cm",color:"#faf500"},
  {min:100,label:"100〜149cm",color:"#ff9900"},
  {min:150,label:"150〜199cm",color:"#fe2900"},
  {min:200,label:"200cm以上",color:"#b40068"},
].map(Object.freeze));
export function snowHour(value) {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value) || !Number.isFinite(Date.parse(value)))throw new Error("積雪の時刻が不正です");
  if(new Date(Date.parse(value)+9*3600000).toISOString().slice(0,19)!==value.slice(0,19))throw new Error("積雪の日付が不正です");
  const hour=value.slice(0,13)+":00:00+09:00";
  if(new Date(hour).toISOString()!==new Date(Date.parse(value)-new Date(value).getUTCMinutes()*60000-new Date(value).getUTCSeconds()*1000).toISOString())throw new Error("積雪の正時が不正です");
  return hour;
}
export function snowMapKey(hour) {
  if(snowHour(hour)!==hour)throw new Error("積雪は正時の観測を使用します");
  return hour.slice(0,19).replace(/[-:T]/g,"");
}
export function decodeSnowStations(table,data,hour) {
  snowMapKey(hour);
  if(!table || !data || Array.isArray(table) || Array.isArray(data) || Object.keys(table).length>2500 || Object.keys(data).length>2500)throw new Error("積雪観測の形式が不正です");
  const points=[];
  for(const [id,station] of Object.entries(table)) {
    if(!/^[0-9]{5}$/.test(id) || !/^[0-2]{8}$/.test(station.elems ?? ""))throw new Error("観測所の定義が不正です");
    if(station.elems[5]!=="1")continue;
    const coord=(pair)=>Array.isArray(pair) && pair.length===2 && pair.every(Number.isFinite) && pair[1]>=0 && pair[1]<60?pair[0]+pair[1]/60:NaN;
    const lat=coord(station.lat),lng=coord(station.lon);
    if(lat<20 || lat>48 || lng<122 || lng>154 || !Number.isFinite(lat+lng) || typeof station.kjName!=="string" || station.kjName.length>60)throw new Error("積雪観測点の位置が不正です");
    const raw=data[id]?.snow;
    if(raw!==undefined && (!Array.isArray(raw) || raw.length!==2 || !Number.isInteger(raw[1]) || raw[1]<0 || raw[1]>7 || raw[0]!==null && (!Number.isFinite(raw[0]) || raw[0]<0 || raw[0]>1500)))throw new Error("積雪深・品質が不正です");
    const quality=raw?.[1] ?? 7;
    const value=raw && raw[0]!==null && [0,1,4].includes(quality)?raw[0]:null;
    points.push({id,name:station.kjName,lng,lat,value,quality,hour,usable:quality===0 && value!==null});
  }
  if(!points.length || points.length>1000)throw new Error("積雪観測点がありません");
  return points;
}
export function snowStationValue(point) {
  return point.value===null?"資料なし":`${point.value}cm`;
}
export function snowStationLabel(point) {
  if(point.value===null)return "資料なし（観測休止・欠測等）";
  return `${snowStationValue(point)}${point.quality!==0?"・参考値":""}`;
}

export function snowPointColor(value) {
  if(value===null)return null;
  if(!Number.isFinite(value) || value<0 || value>1500)throw new Error("積雪深の表示値が不正です");
  return LIVE_SNOW_BANDS.findLast(band=>value>=band.min).color;
}

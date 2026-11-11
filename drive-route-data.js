import { ROAD_RISK_COLORS } from "./road-risk-data.js?v=20261110-risk-colors1";
// Route geometry and elapsed time stay independent of weather and the UI.
export const ROUTE_API = "https://valhalla1.openstreetmap.de/route";
export const ROUTE_LIMIT_KM = 1000;
export const ROUTE_COLORS = Object.freeze(ROAD_RISK_COLORS.map((color,i)=>i===1?"#197c88":color));
export const PRIORITIES = {fastest:"時間優先",highway:"高速優先",local:"一般道優先",shortest:"距離優先"};
export const ROAD_KIND_LABELS = {highway:"高速道路",local:"一般道",unknown:"区分不明"};

export function validPoint(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)
    && point[0] >= 122 && point[0] <= 154 && point[1] >= 20 && point[1] <= 48;
}
export function kmBetween(a,b) {
  const r=Math.PI/180, dlat=(b[1]-a[1])*r, dlon=(b[0]-a[0])*r;
  return 12742*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin(dlon/2)**2)));
}
export function departureTime(value,now=Date.now()) {
  if (!value) return now;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("出発日時を確認してください");
  const stamp=Date.parse(value+":00+09:00");
  if (!Number.isFinite(stamp) || new Date(stamp+9*3600000).toISOString().slice(0,16)!==value) throw new Error("出発日時を確認してください");
  return stamp;
}
export function routeRequest(start,end,priority,departure) {
  if (!validPoint(start) || !validPoint(end) || !Object.hasOwn(PRIORITIES,priority)) throw new Error("日本付近の始点・終点と検索条件を指定してください");
  const direct=kmBetween(start,end);
  if (direct < .05 || direct > ROUTE_LIMIT_KM) throw new Error("始点と終点は50m以上、直線で1000km以内にしてください");
  const options={use_ferry:0,exclude_ferries:true};
  if (priority==="highway") Object.assign(options,{use_highways:1,use_tolls:1});
  if (priority==="local") Object.assign(options,{use_highways:0,use_tolls:0});
  if (priority==="shortest") options.shortest=true;
  return {locations:[start,end].map(([lon,lat])=>({lon,lat,search_cutoff:1000})),costing:"auto",costing_options:{auto:options},units:"kilometers",language:"ja-JP",elevation_interval:250,
    date_time:{type:1,value:new Date(departure+9*3600000).toISOString().slice(0,16)}};
}
export function decodePolyline(text) {
  if (typeof text!=="string" || text.length>2000000) throw new Error("経路の形状が不正です");
  const points=[];let at=0,lat=0,lng=0;
  function delta(){let value=0,shift=0,part;do{if(at>=text.length || shift>30)throw new Error("経路の形状が途中で切れています");part=text.charCodeAt(at++)-63;if(part<0 || part>63)throw new Error("経路の座標が不正です");value+=(part&31)*2**shift;shift+=5;}while(part>=32);return value%2?-(value+1)/2:value/2;}
  while(at<text.length){lat+=delta();lng+=delta();const p=[lng/1e6,lat/1e6];if(!validPoint(p))throw new Error("経路が日本付近の範囲外です");points.push(p);if(points.length>100000)throw new Error("経路が長すぎます");}
  if(points.length<2)throw new Error("経路が見つかりません");return points;
}
export function decodeRoute(json) {
  const trip=json?.trip, leg=trip?.legs?.[0];
  if(trip?.status!==0 || trip.legs.length!==1 || !leg || trip.summary?.has_ferry)throw new Error("自動車だけで通る経路を取得できません");
  const distance=leg.summary?.length,seconds=leg.summary?.time;
  if(!Number.isFinite(distance) || distance<=0 || distance>ROUTE_LIMIT_KM || !Number.isFinite(seconds) || seconds<=0 || seconds>48*3600)throw new Error("無料試作版は1000km・走行48時間以内の経路に対応します");
  const coordinates=decodePolyline(leg.shape),distances=[0],times=new Array(coordinates.length).fill(null);
  for(let i=1;i<coordinates.length;i++)distances.push(distances[i-1]+kmBetween(coordinates[i-1],coordinates[i]));
  const geometricLength=distances.at(-1);
  if(geometricLength<=0 || Math.abs(geometricLength-distance)>Math.max(.5,distance*.05))throw new Error("経路の長さと形状が一致しません");
  for(let i=0;i<distances.length;i++)distances[i]*=distance/geometricLength;
  if(!Array.isArray(leg.maneuvers) || leg.maneuvers.length>20000)throw new Error("区間ごとの所要時間がありません");
  // Valhalla omits highway=false. Check the summary before interpreting omission
  // as a local road; old/inconsistent responses must remain unknown.
  const highwayInfo=typeof trip.summary?.has_highway==="boolean"
    && trip.summary.has_highway===leg.maneuvers.some(m=>m.highway===true)
    && leg.maneuvers.every(m=>m.highway===undefined||typeof m.highway==="boolean");
  const roadSections=[];
  let elapsed=0,previous=0;
  for(const m of leg.maneuvers){
    const a=m.begin_shape_index,b=m.end_shape_index;
    if(!Number.isInteger(a)||!Number.isInteger(b)||a!==previous||b<a||b>=coordinates.length||!Number.isFinite(m.time)||m.time<0)throw new Error("区間ごとの所要時間が不正です");
    for(let i=a;i<=b;i++)times[i]=elapsed+(distances[b]===distances[a]?0:(distances[i]-distances[a])/(distances[b]-distances[a])*m.time);
    if(distances[b]>distances[a]){
      const kind=highwayInfo?(m.highway?"highway":"local"):"unknown",last=roadSections.at(-1);
      // These are guidance sections, not surveyed road boundaries. A maneuver's
      // highway flag means it contains a highway; explain the boundary precision in the UI.
      if(last?.kind===kind)last.endKm=distances[b];
      else roadSections.push({startKm:distances[a],endKm:distances[b],kind});
    }
    elapsed+=m.time;previous=b;
  }
  if(previous!==coordinates.length-1 || times.some(t=>t===null) || Math.abs(elapsed-seconds)>Math.max(5,seconds*.01))throw new Error("区間ごとの所要時間を照合できません");
  // Small serialization rounding is distributed over the full duration.
  for(let i=0;i<times.length;i++)times[i]*=seconds/elapsed;
  const elevation=leg.elevation,interval=leg.elevation_interval;
  const hasElevation=Array.isArray(elevation) && elevation.length>1 && elevation.length<=10000 && Number.isFinite(interval) && interval>0
    && Math.abs((elevation.length-1)*interval-distance*1000)<interval*2+100;
  return {coordinates,distances,times,distance,seconds,roadSections,elevation:hasElevation?elevation:null,elevationInterval:interval,hasHighway:Boolean(trip.summary.has_highway),hasToll:Boolean(trip.summary.has_toll)};
}
export function roadKindAt(route,km) {
  if(!Number.isFinite(km)||km<0||km>route.distance)return "unknown";
  const sections=route.roadSections||[];
  return sections.find((s,i)=>km>=s.startKm&&(km<s.endKm||(i===sections.length-1&&km===s.endKm)))?.kind||"unknown";
}
export function validateBreaks(breaks,distance) {
  if(!Array.isArray(breaks)||breaks.length>12)throw new Error("休憩は12か所まで指定できます");
  return breaks.map(b=>{
    if(!Number.isFinite(b.km)||b.km<0||b.km>=distance||!Number.isFinite(b.minutes)||b.minutes<=0||b.minutes>1440)throw new Error("休憩位置は到着前の距離、休憩時間は1〜1440分で指定してください");
    return {...b};
  }).sort((a,b)=>a.km-b.km);
}
function interpolateAt(route,km) {
  let lo=0,hi=route.distances.length-1;
  while(lo<hi){const m=(lo+hi)>>1;if(route.distances[m]<km)lo=m+1;else hi=m;}
  const b=lo,a=Math.max(0,b-1),span=route.distances[b]-route.distances[a],f=span?(km-route.distances[a])/span:0;
  const coordinate=route.coordinates[a].map((v,i)=>v+(route.coordinates[b][i]-v)*f);
  let elevation=null;
  if(route.elevation){const meters=km*1000,last=route.elevation.length-1,j=Math.min(Math.floor(meters/route.elevationInterval),last-1),next=j+1;
    const from=j*route.elevationInterval,to=next===last?route.distance*1000:next*route.elevationInterval,u=Math.max(0,Math.min(1,(meters-from)/(to-from)));
    const z=route.elevation[j],w=route.elevation[next];if([z,w,u].every(Number.isFinite)&&[z,w].every(v=>v>=-500&&v<9000))elevation=z+(w-z)*u;}
  return {coordinate,seconds:route.times[a]+(route.times[b]-route.times[a])*f,elevation};
}
export function sampleRoute(route,departure,breaks=[]) {
  const stops=validateBreaks(breaks,route.distance),count=Math.ceil(route.distance/.5);
  const positions=[...new Set([...Array.from({length:count+1},(_,i)=>route.distance*i/count),...stops.map(b=>b.km)])].sort((a,b)=>a-b);
  return positions.flatMap(km=>{
    const point=interpolateAt(route,km),rest=stops.filter(b=>b.km<km-1e-8).reduce((sum,b)=>sum+b.minutes*60,0);
    const minutes=stops.filter(b=>Math.abs(b.km-km)<1e-8).reduce((sum,b)=>sum+b.minutes,0);
    const arrival={...point,km,roadKind:roadKindAt(route,km),time:departure+(point.seconds+rest)*1000,restMinutes:0};
    return minutes?[arrival,{...arrival,time:arrival.time+minutes*60000,restMinutes:minutes}]:[arrival];
  });
}
export function routeSegments(route,samples) {
  let cursor=0;
  return {type:"FeatureCollection",features:samples.slice(0,-1).map((sample,i)=>{
    const next=samples[i+1],coordinates=[sample.coordinate];
    while(cursor<route.coordinates.length && route.distances[cursor]<=sample.km)cursor++;
    while(cursor<route.coordinates.length && route.distances[cursor]<next.km)coordinates.push(route.coordinates[cursor++]);
    coordinates.push(next.coordinate);
    // A missing end remains unknown; known ends take the more severe rank.
    const rank=sample.rank===0||next.rank===0?0:Math.max(sample.rank,next.rank);
    return {type:"Feature",properties:{index:i,rank,color:ROUTE_COLORS[rank],source:sample.source},geometry:{type:"LineString",coordinates}};
  })};
}
export function estimateSnow(stations,point) {
  const nearest=stations.filter(s=>s.usable && Number.isFinite(s.value) && s.value>=0).map(s=>({...s,distance:kmBetween([s.lng,s.lat],point)})).filter(s=>s.distance<=100).sort((a,b)=>a.distance-b.distance).slice(0,4);
  if(!nearest.length)return null;
  if(nearest[0].distance<.1)return {value:nearest[0].value,count:1,distance:nearest[0].distance};
  const weights=nearest.map(s=>1/Math.max(1,s.distance)**2),sum=weights.reduce((a,b)=>a+b,0);
  return {value:nearest.reduce((v,s,i)=>v+s.value*weights[i],0)/sum,count:nearest.length,distance:nearest[0].distance};
}

export function createRouteClient(fetchImpl=fetch,now=Date.now) {
  let last=-Infinity;
  return async (request,signal)=>{
    if(now()-last<1500)throw new Error("経路検索は少し間をあけて再実行してください");last=now();
    const response=await fetchImpl(ROUTE_API,{method:"POST",headers:{"Content-Type":"application/json","X-Client-Id":"bousai-wx-lab.github.io/winter-road-navi"},body:JSON.stringify(request),credentials:"omit",referrerPolicy:"no-referrer",signal});
    if(!response.ok)throw new Error(response.status===429?"無料経路サービスが混み合っています。時間をおいて再実行してください":"経路を取得できません。道路に近い地点を選び直してください");
    const text=await response.text();if(text.length>5000000)throw new Error("経路データが大きすぎます");return decodeRoute(JSON.parse(text));
  };
}

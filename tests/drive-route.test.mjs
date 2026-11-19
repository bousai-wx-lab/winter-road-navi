import test from "node:test";
import assert from "node:assert/strict";
import {departureTime,returnDepartureTime,routeRequest,decodePolyline,decodeRoute,sampleRoute,routeSegments,estimateSnow,createRouteClient,roadKindAt,kmBetween,ROUTE_LIMIT_KM,ROUTE_LIMIT_HOURS} from "../drive-route-data.js";
import {forecastPeriods,sourceForTime,createDriveWeather,forecastSnowfallLabel} from "../drive-weather-data.js";
import {RISK_LEVELS} from "../forecast-risk-data.js";

const departure=Date.parse("2026-11-10T07:00:00+09:00");
test("empty departure is now; entered wall time is always JST and invalid dates fail",()=>{
  assert.equal(departureTime("",1234),1234);assert.equal(departureTime("2026-11-10T07:00"),departure);
  assert.throws(()=>departureTime("2027-02-29T07:00"));assert.throws(()=>departureTime("2026-11-10T25:00"));
});
test("all four route priorities are sent to the engine without pretending they are hard exclusions",()=>{
  const get=p=>routeRequest([138.18,36.64],[138.63,36.34],p,departure).costing_options.auto;
  assert.equal(get("local").use_highways,0);assert.equal(get("local").use_tolls,0);
  assert.equal(get("highway").use_highways,1);assert.equal(get("shortest").shortest,true);
  assert.equal(get("fastest").shortest,undefined);assert.equal(get("fastest").exclude_ferries,true);
  assert.throws(()=>routeRequest([0,0],[138,36],"local",departure));
});
const route={coordinates:[[138,36],[138.01,36.01],[138.02,36]],distances:[0,1,2],times:[0,600,1200],distance:2,seconds:1200,elevation:[100,200,300],elevationInterval:1000};
test("rests affect departure from a stop, not arrival; multiple rests accumulate at every later segment",()=>{
  const points=sampleRoute(route,departure,[{km:1,minutes:30},{km:1.5,minutes:10}]);
  const stop=points.filter(s=>s.km===1);assert.equal(stop.length,2);
  assert.equal(stop[0].time,departure+600000);assert.equal(stop[1].time,departure+2400000);
  assert.equal(points.at(-1).time,departure+(1200+2400)*1000);
  assert.equal(points.at(-1).elevation,300);
  assert.throws(()=>sampleRoute(route,departure,[{km:2,minutes:5}]));
  assert.throws(()=>sampleRoute(route,departure,[{km:1,minutes:-1}]));
});
test("return time uses the outbound arrival including its own rests, or a specified JST date",()=>{
  const arrival=sampleRoute(route,departure,[{km:1,minutes:30}]).at(-1).time;
  const leave=hours=>returnDepartureTime({method:"stay",hours},arrival);
  assert.equal(leave("1.5"),Date.parse("2026-11-10T09:20:00+09:00"));
  assert.equal(leave("2"),leave("1.5")+30*60000);
  assert.equal(leave("0"),arrival);
  assert.equal(returnDepartureTime({method:"departure",departure:"2026-11-11T17:00"},arrival),
    Date.parse("2026-11-11T17:00:00+09:00"));
  assert.throws(()=>leave(""),/滞在時間/);
  assert.throws(()=>leave("-1"),/滞在時間/);
  assert.throws(()=>returnDepartureTime({method:"departure",departure:"2026-11-10T07:30"},arrival),/到着予定時刻以降/);
  assert.throws(()=>returnDepartureTime({method:"departure",departure:""},arrival),/入力/);
});
test("map risk segments retain original road bends and mark missing samples unknown",()=>{
  const samples=[{coordinate:route.coordinates[0],km:0,rank:3,source:"forecast"},{coordinate:route.coordinates[2],km:2,rank:7,source:"forecast"}];
  const feature=routeSegments(route,samples).features[0];assert.deepEqual(feature.geometry.coordinates,route.coordinates);assert.equal(feature.properties.rank,7);
  samples[1].rank=0;assert.equal(routeSegments(route,samples).features[0].properties.rank,0);
});
test("the last elevation sample belongs to the destination even if the final interval is short",()=>{
  const r={...route,distance:2.1,distances:[0,1,2.1],elevation:[100,200,300,350]};
  assert.equal(sampleRoute(r,departure).at(-1).elevation,350);
});
test("snow interpolation keeps real zero, rejects missing/bad quality and does not extrapolate past 100km",()=>{
  const stations=[{lng:138,lat:36,value:0,usable:true},{lng:138.1,lat:36,value:20,usable:true},{lng:138,lat:36,value:100,usable:false}];
  assert.equal(estimateSnow(stations,[138,36]).value,0);
  const estimate=estimateSnow(stations,[138.05,36]);assert.ok(Math.abs(estimate.value-10)<.01);assert.equal(estimate.count,2);
  assert.equal(estimateSnow(stations,[145,43]),null);assert.equal(estimateSnow([{...stations[0],value:null}],[138,36]),null);
});
const manifest={generated_at:"2026-11-10T05:00:00+09:00",layers:{weather3h:{slots:[{id:"weather3h_20261110000000",validtime:"20261110000000",basetime:"20261109200000",status:"available"},{id:"weather3h_20261110030000",validtime:"20261110030000",basetime:"20261109200000",status:"unavailable"}]}}};
test("forecast boundaries are determined per arrival time; missing slots within horizon do not become normals",()=>{
  const periods=forecastPeriods(manifest,departure);
  assert.equal(sourceForTime(Date.parse("2026-11-10T06:00+09:00"),periods).source,"forecast");
  assert.equal(sourceForTime(Date.parse("2026-11-10T09:00+09:00"),periods).target.validtime,"20261110000000");
  assert.equal(sourceForTime(Date.parse("2026-11-10T10:00+09:00"),periods).target,null);
  assert.equal(sourceForTime(Date.parse("2026-11-10T12:00:00.001+09:00"),periods).source,"normal");
  assert.equal(sourceForTime(Date.parse("2026-11-10T05:59:59+09:00"),periods).source,"normal");
  assert.throws(()=>forecastPeriods(manifest,departure+24*3600000));
});

const forecastTimes = {
  morningStart: "20261109210000",
  morningEnd: "20261110000000",
  noon: "20261110030000",
  eveningStart: "20261110060000",
  eveningEnd: "20261110090000",
};
function forecastWeatherFixture({wrongMorningIssue = false, missingEveningFile = false} = {}) {
  const temperatureValues = [-1, 4, 8, 6, 1];
  const times = Object.values(forecastTimes);
  const layers = {};
  for (const kind of ["temp3h", "weather3h", "precip3h", "snow3h"]) {
    layers[kind] = {slots: (kind === "temp3h" ? times : times.slice(1)).map(validtime => ({
      id: `${kind}_${validtime}`, validtime, status: "available", target_date: "2026-11-10",
      basetime: wrongMorningIssue && kind === "temp3h" && validtime === forecastTimes.morningStart
        ? "20261109170000" : "20261109200000",
    }))};
  }
  const manifest = {generated_at: "2026-11-10T05:00:00+09:00", layers};
  const area = [[[137,35],[139,35],[139,37],[137,37],[137,35]]];
  const temperatureRequests = [];
  async function fetchImpl(url) {
    const file = new URL(url).pathname.split("/").at(-1);
    if (file === "forecast_manifest.json") return Response.json(manifest);
    const match = /^forecast_(\w+?)_(\d{14})_value\.(geojson|csv)$/.exec(file);
    assert.ok(match, file);
    const [,kind,validtime] = match;
    if (kind === "temp3h") {
      temperatureRequests.push(validtime);
      if (missingEveningFile && validtime === forecastTimes.eveningEnd) return new Response("", {status: 404});
      const value = temperatureValues[times.indexOf(validtime)];
      const rows = ["longitude,latitude,forecast_c,source_date,target_date"];
      for (let row=600; row<763; row++) {
        for (let col=2080; col<2272; col++) rows.push(`${(col+.5)/16},${(row+.5)/20},${value},2026-11-10,2026-11-10`);
      }
      return new Response(rows.join("\n"));
    }
    const level = kind === "weather3h" ? "Rain" : kind === "precip3h" ? "1<=mm<5" : null;
    return Response.json({
      type: "FeatureCollection",
      features: Object.keys(RISK_LEVELS[kind]).map(code => ({
        type: "Feature", properties: {level: code},
        geometry: {type: "Polygon", coordinates: code === level ? area : []},
      })),
    });
  }
  return {fetchImpl, temperatureRequests};
}

const forecastTime = clock => Date.parse(`2026-11-10T${clock}+09:00`);
const samplesAt = (...clocks) => clocks.map(clock => ({coordinate: [138,36], time: forecastTime(clock), km: 0}));

test("drive uses the colder endpoint for the forecast temperature and route risk, including the exact frame end", async () => {
  const {fetchImpl, temperatureRequests} = forecastWeatherFixture();
  const analyze = createDriveWeather({fetchImpl, now: () => departure});
  const {samples} = await analyze(samplesAt("06:30", "09:00", "09:01", "17:30"));
  assert.deepEqual(samples.map(s => [s.temperature, s.temperatureTime, s.rank]), [
    ["-1.0℃", forecastTime("06:00"), 4],
    ["-1.0℃", forecastTime("06:00"), 4],
    ["4.0℃", forecastTime("09:00"), 2],
    ["1.0℃", forecastTime("18:00"), 3],
  ]);
  assert.deepEqual(samples.map(s => s.forecastEnd), ["09:00", "09:00", "12:00", "18:00"].map(forecastTime));
  assert.ok(samples.every(s => s.weather === "雨" && s.snowfall === "降雪量なし"));
  assert.equal(temperatureRequests.filter(validtime => validtime === forecastTimes.morningEnd).length, 1);
  const stops = (a, b) => [{...a, km: 0}, {...b, km: 2}];
  assert.equal(routeSegments(route, stops(samples[0], samples[1])).features[0].properties.color, "#ff8c24");
  assert.equal(routeSegments(route, stops(samples[3], samples[3])).features[0].properties.color, "#ffe032");
});

test("a missing or different-issue endpoint never substitutes one temperature or discards the frame's weather", async () => {
  const {fetchImpl, temperatureRequests} = forecastWeatherFixture({wrongMorningIssue: true, missingEveningFile: true});
  const analyze = createDriveWeather({fetchImpl, now: () => departure});
  const {samples, notices} = await analyze(samplesAt("06:30", "17:30"));
  for (const sample of samples) {
    assert.equal(sample.source, "forecast");
    assert.equal(sample.temperature, "資料なし");
    assert.equal(sample.temperatureTime, null);
    assert.equal(sample.rank, 0);
    assert.equal(sample.weather, "雨");
    assert.equal(sample.snowfall, "降雪量なし");
  }
  assert.ok(!temperatureRequests.includes(forecastTimes.morningStart));
  assert.equal(notices.length, 1);
});
test("drive readout keeps official snowfall ranges and distinguishes no snowfall from missing data",()=>{
  assert.deepEqual([0,1,3,6,-1,null].map(forecastSnowfallLabel),
    ["降雪量なし","1〜2cm","3〜5cm","6cm以上","資料なし","資料なし"]);
});
test("manifest failures fail closed without showing climatology as the current forecast",async()=>{
  const analyze=createDriveWeather({fetchImpl:async()=>{throw new Error("offline");},now:()=>departure});
  const result=await analyze([{coordinate:[138,36],time:departure,km:0}],new AbortController().signal);
  assert.equal(result.samples[0].rank,0);assert.equal(result.samples[0].source,"unknown");
});
test("abort remains an abort; it cannot yield a late result",async()=>{
  const abort=new AbortController();abort.abort();
  const analyze=createDriveWeather({fetchImpl:async()=>{throw new DOMException("Aborted","AbortError");}});
  await assert.rejects(analyze([],abort.signal),{name:"AbortError"});
});
test("route service reports failure without automatic retries, observes rate limit and identifies the client",async()=>{
  const calls=[];const client=createRouteClient(async(url,options)=>{calls.push(options);return new Response("",{status:429});},()=>2000);
  await assert.rejects(client({}),/混み合/);await assert.rejects(client({}),/間をあけ/);assert.equal(calls.length,1);
  assert.equal(calls[0].headers["X-Client-Id"],"bousai-wx-lab.github.io/winter-road-navi");assert.equal(calls[0].credentials,"omit");
});
test("cancelling during the inter-leg wait sends no return request",async()=>{
  let requests=0;
  const client=createRouteClient(async()=>{requests++;return new Response("",{status:429});},()=>2000);
  await assert.rejects(client({}),/混み合/);
  const abort=new AbortController();
  const returning=client({},abort.signal,{waitForCooldown:true});
  abort.abort();
  await assert.rejects(returning,{name:"AbortError"});
  assert.equal(requests,1);
});
test("invalid geometry, service failures and impossible duration cannot turn into a straight route",()=>{
  assert.throws(()=>decodePolyline("?"));assert.throws(()=>decodeRoute({trip:{status:1,legs:[]}}));
  assert.throws(()=>decodeRoute({trip:{status:0,legs:[{summary:{length:1001,time:5000}}]}}));
});

function roadFixture(){
  const points=[[138,36],[138.01,36],[138.02,36],[138.03,36],[138.04,36]],last=[0,0];
  const encode=n=>{n=n<0?-n*2-1:n*2;let s="";while(n>=32){s+=String.fromCharCode((n%32|32)+63);n=Math.floor(n/32);}return s+String.fromCharCode(n+63);};
  const shape=points.map(p=>[p[1],p[0]].map((v,i)=>{const n=Math.round(v*1e6),s=encode(n-last[i]);last[i]=n;return s;}).join("")).join("");
  const length=points.slice(1).reduce((sum,p,i)=>sum+kmBetween(points[i],p),0),summary={length,time:400,has_highway:true};
  return {trip:{status:0,summary,legs:[{shape,summary,maneuvers:[
    {begin_shape_index:0,end_shape_index:1,time:100},
    {begin_shape_index:1,end_shape_index:2,time:100,highway:true},
    {begin_shape_index:2,end_shape_index:3,time:100,highway:true},
    {begin_shape_index:3,end_shape_index:4,time:100},
    {begin_shape_index:4,end_shape_index:4,time:0}
  ]}]}};
}
test("road sections retain distance boundaries, merge adjacent guidance sections, and survive rests",()=>{
  const r=decodeRoute(roadFixture());
  assert.deepEqual(r.roadSections.map(s=>s.kind),["local","highway","local"]);
  const boundary=r.distances[1];
  assert.equal(r.roadSections[1].startKm,boundary);assert.equal(r.roadSections[1].endKm,r.distances[3]);
  assert.equal(roadKindAt(r,0),"local");assert.equal(roadKindAt(r,boundary-.00001),"local");
  assert.equal(roadKindAt(r,boundary),"highway");assert.equal(roadKindAt(r,r.distance),"local");
  assert.equal(roadKindAt(r,-1),"unknown");assert.equal(roadKindAt(r,r.distance+1),"unknown");
  const stop=sampleRoute(r,departure,[{km:boundary,minutes:20}]).filter(s=>s.km===boundary);
  assert.deepEqual(stop.map(s=>s.roadKind),["highway","highway"]);assert.equal(stop[1].time-stop[0].time,1200000);
});
test("all-local routes accept omitted false flags; absent or inconsistent road metadata stays unknown",()=>{
  const local=roadFixture();local.trip.summary.has_highway=false;
  for(const m of local.trip.legs[0].maneuvers)delete m.highway;
  assert.deepEqual(decodeRoute(local).roadSections.map(s=>s.kind),["local"]);
  for(const mutate of [j=>delete j.trip.summary.has_highway,j=>j.trip.summary.has_highway=false,j=>j.trip.legs[0].maneuvers[0].highway="false"]){
    const json=roadFixture();mutate(json);const r=decodeRoute(json);
    assert.deepEqual(r.roadSections.map(s=>s.kind),["unknown"]);
    assert.ok(sampleRoute(r,departure).every(s=>s.roadKind==="unknown"));
  }
});

function nationalRouteFixture() {
  const points=[[130,25],[130,40],[130,25],[130,40]],last=[0,0];
  const encode=n=>{n=n<0?-n*2-1:n*2;let s="";while(n>=32){s+=String.fromCharCode((n%32|32)+63);n=Math.floor(n/32);}return s+String.fromCharCode(n+63);};
  const shape=points.map(p=>[p[1],p[0]].map((v,i)=>{const n=Math.round(v*1e6),s=encode(n-last[i]);last[i]=n;return s;}).join("")).join("");
  const summary={length:ROUTE_LIMIT_KM,time:ROUTE_LIMIT_HOURS*3600,has_highway:false,has_ferry:false};
  return {trip:{status:0,summary,legs:[{shape,summary,elevation_interval:250,
    elevation:Array.from({length:ROUTE_LIMIT_KM*4+1},(_,i)=>i%500),
    maneuvers:[{begin_shape_index:0,end_shape_index:3,time:summary.time}]}]}};
}
test("national drive requests accept Kagoshima to Aomori and mainland-to-Hokkaido distances",()=>{
  for(const [from,to] of [[[130.51203,31.58331],[140.68687,40.78849]],[[130.66,31.0],[141.94,45.52]]]) {
    assert.ok(kmBetween(from,to)>1000);
    const request=routeRequest(from,to,"fastest",departure);
    assert.equal(request.costing_options.auto.exclude_ferries,true);
    assert.equal(request.elevation_interval,250);
  }
});
test("5000km and 120 driving hours retain elevation, 500m weather spacing, rests and endpoint timing",()=>{
  const r=decodeRoute(nationalRouteFixture());
  assert.equal(r.elevation.length,20001);
  const samples=sampleRoute(r,departure,[{km:1234.56,minutes:60}]);
  assert.equal(samples.at(-1).km,5000);
  assert.equal(samples.at(-1).time,departure+(120+1)*3600000);
  assert.equal(samples.at(-1).elevation,r.elevation.at(-1));
  assert.ok(samples.every((p,i)=>i===0 || p.km-samples[i-1].km<=.500001));
  assert.equal(samples.filter(p=>p.km===1234.56).length,2);
  assert.equal(routeSegments(r,samples.map(p=>({...p,rank:2,source:"normal"}))).features.length,samples.length-1);
});
test("routes exceeding the expanded distance or driving-time boundary still fail",()=>{
  for(const [key,value] of [["length",ROUTE_LIMIT_KM+.01],["time",ROUTE_LIMIT_HOURS*3600+1]]) {
    const json=nationalRouteFixture();json.trip.legs[0].summary[key]=value;
    assert.throws(()=>decodeRoute(json),/片道5000km・走行120時間/);
  }
  const json=nationalRouteFixture();json.trip.summary.has_ferry=true;
  assert.throws(()=>decodeRoute(json),/自動車だけ/);
});

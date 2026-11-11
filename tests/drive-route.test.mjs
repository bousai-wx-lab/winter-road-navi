import test from "node:test";
import assert from "node:assert/strict";
import {departureTime,routeRequest,decodePolyline,decodeRoute,sampleRoute,routeSegments,estimateSnow,createRouteClient,roadKindAt,kmBetween} from "../drive-route-data.js";
import {forecastPeriods,sourceForTime,createDriveWeather} from "../drive-weather-data.js";

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

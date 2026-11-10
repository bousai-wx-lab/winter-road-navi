import test from "node:test";
import assert from "node:assert/strict";
import {departureTime,routeRequest,decodePolyline,decodeRoute,sampleRoute,routeSegments,estimateSnow,createRouteClient} from "../drive-route-data.js";
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

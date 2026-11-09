import test from "node:test";
import assert from "node:assert/strict";
import {forecastSnowSlots,forecastSnowGrid,addForecastSnow,createSnowForecastLoader} from "../forecast-snow-data.js";
import {projectRiskField} from "../forecast-risk-data.js";

const hour="2026-11-08T10:00:00+09:00",base="20261107200000";
const stamp=h=>`20261108${String(h-9).padStart(2,"0")}0000`;
const target=h=>({basetime:base,validtime:stamp(h)});
function manifest(hours=[9,12,15,18]) {
  return {generated_at:"2026-11-08T06:00:00+09:00",layers:{snow3h:{slots:hours.map(h=>({id:`snow3h_${stamp(h)}`,validtime:stamp(h),basetime:base,status:"available"}))}}};
}
const stations=[10,0,null,5].map((value,i)=>({id:String(10001+i),name:`試験${i}`,lng:137.5+i*.0625,lat:35,value,quality:value===null?7:0}));
const square=(x,y,w=.0625,h=.05)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]];
function geometry(values) {
  return {type:"FeatureCollection",features:[[1,"1<=cm<3"],[3,"3<=cm<6"],[6,"6<=cm"],[-1,"NoData"]].map(([v,level])=>({type:"Feature",properties:{level},geometry:{type:"Polygon",coordinates:values.flatMap((n,i)=>n===v?[square(137.5+i*.0625,35)]:[])}}))};
}
test("selected time accumulates full 3h classes after the latest observation, including the overlapping first period",()=>{
  const plan=forecastSnowSlots(manifest(),target(18),hour);
  assert.deepEqual(plan.slots.map(s=>s.validtime),[stamp(12),stamp(15),stamp(18)]);
  assert.equal(plan.start,"2026-11-08T00:00:00.000Z");assert.equal(plan.overlapHours,1);assert.equal(plan.gapHours,0);
  assert.equal(forecastSnowSlots(manifest(),target(12),hour).slots.length,1);
  assert.equal(forecastSnowSlots(manifest(),target(9),"2026-11-08T09:00:00+09:00").slots.length,0,"a period ending at the observation is already observed");
  assert.throws(()=>forecastSnowSlots(manifest(),target(9),hour),/実況より前/);
  const gap=forecastSnowSlots(manifest([15,18]),target(18),"2026-11-08T11:00:00+09:00");assert.equal(gap.gapHours,0);assert.equal(gap.overlapHours,2);assert.equal(gap.missingSlots,1);
  assert.equal(forecastSnowSlots(manifest([18]),target(18),hour).missingSlots,2);
});
test("missing steps become zero contributions; mixed forecast issues and duplicates still fail closed",()=>{
  assert.equal(forecastSnowSlots(manifest([9,12,18]),target(18),hour).slots[1].missing,true);
  const mixed=manifest();mixed.layers.snow3h.slots[2].basetime="20261107230000";assert.throws(()=>forecastSnowSlots(mixed,target(18),hour),/発表回/);
  const absent=manifest();absent.layers.snow3h.slots[1].status="missing";assert.equal(forecastSnowSlots(absent,target(18),hour).slots[0].missing,true);
  const duplicate=manifest();duplicate.layers.snow3h.slots.push({...duplicate.layers.snow3h.slots[1]});assert.throws(()=>forecastSnowSlots(duplicate,target(18),hour),/重複/);
  assert.throws(()=>forecastSnowSlots(manifest(),{...target(18),basetime:"20261108020000"},hour),/発表回/);
  assert.equal(forecastSnowSlots(manifest(),target(21),hour).slots.at(-1).missing,true);
});
test("stations use their own native 5km cell, preserving zero and explicit NoData rather than reading image transparency",()=>{
  const grid=forecastSnowGrid(stations);
  const fields=[geometry([1,0,6,-1]),geometry([3,0,6,0]),geometry([6,0,6,3])].map(g=>projectRiskField(g,grid,"snow3h"));
  assert.deepEqual(fields.map(a=>[...a]),[[1,0,6,-1],[3,0,6,0],[6,0,6,3]]);
  assert.deepEqual(addForecastSnow(stations,fields).map(p=>p.value),[20,0,null,8]);
  assert.deepEqual(addForecastSnow(stations,fields).map(p=>p.added),[10,0,null,3]);
  assert.deepEqual(stations.map(s=>s.value),[10,0,null,5],"the observed values remain untouched");
  const boundary=forecastSnowGrid([{lat:35,lng:137.5},{lat:35.0499,lng:137.56249},{lat:35.05,lng:137.5625}]);
  assert.deepEqual([...boundary.rows],[700,700,701]);assert.deepEqual([...boundary.cols],[2200,2200,2201]);
  assert.throws(()=>addForecastSnow(stations,[[1,2,3,4]]),/階級/);assert.throws(()=>addForecastSnow(stations,[[1]]),/地点数/);
});
const response=value=>({ok:true,text:async()=>JSON.stringify(value)});
const file=url=>new URL(url).pathname.split("/").at(-1);
const valuesFor=name=>name.includes(stamp(12))?1:name.includes(stamp(15))?3:6;
test("rewinding the selected time recomputes from observations and reuses only matching forecast geometry",async()=>{
  const calls=[];const load=createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async url=>{const name=file(url);calls.push(name);return response(name==="forecast_manifest.json"?manifest():geometry([valuesFor(name),0,0,0]));}});
  assert.equal((await load(stations,hour,target(18))).points[0].value,20);
  assert.equal((await load(stations,hour,target(12))).points[0].value,11);
  assert.equal((await load(stations,hour,target(15))).points[0].value,14);
  assert.equal(calls.filter(n=>n.endsWith("geojson")).length,3);assert.equal(calls.filter(n=>n==="forecast_manifest.json").length,6);
});
test("a manifest change during loading retries as one generation instead of mixing old and new class values",async()=>{
  let manifests=0,geometries=0;const a=manifest(),b={...manifest(),generated_at:"2026-11-08T06:01:00+09:00"};
  const load=createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async url=>{
    if(file(url)==="forecast_manifest.json")return response(++manifests===1?a:b);
    geometries++;return response(geometry([manifests===1?1:3,0,0,0]));
  }});
  assert.equal((await load(stations,hour,target(18))).points[0].value,19);assert.equal(geometries,6);assert.equal(manifests,4);
});
test("expired, unavailable and malformed source data do not turn into zero additions",async()=>{
  const expired={...manifest(),generated_at:"2026-11-07T00:00:00Z"};
  await assert.rejects(createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async()=>response(expired)})(stations,hour,target(18)),/更新時刻/);
  await assert.rejects(createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async url=>file(url)==="forecast_manifest.json"?response(manifest()):{ok:false}})(stations,hour,target(18)),/取得/);
  const bad=geometry([1,0,0,0]);bad.features[0].properties.level="unexpected";
  let broken=true;
  const recover=createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async url=>response(file(url)==="forecast_manifest.json"?manifest():broken?bad:geometry([1,0,0,0]))});
  await assert.rejects(recover(stations,hour,target(12)),/未知/);
  broken=false;assert.equal((await recover(stations,hour,target(12))).points[0].value,11,"an invalid geometry must not poison subsequent retries");
});
test("a late response to an aborted projection cannot produce a result",async()=>{
  let release,started;const pending=new Promise(r=>{release=r;}),ready=new Promise(r=>{started=r;});
  const load=createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async url=>{if(file(url)==="forecast_manifest.json")return response(manifest());started();await pending;return response(geometry([1,0,0,0]));}});
  const controller=new AbortController(),result=load(stations,hour,target(12),controller.signal);await ready;controller.abort();release();await assert.rejects(result,{name:"AbortError"});
});

test("missing forecast slots and NoData cells add zero without inventing an observation",async()=>{
  const m=manifest([12,18]);const calls=[];
  const load=createSnowForecastLoader({now:()=>Date.parse(hour),fetchImpl:async url=>{
    const name=file(url);calls.push(name);return response(name==="forecast_manifest.json"?m:geometry([name.includes(stamp(12))?1:6,-1,6,0]));
  }});
  const result=await load(stations,hour,target(18));
  assert.deepEqual(result.points.map(p=>p.value),[17,0,null,5]);
  assert.equal(calls.filter(n=>n.endsWith("geojson")).length,2);
  assert.equal(result.plan.missingSlots,1);
});

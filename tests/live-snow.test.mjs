import test from "node:test";
import assert from "node:assert/strict";
import {snowHour,snowMapKey,decodeSnowStations,snowStationValue,snowStationLabel,snowPointColor,LIVE_SNOW_BANDS,LIVE_SNOW_LABEL_ZOOM} from "../live-snow-data.js";
import {observedRoadClass,precipitationStations,snowfallStations,buildObservedRoadData} from "../observed-road-risk.js";
import {analysisSnowSlots} from "../snow-analysis-control.js";
const hour="2026-01-22T20:00:00+09:00";
test("observed roads prefer snow, including confirmed snow with zero snowfall, over cold after precipitation",()=>{
  for (const [snowfall,rank] of [[.5,5],[1,6],[2,6],[3,7],[5,7],[6,8]]) {
    assert.equal(observedRoadClass(-2,true,snowfall,false),rank);
  }
  assert.equal(observedRoadClass(-2,true,0,true),5);
  assert.equal(observedRoadClass(3,true,0,false),2);
  assert.equal(observedRoadClass(2,true,0,false),3);
  assert.equal(observedRoadClass(0,true,0,false),4);
  assert.equal(observedRoadClass(-2,false,0,false),1);
  assert.equal(observedRoadClass(6,true,0,false),1);
  assert.equal(observedRoadClass(-2,null,0,false),0);
  assert.equal(observedRoadClass(6,false,0,null),0);
  assert.equal(observedRoadClass(-2,true,null,true),4);
});
test("prior precipitation uses four complete three-hour frames for a dry claim and snowfall uses three one-hour frames",()=>{
  const table={10001:{lat:[37,0],lon:[137,0]}};
  const frame=(precipitation3h,snow1h)=>({10001:{precipitation3h:[precipitation3h,0],snow1h:[snow1h,0]}});
  const zero=frame(0,0), wet=frame(.5,2);
  assert.deepEqual(precipitationStations(table,[null,zero,wet,zero]).map(s=>s.value),[true]);
  assert.deepEqual(precipitationStations(table,[zero,zero,zero,zero]).map(s=>s.value),[false]);
  assert.deepEqual(precipitationStations(table,[zero,null,zero,zero]),[]);
  assert.deepEqual(snowfallStations(table,[wet,wet,zero]).map(s=>s.value),[4]);
  assert.deepEqual(snowfallStations(table,[wet,null,zero]),[]);
});
test("observed road gridding uses nearby measurements and never treats an unsupported cell as dry",()=>{
  const grid={count:3,rowScale:20,colScale:16,rows:new Uint16Array([740,740,740]),cols:new Uint16Array([2192,2193,2224])};
  const position=[137.03,37.025], temperature={grid,values:new Float64Array([-2,-2,-2])};
  const wet=[{coordinate:position,value:true}], snow=[{coordinate:position,value:0}];
  assert.deepEqual([...buildObservedRoadData(temperature,snow,wet,[2,1,2]).classes],[5,4,0]);
});
test("the observed snow surface uses analysis frames only",()=>{
  const slot={basetime:"20261118110000",validtime:"20261118110000",elements:["snowd"]};
  assert.deepEqual(analysisSnowSlots([slot,{...slot,validtime:"20261118120000"}]),[{key:slot.validtime,time:"2026-11-18T11:00:00Z"}]);
  assert.throws(()=>analysisSnowSlots([slot,slot]),/重複/);
});
test("snow uses a valid Japanese-time hour; does not use non-hour observations",()=>{
  assert.equal(snowHour("2026-09-26T20:40:00+09:00"),"2026-09-26T20:00:00+09:00");
  assert.equal(snowMapKey(hour),"20260122200000");
  for(const bad of ["2026-02-30T20:00:00+09:00","2026-01-22T20:10:00+09:00","2026-01-22T20:00:00Z"])assert.throws(()=>snowMapKey(bad));
});
test("zero, absent values, inactive observations and reference values remain different",()=>{
  const meta={type:"C",elems:"11112110",lat:[37,0],lon:[137,0],kjName:"試験地点"};
  const table={10001:meta,10002:{...meta,lon:[137,10]},10003:{...meta,lon:[137,20]},10004:{...meta,lon:[137,30]},10005:{...meta,elems:"11112010"}};
  const decoded=decodeSnowStations(table,{10001:{snow:[0,0]},10002:{snow:[null,5]},10003:{snow:[25,4]}},hour);
  assert.equal(decoded.length,4);assert.equal(decoded[0].value,0);assert.equal(decoded[0].usable,true);
  assert.equal(snowStationLabel(decoded[0]),"0cm");assert.equal(decoded[1].value,null);assert.equal(decoded[3].value,null);
  assert.match(snowStationLabel(decoded[1]),/資料なし/);assert.equal(decoded[2].value,25);assert.equal(decoded[2].usable,false);assert.match(snowStationLabel(decoded[2]),/参考値/);
  assert.throws(()=>decodeSnowStations(table,{10001:{snow:[-1,0]}},hour));
});

test("point colors match the supplied snow-depth classes at every boundary",()=>{
  const colors=["#d5dde2","#9fd2ff","#228cff","#0041ff","#faf500","#ff9900","#fe2900","#b40068"];
  assert.deepEqual(LIVE_SNOW_BANDS.map(b=>b.min),[0,1,5,20,50,100,150,200]);
  assert.deepEqual(LIVE_SNOW_BANDS.map(b=>b.color),colors);
  for(let i=0;i<LIVE_SNOW_BANDS.length;i++) {
    const min=LIVE_SNOW_BANDS[i].min,end=i===LIVE_SNOW_BANDS.length-1?1500:LIVE_SNOW_BANDS[i+1].min-1;
    assert.equal(snowPointColor(min),colors[i]);assert.equal(snowPointColor(end),colors[i]);
  }
  assert.equal(snowPointColor(null),null,"no-data uses a pattern, never the 0cm color");
  for(const bad of [NaN,Infinity,-1,1501,undefined])assert.throws(()=>snowPointColor(bad));
});
test("station values keep zero, references and absent observations distinct",()=>{
  assert.equal(snowStationValue({value:0}),"0cm");assert.equal(snowStationValue({value:12}),"12cm");
  assert.equal(snowStationValue({value:null}),"資料なし");
  assert.equal(snowStationLabel({value:0,quality:0}),"0cm");
  assert.equal(snowStationLabel({value:12,quality:4}),"12cm・参考値");
  assert.match(snowStationLabel({value:null,quality:6}),/資料なし/);
  assert.equal(LIVE_SNOW_LABEL_ZOOM,7);
});

import test from "node:test";
import assert from "node:assert/strict";
import {snowHour,snowMapKey,decodeSnowStations,snowStationValue,snowStationLabel,snowPointColor,LIVE_SNOW_BANDS,LIVE_SNOW_LABEL_ZOOM} from "../live-snow-data.js";
const hour="2026-01-22T20:00:00+09:00";
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

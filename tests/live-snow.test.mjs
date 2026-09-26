import test from "node:test";
import assert from "node:assert/strict";
import {expandGrid} from "../temperature-layer.js";
import {snowHour,snowMapKey,decodeSnowStations,snowStationLabel,snowTriangles,triangleSnow,makeSnowSurface,snowContours,snowSurfaceLabel} from "../live-snow-data.js";

const hour="2026-01-22T20:00:00+09:00";
const station=(id,lng,lat,value)=>({id,name:id,lng,lat,value,quality:0,usable:value!==null});
const points=[station("10001",137,37,0),station("10002",137.3,37,30),station("10003",137,37.3,60)];
function smallGrid() {
  const runs=[];for(let row=4440;row<4477;row++)runs.push(row,10960,26);
  return expandGrid({cell_count:37*26,runs});
}
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
  assert.match(snowStationLabel(decoded[0]),/1cm未満/);assert.equal(decoded[1].value,null);assert.equal(decoded[3].value,null);
  assert.match(snowStationLabel(decoded[1]),/資料なし/);assert.equal(decoded[2].value,25);assert.equal(decoded[2].usable,false);assert.match(snowStationLabel(decoded[2]),/参考値/);
  assert.throws(()=>decodeSnowStations(table,{10001:{snow:[-1,0]}},hour));
});
test("triangular interpolation agrees with an independent linear field and station vertices",()=>{
  const triangles=snowTriangles(points);assert.equal(triangles.length,1);
  for(const p of points)assert.ok(Math.abs(triangleSnow(triangles[0],p.lng,p.lat)-p.value)<1e-7);
  assert.ok(Math.abs(triangleSnow(triangles[0],137.1,37.1)-30)<1e-7);
  assert.ok(Number.isNaN(triangleSnow(triangles[0],137.3,37.3)));
  assert.equal(snowTriangles([points[0],points[1],station("10004",137,39,60)]).length,0);
});
test("missing and reference stations block interpolation rather than bridging holes",()=>{
  const square=[station("10001",137,37,0),station("10002",137.3,37,30),station("10003",137,37.3,60),station("10004",137.3,37.3,90)];
  assert.equal(snowTriangles(square).length,2);
  const missing=station("10005",137.15,37.15,null);assert.equal(snowTriangles([...square,missing]).length,0);
  assert.equal(snowTriangles([...square,{...missing,value:35,quality:4,usable:false}]).length,0);
  assert.equal(snowTriangles(square.map(s=>({...s,value:null,usable:false}))).length,0);
});
test("land-mask surface follows the analytic field and leaves unsupported cells transparent",()=>{
  const grid=smallGrid(),surface=makeSnowSurface(points,grid);
  assert.ok(surface.count>100);assert.ok(surface.count<grid.count);
  for(let i=0;i<grid.count;i++)if(Number.isFinite(surface.values[i])){
    const expected=100*((grid.cols[i]+.5)/80-137)+200*((grid.rows[i]+.5)/120-37);
    assert.ok(Math.abs(surface.values[i]-expected)<1e-4);
  }else assert.equal(surface.bins[i],0);
  assert.match(snowSurfaceLabel(surface,grid,138,38),/推定なし/);
  const empty=makeSnowSurface(points.map(s=>({...s,value:null,usable:false})),grid);
  assert.equal(empty.count,0);assert.equal(empty.contours.features.length,0);assert.ok(empty.bins.every(b=>b===0));
});
test("contours lie on their stated depths and never cross a missing square",()=>{
  const grid=smallGrid(),surface=makeSnowSurface(points,grid);
  assert.ok(surface.contours.features.length>=4);
  for(const feature of surface.contours.features)for(const line of feature.geometry.coordinates)for(const [lng,lat]of line){
    assert.ok(Math.abs(100*(lng-137)+200*(lat-37)-feature.properties.depth)<1e-4);
  }
  assert.equal(snowContours({...grid,count:4,rows:Uint16Array.from([4440,4440,4441,4441]),cols:Uint16Array.from([10960,10961,10960,10961])},Float32Array.from([0,10,NaN,10])).features.length,0);
});

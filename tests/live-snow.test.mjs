import test from "node:test";
import assert from "node:assert/strict";
import {expandGrid} from "../temperature-layer.js";
import {snowHour,snowMapKey,decodeSnowStations,snowStationLabel,snowTriangles,triangleSnow,makeSnowSurface,snowContours,snowSurfaceLabel,snowSurfaceBins,snowColor,LIVE_SNOW_SCALES} from "../live-snow-data.js";

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
  assert.equal(snowStationLabel(decoded[0]),"0cm");assert.equal(decoded[1].value,null);assert.equal(decoded[3].value,null);
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
test("missing and reference stations do not affect interpolation geometry, as if they did not exist",()=>{
  const square=[station("10001",137,37,0),station("10002",137.3,37,30),station("10003",137,37.3,60),station("10004",137.3,37.3,90)];
  assert.equal(snowTriangles(square).length,2);
  const missing=station("10005",137.15,37.15,null);
  assert.deepEqual(snowTriangles([...square,missing]),snowTriangles(square));
  assert.deepEqual(snowTriangles([...square,{...missing,value:35,quality:4,usable:false}]),snowTriangles(square));
  const grid=smallGrid(),base=makeSnowSurface(square,grid),withoutMissing=makeSnowSurface([...square,missing],grid);
  assert.deepEqual(withoutMissing.values,base.values);assert.deepEqual(withoutMissing.contours,base.contours);
  assert.equal(snowTriangles([square[0],square[1],missing]).length,0);
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

test("snow fill starts at white 1cm, hides zero and sub-centimetre estimates, and saturates at the chosen depth",()=>{
  const values=Float32Array.from([NaN,-1,0,.5,.999,1,5,10,20,50,100,200,350]);
  for(const scale of LIVE_SNOW_SCALES) {
    const bins=snowSurfaceBins(values,scale);
    assert.ok(bins.slice(0,5).every(b=>b===0));assert.equal(snowColor(bins[5]),"#ffffff");
    assert.equal(snowColor(bins[values.indexOf(scale)]),"#000000");
    for(let i=6;i<bins.length;i++)assert.ok(bins[i]>=bins[i-1]);
  }
  assert.ok(snowSurfaceBins(values,10)[6]>snowSurfaceBins(values,50)[6]);
  assert.equal(snowColor(snowSurfaceBins(Float32Array.of(25.5),50)[0]),"#808080");
  assert.throws(()=>snowSurfaceBins(values,0));assert.throws(()=>snowSurfaceBins(values,75));
});

test("zero anchors remain in interpolation but do not produce a white snow area or claim snow absence",()=>{
  const grid=smallGrid(),surface=makeSnowSurface(points.map(p=>({...p,value:0})),grid);
  assert.ok(surface.count>0);assert.ok(surface.bins.every(b=>b===0));assert.equal(surface.contours.features.length,0);
  assert.match(snowSurfaceLabel(surface,grid,137.05,37.05),/1cm未満.*塗りなし/);
  assert.match(snowSurfaceLabel(surface,grid,138,38),/推定なし/);
});

test("interior hills and an exact-threshold saddle retain closed contour rings",()=>{
  const grid=expandGrid({cell_count:169,runs:Array.from({length:13},(_,i)=>[4440+i,10960,13]).flat()});
  for(const field of [(x,y)=>Math.max(0,10-2.5*Math.min(Math.hypot(x-4,y-6),Math.hypot(x-8,y-6))),
    (x,y)=>Math.abs(x-6)<=3&&Math.abs(y-6)<=3?Math.max(0,5+(x-6)*(y-6)):0]) {
    const contours=snowContours(grid,Float32Array.from(grid.rows,(row,i)=>field(grid.cols[i]-10960,row-4440)));
    assert.ok(contours.features.length>0);
    for(const feature of contours.features)for(const line of feature.geometry.coordinates)assert.deepEqual(line[0],line.at(-1));
  }
});

test("connected summit contours are rounded closed curves without changing the underlying estimates",()=>{
  const runs=[];for(let row=4440;row<4449;row++)runs.push(row,10960,9);
  const grid=expandGrid({cell_count:81,runs});
  const values=Float32Array.from(grid.rows,(row,i)=>Math.max(0,20-4*(Math.abs(row-4444)+Math.abs(grid.cols[i]-10964))));
  const before=Array.from(values),contours=snowContours(grid,values);
  assert.deepEqual(Array.from(values),before);
  const feature=contours.features.find(f=>f.properties.depth===10);
  assert.equal(feature.geometry.coordinates.length,1);
  const line=feature.geometry.coordinates[0];assert.deepEqual(line[0],line.at(-1));
  assert.ok(line.length>30);
  for(const [lng,lat] of line) {
    const expected=20-4*(Math.abs(lat*120-.5-4444)+Math.abs(lng*80-.5-10964));
    assert.ok(Math.abs(expected-10)<=1.00001,"rounding stays near the 10cm contour of the independent analytic field");
  }
  for(let i=1;i<line.length-1;i++) {
    const a=[(line[i][0]-line[i-1][0])*80,(line[i][1]-line[i-1][1])*120];
    const b=[(line[i+1][0]-line[i][0])*80,(line[i+1][1]-line[i][1])*120];
    const length=Math.hypot(...a)*Math.hypot(...b);
    if(length>1e-15)assert.ok((a[0]*b[0]+a[1]*b[1])/length>.85,"the former sharp corners are rounded");
  }
  const missing=values.slice();
  for(let i=0;i<missing.length;i++)if(grid.cols[i]===10964)missing[i]=NaN;
  for(const f of snowContours(grid,missing).features)for(const part of f.geometry.coordinates) {
    const xs=part.map(p=>p[0]*80-.5);
    assert.ok(Math.max(...xs)<=10963+1e-7 || Math.min(...xs)>=10965-1e-7,"no curve bridges the missing column");
  }
});

import {lookupCell} from "./temperature-layer.js";

export const AMEDAS_ROOT="https://www.jma.go.jp/bosai/amedas/";
export const LIVE_SNOW_LEVELS=[1,5,10,20,50,100];
export const LIVE_SNOW_SCALES=Object.freeze([10,20,50,100,200,350]);
export const LIVE_SNOW_DEFAULT_SCALE=50;
export const SNOW_MAX_EDGE_KM=80;
export const SNOW_MAX_NEAREST_KM=40;
const project=(lng,lat)=>[(lng-137)*111.32*Math.cos(37*Math.PI/180),(lat-37)*111.32];
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
export function snowStationLabel(point) {
  if(point.value===null)return "資料なし（観測休止・欠測等）";
  return `${point.value}cm${point.value===0?"（1cm未満を含み得ます）":""}${point.quality!==0?"・参考値":""}`;
}

function triangle(a,b,c,points) {
  const p=points[a],q=points[b],r=points[c];
  const det=2*(p.x*(q.y-r.y)+q.x*(r.y-p.y)+r.x*(p.y-q.y));
  if(Math.abs(det)<1e-8)return null;
  const pp=p.x*p.x+p.y*p.y,qq=q.x*q.x+q.y*q.y,rr=r.x*r.x+r.y*r.y;
  const x=(pp*(q.y-r.y)+qq*(r.y-p.y)+rr*(p.y-q.y))/det;
  const y=(pp*(r.x-q.x)+qq*(p.x-r.x)+rr*(q.x-p.x))/det;
  return {a,b,c,x,y,r2:(x-p.x)**2+(y-p.y)**2};
}
export function snowTriangles(stations) {
  // Missing/flagged stations participate in triangulation, then all triangles
  // touching them are rejected. This avoids bridging an observed data hole.
  const points=stations.map(s=>{const [x,y]=project(s.lng,s.lat);return {...s,x,y};});
  if(points.length<3)return [];
  const count=points.length;
  points.push({x:-10000,y:-6000},{x:10000,y:-6000},{x:0,y:10000});
  let triangles=[triangle(count,count+1,count+2,points)];
  for(let i=0;i<count;i++) {
    const bad=triangles.filter(t=>(points[i].x-t.x)**2+(points[i].y-t.y)**2<=t.r2+1e-7),edges=new Map();
    for(const t of bad)for(const [a,b] of [[t.a,t.b],[t.b,t.c],[t.c,t.a]]){const key=[a,b].sort((a,b)=>a-b).join(",");const edge=edges.get(key);if(edge)edge.count++;else edges.set(key,{a,b,count:1});}
    const remove=new Set(bad);triangles=triangles.filter(t=>!remove.has(t));
    for(const edge of edges.values())if(edge.count===1){const t=triangle(edge.a,edge.b,i,points);if(t)triangles.push(t);}
  }
  return triangles.filter(t=>[t.a,t.b,t.c].every(i=>i<count && points[i].usable))
    .map(t=>[points[t.a],points[t.b],points[t.c]])
    .filter(t=>t.every((p,i)=>Math.hypot(p.x-t[(i+1)%3].x,p.y-t[(i+1)%3].y)<=SNOW_MAX_EDGE_KM));
}
export function triangleSnow(t,lng,lat) {
  const [x,y]=project(lng,lat),[a,b,c]=t;
  const d=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
  if(Math.abs(d)<1e-8)return NaN;
  const u=((b.y-c.y)*(x-c.x)+(c.x-b.x)*(y-c.y))/d;
  const v=((c.y-a.y)*(x-c.x)+(a.x-c.x)*(y-c.y))/d,w=1-u-v;
  if(Math.min(u,v,w)<-1e-9 || Math.min(...t.map(p=>Math.hypot(p.x-x,p.y-y)))>SNOW_MAX_NEAREST_KM)return NaN;
  return Math.max(0,u*a.value+v*b.value+w*c.value);
}
export function makeSnowSurface(stations,grid) {
  if(!grid || grid.rowScale && grid.rowScale!==120 || grid.colScale && grid.colScale!==80)throw new Error("積雪の陸域格子が不正です");
  const triangles=snowTriangles(stations),buckets=new Map(),size=50;
  for(const t of triangles) {
    for(let x=Math.floor(Math.min(...t.map(p=>p.x))/size);x<=Math.floor(Math.max(...t.map(p=>p.x))/size);x++)
      for(let y=Math.floor(Math.min(...t.map(p=>p.y))/size);y<=Math.floor(Math.max(...t.map(p=>p.y))/size);y++){
        const key=`${x},${y}`;if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(t);
      }
  }
  const values=new Float32Array(grid.count).fill(NaN),bins=new Uint8Array(grid.count);
  let count=0;
  if(triangles.length)for(let i=0;i<grid.count;i++) {
    const lng=(grid.cols[i]+.5)/80,lat=(grid.rows[i]+.5)/120,[x,y]=project(lng,lat);
    for(const t of buckets.get(`${Math.floor(x/size)},${Math.floor(y/size)}`) ?? []) {
      const value=triangleSnow(t,lng,lat);if(!Number.isFinite(value))continue;
      values[i]=value;count++;break;
    }
  }
  bins.set(snowSurfaceBins(values));
  return {values,bins,count,triangleCount:triangles.length,contours:snowContours(grid,values)};
}
export function snowContours(grid,values) {
  const segments=LIVE_SNOW_LEVELS.map(()=>[]),index=new Map(),supportedSquares=new Set();
  for(let i=0;i<grid.count;i++)if(Number.isFinite(values[i]))index.set(grid.rows[i]*20000+grid.cols[i],i);
  for(const [key,i] of index) {
    const j=index.get(key+1),k=index.get(key+20000),l=index.get(key+20001);
    if(j===undefined || k===undefined || l===undefined)continue;
    supportedSquares.add(key);
    const coord=n=>[(grid.cols[n]+.5)/80,(grid.rows[n]+.5)/120];
    for(const corners of [[i,j,l],[i,l,k]])for(let level=0;level<LIVE_SNOW_LEVELS.length;level++) {
      const threshold=LIVE_SNOW_LEVELS[level],hits=[];
      for(let edge=0;edge<3;edge++){
        const a=corners[edge],b=corners[(edge+1)%3],av=values[a],bv=values[b];
        if((av<threshold)===(bv<threshold))continue;
        const p=coord(a),q=coord(b),f=(threshold-av)/(bv-av);hits.push(p.map((v,axis)=>v+f*(q[axis]-v)));
      }
      if(hits.length===2 && Math.hypot(hits[0][0]-hits[1][0],hits[0][1]-hits[1][1])>1e-10)segments[level].push(hits);
    }
  }
  const supported=point=>{
    const x=point[0]*80-.5,y=point[1]*120-.5;
    // Include either neighbouring square when a point lies on their shared edge.
    for(const col of new Set([Math.floor(x-1e-8),Math.floor(x+1e-8)]))
      for(const row of new Set([Math.floor(y-1e-8),Math.floor(y+1e-8)]))
        if(supportedSquares.has(row*20000+col))return true;
    return false;
  };
  const supportedSegment=(a,b)=>{
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(b[0]-a[0])*80,Math.abs(b[1]-a[1])*120)*4));
    for(let i=0;i<=steps;i++)if(!supported(a.map((v,axis)=>v+(b[axis]-v)*i/steps)))return false;
    return true;
  };
  return {type:"FeatureCollection",features:segments.flatMap((edges,i)=>{
    const coordinates=joinSnowContours(edges).map(line=>smoothSnowContour(line,supportedSegment));
    return coordinates.length?[{type:"Feature",properties:{depth:LIVE_SNOW_LEVELS[i]},geometry:{type:"MultiLineString",coordinates}}]:[];
  })};
}

// Join native-grid fragments before rounding their corners. Ambiguous junctions
// remain endpoints; no new connection across a saddle or a data gap is invented.
function joinSnowContours(edges) {
  const key=point=>point.map(v=>Math.round(v*1e9)).join(","),nodes=new Map(),used=new Set(),lines=[];
  edges.forEach((edge,i)=>edge.forEach(point=>{const k=key(point);if(!nodes.has(k))nodes.set(k,[]);nodes.get(k).push(i);}));
  function walk(first,start) {
    let id=first,point=start;const line=[point];
    while(!used.has(id)) {
      used.add(id);const edge=edges[id];point=key(edge[0])===key(point)?edge[1]:edge[0];line.push(point);
      const next=nodes.get(key(point));if(next.length!==2)break;
      const candidate=next.find(i=>!used.has(i));if(candidate===undefined)break;id=candidate;
    }
    return line;
  }
  edges.forEach((edge,i)=>{for(const point of edge)if(!used.has(i) && nodes.get(key(point)).length!==2)lines.push(walk(i,point));});
  edges.forEach((edge,i)=>{if(!used.has(i))lines.push(walk(i,edge[0]));});
  return lines;
}

function coarseSnowContour(line) {
  // Remove redundant native-grid vertices so rounding is visible at regional
  // zooms, then cap each control edge at 12 km to avoid cutting large corners.
  const xy=line.map(p=>project(...p)),keep=new Set([0,line.length-1]),stack=[[0,line.length-1]];
  while(stack.length) {
    const [start,end]=stack.pop(),a=xy[start],b=xy[end],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
    let furthest=-1,distance=.15*.15;
    for(let i=start+1;i<end;i++) {
      const p=xy[i],f=length?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length)):0;
      const d=(p[0]-a[0]-f*dx)**2+(p[1]-a[1]-f*dy)**2;
      if(d>distance){distance=d;furthest=i;}
    }
    if(furthest>=0){keep.add(furthest);stack.push([start,furthest],[furthest,end]);}
  }
  const simple=[...keep].sort((a,b)=>a-b).map(i=>line[i]),result=[simple[0]];
  for(let i=1;i<simple.length;i++) {
    const a=simple[i-1],b=simple[i],p=project(...a),q=project(...b),steps=Math.max(1,Math.ceil(Math.hypot(q[0]-p[0],q[1]-p[1])/12));
    for(let j=1;j<=steps;j++)result.push(a.map((v,k)=>v+(b[k]-v)*j/steps));
  }
  return result;
}

function smoothSnowContour(line,supportedSegment) {
  const closed=line[0].every((v,i)=>Math.abs(v-line.at(-1)[i])<1e-9);
  const coarse=coarseSnowContour(line),base=coarse.every((point,i)=>i===0 || supportedSegment(coarse[i-1],point))?coarse:line;
  let current=closed?base.slice(0,-1):base;
  if(current.length<3)return line;
  // Three Chaikin passes round only the drawing, with bounded control edges.
  // Keep open endpoints fixed and reject a pass that enters an unsupported cell.
  for(let pass=0;pass<3;pass++) {
    const next=closed?[]:[current[0]],count=closed?current.length:current.length-1;
    for(let i=0;i<count;i++) {
      const a=current[i],b=current[(i+1)%current.length];
      next.push(a.map((v,j)=>.75*v+.25*b[j]),a.map((v,j)=>.25*v+.75*b[j]));
    }
    if(!closed)next.push(current.at(-1));
    if(!next.every((point,i)=>i===0 || supportedSegment(next[i-1],point)) || closed && !supportedSegment(next.at(-1),next[0]))break;
    current=next;
  }
  return closed?[...current,current[0]]:current;
}

export function snowSurfaceBins(values,scale=LIVE_SNOW_DEFAULT_SCALE) {
  if(!LIVE_SNOW_SCALES.includes(scale))throw new Error("積雪深の表示上限が不正です");
  return Uint8Array.from(values,value=>Number.isFinite(value) && value>=0?1+Math.round(Math.min(1,value/scale)*80):0);
}
export function snowColor(bin) {
  if(!Number.isInteger(bin) || bin<1 || bin>81)throw new Error("積雪深の表示色が不正です");
  const gray=Math.round(255*(1-(bin-1)/80)).toString(16).padStart(2,"0");
  return "#"+gray.repeat(3);
}
export function snowSurfaceLabel(surface,grid,lng,lat) {
  const index=lookupCell(grid,lng,lat),value=index<0?NaN:surface?.values[index];
  return Number.isFinite(value)?`約${value.toFixed(1)}cm（独自推定）`:"推定なし（観測範囲外・資料不足）";
}

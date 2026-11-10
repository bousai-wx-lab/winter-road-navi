import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { createRouteClient, departureTime, routeRequest, sampleRoute, routeSegments, validPoint, ROUTE_COLORS, PRIORITIES } from "./drive-route-data.js";
import { createDriveWeather } from "./drive-weather-data.js";
import { timeLabel } from "./live-temperature-data.js";
import { NORMAL_ROAD_RULES } from "./road-risk-data.js";
import { RISK_RULES } from "./forecast-risk-data.js";

const $=id=>document.getElementById(id), SVG="http://www.w3.org/2000/svg";
function svg(tag,attributes,text){const el=document.createElementNS(SVG,tag);for(const [key,value] of Object.entries(attributes))el.setAttribute(key,String(value));if(text!==undefined)el.textContent=text;return el;}
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
const sourceLabel=source=>source==="forecast"?"予測":source==="normal"?"平年値":"資料不足";

export function initDrive(map) {
  const routeClient=createRouteClient(),weather=createDriveWeather();
  let active=false,picking="start",start=null,end=null,token=0,abort=null,result=null,collapsed=false,lastRoute=null;
  const markers={},empty={type:"FeatureCollection",features:[]};
  function status(text,state="ready"){$("driveStatus").textContent=text;$("driveStatus").dataset.state=state;}
  function layers(){
    if(!map.getSource("drive-route"))map.addSource("drive-route",{type:"geojson",data:empty});
    if(!map.getLayer("drive-route-halo"))map.addLayer({id:"drive-route-halo",type:"line",source:"drive-route",layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":"#fff","line-width":9,"line-opacity":.95}});
    if(!map.getLayer("drive-route-line"))map.addLayer({id:"drive-route-line",type:"line",source:"drive-route",layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":["get","color"],"line-width":5}});
  }
  function clearResult(){
    ++token;abort?.abort();result=null;$("driveAnalyze").disabled=false;$("driveProfile").hidden=true;$("driveChart").replaceChildren();$("driveCards").replaceChildren();$("driveReadout").replaceChildren();$("driveSummary").textContent="";$("driveNotices").textContent="";
    map.getSource("drive-route")?.setData(empty);markers.inspect?.remove();delete markers.inspect;map.resize();
  }
  function invalidate(){clearResult();status("条件を変更しました。「解析スタート」で更新してください");}
  function pointMarker(key,coordinate,label){
    markers[key]?.remove();delete markers[key];if(!coordinate||!active)return;
    const element=node("span",label,"drive-marker "+(key==="end"?"drive-marker-end":""));
    markers[key]=new maplibregl.Marker({element}).setLngLat(coordinate).addTo(map);
  }
  function updateSelection(){
    $("drivePickStart").setAttribute("aria-pressed",String(picking==="start"));$("drivePickEnd").setAttribute("aria-pressed",String(picking==="end"));
    pointMarker("start",start,"A");pointMarker("end",end,"B");
    $("drivePickHint").textContent=picking?(picking==="start"?"地図をクリックして始点 A を選択":"地図をクリックして終点 B を選択"):"始点・終点を変更するときは A・B のボタンを選択";
    if(active)map.getCanvas().style.cursor=picking?"crosshair":"";
  }
  function pick(key){picking=key;updateSelection();if(matchMedia("(max-width:760px)").matches){document.querySelector(".control-panel").classList.add("is-collapsed");$("panelToggle").textContent="設定を開く";$("panelToggle").setAttribute("aria-expanded","false");}}
  $("drivePickStart").addEventListener("click",()=>pick("start"));$("drivePickEnd").addEventListener("click",()=>pick("end"));
  for(const key of ["start","end"]){
    $(key==="start"?"driveStart":"driveEnd").addEventListener("change",event=>{
      const values=event.target.value.split(/[,、\s]+/).filter(Boolean).map(Number),point=[values[1],values[0]];
      invalidate();lastRoute=null;
      if(!validPoint(point)){if(key==="start")start=null;else end=null;status("座標は日本付近の「緯度, 経度」で指定してください","error");}
      else {if(key==="start")start=point;else end=point;picking=start&&end?null:!start?"start":"end";}
      updateSelection();
    });
  }
  for(const id of ["driveDeparture","drivePriority"])$(id).addEventListener("change",()=>{invalidate();lastRoute=null;});
  $("driveAddBreak").addEventListener("click",()=>{
    if($("driveBreaks").children.length>=12)return;
    const row=node("div",undefined,"drive-break"),km=document.createElement("input"),minutes=document.createElement("input"),remove=node("button","削除");
    km.type=minutes.type="number";km.min="0";km.step="0.1";km.placeholder="出発からkm";km.setAttribute("aria-label","休憩位置（出発からkm）");minutes.min="1";minutes.max="1440";minutes.step="1";minutes.placeholder="休憩の分数";minutes.setAttribute("aria-label","休憩時間（分）");remove.type="button";
    for(const input of [km,minutes])input.addEventListener("change",invalidate);
    remove.addEventListener("click",()=>{row.remove();invalidate();});row.append(km,minutes,remove);$("driveBreaks").append(row);km.focus();
  });
  function readBreaks(){return Array.from($("driveBreaks").children).map(row=>{const [a,b]=row.querySelectorAll("input");if(!a.value&&!b.value)return null;if(!a.value||!b.value)throw new Error("休憩の距離と分数を両方入力してください");return {km:Number(a.value),minutes:Number(b.value)};}).filter(Boolean);}
  function readout(index,move=false){
    if(!result)return;index=Math.max(0,Math.min(result.samples.length-1,Math.round(index)));$("drivePosition").value=String(index);
    const s=result.samples[index];$("drivePositionLabel").textContent=`${s.km.toFixed(1)}km · ${timeLabel(s.time)} 通過予定${s.restMinutes?`（休憩${s.restMinutes}分後）`:""}`;
    const heading=node("strong",`${sourceLabel(s.source)} · ${s.riskLabel}`),body=node("span",`${s.elevation===null?"標高不明":`標高 ${Math.round(s.elevation)}m`}　${s.weather?`${s.weather}　`:""}気温 ${s.temperature}　積雪深 ${s.snow}`),note=node("details",undefined,"drive-point-note");note.append(node("summary","この地点のデータ"),node("small",s.note));
    $("driveReadout").replaceChildren(heading,body,note);$("driveReadout").dataset.source=s.source;$("driveReadout").dataset.rank=String(s.rank);
    if(active){if(index===0||index===result.samples.length-1){markers.inspect?.remove();delete markers.inspect;}else pointMarker("inspect",s.coordinate,"●");if(move)map.easeTo({center:s.coordinate,duration:300});}
    const line=$("driveChart").querySelector(".drive-position-line");if(line){const x=55+880*s.km/result.route.distance;line.setAttribute("x1",x);line.setAttribute("x2",x);}
  }
  function renderProfile(){
    if(!result)return;
    const {route,samples,departure,priority}=result,stops=readBreaks().reduce((sum,b)=>sum+b.minutes,0),endTime=samples.at(-1).time;
    const sources=new Set(samples.map(s=>s.source));
    $("driveSummary").textContent=`${route.distance.toFixed(1)}km · 走行 約${Math.round(route.seconds/60)}分${stops?` ＋ 休憩${stops}分`:""} · ${PRIORITIES[priority]} · ${sourceLabel(samples[0].source)}${sources.size>1?"／"+[...sources].filter(s=>s!==samples[0].source).map(sourceLabel).join("／"):""}`;
    $("driveTripTiming").textContent=`出発 ${timeLabel(departure)} → 到着予定 ${timeLabel(endTime)}`;
    $("driveNotices").textContent=[...result.notices,!route.elevation?"標高を取得できませんでした。経路の気象は下に表示します。":"",priority==="local"&&route.hasHighway?"一般道優先ですが、一部に高速道路を含む経路です。":"",route.hasToll?"有料道路を含みます。":""].filter(Boolean).join(" ");
    $("driveProfile").hidden=!active;$("driveProfileBody").hidden=collapsed;$("driveProfileToggle").textContent=collapsed?"断面図を開く":"断面図を折りたたむ";$("driveProfileToggle").setAttribute("aria-expanded",String(!collapsed));
    const chart=svg("svg",{viewBox:"0 0 960 205",role:"img","aria-label":"横軸は走行距離km、縦軸は標高m。路線の色は区間の気象リスク。下のスライダーで各地点の数値を確認できます。"});
    const valid=samples.filter(s=>Number.isFinite(s.elevation)),bottom=Math.min(0,...valid.map(s=>Math.floor(s.elevation/100)*100)),top=Math.max(bottom+100,...valid.map(s=>Math.ceil(s.elevation/100)*100));
    const x=km=>55+880*km/route.distance,y=z=>160-130*(z-bottom)/(top-bottom);
    for(let i=0;i<=4;i++){const z=bottom+(top-bottom)*i/4;chart.append(svg("line",{x1:55,y1:y(z),x2:935,y2:y(z),class:"drive-grid"}),svg("text",{x:48,y:y(z)+4,"text-anchor":"end"},String(Math.round(z))));const km=route.distance*i/4;chart.append(svg("text",{x:x(km),y:187,"text-anchor":i===0?"start":i===4?"end":"middle"},`${km.toFixed(1)}km`));}
    chart.append(svg("text",{x:9,y:16},"標高m"));
    const haloGroup=svg("g",{}),routeGroup=svg("g",{});chart.append(haloGroup,routeGroup);
    for(let i=0;i<samples.length-1;i++){const a=samples[i],b=samples[i+1],rank=a.rank===0||b.rank===0?0:Math.max(a.rank,b.rank);
      chart.append(svg("line",{x1:x(a.km),y1:17,x2:x(b.km),y2:17,stroke:a.source==="normal"?"#917340":a.source==="forecast"?"#176b83":"#75838c","stroke-width":5}));
      if(Number.isFinite(a.elevation)&&Number.isFinite(b.elevation)){
        const line={x1:x(a.km),y1:y(a.elevation),x2:x(b.km),y2:y(b.elevation),"stroke-linecap":"round"};
        haloGroup.append(svg("line",{...line,stroke:"#607a8b","stroke-width":6}));routeGroup.append(svg("line",{...line,stroke:ROUTE_COLORS[rank],"stroke-width":4}));
      }
    }
    if(!valid.length)chart.append(svg("text",{x:480,y:90,"text-anchor":"middle"},"標高データなし"));
    chart.append(svg("line",{x1:55,x2:55,y1:24,y2:163,class:"drive-position-line"}));
    chart.addEventListener("click",event=>{const box=chart.getBoundingClientRect(),km=Math.max(0,Math.min(route.distance,((event.clientX-box.left)/box.width*960-55)/880*route.distance));let nearest=0;for(let i=1;i<samples.length;i++)if(Math.abs(samples[i].km-km)<Math.abs(samples[nearest].km-km))nearest=i;readout(nearest,true);});
    $("driveChart").replaceChildren(chart);$("drivePosition").max=String(samples.length-1);
    const cards=[...new Set([0,.25,.5,.75,1].map(f=>Math.round(f*(samples.length-1))))].map(i=>{
      const s=samples[i],button=node("button",undefined,"drive-card");button.type="button";button.append(node("strong",`${s.km.toFixed(1)}km · ${new Date(s.time+9*3600000).toISOString().slice(11,16)}`),node("span",`${sourceLabel(s.source)}${s.weather?` · ${s.weather}`:""}`),node("span",`気温 ${s.temperature}`),node("span",`積雪 ${s.snow}`));button.addEventListener("click",()=>readout(i,true));return button;
    });$("driveCards").replaceChildren(...cards);readout(0);map.resize();
  }
  $("drivePosition").addEventListener("input",event=>readout(Number(event.target.value)));
  $("driveProfileToggle").addEventListener("click",()=>{collapsed=!collapsed;$("driveProfileBody").hidden=collapsed;$("driveProfileToggle").textContent=collapsed?"断面図を開く":"断面図を折りたたむ";$("driveProfileToggle").setAttribute("aria-expanded",String(!collapsed));map.resize();});
  $("driveReset").addEventListener("click",()=>{clearResult();start=end=null;lastRoute=null;picking="start";collapsed=false;$("driveStart").value=$("driveEnd").value=$("driveDeparture").value="";$("driveBreaks").replaceChildren();$("drivePriority").value="fastest";updateSelection();status("始点 A と終点 B を地図で選んでください");});
  $("driveAnalyze").addEventListener("click",async()=>{
    clearResult();const current=token;abort=new AbortController();const signal=abort.signal;
    const timeout=setTimeout(()=>{if(current===token){abort.abort();status("解析が時間内に終わりませんでした。時間をおいて再実行してください","error");}},90000);
    try{
      // Read the visible fields again: autofill/accessibility input may not emit change.
      const parsePoint=id=>{const v=$(id).value.split(/[,、\s]+/).filter(Boolean).map(Number);return v.length===2?[v[1],v[0]]:null;};
      start=parsePoint("driveStart");end=parsePoint("driveEnd");
      const departure=departureTime($("driveDeparture").value),priority=$("drivePriority").value,request=routeRequest(start,end,priority,departure),breaks=readBreaks();
      $("driveAnalyze").disabled=true;picking=null;updateSelection();status("自動車の経路と標高を取得しています","loading");
      const cacheKey=JSON.stringify(request),route=lastRoute?.key===cacheKey?lastRoute.route:await routeClient(request,signal);
      if(current!==token)return;lastRoute={key:cacheKey,route};
      const points=sampleRoute(route,departure,breaks);status("経路の通過時刻を計算しました。気象を照合しています","loading");
      const data=await weather(points,signal,text=>{if(current===token)status(text,"loading");});
      if(current!==token||!active)return;
      result={...data,route,departure,priority};collapsed=false;layers();map.getSource("drive-route").setData(routeSegments(route,data.samples));renderProfile();
      const bounds=new maplibregl.LngLatBounds();for(const coordinate of route.coordinates)bounds.extend(coordinate);map.fitBounds(bounds,{padding:50,maxZoom:12,duration:500});
      status(`解析できました。${data.samples.length}地点の通過時刻を反映しています`);
      if(matchMedia("(max-width:760px)").matches){document.querySelector(".control-panel").classList.add("is-collapsed");$("panelToggle").setAttribute("aria-expanded","false");$("panelToggle").textContent="設定を開く";}
    }catch(error){if(current!==token||signal.aborted)return;status(error.message?.match(/[ぁ-んァ-ヶ一-龠]/)?error.message:"解析に失敗しました。通信を確認して再実行してください","error");}
    finally{clearTimeout(timeout);if(current===token)$("driveAnalyze").disabled=false;}
  });
  const legend=$("driveLegend");
  for(let rank=2;rank<=8;rank++){const line=node("div",undefined,"drive-legend-row"),swatch=node("i");swatch.style.backgroundColor=ROUTE_COLORS[rank];line.append(swatch,node("span",NORMAL_ROAD_RULES[rank]),node("span",RISK_RULES[rank].short));legend.append(line);}
  map.on("click",event=>{
    if(!active)return;
    if(picking){const point=[event.lngLat.lng,event.lngLat.lat];if(!validPoint(point)){status("日本付近の道路上を選んでください","error");return;}invalidate();lastRoute=null;
      if(picking==="start"){start=point;$("driveStart").value=`${point[1].toFixed(5)}, ${point[0].toFixed(5)}`;picking="end";}else{end=point;$("driveEnd").value=`${point[1].toFixed(5)}, ${point[0].toFixed(5)}`;picking=null;}
      updateSelection();status(start&&end?"始点・終点を選びました。「解析スタート」を押してください":"終点 B を地図で選んでください");
    }else if(result && map.getLayer("drive-route-line")){const hit=map.queryRenderedFeatures([[event.point.x-8,event.point.y-8],[event.point.x+8,event.point.y+8]],{layers:["drive-route-line"]})[0];if(hit)readout(Number(hit.properties.index));}
  });
  return {setActive(value){active=value;$("driveControls").hidden=!value;$("driveProfile").hidden=!value||!result;if(!value){if(!result && $("driveAnalyze").disabled)status("解析を中止しました。「解析スタート」で再実行できます");++token;abort?.abort();$("driveAnalyze").disabled=false;for(const marker of Object.values(markers))marker.remove();}else{layers();updateSelection();if(result){map.getSource("drive-route").setData(routeSegments(result.route,result.samples));renderProfile();}}for(const id of ["drive-route-halo","drive-route-line"])if(map.getLayer(id))map.setLayoutProperty(id,"visibility",value?"visible":"none");map.resize();},isPicking:()=>Boolean(picking)};
}

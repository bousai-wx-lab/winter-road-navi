import * as maplibregl from "./vendor/maplibre-gl.mjs";
import { createRouteClient, departureTime, routeRequest, sampleRoute, routeSegments, validPoint, ROUTE_COLORS, PRIORITIES } from "./drive-route-data.js";
import { createDriveWeather } from "./drive-weather-data.js";
import { timeLabel } from "./live-temperature-data.js";
import { NORMAL_ROAD_RULES } from "./road-risk-data.js";
import { RISK_RULES } from "./forecast-risk-data.js";

const $=id=>document.getElementById(id), SVG="http://www.w3.org/2000/svg";
function svg(tag,attributes,text){const el=document.createElementNS(SVG,tag);for(const [key,value] of Object.entries(attributes))el.setAttribute(key,String(value));if(text!==undefined)el.textContent=text;return el;}
function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
const sourceLabel=source=>source==="forecast"?"予測値":source==="normal"?"平年値":"資料不足";
function profileAxis(samples){const columns=Math.min(9,new Set(samples.map(s=>s.km)).size);return {columns,left:66+934/columns/2,width:934*(columns-1)/columns};}
const compactTemperature=text=>text.replace(/(-?\d+(?:\.\d+)?)℃以上\s*(-?\d+(?:\.\d+)?)℃未満/g,"$1〜<$2").replaceAll("℃","").replace("最低 ","低 ").replace("／最高 ","\n高 ");
const compactSnow=text=>text.replace("推定 約","約").replaceAll("cm","").replace("現象あり・", "あり ").replace("現象なし","なし");
const weatherIcon={"晴れ":"☀","くもり":"☁","雨":"☂","雨または雪":"☂❄","雪":"❄"};

export function initDrive(map,hooks={}) {
  const routeClient=createRouteClient(),weather=createDriveWeather();
  let active=false,picking="start",start=null,end=null,token=0,abort=null,result=null,collapsed=false,lastRoute=null;
  const markers={},empty={type:"FeatureCollection",features:[]};
  function status(text,state="ready"){$("driveStatus").textContent=text;$("driveStatus").dataset.state=state;}
  function layers(){
    // Short risk segments must survive GeoJSON tiling at nationwide zoom levels.
    if(!map.getSource("drive-route"))map.addSource("drive-route",{type:"geojson",data:empty,tolerance:0});
    if(!map.getLayer("drive-route-halo"))map.addLayer({id:"drive-route-halo",type:"line",source:"drive-route",layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":"#fff","line-width":14,"line-opacity":.95}});
    if(!map.getLayer("drive-route-line"))map.addLayer({id:"drive-route-line",type:"line",source:"drive-route",layout:{"line-join":"round","line-cap":"round"},paint:{"line-color":["get","color"],"line-width":9}});
    map.moveLayer("drive-route-halo");map.moveLayer("drive-route-line");
  }
  function clearResult(){
    ++token;abort?.abort();result=null;$("driveAnalyze").disabled=false;$("driveProfile").hidden=true;$("driveChart").replaceChildren();$("driveCards").replaceChildren();$("driveReadout").replaceChildren();$("driveSummary").textContent="";$("driveNotices").textContent="";
    map.getSource("drive-route")?.setData(empty);markers.inspect?.remove();delete markers.inspect;hooks.onSelection?.(null);map.resize();
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
    const s=result.samples[index];$("drivePositionLabel").textContent=`${s.km.toFixed(1)}km · ${timeLabel(s.time).slice(5)}${s.restMinutes?`（休憩${s.restMinutes}分後）`:""}`;
    const heading=node("strong",`${sourceLabel(s.source)} · ${s.riskLabel}`),body=node("span",`${s.elevation===null?"標高不明":`${Math.round(s.elevation)}m`}　${s.weather?`${s.weather}　`:""}気温 ${compactTemperature(s.temperature).replace("\n"," / ")}${s.temperature.includes("℃")?"℃":""}　積雪 ${compactSnow(s.snow)}${/\d/.test(s.snow)?"cm":""}`),note=node("details",undefined,"drive-point-note");note.append(node("summary","詳細"),node("small",`気温 ${s.temperature}。積雪深 ${s.snow}。${s.note}`));
    $("driveReadout").replaceChildren(heading,body,note);$("driveReadout").dataset.source=s.source;$("driveReadout").dataset.rank=String(s.rank);
    if(active){if(index===0||index===result.samples.length-1){markers.inspect?.remove();delete markers.inspect;}else pointMarker("inspect",s.coordinate,"●");if(move)map.easeTo({center:s.coordinate,duration:300});}
    const line=$("driveChart").querySelector(".drive-position-line");if(line){const axis=profileAxis(result.samples),x=axis.left+axis.width*s.km/result.route.distance;line.setAttribute("x1",x);line.setAttribute("x2",x);}
    const buttons=Array.from($("driveCards").querySelectorAll("button"));
    const nearest=buttons.reduce((best,b)=>Math.abs(Number(b.dataset.km)-s.km)<Math.abs(Number(best.dataset.km)-s.km)?b:best,buttons[0]);
    for(const button of buttons)button.setAttribute("aria-pressed",String(button===nearest));
    hooks.onSelection?.(s);
  }
  function renderProfile(){
    if(!result)return;
    const {route,samples,departure,priority}=result,stops=readBreaks().reduce((sum,b)=>sum+b.minutes,0),endTime=samples.at(-1).time;
    const sources=new Set(samples.map(s=>s.source));
    $("driveSummary").textContent=`${route.distance.toFixed(1)}km · 走行 約${Math.round(route.seconds/60)}分${stops?` ＋ 休憩${stops}分`:""} · ${PRIORITIES[priority]} · ${sourceLabel(samples[0].source)}${sources.size>1?"／"+[...sources].filter(s=>s!==samples[0].source).map(sourceLabel).join("／"):""}`;
    $("driveTripTiming").textContent=`出発 ${timeLabel(departure).slice(5)} → 到着 ${timeLabel(endTime).slice(5)}`;
    $("driveTripTiming").title=`出発 ${timeLabel(departure)} → 到着予定 ${timeLabel(endTime)}`;
    $("driveNotices").textContent=[...result.notices,!route.elevation?"標高を取得できませんでした。経路の気象は下に表示します。":"",priority==="local"&&route.hasHighway?"一般道優先ですが、一部に高速道路を含む経路です。":"",route.hasToll?"有料道路を含みます。":""].filter(Boolean).join(" ");
    $("driveProfileHelpLabel").textContent=$("driveNotices").textContent?"説明・注意あり":"表示の説明";
    $("driveProfile").hidden=!active;$("driveProfileBody").hidden=collapsed;$("driveProfileToggle").textContent=collapsed?"断面図を開く":"断面図を折りたたむ";$("driveProfileToggle").setAttribute("aria-expanded",String(!collapsed));
    const chart=svg("svg",{viewBox:"0 0 1000 90",preserveAspectRatio:"none",role:"img","aria-label":"横軸は走行距離km、縦軸は標高m。下の気象表と同じ距離位置。路線の色は区間の気象リスク。"});
    const valid=samples.filter(s=>Number.isFinite(s.elevation)),bottom=Math.min(0,...valid.map(s=>Math.floor(s.elevation/100)*100)),top=Math.max(bottom+100,...valid.map(s=>Math.ceil(s.elevation/100)*100));
    const axis=profileAxis(samples),x=km=>axis.left+axis.width*km/route.distance,y=z=>82-66*(z-bottom)/(top-bottom);
    for(let i=0;i<=2;i++){const z=bottom+(top-bottom)*i/2;chart.append(svg("line",{x1:axis.left,y1:y(z),x2:x(route.distance),y2:y(z),class:"drive-grid"}),svg("text",{x:60,y:y(z)+4,"text-anchor":"end"},String(Math.round(z))));}
    chart.append(svg("text",{x:8,y:14},"標高m"));
    const haloGroup=svg("g",{}),routeGroup=svg("g",{});chart.append(haloGroup,routeGroup);
    for(let i=0;i<samples.length-1;i++){const a=samples[i],b=samples[i+1],rank=a.rank===0||b.rank===0?0:Math.max(a.rank,b.rank);
      if(Number.isFinite(a.elevation)&&Number.isFinite(b.elevation)){
        const line={x1:x(a.km),y1:y(a.elevation),x2:x(b.km),y2:y(b.elevation),"stroke-linecap":"round"};
        haloGroup.append(svg("line",{...line,stroke:"#607a8b","stroke-width":6}));routeGroup.append(svg("line",{...line,stroke:ROUTE_COLORS[rank],"stroke-width":4}));
      }
    }
    if(!valid.length)chart.append(svg("text",{x:500,y:60,"text-anchor":"middle"},"標高データなし"));
    chart.append(svg("line",{x1:axis.left,x2:axis.left,y1:8,y2:85,class:"drive-position-line"}));
    chart.addEventListener("click",event=>{const box=chart.getBoundingClientRect(),km=Math.max(0,Math.min(route.distance,((event.clientX-box.left)/box.width*1000-axis.left)/axis.width*route.distance));let nearest=0;for(let i=1;i<samples.length;i++)if(Math.abs(samples[i].km-km)<Math.abs(samples[nearest].km-km))nearest=i;readout(nearest,true);});
    $("driveChart").replaceChildren(chart);$("drivePosition").max=String(samples.length-1);
    // Columns share the profile's distance axis; every sample remains available via the slider.
    const columns=Array.from({length:axis.columns},(_,j)=>{const km=route.distance*j/(axis.columns-1);return samples.reduce((best,s,i)=>Math.abs(s.km-km)<Math.abs(samples[best].km-km)?i:best,0);});
    const table=node("table",undefined,"drive-weather-table"),head=document.createElement("thead"),body=document.createElement("tbody"),header=document.createElement("tr");
    table.setAttribute("aria-label","経路の距離と通過時刻ごとの気象");const corner=node("th","距離\n通過時刻");corner.scope="col";header.append(corner);
    for(const i of columns){const s=samples[i],cell=document.createElement("th"),button=node("button");cell.scope="col";button.type="button";button.dataset.km=String(s.km);button.title=`${sourceLabel(s.source)} · ${timeLabel(s.time)}`;button.append(node("strong",`${s.km.toFixed(1)}km`),node("span",timeLabel(s.time).slice(5)));button.addEventListener("click",()=>readout(i,true));cell.append(button);header.append(cell);}
    head.append(header);
    for(const [label,key] of [["データ","source"],["天気","weather"],["気温 ℃","temperature"],["積雪 cm","snow"]]){const row=document.createElement("tr"),heading=node("th",label);row.dataset.field=key;heading.scope="row";row.append(heading);
      for(const i of columns){const s=samples[i],cell=document.createElement("td");cell.title=key==="source"?sourceLabel(s.source):key==="weather"?s.source==="normal"?"平年値では天気を表示しません":sourceLabel(s.source)+(s.weather?` · ${s.weather}`:""):s[key];cell.textContent=key==="source"?sourceLabel(s.source):key==="weather"?s.source==="normal"?"—":`${weatherIcon[s.weather]||""} ${s.weather||"資料なし"}`.trim():key==="temperature"?compactTemperature(s.temperature):compactSnow(s.snow);row.append(cell);}body.append(row);
    }
    table.append(head,body);$("driveCards").replaceChildren(table);readout(0);map.resize();
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
  return {bringToFront(){if(active)for(const id of ["drive-route-halo","drive-route-line"])if(map.getLayer(id))map.moveLayer(id);},setActive(value){active=value;$("driveControls").hidden=!value;$("driveProfile").hidden=!value||!result;if(!value){if(!result && $("driveAnalyze").disabled)status("解析を中止しました。「解析スタート」で再実行できます");++token;abort?.abort();$("driveAnalyze").disabled=false;for(const marker of Object.values(markers))marker.remove();}else{layers();updateSelection();if(result){map.getSource("drive-route").setData(routeSegments(result.route,result.samples));renderProfile();}}for(const id of ["drive-route-halo","drive-route-line"])if(map.getLayer(id))map.setLayoutProperty(id,"visibility",value?"visible":"none");map.resize();},isPicking:()=>Boolean(picking)};
}

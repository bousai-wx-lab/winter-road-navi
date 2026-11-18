import {AMEDAS_ROOT, snowMapKey, stationCoordinate} from "./live-snow-data.js?v=20261118-observed-snow2";
import {LIVE_ROOT, classForTemperature, decodeLiveCSV, liveFile, liveSlots, timeLabel} from "./live-temperature-data.js";
import {kmBetween} from "./drive-route-data.js";
import {lookupCell} from "./temperature-layer.js";
import {WEATHER_COLORS,weatherTile} from "./weather-data.js";

export const OBSERVED_ROAD_RULES = Object.freeze([
  "資料不足", "該当なし", "5℃以下・前12h降水", "2℃以下・前12h降水", "0℃以下・前12h降水",
  "雪・前3h降雪1cm未満", "前3h降雪1〜2cm", "前3h降雪3〜5cm", "前3h降雪6cm以上",
]);
const SUPPORT_KM = 15;

function stationsWithAmounts(table, frames, field, classify) {
  return Object.entries(table).flatMap(([id, station]) => {
    const coordinate = stationCoordinate(station);
    if (!coordinate) return [];
    const amounts = frames.map(frame => {
      const amount = frame?.[id]?.[field];
      return Array.isArray(amount) && amount[1] === 0 && Number.isFinite(amount[0]) && amount[0] >= 0 ? amount[0] : null;
    });
    const value = classify(amounts);
    return value === null ? [] : [{coordinate, value}];
  });
}

export function precipitationStations(table, frames) {
  return stationsWithAmounts(table,frames,"precipitation3h",amounts =>
    amounts.some(amount => amount > 0) ? true : amounts.every(amount => amount === 0) ? false : null);
}

export function snowfallStations(table, frames) {
  return stationsWithAmounts(table,frames,"snow1h",amounts =>
    amounts.every(Number.isFinite) ? amounts.reduce((sum,amount)=>sum+amount,0) : null);
}

export function observedRoadClass(temperature, wet, snowfall, snowWeather = null) {
  if (snowfall >= 6) return 8;
  if (snowfall >= 3) return 7;
  if (snowfall >= 1) return 6;
  if (snowfall !== null && (snowfall > 0 || snowWeather)) return 5;
  const temperatureClass = classForTemperature(temperature);
  if (wet === true && temperatureClass >= 2) return temperatureClass;
  return snowfall === 0 && snowWeather === false && (temperatureClass === 1 || wet === false) ? 1 : 0;
}

function nearestValue(point, stations) {
  let closest = SUPPORT_KM, value = null;
  for (const station of stations) {
    const [lng,lat] = station.coordinate;
    if (Math.abs(point[1]-lat) > .14 || Math.abs(point[0]-lng) > .21) continue;
    const distance = kmBetween(point,station.coordinate);
    if (distance > closest || distance === closest && value !== null) continue;
    closest = distance;
    value = station.value;
  }
  return value;
}

export function buildObservedRoadData(temperature, snowStations, rainStations, snowWeather = []) {
  const {grid, values} = temperature;
  const classes = Uint8Array.from(values, (value,i) => {
    const point = [(grid.cols[i]+.5)/grid.colScale,(grid.rows[i]+.5)/grid.rowScale];
    const weather = snowWeather[i] === 2 ? true : snowWeather[i] === 1 ? false : null;
    return observedRoadClass(value,nearestValue(point,rainStations),nearestValue(point,snowStations),weather);
  });
  return {grid, classes};
}

const hourAt = ms => new Date(ms+9*3600000).toISOString().slice(0,19)+"+09:00";
const weatherPixels = [...WEATHER_COLORS.map(color=>Number.parseInt(color.slice(1),16)),0xb9ebff];

async function snowWeatherMask(grid, slot, signal) {
  const {url,nativeZoom,tileSize} = weatherTile("observed",slot,6);
  const scale = 2**nativeZoom;
  const pixels = new Uint8Array(grid.count), groups = new Map();
  for (let i=0; i<grid.count; i++) {
    const lng=(grid.cols[i]+.5)/grid.colScale, lat=(grid.rows[i]+.5)/grid.rowScale;
    const column=(lng+180)/360*scale;
    const row=(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*scale;
    const x=Math.floor(column),y=Math.floor(row), key=`${x}/${y}`;
    if (!groups.has(key)) groups.set(key,{x,y,points:[]});
    groups.get(key).points.push({i, pixel:4*(Math.floor((row-y)*tileSize)*tileSize+Math.floor((column-x)*tileSize))});
  }
  await Promise.all([...groups.values()].map(async ({x,y,points}) => {
    try {
      const response=await fetch(url.replace("{x}",x).replace("{y}",y),{credentials:"omit",referrerPolicy:"no-referrer",signal});
      if (!response.ok) return;
      const image=await createImageBitmap(await response.blob());
      try {
        if (image.width!==tileSize || image.height!==tileSize) return;
        const canvas=document.createElement("canvas");
        canvas.width=canvas.height=tileSize;
        const context=canvas.getContext("2d");
        context.drawImage(image,0,0);
        const data=context.getImageData(0,0,tileSize,tileSize).data;
        for (const {i,pixel} of points) {
          // This compares the official categorical snow color, without deriving a snow amount from an image.
          if (data[pixel+3]!==255) continue;
          const category=weatherPixels.indexOf(data[pixel]*65536+data[pixel+1]*256+data[pixel+2]);
          if (category>=0) pixels[i]=category===4?2:1;
        }
      } finally { image.close(); }
    } catch (error) { if (signal.aborted) throw error; }
  }));
  return pixels;
}

export function initObservedRoadRisk({onData, onState, weatherSlot = () => null, now = Date.now} = {}) {
  let active = false, request = null, current = null, lastSnow = null;
  const earlierFrames = new Map();
  async function load(snapshot) {
    request?.abort();
    current = null;
    if (!active || !snapshot) { onState?.("waiting"); return; }
    const controller = new AbortController(), {signal} = controller;
    request = controller;
    onState?.("loading");
    async function get(url, json = true) {
      const response = await fetch(url, {cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
      if (!response.ok) throw new Error("実況の資料を取得できません");
      const text = await response.text();
      if (text.length > 5_000_000) throw new Error("実況の資料が大きすぎます");
      return json ? JSON.parse(text) : text;
    }
    try {
      const snowTime = Date.parse(snapshot.hour);
      if (now()-snowTime > 95*60000 || snowTime-now() > 5*60000) throw new Error("積雪の時刻が有効範囲外です");
      const manifestUrl = LIVE_ROOT+"observed_realtime_manifest.json";
      const readTemperature = async () => {
        const manifest = await get(manifestUrl);
        const [slot] = liveSlots(manifest,"current");
        const temperatureTime = Date.parse(slot.target_time);
        if (now()-temperatureTime > 35*60000 || temperatureTime-now() > 5*60000
          || Math.abs(temperatureTime-snowTime) > 65*60000) throw new Error("実況気温の時刻が有効範囲外です");
        const temperature = decodeLiveCSV(await get(LIVE_ROOT+liveFile("current",slot),false),"current",slot);
        if ((await get(manifestUrl)).latest_time !== slot.target_time) throw new Error("実況気温が更新中です");
        return {temperature, temperatureTime};
      };
      const offsets = [1,2,3,6,9];
      const [{temperature,temperatureTime},...earlier] = await Promise.all([
        readTemperature(),
        ...offsets.map(async offset => {
          const key = snowMapKey(hourAt(snowTime-offset*3600000));
          if (earlierFrames.has(key)) return earlierFrames.get(key);
          try {
            const frame = await get(AMEDAS_ROOT+`data/map/${key}.json`);
            earlierFrames.set(key,frame);
            if (earlierFrames.size > 12) earlierFrames.delete(earlierFrames.keys().next().value);
            return frame;
          } catch (error) { if (signal.aborted) throw error; return null; }
        }),
      ]);
      if (signal.aborted) return;
      const rainStations = precipitationStations(snapshot.table,[snapshot.data,...earlier.slice(2)]);
      const snowStations = snowfallStations(snapshot.table,[snapshot.data,...earlier.slice(0,2)]);
      const slot = weatherSlot();
      const snowWeather = slot && Date.parse(slot.end) === snowTime ? await snowWeatherMask(temperature.grid,slot,signal) : [];
      if (signal.aborted) return;
      current = {...buildObservedRoadData(temperature,snowStations,rainStations,snowWeather),snowTime,temperatureTime};
      onData?.(current);
      onState?.("ready",`気温 ${timeLabel(temperatureTime)} ・ 降雪・降水 ${timeLabel(snowTime)}まで`);
    } catch (error) {
      if (!signal.aborted) onState?.("error",error.message);
    }
  }
  return {
    setActive(value) { active = value; if (!value) { request?.abort(); current=null; lastSnow=null; } },
    setSnow(snapshot) { if (active) { lastSnow=snapshot; void load(snapshot); } },
    retry() { if (lastSnow) void load(lastSnow); },
    current: () => current,
    tooltipAt(lng,lat) {
      if (!current) return "資料を準備中・取得不能";
      const index = lookupCell(current.grid,lng,lat);
      return index < 0 ? "対象範囲外" : OBSERVED_ROAD_RULES[current.classes[index]];
    },
  };
}

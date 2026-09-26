// The upstream public feed is consumed without recomputing temperatures.
export const LIVE_ROOT = "https://nature-wx-lab.github.io/weather-distribution-plus/data/temperature_distribution_tool/";
export const LIVE_POLL_MS = 10 * 60 * 1000;
export const LIVE_KINDS = Object.freeze({
  current: { label: "実況気温（アメダス10分値から内挿）", manifest: "observed_realtime_manifest.json" },
  observed: { label: "実況の日最低・日最高", manifest: "observed_realtime_manifest.json" },
  temp3h: { label: "予想気温（3時間ごと）", manifest: "forecast_manifest.json" },
  daily: { label: "予想の日最低・日最高", manifest: "forecast_manifest.json" },
});

export function utcTime(value) {
  if (!/^\d{14}$/.test(value ?? "")) throw new Error("予報時刻が不正です");
  const iso = `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}Z`;
  if (!Number.isFinite(Date.parse(iso)) || new Date(iso).toISOString().replace(/[-:TZ.]/g, "").slice(0,14) !== value) throw new Error("予報時刻が不正です");
  return iso;
}

export function timeLabel(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "時刻不明";
  return new Intl.DateTimeFormat("ja-JP", {timeZone:"Asia/Tokyo", year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(date);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}

export function liveSlots(manifest, kind) {
  if (!Object.hasOwn(LIVE_KINDS, kind) || !Number.isFinite(Date.parse(manifest?.generated_at))) throw new Error("更新情報が不正です");
  if (kind === "current") {
    if (!Number.isFinite(Date.parse(manifest.latest_time)) || manifest.grid_count !== 31296 || manifest.station_count < 1) throw new Error("実況時刻・格子数が不正です");
    return [{id:"current", label:"最新の実況気温", target_date:manifest.latest_time.slice(0,10), target_time:manifest.latest_time, status:"available"}];
  }
  const slots = kind === "observed" ? manifest.slots : manifest.layers?.[kind]?.slots;
  if (!Array.isArray(slots) || !slots.length || slots.length > 48 || new Set(slots.map(s => s.id)).size !== slots.length) throw new Error("対象時刻が不正です");
  for (const slot of slots) {
    const idPattern = kind === "temp3h" ? /^temp3h_\d{14}$/ : kind === "observed" ? /^\d{8}_(min|max)$/ : /^(today|tomorrow)_(min|max)$/;
    if (!idPattern.test(slot.id ?? "") || !validDate(slot.target_date) || !["available","stale","unavailable"].includes(slot.status)) throw new Error("対象情報が不正です");
    if (kind === "observed") {
      if (manifest.grid_count !== 31296 || slot.id.slice(0,8) !== slot.target_date.replaceAll("-", "") || !Number.isFinite(Date.parse(slot.target_time))) throw new Error("実況対象日が不正です");
    } else if (slot.status !== "unavailable") {
      const target = utcTime(slot.validtime); utcTime(slot.basetime);
      const day = new Date(Date.parse(target) + 9*3600*1000).toISOString().slice(0,10);
      if (day !== slot.target_date || (kind === "temp3h" && slot.id !== `temp3h_${slot.validtime}`)) throw new Error("予想対象日が不正です");
    }
  }
  return slots;
}

export function liveFile(kind, slot) {
  if (slot.status === "unavailable") throw new Error("対象データなし");
  if (kind === "current") return "observed_temp_value_30y.csv";
  if (kind === "observed" && /^\d{8}_(min|max)$/.test(slot.id)) return `observed_${slot.id}_anomaly_30y.csv`;
  if (kind === "daily" && /^(today|tomorrow)_(min|max)$/.test(slot.id)) return `forecast_${slot.id}_anomaly_30y.csv`;
  if (kind === "temp3h" && /^temp3h_\d{14}$/.test(slot.id)) return `forecast_${slot.id}_value.csv`;
  throw new Error("データ参照が不正です");
}

export function liveSlotKey(slot,kind) {
  return kind === "temp3h" ? slot.validtime : kind === "current" ? "current" : `${slot.target_date}:${slot.element}`;
}

export function chooseLiveSlot(slots,{kind,id,target,followLatest=false,now=Date.now()}) {
  if(followLatest) return slots.at(-1);
  const kept=target ? slots.find(s=>liveSlotKey(s,kind)===target) : slots.find(s=>s.id===id);
  return kept || (kind==="daily"?slots.find(s=>s.status==="available"):null)
    || (kind==="temp3h"?slots.find(s=>s.status!=="unavailable" && Date.parse(utcTime(s.validtime))>=now):null) || slots.at(-1);
}

export function classForTemperature(value) {
  return !Number.isFinite(value) ? 0 : value <= 0 ? 4 : value <= 2 ? 3 : value <= 5 ? 2 : 1;
}

export function decodeLiveCSV(text, kind, slot, expectedCount = 31296) {
  if (typeof text !== "string" || text.length > 5_000_000) throw new Error("気温データが不正です");
  const lines = text.trim().replace(/^\uFEFF/, "").split(/\r?\n/), header = lines.shift().split(",");
  const field = kind === "current" || kind === "observed" ? "observed_c" : "forecast_c";
  const required = ["longitude","latitude",field,"source_date","target_date"];
  if (new Set(header).size !== header.length || required.some(key => !header.includes(key)) || lines.length !== expectedCount) throw new Error("気温の列・格子数が一致しません");
  const rows = lines.map(line => {
    const fields = line.split(",");
    if (fields.length !== header.length) throw new Error("気温の行が不正です");
    const record = Object.fromEntries(header.map((key,i)=>[key,fields[i]]));
    const lng=Number(record.longitude), lat=Number(record.latitude);
    const row=Math.floor(lat*20), col=Math.floor(lng*16);
    if (!record.longitude || !record.latitude || !Number.isFinite(lng) || !Number.isFinite(lat) || lng<122 || lng>150 || lat<20 || lat>48
      || Math.abs(lng-(col+.5)/16)>.0006 || Math.abs(lat-(row+.5)/20)>.00001) throw new Error("約5km格子の座標が不正です");
    const value=record[field] === "" ? NaN : Number(record[field]);
    if (record[field] !== "" && (!Number.isFinite(value) || value < -60 || value > 60)) throw new Error("気温値が不正です");
    const target=kind === "current" || kind === "observed" ? slot.target_time : slot.target_date;
    if (record.target_date !== target || ((kind === "current" || kind === "observed") && record.source_date !== slot.target_date)) throw new Error("気温と選択時刻が一致しません");
    return {row,col,value};
  }).sort((a,b)=>a.row-b.row || a.col-b.col);
  const count=rows.length, grid={count,rowScale:20,colScale:16,rows:new Uint16Array(count),cols:new Uint16Array(count),rects:new Float32Array(count*4)};
  const values=new Float64Array(count), bins=new Uint8Array(count), classes=new Uint8Array(count);
  const mercatorY=lat=>(1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2;
  rows.forEach(({row,col,value},i)=>{
    if(i && row===rows[i-1].row && col===rows[i-1].col) throw new Error("気温格子が重複しています");
    grid.rows[i]=row;grid.cols[i]=col;
    grid.rects.set([(col/16+180)/360,mercatorY(row/20),((col+1)/16+180)/360,mercatorY((row+1)/20)],i*4);
    values[i]=value;classes[i]=classForTemperature(value);
    bins[i]=classes[i]; // The live face uses the same thresholds as the roads.
  });
  return {grid,values,bins,classes};
}

export function liveFreshness(manifest, kind, slot, now=Date.now()) {
  if (kind === "current" || kind === "observed") {
    if (now-Date.parse(manifest.latest_time)>35*60*1000) return "実況の更新が遅れています。表示時刻を確認してください。";
    if (slot.source === "realtime") return "当日0時から表示時刻までの暫定値です。";
    return "";
  }
  if (slot.status === "unavailable") return slot.message || "この予想はデータなしです。";
  if (slot.status === "stale" || (kind === "temp3h" && Date.parse(utcTime(slot.validtime))<now)) return "予想対象時刻を過ぎています。実況も確認してください。";
  if (now-Date.parse(manifest.generated_at)>8*3600*1000) return "予想データの更新が遅れています。発表時刻を確認してください。";
  return "";
}

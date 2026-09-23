import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { setImmediate as nextTurn } from "node:timers/promises";
import { initTemperature, winterSeasonDays } from "../temperature-control.js";
import { ROAD_CLASSES } from "../temperature-display-data.js";

const CELL_COUNT = 387717;
const DAYS = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(5, 10));
const SEASON_DAYS = winterSeasonDays(DAYS);
const sourceIndex = (seasonIndex) => DAYS.indexOf(SEASON_DAYS[seasonIndex]);

class Element {
  constructor(value = "") {
    this.value = value;
    this.textContent = "";
    this.dataset = {};
    this.options = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.checked = true;
    this.disabled = false;
    this.hidden = false;
  }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  replaceChildren(...children) { this.options = children; }
  getContext() { return { fillStyle: "", fillRect() {} }; }
  emit(name) { return this.listeners.get(name)?.({ target: this }); }
}

async function waitFor(predicate, description) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 3000) throw new Error(`Timed out: ${description}`);
    await nextTurn();
  }
}

function payload(value, url) {
  const raw = Buffer.from(JSON.stringify(value));
  const bytes = url.endsWith(".gz") ? gzipSync(raw) : raw;
  return {
    bytes,
    record: { url, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), uncompressed_bytes: raw.byteLength },
  };
}

function fixture({ automatic = false } = {}) {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get("temperatureOpacity").value = "70";
  get("playSpeed").value = "10000";
  const document = {
    hidden: false,
    getElementById: get,
    querySelector: () => get("legend"),
    listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
  };
  const map = {
    layers: new Map(), listeners: new Map(),
    addLayer(layer, before) { assert.equal(before, "general-road-casing"); this.layers.set(layer.id, layer); },
    getLayer(id) { return this.layers.get(id); },
    removeLayer(id) { this.layers.delete(id); },
    on(name, fn) { this.listeners.set(name, fn); },
    click() { this.listeners.get("click")?.({ lngLat: { lng: 139.69375, lat: 35.6875 } }); },
  };
  const runs = [];
  for (let row = 4200, remaining = CELL_COUNT; remaining > 0; row++) {
    const length = Math.min(4000, remaining);
    runs.push(row, 10000, length);
    remaining -= length;
  }
  const grid = payload({ cell_count: CELL_COUNT, runs }, "grid.json");
  const data = DAYS.map((day, index) => {
    const bin = index % 81 + 1;
    const roadClass = bin <= 40 ? 4 : bin <= 42 ? 3 : bin <= 45 ? 2 : 1;
    return payload({ day, cell_count: CELL_COUNT, runs: [bin, CELL_COUNT], road_runs: [roadClass, CELL_COUNT] }, `${day}.json.gz`);
  });
  const manifest = {
    schema_version: 1, cell_count: CELL_COUNT, bin_min: -40, bin_step: 1, bin_count: 81, missing_bin: 0,
    days: DAYS, grid: grid.record, road_classes: ROAD_CLASSES, files: data.map((entry, i) => ({ day: DAYS[i], ...entry.record })),
  };
  let manual = !automatic;
  let closed = false;
  let rafId = 0;
  const responses = new Map();
  const calls = new Map();
  const failures = new Set();
  const frames = new Map();
  const actions = [];
  const roadEvents = [];
  const globals = ["document", "Option", "fetch", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    requestAnimationFrame: (fn) => { frames.set(++rafId, fn); return rafId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: async (url) => {
      if (closed) throw new Error("Fixture closed");
      const name = String(url).split("/").at(-1);
      if (name === "manifest.json") return Response.json(manifest);
      if (name === "grid.json") return new Response(grid.bytes);
      const index = DAYS.indexOf(name.replace(".json.gz", ""));
      assert.notEqual(index, -1, `unexpected URL ${url}`);
      calls.set(index, (calls.get(index) || 0) + 1);
      if (failures.has(index)) return new Response("unavailable", { status: 503 });
      if (!manual || (name === "09-15.json.gz" && calls.get(index) === 1)) return new Response(data[index].bytes);
      return new Promise((resolve, reject) => responses.set(index, { resolve, reject }));
    },
  });
  const invoke = (id, event) => {
    const result = Promise.resolve(get(id).emit(event));
    actions.push(result);
    return result;
  };
  return {
    get, map, frames, responses, calls, failures, roadEvents,
    async boot() {
      initTemperature(map, {
        onGrid: (grid) => roadEvents.push({ state: "grid", count: grid.count }),
        onDay: (classes, day) => roadEvents.push({ state: "day", day, value: classes[0], count: classes.length }),
        onUnavailable: (state) => roadEvents.push({ state }),
      });
      await waitFor(() => get("map").dataset.temperatureDay === "09-15", "initial day");
    },
    hold() { manual = true; },
    automatic() { manual = false; },
    play: () => invoke("playYear", "click"),
    retry: () => invoke("retryTemperature", "click"),
    select(index) { get("dateSlider").value = String(index); return invoke("dateSlider", "input"); },
    resolve(index) {
      const response = responses.get(index);
      assert.ok(response, `day ${index} is pending`);
      responses.delete(index);
      response.resolve(new Response(data[index].bytes));
    },
    progress() { return Number(get("seasonPreparationStatus").textContent.match(/(\d+)\/275日/)?.[1] || 0); },
    async close() {
      document.hidden = true;
      document.listeners.get("visibilitychange")?.();
      closed = true;
      for (const response of responses.values()) response.reject(new Error("Fixture closed"));
      responses.clear();
      await Promise.allSettled(actions);
      await nextTurn();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("the winter timeline is continuous across New Year and ends on June 15", () => {
  assert.equal(SEASON_DAYS.length, 275);
  assert.equal(SEASON_DAYS[0], "09-15");
  assert.equal(SEASON_DAYS.at(-1), "06-15");
  assert.equal(SEASON_DAYS[SEASON_DAYS.indexOf("12-31") + 1], "01-01");
  assert.equal(SEASON_DAYS[SEASON_DAYS.indexOf("02-28") + 1], "02-29");
  assert.equal(SEASON_DAYS.includes("07-01"), false);
  assert.throws(() => winterSeasonDays(DAYS.slice(1)), /Invalid calendar/);
});

test("a late earlier-day response cannot replace the newer selection", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.map.click();
    f.hold();
    const earlier = f.select(16);
    const later = f.select(17);
    await waitFor(() => f.responses.has(sourceIndex(17)), "newer selected day");
    f.resolve(sourceIndex(17));
    await later;
    assert.equal(f.responses.has(sourceIndex(16)), false, "obsolete rapid-slider day was not fetched");
    await earlier;
    assert.equal(f.get("map").dataset.temperatureDay, SEASON_DAYS[17]);
    assert.match(f.get("temperaturePoint").textContent, /10\/02/);
    assert.equal(f.roadEvents.at(-1).day, SEASON_DAYS[17]);
    assert.equal(f.roadEvents.some((event) => event.day === SEASON_DAYS[16]), false);
  } finally { await f.close(); }
});

test("cancelled playback does not cancel background preparation or start a stale animation", async () => {
  const f = fixture();
  try {
    await f.boot();
    let oldSettled = false;
    const old = f.play().then(() => { oldSettled = true; });
    assert.equal(f.responses.size, 3);
    await f.play(); // Stop the first preparation.
    const restarted = f.play();
    await waitFor(() => oldSettled, "cancelled generation settles without awaiting new requests");
    await old;
    assert.equal(f.get("playYear").getAttribute("aria-pressed"), "true");
    assert.equal(f.frames.size, 0);
    assert.deepEqual([...f.responses.keys()].sort((a, b) => a - b), [sourceIndex(1), sourceIndex(2), sourceIndex(3)].sort((a, b) => a - b));
    await f.play();
    // The background requests remain in flight after the second playback stop.
    assert.equal(f.responses.size, 3);
    for (const index of [...f.responses.keys()]) f.resolve(index);
    await restarted;
    assert.equal(f.frames.size, 0);
  } finally { await f.close(); }
});

test("clicking after a failed day load reports failure, and retry restores the selected point", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.failures.add(sourceIndex(15));
    await f.select(15);
    assert.equal(f.get("temperatureStatus").dataset.state, "error");
    assert.equal(f.get("retryTemperature").hidden, false);
    assert.equal(f.roadEvents.at(-1).state, "error");
    f.map.click();
    assert.doesNotMatch(f.get("temperaturePoint").textContent, /読み込み中/);
    assert.match(f.get("temperaturePoint").textContent, /失敗|再試行|表示でき/);
    f.failures.delete(sourceIndex(15));
    f.automatic();
    await f.retry();
    assert.equal(f.get("temperatureStatus").dataset.state, "ready");
    assert.match(f.get("temperaturePoint").textContent, /09\/30/);
    assert.equal(f.get("retryTemperature").hidden, true);
    assert.equal(f.roadEvents.at(-1).day, SEASON_DAYS[15]);
  } finally { await f.close(); }
});

test("mesh visibility and opacity leave the selected road classes unchanged", async () => {
  const f = fixture();
  try {
    await f.boot();
    const previousEvents = f.roadEvents.length;
    f.get("temperatureToggle").checked = false;
    f.get("temperatureToggle").emit("change");
    f.get("temperatureOpacity").value = "0";
    f.get("temperatureOpacity").emit("input");
    assert.equal(f.roadEvents.length, previousEvents);
    f.map.click();
    assert.match(f.get("temperaturePoint").textContent, /道路着色：0℃以下/);
    const pending = f.select(20);
    assert.equal(f.get("map").dataset.temperatureDay, "09-15");
    assert.match(f.get("mapTemperatureLabel").textContent, /9月15日を表示中/);
    await waitFor(() => f.responses.has(sourceIndex(20)), "selected uncached day");
    f.resolve(sourceIndex(20));
    await pending;
    assert.equal(f.roadEvents.at(-1).day, SEASON_DAYS[20]);
  } finally { await f.close(); }
});

test("an old preparation failure cannot overwrite a successful manual selection", async () => {
  const f = fixture();
  try {
    await f.boot();
    const preparation = f.play();
    const selection = f.select(20);
    await waitFor(() => f.responses.has(sourceIndex(20)), "manual selection");
    f.resolve(sourceIndex(20));
    await selection;
    const oldIndex = sourceIndex(1);
    const oldRequest = f.responses.get(oldIndex);
    f.responses.delete(oldIndex);
    oldRequest.reject(new Error("Delayed old request failed"));
    await preparation;
    assert.equal(f.get("map").dataset.temperatureDay, SEASON_DAYS[20]);
    assert.equal(f.get("temperatureStatus").dataset.state, "ready");
    assert.equal(f.get("playYear").getAttribute("aria-pressed"), "false");
    assert.equal(f.frames.size, 0);
  } finally { await f.close(); }
});

test("all 275 season days are prepared in the background and kept after playback stops", async () => {
  const f = fixture({ automatic: true });
  try {
    await f.boot();
    await waitFor(() => f.get("seasonPreparationStatus").textContent.includes("275日分の準備完了"), "season prepared");
    assert.equal(f.get("dateSlider").max, "274");
    assert.deepEqual(f.get("monthSelect").options.map((option) => Number(option.value)), [9, 10, 11, 12, 1, 2, 3, 4, 5, 6]);
    assert.equal(f.get("daySelect").options[0].value, "15");
    assert.equal(f.calls.size, 275, "summer files are never requested");
    assert.equal(f.calls.has(DAYS.indexOf("07-01")), false);
    await f.play();
    await f.play();
    const earlierCalls = f.calls.get(sourceIndex(0));
    const finalCalls = f.calls.get(sourceIndex(274));
    await f.select(SEASON_DAYS.indexOf("12-31"));
    await f.select(SEASON_DAYS.indexOf("12-31") + 1);
    assert.equal(f.get("map").dataset.temperatureDay, "01-01");
    await f.select(274);
    assert.equal(f.get("map").dataset.temperatureDay, "06-15");
    assert.equal(f.get("nextDay").disabled, true);
    assert.equal(f.get("daySelect").options.at(-1).value, "15");
    await f.select(275);
    assert.equal(f.get("map").dataset.temperatureDay, "06-15", "the slider cannot enter summer");
    await f.select(0);
    assert.equal(f.get("previousDay").disabled, true);
    assert.equal(f.calls.get(sourceIndex(0)), earlierCalls);
    assert.equal(f.calls.get(sourceIndex(274)), finalCalls);
    assert.equal(f.frames.size, 0);
  } finally { await f.close(); }
});

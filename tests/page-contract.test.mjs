import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

test("page explains independent climate estimates and safety limits", () => {
  for (const phrase of [
    "独自算出・独自内挿",
    "予報・実況・路面状態ではありません",
    "道路上の雪・凍結・通行規制や安全は判定しません",
    "公式の日別1kmメッシュではありません",
    "現在地を取得せず",
    "アクセス解析を使用しません",
  ]) {
    assert.equal(html.includes(phrase), true, phrase);
  }
});

test("page has no inline event handlers or executable inline scripts", () => {
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false);
  assert.equal(html.includes("javascript:"), false);
});

test("branded winter header and footer link to the blog and X without a usage guide", () => {
  assert.equal(html.includes('class="topbar-inner"'), true);
  assert.equal(html.includes('src="./assets/bousaiwxlab-site-icon.png"'), true);
  assert.equal(html.includes('class="site-footer"'), true);
  assert.equal(html.includes('href="https://bousai-wx-lab.com/"'), true);
  assert.equal(html.includes('href="https://x.com/bousai_wx_lab"'), true);
  assert.equal(html.includes("使い方"), false);
});

test("header stays compact and map focus does not add a second full frame", () => {
  assert.match(styles, /\.topbar\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /main\s*\{[^}]*padding:\s*0;/s);
  assert.match(styles, /\.map-shell\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;/s);
  assert.match(styles, /\.maplibregl-canvas:focus-visible\s*\{[^}]*outline:\s*none/s);
});

test("road controls and mesh calendar exist, old station blur remains absent", () => {
  for (const contract of ['id="highwayToggle"', 'id="generalToggle"', 'id="resetView"']) {
    assert.equal(html.includes(contract), true, contract);
  }
  for (const control of ['id="dateSlider"', 'id="temperatureToggle"', 'id="playYear"', 'id="previousDay"', 'id="nextDay"']) {
    assert.equal(html.includes(control), true, control);
  }
  for (const removed of ["temperature-data.js", "代表180地点"]) {
    assert.equal(html.includes(removed) || app.includes(removed), false, removed);
  }
});

test("winter calendar and background preparation are visible without exposing summer controls", () => {
  assert.equal(html.includes('id="dateSlider" type="range" min="0" max="274" value="0"'), true);
  assert.equal(html.includes('id="seasonPreparationStatus"'), true);
  assert.equal(html.includes("9月15日から翌6月15日までの275日"), true);
  assert.equal(html.includes("1年を再生"), false);
});

test("snow shares the same map and calendar with independent visibility, opacity and solid threshold lines", () => {
  for (const id of ["snowToggle", "snowOpacity", "snowStatus", "snowPreparationStatus", "snowPoint"]) {
    assert.equal(html.includes(`id="${id}"`), true, id);
  }
  for (const level of [1, 5, 10, 20, 50, 100]) assert.equal(html.includes(`>${level}cm</span>`), true);
  assert.equal(html.includes("雪域の境界</span>"), true);
  assert.equal(html.includes("現象なしは無色"), true);
  assert.equal(html.includes("細い実線"), true);
  assert.equal(html.includes("推定した1km格子境界"), true);
  assert.equal(app.includes("initSnow(map, grid, manifest)"), true);
});

test("application does not use location, storage, cookies, or HTML injection", () => {
  for (const token of [
    "geo" + "location",
    "local" + "Storage",
    "session" + "Storage",
    "indexed" + "DB",
    "document." + "cookie",
    "inner" + "HTML",
    "outer" + "HTML",
    "eval" + "(",
    "new " + "Function",
  ]) {
    assert.equal(app.includes(token), false, token);
  }
});

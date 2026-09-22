import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../styles.css", import.meta.url), "utf8");

test("page explains the climate normal scope and safety limits", () => {
  for (const phrase of [
    "気象庁の1991〜2020年の日別平年値を加工しています",
    "代表180地点をぼかした参考分布",
    "予報・実況・路面温度・凍結・通行規制・経路案内",
    "現在の道路状況や安全を示す地図ではありません",
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

test("daily timeline combines scrubbing, one-day steps, and full-year playback", () => {
  for (const contract of [
    'id="dateSlider"',
    'max="365"',
    'id="previousDay"',
    'id="nextDay"',
    'id="playButton"',
    'value="8"',
    'id="temperatureToggle"',
    'id="temperatureOpacity"',
  ]) {
    assert.equal(html.includes(contract), true, contract);
  }
  assert.equal(app.includes("requestAnimationFrame"), true);
  assert.equal(app.includes("TEMPERATURE_DAY_COUNT"), true);
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

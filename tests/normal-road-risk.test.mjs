import test from "node:test";
import assert from "node:assert/strict";
import {normalRoadClass, combineNormalRoadClasses, createNormalRoadRisk, ROAD_RISK_COLORS} from "../road-risk-data.js";
import {SNOW_BIN_STARTS} from "../snow-display-data.js";
import {RISK_RULES} from "../forecast-risk-data.js";

const snowBin = depth => SNOW_BIN_STARTS.indexOf(depth) + 3;
test("normal temperature bands align with forecast colors, with snow taking priority", () => {
  assert.deepEqual(RISK_RULES.map(r => r.color), ROAD_RISK_COLORS);
  for (const temperature of [0,1,2,3,4]) {
    assert.equal(normalRoadClass(temperature, 1), temperature);
    assert.equal(normalRoadClass(temperature, 2), 5);
    for (const [depth, expected] of [[1,6],[2,6],[3,7],[9,7],[10,8],[19,8],[100,8]]) {
      assert.equal(normalRoadClass(temperature, snowBin(depth)), expected);
    }
    assert.equal(normalRoadClass(temperature, 0), 0, "missing snow must not become snow-free");
  }
  assert.deepEqual([...combineNormalRoadClasses(new Uint8Array([4,1,0,2]), new Uint8Array([1,2,3,0]))], [4,5,6,0]);
  assert.throws(() => combineNormalRoadClasses(new Uint8Array(2), new Uint8Array(1)), /一致/);
  assert.throws(() => normalRoadClass(5, 1), /不正/);
  assert.throws(() => normalRoadClass(1, 255), /不正/);
});

test("late snow cannot replace a new day, a cleared mode, or a failed download", async () => {
  const pending = new Map(), shown = [], states = [];
  const risk = createNormalRoadRisk(day => new Promise((resolve, reject) => pending.set(day,{resolve,reject})), {
    onData: data => shown.push(data), onUnavailable: state => states.push(state),
  });
  const a = risk.setDay(new Uint8Array([4]), "01-01");
  const b = risk.setDay(new Uint8Array([1]), "01-02");
  pending.get("01-02").resolve(new Uint8Array([snowBin(10)])); await b;
  pending.get("01-01").resolve(new Uint8Array([1])); await a;
  assert.deepEqual(shown.map(v=>[v.day,...v.classes]), [["01-02",8]]);
  const c = risk.setDay(new Uint8Array([1]), "01-03"); risk.clear();
  pending.get("01-03").resolve(new Uint8Array([1])); await c;
  assert.equal(shown.length, 1);
  const d = risk.setDay(new Uint8Array([1]), "01-04");
  pending.get("01-04").reject(new Error("network")); await d;
  assert.equal(states.at(-1), "error"); assert.equal(shown.length, 1);
  const retry = risk.retry(); pending.get("01-04").resolve(new Uint8Array([2])); await retry;
  assert.equal(shown.at(-1).classes[0], 5);
});

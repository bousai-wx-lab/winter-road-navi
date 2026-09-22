import assert from "node:assert/strict";
import test from "node:test";
import { ROAD_CLASSES, validRoadClassContract, decodeDisplayDay, unpackRoadClasses, roadClassLabel } from "../temperature-display-data.js";

const runs = (values) => values.flatMap((value) => [value, 1]);
function decode(bins, classes) {
  return decodeDisplayDay({ cell_count: bins.length, runs: runs(bins), road_runs: runs(classes) }, bins.length);
}

test("two-bit road cache preserves missing and all source threshold classes", () => {
  // Includes the ambiguous display bins containing exactly 0, 2 and 5 degrees.
  const bins = [0, 40, 41, 41, 42, 43, 43, 44, 45, 46, 46, 47];
  const classes = [0, 4, 4, 3, 3, 3, 2, 2, 2, 2, 1, 1];
  const packed = decode(bins, classes);
  assert.equal(packed.roadCodes.length, 3);
  assert.deepEqual([...unpackRoadClasses(packed)], classes);
});

test("missing, impossible bin/class pairs and malformed runs fail closed", () => {
  for (const [bin, value] of [[0, 1], [40, 0], [40, 3], [41, 2], [42, 4], [43, 1], [44, 3], [46, 3], [47, 2]]) {
    assert.throws(() => decode([bin], [value]));
  }
  for (const road_runs of [undefined, [], [4], [4, 0], [4, 2], [5, 1], [4, 0.5]]) {
    assert.throws(() => decodeDisplayDay({ cell_count: 1, runs: [40, 1], road_runs }, 1));
  }
});

test("class metadata and labels cannot silently change thresholds", () => {
  assert.equal(validRoadClassContract(ROAD_CLASSES), true);
  const wrong = structuredClone(ROAD_CLASSES);
  wrong[3].upper_inclusive_c = 3;
  assert.equal(validRoadClassContract(wrong), false);
  assert.match(roadClassLabel(4), /0℃以下/);
  assert.match(roadClassLabel(0), /気温なし/);
  assert.throws(() => roadClassLabel(5));
});

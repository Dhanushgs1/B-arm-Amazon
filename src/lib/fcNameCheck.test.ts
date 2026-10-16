import test from "node:test";
import assert from "node:assert/strict";
import { missingFromFc, sameNames } from "./fcNameCheck.ts";

test("names in the Current stock sheet with no FC sheet match are listed once, in file order", () => {
  assert.deepEqual(missingFromFc(["Blades", " blades ", "Neck  traction pillow (Blue)", "New thing", "new thing"], ["BLADES", "Lancing device"]),
    ["Neck traction pillow (Blue)", "New thing"]);
  assert.deepEqual(missingFromFc(["", "Blades"], ["Blades"]), []);
});

test("same missing names in any order / case count as already mailed", () => {
  assert.ok(sameNames(["A", "b"], ["B", "a "]));
  assert.ok(!sameNames(["A"], ["A", "B"]));
});

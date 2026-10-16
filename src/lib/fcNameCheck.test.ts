import test from "node:test";
import assert from "node:assert/strict";
import { missingFromFc, sameNames, FC_IGNORED_NAMES } from "./fcNameCheck.ts";

test("names in the Current stock sheet with no FC sheet match are listed once, in file order", () => {
  assert.deepEqual(missingFromFc(["Blades", " blades ", "Foot  roller (Blue)", "New thing", "new thing"], ["BLADES", "Lancing device"]),
    ["Foot roller (Blue)", "New thing"]);
  assert.deepEqual(missingFromFc(["", "Blades"], ["Blades"]), []);
});

test("same missing names in any order / case count as already mailed", () => {
  assert.ok(sameNames(["A", "b"], ["B", "a "]));
  assert.ok(!sameNames(["A"], ["A", "B"]));
});

test("the 25 names of the 16-10-2026 mail: the 23 ignored ones are left out, the 2 new products and any other new name stay", () => {
  const mailed = [
    "Baby nasal aspirator - hand pump (white model)", "Baby nasal aspirator (hand pump-Pink)", "Bulb Syringe IUI applicator -8cm(Pack of 5)",
    "Chewy tube (Blue) - Spiral model", "Contact lens cleaner", "Cradle cap brush", "Cradle cap comb - double sided", "Cradle cap scrub",
    "Digital pelvic muscle trainer- new model", "Electric Baby Nasal Aspirator (Music & Lights)", "Instant Breast warmers (Red)",
    "IQ puzzles (Autism)", "IR Bulb", "IUI Catheter and Syringes (Insemination kit)", "Nail cleaning device", "Neck traction pillow (Blue)",
    "Neck traction pillow (green)", "Pelvic muscle floor trainer (screw type) - Blue", "Pregnancy kit combo with Ovulation thermometer",
    "Semi- Transparent Human Model", "Sensory brush", "Suture Practice pad(MW)", "Syringes for nasal aspirator",
    "Warming Lactation Massager (Dark Pink)", "Warming Lactation Massager (Green)",
  ];
  assert.deepEqual(missingFromFc([...mailed, "sensory BRUSH ", "Brand new product"], []), [
    "Chewy tube (Blue) - Spiral model", "Electric Baby Nasal Aspirator (Music & Lights)", "Brand new product",
  ]);
});

// The two screenshots of 16-10-2026, name for name.
const PIC1_UNMARKED = [
  "Neck traction pillow (Blue)", "Neck traction pillow (green)", "Sensory brush", "Suture Practice pad(MW)",
  "Baby nasal aspirator - hand pump (white model)", "Contact lens cleaner", "Cradle cap scrub", "Cradle cap brush",
  "Cradle cap comb - double sided", "Syringes for nasal aspirator", "Pregnancy kit combo with Ovulation thermometer",
  "IQ puzzles (Autism)", "IUI Catheter and Syringes (Insemination kit)", "Bulb Syringe IUI applicator -8cm(Pack of 5)", "IR Bulb",
];
const PIC1_YELLOW = ["Chewy tube (Blue) - Spiral model", "Electric Baby Nasal Aspirator (Music & Lights)"];
const PIC2_NOT_RESTOCKED = [
  "Baby nasal aspirator (hand pump-Pink)", "Instant Breast warmers (Red)", "Warming Lactation Massager (Green)",
  "Warming Lactation Massager (Dark Pink)", "Wearable lactation massager (Purple)", "Wearable lactation massager (Grey)",
  "Pelvic muscle floor trainer (screw type) - Blue", "Digital pelvic muscle trainer- new model", "Nail cleaning device",
  "Semi- Transparent Human Model",
];

test("ignore list is exactly the 15 unmarked (picture 1) + the 10 not-restocked (picture 2)", () => {
  assert.equal(PIC1_UNMARKED.length, 15);
  assert.equal(PIC2_NOT_RESTOCKED.length, 10);
  assert.deepEqual([...FC_IGNORED_NAMES].sort(), [...PIC1_UNMARKED, ...PIC2_NOT_RESTOCKED].sort());
  for (const y of PIC1_YELLOW) assert.ok(!FC_IGNORED_NAMES.includes(y), `${y} must not be ignored`);
});

test("each of the 25 is left out, also with other case / spacing; the 2 yellow and new products are mailed", () => {
  for (const n of [...PIC1_UNMARKED, ...PIC2_NOT_RESTOCKED]) {
    assert.deepEqual(missingFromFc([n], []), [], n);
    assert.deepEqual(missingFromFc([`  ${n.toUpperCase()}  `], []), [], `${n} (upper case, padded)`);
  }
  assert.deepEqual(missingFromFc([...PIC1_UNMARKED, ...PIC1_YELLOW, ...PIC2_NOT_RESTOCKED, "Brand new product"], []),
    [...PIC1_YELLOW, "Brand new product"]);
  // A yellow product already in the FC sheet is not mailed, like any other matched name.
  assert.deepEqual(missingFromFc(PIC1_YELLOW, ["Chewy tube (Blue) - Spiral model"]), ["Electric Baby Nasal Aspirator (Music & Lights)"]);
});

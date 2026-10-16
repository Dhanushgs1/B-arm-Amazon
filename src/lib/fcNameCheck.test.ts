import test from "node:test";
import assert from "node:assert/strict";
import { missingFromFc, sameNames } from "./fcNameCheck.ts";

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

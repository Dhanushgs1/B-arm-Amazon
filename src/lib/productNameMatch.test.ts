import test from "node:test";
import assert from "node:assert/strict";
import { productMatchKey, nameIndex } from "./productNameMatch.ts";

test("match key: case, outer / repeated spaces, brackets and punctuation do not matter", () => {
  const k = productMatchKey("Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)");
  assert.equal(productMatchKey("Pregnancy kit(1 early 1 normal 2 pee cup)"), k);
  assert.equal(productMatchKey("  pregnancy   KIT (1 early, 1 normal, 2 pee cup) "), k);
  assert.equal(productMatchKey("Pregnancy kit\r\n(1 early 1 normal 2 pee cup)"), k);
  assert.equal(productMatchKey("IR Thermometer GP-100"), productMatchKey("IR THERMOMETER- GP 100"));
  assert.equal(productMatchKey("Nylon suture thread 2-0 - 24MM"), productMatchKey("Nylon suture thread 2-0 24 mm"));
  assert.equal(productMatchKey("Anti choking device- Red & Black"), productMatchKey("Anti choking device - Red and Black"));
  assert.equal(productMatchKey("Mesh Nebulizer MY135B (Grey)"), productMatchKey("Mesh nebulizer MY 135 B grey"));
});

test("match key: different pack sizes, quantities, variants and decimals stay apart", () => {
  const differ = (a: string, b: string) => assert.notEqual(productMatchKey(a), productMatchKey(b), `${a} ≠ ${b}`);
  differ("Bulb Syringe IUI applicator (10.5 cm)(Pack of 2)", "Bulb Syringe IUI applicator (10.5 cm)(Pack of 5)");
  differ("Bulb Syringe IUI applicator (10.5 cm)(Pack of 2)", "Bulb Syringe IUI applicator (105 cm)(Pack of 2)");
  differ("Ovulation strips (Pack of 2)", "Ovulation strips (Pack of 20)");
  differ("gluco spark Meter With 25 Strips & 25 lancets", "gluco spark Meter With 50 Strips & 25 lancets");
  differ("gluco spark Meter With 50 Strips & 25 lancets", "gluco spark Meter With 50 Strips & 50 lancets");
  differ("Chewy tube (Red)", "Chewy tube (Red) - Spiral model");
  differ("Chewy tube (Red)", "Chewy tube (Yellow)");
  differ("Mesh nebulizer MY135B (Blue)", "Mesh Nebulizer MY135B (Grey)");
  differ("Nylon 19mm Suture Thread", "Nylon 2-0 19mm suture thread");
  differ("Insemination kit (Pack of 2)", "Insemination kit-17cm Supplier 2 (Pack of 2)");
  differ("Pregnancy kit combo with Ovulation thermometer", "Pregnancy kit combo without Ovulation thermometer");
  differ("Glucospark 50 strips and 100 lancets (without meter)", "Glucospark 100 strips and 100 lancets (without meter)");
  // order of words is kept: a colour combo is not the same as its reverse
  differ("Chewy tube combo- Red and green", "Chewy tube combo- Green and red");
  assert.equal(productMatchKey(""), "");
  assert.equal(productMatchKey(null), "");
});

const SPS = [
  { product: "Pregnancy kit(1 early 1 normal 2 pee cup)", qty: 22 },
  { product: "UTI Test Strips (Pack of 4)", qty: 0 },
  { product: "Lancing device", qty: null },
  { product: "Ovulation strips (Pack of 10)", qty: 163 },
  { product: "Ovulation strips (Pack of 20)", qty: 80 },
];
const idx = (rows: { product: string; qty: number | null }[]) => nameIndex(rows, (r) => r.product, (r) => r.qty);

test("lookup: exact, normalized, missing; a real 0 and a blank quantity are told apart", () => {
  const ix = idx(SPS);
  const hit = ix.find("Pregnancy Kit (1 Early 1 Normal 2 Pee Cup)");
  assert.equal(hit.status, "normalized");
  assert.equal(hit.status === "normalized" && hit.row.qty, 22);
  const zero = ix.find("UTI Test Strips (Pack of 4)");
  assert.equal(zero.status, "exact");
  assert.equal(zero.status === "exact" && zero.row.qty, 0);
  const blank = ix.find("lancing  device");
  assert.equal(blank.status, "exact");          // product found …
  assert.equal(blank.status === "exact" && blank.row.qty, null); // … but its quantity is missing
  assert.deepEqual(ix.find("Ovulation strips (Pack of 5)"), { status: "missing" });
  assert.equal(ix.find("Ovulation strips (Pack of 20)").status, "exact");
});

test("lookup: names that collide after normalizing with different values are ambiguous, never guessed", () => {
  const ix = idx([
    { product: "Teething tube combo (Green red yellow)", qty: 408 },
    { product: "Teething Tube Combo (Green, Red, Yellow)", qty: 12 },
  ]);
  const amb = ix.find("Teething tube combo - green red yellow");
  assert.equal(amb.status, "ambiguous");
  assert.deepEqual(amb.status === "ambiguous" && amb.candidates, ["Teething tube combo (Green red yellow)", "Teething Tube Combo (Green, Red, Yellow)"]);
  // an exact spelling is not a guess
  assert.equal(ix.find("Teething tube combo (Green red yellow)").status, "exact");
  assert.equal(ix.ambiguous().length, 1);
});

test("lookup: repeated names with the same value resolve; with different values they are ambiguous", () => {
  const same = idx([{ product: "Sensory brush", qty: 1344 }, { product: "Sensory  Brush", qty: 1344 }]);
  const r = same.find("sensory brush");
  assert.equal(r.status, "exact");
  assert.equal(r.status === "exact" && r.row.qty, 1344);
  const clash = idx([{ product: "Sensory brush", qty: 1344 }, { product: "Sensory brush", qty: 5 }]);
  assert.equal(clash.find("Sensory brush").status, "ambiguous");
  assert.equal(clash.find("Sensory-brush").status, "ambiguous");
});

// The JavaScript model must produce the reference model's registers exactly.
//   node test/parity.test.js
// Fixtures: dev/make_fixtures.py (needs the VTX project's Python model).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Speech = require("../js/speech.js");

const dict = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "vendor", "cmudict.dict.gz"))).toString("utf8");
Speech.loadDictionary(dict);
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "parity.json"), "utf8"));

let failures = 0, frames = 0;
for (const c of cases) {
  const r = Speech.speak(c.voice, c.text, c.mode);
  const problems = [];
  if (r.frames.length !== c.regs.length) problems.push(`frames ${r.frames.length}, expected ${c.regs.length}`);
  const n = Math.min(r.frames.length, c.regs.length);
  for (let i = 0; i < n && problems.length < 3; i++) {
    const got = r.frames[i].regs.join(","), want = c.regs[i].join(",");
    if (got !== want) problems.push(`frame ${i}: ${got} expected ${want}`);
    if (r.frames[i].shape !== c.shape[i]) problems.push(`frame ${i}: shape ${r.frames[i].shape} expected ${c.shape[i]}`);
  }
  const phon = JSON.stringify(r.phonemes.map((p) => [p.label, p.start]));
  if (phon !== JSON.stringify(c.phonemes)) problems.push(`phonemes ${phon}`);
  const words = JSON.stringify(r.words.map((w) => [w.word, w.phonemes.join(" "), w.how]));
  if (words !== JSON.stringify(c.words)) problems.push(`words ${words} expected ${JSON.stringify(c.words)}`);
  frames += n;
  if (problems.length) { failures++; console.log(`FAIL ${JSON.stringify(c.text)}\n  ${problems.join("\n  ")}`); }
}
console.log(`${cases.length - failures}/${cases.length} cases exact, ${frames} frames compared`);
process.exit(failures ? 1 : 0);

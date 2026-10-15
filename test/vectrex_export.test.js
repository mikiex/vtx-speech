// The Vectrex exporter must give the VTX project's exporter's bytes.
//   node test/vectrex_export.test.js
// Fixture: dev/make_export_fixture.py (needs the VTX project).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Speech = require("../js/speech.js");
const Export = require("../js/vectrex_export.js");

Speech.loadDictionary(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "vendor", "cmudict.dict.gz"))).toString("utf8"));
const want = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "vectrex_export.json"), "utf8"));
const c = Export.compile(want.source, want.word_order);
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const hex = (bytes) => Buffer.from(bytes).toString("hex");

check(!c.problems.length, `compiles${c.problems.length ? ": " + c.problems.join("; ") : ""}`);
if (!c.problems.length) {
  check(JSON.stringify(c.noises) === JSON.stringify(want.noises), `noise table (${want.noises.length} entries)`);
  const badWords = want.words.filter((w, i) => hex(c.words[i]) !== w).length;
  check(c.words.length === want.words.length && !badWords, `${want.words.length} word tracks byte-identical`);
  const badSeqs = want.seqs.filter((s, i) => !c.seqs[i] || hex(c.seqs[i].bytes) !== s.bytes).length;
  check(!badSeqs, `${want.seqs.length} phrases and alternatives byte-identical`);
  const asm = Export.toAsm(c);
  check(/^VS_Words:/m.test(asm) && /^VS_Clock_EP:/m.test(asm), "AS09 source has the player's tables");
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);

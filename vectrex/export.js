// Phrase list -> speech data for vtx_speech.asm (AS09 source).
//   node vectrex/export.js <phrases.txt> [speech_data.asm]
// The same exporter as the web page (https://mikiex.github.io/vtx-speech/).
// The phrase format is described at the top of js/vectrex_export.js.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Speech = require("../js/speech.js");
const Export = require("../js/vectrex_export.js");

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error("usage: node vectrex/export.js <phrases.txt> [speech_data.asm]");
  process.exit(2);
}
Speech.loadDictionary(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "..", "vendor", "cmudict.dict.gz"))).toString("utf8"));
const c = Export.compile(fs.readFileSync(input, "utf8"));
if (c.problems.length) {
  console.error(c.problems.join("\n"));
  process.exit(1);
}
const asm = Export.toAsm(c, `node vectrex/export.js ${path.basename(input)}`);
if (output) {
  fs.writeFileSync(output, asm);
  const bytes = c.words.reduce((t, w) => t + w.length, 0);
  console.log(`${output}: ${c.names.length} words (${bytes} bytes), ${c.phrases.length} phrases`);
} else process.stdout.write(asm);

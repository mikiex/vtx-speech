// Prints a recording's loudness and pitch per 50 Hz frame, to copy the
// cadence and intonation of a phrase into phoneme-mode text.
//   node dev/analyse_reference.js <file.wav> [our phoneme text]
// Reference recordings stay out of the repository (build/ is ignored).
// With phoneme text, our rendering of it is printed beside the recording.
"use strict";
const fs = require("fs");
const path = require("path");

function readWav(file) {
  const b = fs.readFileSync(file), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const id = (o) => b.toString("latin1", o, o + 4);
  if (id(0) !== "RIFF" || id(8) !== "WAVE") throw new Error("not a WAV file");
  let p = 12, channels = 1, rate = 0, bits = 16;
  while (p + 8 <= b.length) {
    const size = v.getUint32(p + 4, true);
    if (id(p) === "fmt ") { channels = v.getUint16(p + 10, true); rate = v.getUint32(p + 12, true); bits = v.getUint16(p + 22, true); }
    if (id(p) === "data") {
      const step = channels * bits / 8, n = Math.floor(Math.min(size, b.length - p - 8) / step), out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const o = p + 8 + i * step;
        out[i] = bits === 8 ? (b[o] - 128) / 128 : v.getInt16(o, true) / 32768;
      }
      return { samples: out, rate };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

// Per 20 ms frame: RMS (dB below the loudest frame) and pitch by normalised
// autocorrelation over 40 ms (60..400 Hz), 0 when unvoiced or quiet.
function analyse(samples, rate) {
  const hop = Math.round(rate / 50), win = 2 * hop, minLag = Math.floor(rate / 400), maxLag = Math.ceil(rate / 60);
  const frames = [];
  for (let s = 0; s + hop <= samples.length; s += hop) {
    let e = 0;
    for (let i = 0; i < hop; i++) e += samples[s + i] ** 2;
    frames.push({ rms: Math.sqrt(e / hop), f0: 0, clarity: 0 });
  }
  const peak = Math.max(...frames.map((f) => f.rms));
  frames.forEach((f, k) => {
    f.db = 20 * Math.log10(f.rms / peak + 1e-9);
    const s = k * hop;
    if (f.db < -30 || s + win + maxLag > samples.length) return;
    let best = -1, bestLag = 0;
    const r = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let xy = 0, xx = 0, yy = 0;
      for (let i = 0; i < win; i++) { const x = samples[s + i], y = samples[s + i + lag]; xy += x * y; xx += x * x; yy += y * y; }
      r.push(xx && yy ? xy / Math.sqrt(xx * yy) : 0);
    }
    best = Math.max(...r);
    // The first peak within 90% of the best guards against octave errors.
    const i = r.findIndex((x, j) => x >= 0.9 * best && (j === 0 || x >= r[j - 1]) && (j === r.length - 1 || x >= r[j + 1]));
    bestLag = minLag + i;
    f.clarity = best;
    if (best >= 0.5) f.f0 = rate / bestLag;
  });
  return frames;
}

const [file, text] = process.argv.slice(2);
if (!file) { console.error("usage: node dev/analyse_reference.js <file.wav> [phoneme text]"); process.exit(2); }
const ref = readWav(file);
const a = analyse(ref.samples, ref.rate);
let ours = null, labels = [];
if (text) {
  const root = path.join(__dirname, "..");
  const zlib = require("zlib");
  const Speech = require(path.join(root, "js", "speech.js")), Render = require(path.join(root, "js", "render.js"));
  global.Ayumi = undefined;
  eval(fs.readFileSync(path.join(root, "vendor", "ayumi.js"), "utf8").replace("Ayumi = function", "global.Ayumi = function"));
  Speech.loadDictionary(zlib.gunzipSync(fs.readFileSync(path.join(root, "vendor", "cmudict.dict.gz"))).toString());
  const r = Speech.speak({}, text, "phonemes");
  // Our pitch is exact: the envelope period of each voiced frame. (The
  // autocorrelation tracker does not lock reliably onto AY output.)
  ours = analyse(Render.render(r.frames, 22050, { clock: 1500000 }, global.Ayumi), 22050);
  ours.forEach((o, k) => { const fr = r.frames[k]; o.f0 = fr && fr.regs.slice(8, 11).some((x) => x & 0x10) ? fr.pitch : 0; });
  r.phonemes.forEach((p) => { labels[p.start] = p.label; });
}
console.log(`${path.basename(file)}: ${ref.rate} Hz, ${(ref.samples.length / ref.rate).toFixed(2)} s, ${a.length} frames`);
console.log("frame  ms    ref dB  ref Hz" + (ours ? "   ours dB ours Hz  phoneme" : ""));
for (let k = 0; k < Math.max(a.length, ours ? ours.length : 0); k++) {
  const f = a[k], o = ours && ours[k];
  const cell = (x) => (x ? `${x.db.toFixed(0).padStart(6)}  ${x.f0 ? x.f0.toFixed(0).padStart(6) : "     -"}` : "".padStart(14));
  console.log(`${String(k).padStart(5)} ${String(k * 20).padStart(5)} ${cell(f)}` + (ours ? `   ${cell(o)}  ${labels[k] || ""}` : ""));
}

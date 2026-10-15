// VTX Speech: English text -> AY register frames, one set per 50 Hz frame.
//
// A JavaScript port of the reference voice model (voice.py, phonemes.py and
// pronounce.py in the VTX project). For the default 1.5 MHz clock it
// produces exactly the reference model's registers (test/parity.test.js).
// Nothing here makes sound: render.js plays the frames through Ayumi.
//
// Works in the browser (window.Speech) and in Node (module.exports).
(function (root) {
  "use strict";

  const FRAME_RATE = 50;
  const DEFAULT_CLOCK = 1500000;
  const MIXER_SILENT = 0x3f;

  // Python's round(): halves go to the even neighbour. The reference model
  // uses it, so the port must too, or some periods differ by one.
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const mix = (a, b, t) => a + (b - a) * t;

  // --- phonemes ------------------------------------------------------------
  // ARPAbet. kind, formants (F1, F2, F3 in Hz), length in 20 ms frames.
  // Vowel formants: Peterson & Barney (1952), adult male averages.
  const P = {};
  function add(names, kind, f, frames, extra) {
    for (const name of names.split(" ")) P[name] = Object.assign({ kind, f: f || null, frames: frames || 8 }, extra || {});
  }
  add("IY", "vowel", [270, 2290, 3010], 9);
  add("IH", "vowel", [390, 1990, 2550], 7);
  add("EH", "vowel", [530, 1840, 2480], 8);
  add("AE", "vowel", [660, 1720, 2410], 10);
  add("AA", "vowel", [730, 1090, 2440], 10);
  add("AO", "vowel", [570, 840, 2410], 10);
  add("UH", "vowel", [440, 1020, 2240], 7);
  add("UW", "vowel", [300, 870, 2240], 9);
  add("AH", "vowel", [640, 1190, 2390], 7);
  add("ER", "vowel", [490, 1350, 1690], 9);
  add("AX", "vowel", [500, 1500, 2500], 4);
  // Diphthongs move from f to f2.
  add("EY", "vowel", [530, 1840, 2480], 12, { f2: [300, 2200, 2900] });
  add("AY", "vowel", [730, 1090, 2440], 14, { f2: [300, 2100, 2900] });
  add("OW", "vowel", [570, 840, 2410], 12, { f2: [330, 800, 2300] });
  add("AW", "vowel", [730, 1090, 2440], 14, { f2: [330, 800, 2300] });
  add("OY", "vowel", [570, 840, 2410], 14, { f2: [300, 2100, 2900] });
  add("W", "sonorant", [290, 610, 2150], 5);
  add("Y", "sonorant", [260, 2070, 3020], 5);
  add("L", "sonorant", [360, 1050, 2880], 6);
  add("R", "sonorant", [310, 1060, 1380], 6);
  add("M", "nasal", [250, 1000, 2200], 6);
  add("N", "nasal", [250, 1700, 2600], 6);
  add("NG", "nasal", [250, 2300, 2750], 6);
  // Fricatives: noise period (smaller is brighter) and noise volume.
  add("S", "fricative", null, 8, { noise: 2, level: 12 });
  add("SH", "fricative", null, 8, { noise: 5, level: 12 });
  add("F", "fricative", null, 7, { noise: 3, level: 7 });
  add("TH", "fricative", null, 6, { noise: 3, level: 6 });
  add("Z", "fricative", [250, 1600, 2500], 7, { noise: 2, level: 10, voiced: true });
  add("ZH", "fricative", [250, 1800, 2500], 7, { noise: 5, level: 10, voiced: true });
  add("V", "fricative", [250, 1100, 2400], 6, { noise: 3, level: 6, voiced: true });
  add("DH", "fricative", [250, 1400, 2500], 5, { noise: 3, level: 5, voiced: true });
  add("HH", "aspirate", null, 4, { noise: 10, level: 8 });
  // Plosives: closure frames, a burst of noise, aspiration, and the formant
  // "locus" the next sound slides in from.
  add("P", "plosive", null, 4, { noise: 8, level: 11, burst: 1, aspirate: 2, locus: [250, 800, 2200] });
  add("B", "plosive", null, 3, { noise: 8, level: 9, burst: 1, aspirate: 0, locus: [250, 800, 2200], voiced: true });
  add("T", "plosive", null, 4, { noise: 2, level: 12, burst: 1, aspirate: 2, locus: [300, 1800, 2700] });
  add("D", "plosive", null, 3, { noise: 2, level: 10, burst: 1, aspirate: 0, locus: [300, 1800, 2700], voiced: true });
  add("K", "plosive", null, 4, { noise: 5, level: 12, burst: 2, aspirate: 2, locus: [300, 2200, 2600] });
  add("G", "plosive", null, 3, { noise: 5, level: 10, burst: 1, aspirate: 0, locus: [300, 2200, 2600], voiced: true });
  add("CH", "affricate", null, 3, { parts: ["T", "SH"] });
  add("JH", "affricate", null, 3, { parts: ["D", "ZH"] });

  // --- pronunciation -------------------------------------------------------
  const SHORT_PAUSE = 8, LONG_PAUSE = 14;
  const PROJECT_WORDS = {
    vectrex: "V EH1 K T R EH2 K S",
    vtx: "V IY1 T IY1 EH1 K S",
    ok: "OW2 K EY1",
    ay: "EY1 W AY1",                 // the chip's name, said as letters
  };
  const PREFERRED = { live: 2, read: 2, lead: 2, wind: 2, wound: 2 };

  class SpeechError extends Error {}

  // CMUdict: word -> first pronunciation, and words with several.
  let DICT = new Map(), VARIANTS = new Map();
  function loadDictionary(text) {
    const first = new Map(), all = new Map();
    for (let line of text.split("\n")) {
      const hash = line.indexOf("#");
      if (hash >= 0) line = line.slice(0, hash);
      line = line.trim();
      if (!line) continue;
      const parts = line.split(/\s+/), word = parts[0], phones = parts.slice(1).join(" ");
      if (!word.includes("(") && !first.has(word)) first.set(word, phones);
      const base = word.split("(")[0];
      if (!all.has(base)) all.set(base, []);
      all.get(base).push(phones);
    }
    VARIANTS = new Map([...all].filter(([, v]) => v.length > 1));
    DICT = first;
    return first.size;
  }

  const known = (word) => PROJECT_WORDS[word] ? PROJECT_WORDS[word].split(" ")
    : DICT.has(word) ? DICT.get(word).split(" ") : null;

  const VOICELESS = new Set(["P", "T", "K", "F", "TH"]);
  const SIBILANT = new Set(["S", "Z", "SH", "ZH", "CH", "JH"]);
  const bare = (ph) => ph.replace(/\d/g, "");
  function plural(phones) {
    const last = bare(phones[phones.length - 1]);
    if (SIBILANT.has(last)) return phones.concat(["IH0", "Z"]);
    return phones.concat([VOICELESS.has(last) ? "S" : "Z"]);
  }
  function past(phones) {
    const last = bare(phones[phones.length - 1]);
    if (last === "T" || last === "D") return phones.concat(["IH0", "D"]);
    return phones.concat([VOICELESS.has(last) || ["S", "SH", "CH"].includes(last) ? "T" : "D"]);
  }
  const ENDINGS = [
    ["'s", plural], ["es", plural], ["s", plural], ["ed", past],
    ["ing", (p) => p.concat(["IH0", "NG"])], ["ers", (p) => p.concat(["ER0", "Z"])],
    ["er", (p) => p.concat(["ER0"])], ["ly", (p) => p.concat(["L", "IY0"])],
    ["ness", (p) => p.concat(["N", "AH0", "S"])], ["less", (p) => p.concat(["L", "AH0", "S"])],
  ];
  function derived(word) {
    for (const [ending, addEnding] of ENDINGS) {
      if (word.endsWith(ending) && word.length > ending.length + 2) {
        const root = word.slice(0, -ending.length);
        const doubled = root.length > 3 && root[root.length - 1] === root[root.length - 2] ? root.slice(0, -1) : null;
        for (const candidate of [root, root + "e", doubled]) {
          const phones = candidate && known(candidate);
          if (phones) return addEnding(phones.slice());
        }
      }
    }
    for (let cut = word.length - 3; cut > 2; cut--) {        // longest first part first
      const a = known(word.slice(0, cut)), b = known(word.slice(cut));
      if (a && b) return a.concat(b);
    }
    return null;
  }

  // Letter-to-sound guesses, longest spellings first ("V" stress as digit).
  const RULES = [
    ["tion", "SH AH0 N"], ["sion", "ZH AH0 N"], ["ture", "CH ER0"], ["igh", "AY1"], ["tch", "CH"],
    ["sch", "S K"], ["ph", "F"], ["sh", "SH"], ["ch", "CH"], ["th", "TH"], ["ck", "K"], ["ng", "NG"],
    ["qu", "K W"], ["wh", "W"], ["kn", "N"], ["wr", "R"], ["ee", "IY1"], ["ea", "IY1"], ["oo", "UW1"],
    ["ou", "AW1"], ["ow", "OW1"], ["oi", "OY1"], ["oy", "OY1"], ["ai", "EY1"], ["ay", "EY1"],
    ["oa", "OW1"], ["au", "AO1"], ["aw", "AO1"], ["ew", "UW1"], ["ie", "IY1"], ["ey", "IY0"],
    ["a", "AE1"], ["e", "EH1"], ["i", "IH1"], ["o", "AA1"], ["u", "AH1"], ["y", "IY0"],
    ["b", "B"], ["c", "K"], ["d", "D"], ["f", "F"], ["g", "G"], ["h", "HH"], ["j", "JH"], ["k", "K"],
    ["l", "L"], ["m", "M"], ["n", "N"], ["p", "P"], ["q", "K"], ["r", "R"], ["s", "S"], ["t", "T"],
    ["v", "V"], ["w", "W"], ["x", "K S"], ["z", "Z"],
  ].sort((a, b) => b[0].length - a[0].length);
  const LONG = { a: "EY1", e: "IY1", i: "AY1", o: "OW1", u: "UW1" };

  function guess(word) {
    let out = [], i = 0;
    const w = word.toLowerCase();
    while (i < w.length) {
      if (w[i] === "e" && i === w.length - 1 && i > 1) break;            // silent final e
      if (LONG[w[i]] && i + 2 === w.length - 1 && w[w.length - 1] === "e" && !"aeiouy".includes(w[i + 1])) {
        out.push(LONG[w[i]]); i += 1; continue;                          // magic e: "vane"
      }
      if ("cg".includes(w[i]) && i + 1 < w.length && "eiy".includes(w[i + 1])) {
        out.push(w[i] === "c" ? "S" : "JH"); i += 1; continue;           // soft c, g
      }
      const rule = RULES.find(([spelling]) => w.startsWith(spelling, i));
      if (rule) { out = out.concat(rule[1].split(" ")); i += rule[0].length; } else i += 1;
    }
    let stressed = false;
    out = out.map((ph) => {
      const d = ph[ph.length - 1];
      if (!/\d/.test(d)) return ph;
      const r = ph.slice(0, -1) + (stressed && d === "1" ? "0" : d);
      stressed = stressed || d === "1";
      return r;
    });
    return out.length ? out : ["AH0"];
  }

  // [phonemes, how]: how is "project", "dictionary", "derived" or "guessed".
  function pronounce(word, choice = 1) {
    const w = word.toLowerCase().replace(/^'+|'+$/g, "");
    if (PROJECT_WORDS[w]) return [PROJECT_WORDS[w].split(" "), "project"];
    if (choice > 1 || (choice === 1 && w in PREFERRED)) {
      const options = VARIANTS.get(w) || [];
      if (choice > options.length) {
        if (!DICT.size && w in PREFERRED && choice === PREFERRED[w]) return [guess(w), "guessed"];
        throw new SpeechError(`"${word}" has ${Math.max(1, options.length)} pronunciation(s), not ${choice}`);
      }
      return [options[choice - 1].split(" "), "dictionary"];
    }
    if (DICT.has(w)) return [DICT.get(w).split(" "), "dictionary"];
    const d = derived(w);
    if (d) return [d, "derived"];
    return [guess(w), "guessed"];
  }

  const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
  const TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
  function numberWords(n) {
    if (n < 20) return [ONES[n]];
    if (n < 100) return [TENS[Math.floor(n / 10)]].concat(n % 10 ? [ONES[n % 10]] : []);
    if (n < 1000) return [ONES[Math.floor(n / 100)], "hundred"].concat(n % 100 ? ["and"].concat(numberWords(n % 100)) : []);
    if (n < 1000000) return numberWords(Math.floor(n / 1000)).concat(["thousand"], n % 1000 ? numberWords(n % 1000) : []);
    return String(n).split("").map((c) => ONES[+c]);
  }

  function symbolToken(text, word) {
    const m = /^([A-Za-z]+)([012])?(?::(\d+))?(?:@(\d+(?:\.\d+)?))?$/.exec(text);
    if (!m || !P[m[1].toUpperCase()]) {
      throw new SpeechError(`unknown phoneme "${text}"; known: ${Object.keys(P).sort().join(" ")} ` +
        "(optionally with stress 0-2, :frames and @pitch, e.g. OW1:15@140)");
    }
    return { p: m[1].toUpperCase(), stress: m[2] ? +m[2] : null, frames: m[3] ? +m[3] : null,
      pitch: m[4] ? +m[4] : null, word };
  }

  function mark(token) {
    if (/^[,.]:\d+$/.test(token)) return { pause: +token.slice(2), rise: false, fixed: true };
    if ([",", ";", ":"].includes(token)) return { pause: SHORT_PAUSE, rise: false };
    if ([".", "!"].includes(token)) return { pause: LONG_PAUSE, rise: false };
    if (token === "?") return { pause: LONG_PAUSE, rise: true };
    if (token.startsWith("^")) return { base: token.length > 1 ? parseFloat(token.slice(1)) : null };
    return null;
  }

  function join(tokens, more) {
    if (tokens.length && "p" in tokens[tokens.length - 1] && more.length && "p" in more[0]) tokens.push({ gap: true });
    for (const t of more) tokens.push(t);
  }

  // English text -> {tokens, words}.
  function parseText(text) {
    const tokens = [], words = [];
    const re = /\/[^/]*\/|[,.]:\d+|\^\d*(?:\.\d+)?|\d+|[A-Za-z']+(?:#\d+)?|[.,!?;:]/g;
    let found;
    while ((found = re.exec(text))) {
      let part = found[0];
      const span = [found.index, found.index + part.length];
      const m = mark(part);
      if (m) { tokens.push(m); continue; }
      if (part.startsWith("/")) {
        const n = words.length, symbols = part.slice(1, -1).split(/\s+/).filter(Boolean);
        words.push({ word: part, phonemes: symbols, how: "phonemes", span });
        join(tokens, symbols.map((s) => symbolToken(s, n)));
        continue;
      }
      const hash = part.indexOf("#"), choice = hash >= 0 ? part.slice(hash + 1) : "";
      if (hash >= 0) part = part.slice(0, hash);
      for (const w of /^\d+$/.test(part) ? numberWords(parseInt(part, 10)) : [part]) {
        const chosen = choice ? +choice : (PREFERRED[w.toLowerCase()] || 1);
        const [phones, how] = pronounce(w, chosen);
        const n = words.length;
        const key = w.toLowerCase().replace(/^'+|'+$/g, "");
        words.push({ word: w, phonemes: phones, how, span,
          variants: how === "project" ? 1 : ((VARIANTS.get(key) || []).length || 1),
          choice: chosen, preferred: PREFERRED[w.toLowerCase()] || 1 });
        join(tokens, phones.map((s) => symbolToken(s, n)));
      }
    }
    if (!tokens.some((t) => "p" in t)) throw new SpeechError("nothing to say");
    return { tokens, words };
  }

  // ARPAbet text -> {tokens, words}: "HH AH0 L OW1:15@140 | W ER1 L D ?".
  function parsePhonemes(text) {
    const tokens = [], words = [];
    let current = [];
    const endWord = () => {
      if (!current.length) return;
      words.push({ word: `#${words.length + 1}`, how: "phonemes",
        phonemes: current.map((t) => t.p + (t.stress !== null ? String(t.stress) : "")) });
      join(tokens, current);
      current = [];
    };
    const re = /[A-Za-z]+[012]?(?::\d+)?(?:@\d+(?:\.\d+)?)?|[,.]:\d+|\^\d*(?:\.\d+)?|[|.,!?;:]/g;
    let found;
    while ((found = re.exec(text))) {
      const part = found[0];
      if (part === "|") { endWord(); continue; }
      const m = mark(part);
      if (m) { endWord(); tokens.push(m); continue; }
      current.push(symbolToken(part, words.length));
    }
    endWord();
    if (!tokens.some((t) => "p" in t)) throw new SpeechError("nothing to say");
    return { tokens, words };
  }

  // --- the voice -----------------------------------------------------------
  const DEFAULT_VOICE = {
    pitch: 110,
    vibrato: { depth: 0, rate: 5 },
    shape: 8,
    lock: "nearest",
    channels: [{ role: "F1", volume: "env" }, { role: "F2", volume: "env" }, { role: "F3", volume: "level" }],
    noise: { period: 0, channels: [] },
    intonation: { stress: 0.15, fall: 0.2, question: 0.35 },
    rate: 1,
    layout: "full",
    clock: DEFAULT_CLOCK,
  };
  const SPEECH_LEVEL = { F1: 14, F2: 10, F3: 6 };
  const STRESS_LENGTH = { 1: 1.3, 2: 1.0, 0: 0.75 };
  const PITCH_SMOOTHING = 0.5;
  const NEAREST_MAX = 63;
  const NEAREST_RECIP = Array.from({ length: NEAREST_MAX + 1 }, (_, n) => n ? pyRound(16384 / n) : 0);

  function withDefaults(voice) {
    const v = Object.assign({}, DEFAULT_VOICE, voice || {});
    for (const key of ["vibrato", "noise", "intonation"]) v[key] = Object.assign({}, DEFAULT_VOICE[key], (voice || {})[key] || {});
    return v;
  }

  // Clocks per envelope cycle at EP = 1: a sawtooth is one sweep, a
  // triangle (shapes 10, 14) two.
  const cycleClocks = (shape) => (shape === 10 || shape === 14 ? 512 : 256);
  const envelopePeriod = (f0, shape, clock) => clamp(pyRound(clock / (cycleClocks(shape) * f0)), 1, 65535);
  const envelopePitch = (ep, shape, clock) => clock / (cycleClocks(shape) * ep);
  const tonePeriod = (freq, clock) => clamp(pyRound(clock / (16 * freq)), 1, 4095);
  const formantUnits = (freq) => clamp(pyRound(freq / 16), 1, 255);
  // The lock's constant: F / f0 = Fq * EP * 4096 / clock, as a 16-bit fraction.
  const nearestK = (clock) => pyRound(65536 * 4096 / clock);

  // "nearest": the formant moves to the nearest harmonic of the pitch, using
  // only multiplies and a 64-entry reciprocal table (what a 6809 does):
  //   Fq = round(F / 16)                 the formant in 16 Hz units
  //   n  = (Fq * EP * K + 32768) >> 16   the nearest harmonic, 1..63
  //   TP = (EP * R[n] + 512) >> 10       round(16 EP / n), R[n] = round(16384 / n)
  // Returns [tone period, harmonic or null, exact].
  function lockedPeriod(freq, ep, lock, shape, clock) {
    if (lock === "off") return [tonePeriod(freq, clock), null, false];
    const triangle = cycleClocks(shape) === 512;
    const k = nearestK(clock) * (triangle ? 2 : 1);
    // Division by 65536 rather than >> keeps products above 2^31 exact.
    const n = clamp(Math.floor((formantUnits(freq) * ep * k + 32768) / 65536), 1, NEAREST_MAX);
    const tp = triangle ? Math.floor((ep * NEAREST_RECIP[n] + 256) / 512) : Math.floor((ep * NEAREST_RECIP[n] + 512) / 1024);
    const base = Math.floor(cycleClocks(shape) * ep / 16);
    return [clamp(tp, 1, 4095), n, base % n === 0 && tp * n === base];
  }

  // One state per frame (label, formants, voicing, noise ...).
  function phonemeStates(tokens, rate) {
    let speed = rate;
    const scaled = (n, least = 1) => Math.max(least, pyRound(n / speed));
    const states = [];
    let lastF = null, base = null;

    const push = (tok, label, f, voice, noise, first) => states.push({
      label, f, voice, noise, first,
      stress: tok ? tok.stress : null, pitch: tok ? tok.pitch : null,
      base, word: tok ? tok.word : null, jump: false,
    });
    const nextFormants = (i) => {
      for (const t of tokens.slice(i + 1)) if ("p" in t && P[t.p].f) return P[t.p].f;
      return [500, 1500, 2500];
    };
    const voiced = (tok, target, frames, voice, glide, noise = null, fEnd = null) => {
      const start = lastF || target;
      for (let k = 0; k < frames; k++) {
        const g = glide ? Math.min(1, (k + 1) / glide) : 1;
        let f = start.map((a, j) => mix(a, target[j], g));
        if (fEnd) {                                   // a diphthong moves on in its last two thirds
          const d = Math.max(0, (k - frames / 3) / (frames * 2 / 3));
          f = f.map((a, j) => mix(a, fEnd[j], d));
        }
        push(tok, tok.p, f, voice, noise, k === 0);
      }
      lastF = states[states.length - 1].f.slice();
    };

    tokens.forEach((tok, i) => {
      if (tok.gap) return;
      if ("base" in tok) { base = tok.base; if (base === null) speed = rate; return; }
      if ("pause" in tok) {
        const n = tok.fixed ? tok.pause : scaled(tok.pause);
        for (let k = 0; k < n; k++) { push(null, "pause", null, null, null, k === 0); states[states.length - 1].rise = tok.rise || false; }
        lastF = null;
        return;
      }
      const p = P[tok.p], kind = p.kind;
      let frames = tok.frames || p.frames;
      if (!tok.frames && kind === "vowel" && tok.stress !== null) frames = Math.max(3, pyRound(frames * STRESS_LENGTH[tok.stress]));
      frames = scaled(frames, kind === "vowel" ? 2 : 1);
      if (kind === "vowel" || kind === "sonorant") voiced(tok, p.f, frames, "full", kind === "vowel" ? 4 : 2, null, p.f2 || null);
      else if (kind === "nasal") voiced(tok, p.f, frames, "murmur", 2);
      else if (kind === "fricative" && p.voiced) voiced(tok, p.f, frames, "low", 2, [p.noise, p.level]);
      else if (kind === "fricative") {
        for (let k = 0; k < frames; k++) push(tok, tok.p, null, null, [p.noise, p.level], k === 0);
        if (p.locus) lastF = p.locus;
      } else if (kind === "aspirate") {
        for (let k = 0; k < frames; k++) push(tok, tok.p, nextFormants(i), null, [p.noise, p.level], k === 0);
        lastF = nextFormants(i);
      } else {                                        // plosive or affricate
        let first = true;
        for (const part of kind === "plosive" ? [tok.p] : p.parts) {
          const q = P[part];
          if (q.kind === "fricative") {
            for (let k = 0, n = scaled(Math.max(1, q.frames - 2)); k < n; k++) push(tok, tok.p, null, null, [q.noise, q.level], false);
            continue;
          }
          const closure = scaled(kind === "plosive" ? (tok.frames || q.frames) : q.frames);
          for (let k = 0; k < closure; k++) {
            push(tok, tok.p, q.voiced ? [250, 800, 2400] : null, q.voiced ? "bar" : null, null, first);
            first = false;
          }
          for (let k = 0; k < q.burst; k++) push(tok, tok.p, null, null, [q.noise, q.level], false);
          for (let k = 0, n = scaled(q.aspirate, 0); k < n; k++) push(tok, tok.p, null, null, [10, Math.max(0, q.level - 4)], false);
          lastF = q.locus;
        }
      }
    });
    return states;
  }

  // The pitch of every frame: falling through each phrase, raised on
  // stressed vowels, rising at a "?", @pitch overrides; then smoothed.
  function intonation(v, states) {
    const into = v.intonation, targets = new Array(states.length).fill(0);
    let start = 0;
    while (start < states.length) {
      let end = start;
      while (end < states.length && states[end].label !== "pause") end++;
      const rise = end < states.length && states[end].rise;
      let lastStress = null;
      for (let i = start; i < end; i++) if (states[i].stress === 1 && states[i].first) lastStress = i;
      const len = end - start;
      for (let i = start; i < end; i++) {
        const s = states[i], pos = (i - start) / Math.max(1, len - 1);
        let f0 = (s.base || v.pitch) * (1 + into.fall / 2 - into.fall * pos);
        if (s.stress === 1) f0 *= 1 + into.stress;
        else if (s.stress === 2) f0 *= 1 + into.stress / 2;
        if (rise && lastStress !== null && i >= lastStress) f0 *= 1 + into.question * (i - lastStress) / Math.max(1, end - 1 - lastStress);
        targets[i] = s.pitch ? s.pitch : f0;
      }
      for (let i = end; i < states.length; i++) {
        if (states[i].label !== "pause") break;
        targets[i] = end > start ? targets[end - 1] : v.pitch;
        end = i + 1;
      }
      start = Math.max(end, start + 1);
    }
    const out = [];
    let current = null;
    states.forEach((state, i) => {
      if (current === null || state.label === "pause" || state.jump) current = targets[i];
      else current += (targets[i] - current) * PITCH_SMOOTHING;
      out.push(current);
    });
    return out;
  }

  // Registers R0..R13 for one state. Voicing "full" uses the voice's channel
  // set-up; "murmur" (nasals): F1 on the envelope and a weak steady F2;
  // "low"/"bar" (voiced fricatives, voiced closures): F1 alone. Noise takes
  // channel C, or B in the "shared" layout (which leaves C to a game).
  function speechFrame(v, state, f0) {
    const f = state.f, voice = state.voice, noise = state.noise;
    const shared = v.layout === "shared";
    let setups;
    if (voice === "full" && shared) setups = [{ role: "F1", volume: "env" }, { role: "F2", volume: "env" }, { role: "off", volume: 0 }];
    else if (voice === "full") setups = v.channels.map((c) => Object.assign({}, c));
    else if (voice === "murmur") setups = [{ role: "F1", volume: "env" }, { role: "F2", volume: 5 }, { role: "off", volume: 0 }];
    else if (voice === "low" || voice === "bar") setups = [{ role: "F1", volume: "env" }, { role: "off", volume: 0 }, { role: "off", volume: 0 }];
    else setups = [0, 1, 2].map(() => ({ role: "off", volume: 0 }));
    // Whisper (an experiment beyond the reference model): no envelope, so no
    // buzz; each formant tone is ANDed with fast noise at a steady volume.
    const whisper = v.whisper && voice;
    if (whisper) {
      setups.forEach((s) => {
        if (/^F[123]$/.test(s.role) && s.volume === "env") { s.volume = SPEECH_LEVEL[s.role]; s.hiss = true; }
      });
    }
    if (noise) setups[shared ? 1 : 2] = { role: "noise", volume: noise[1] };
    const rasp = voice === "full" && !noise && !shared && v.noise.channels.length > 0;
    let formants = f || [500, 1500, 2500];
    // A smaller vocal tract has higher formants (about x1.15 to x1.2 for
    // women's voices, more for children's). 1 is the reference model.
    if (v.formantScale && v.formantScale !== 1) formants = formants.map((x) => x * v.formantScale);
    const ep = envelopePeriod(f0, v.shape, v.clock);
    const regs = new Array(14).fill(0);
    let mixer = 0x3f;
    const tones = [];
    setups.forEach((setup, ch) => {
      const role = setup.role, volume = setup.volume;
      let tp = 0, harmonic = null, exact = false, freq = 0;
      if (role === "F1" || role === "F2" || role === "F3") {
        [tp, harmonic, exact] = lockedPeriod(formants[+role[1] - 1], ep, v.lock, v.shape, v.clock);
        freq = v.clock / (16 * tp);
        mixer &= ~(1 << ch);
      }
      if (role === "noise" || setup.hiss || (rasp && v.noise.channels.includes(ch) && role !== "off")) mixer &= ~(8 << ch);
      let vol;
      if (role === "off") vol = 0;
      else if (volume === "env" || role === "source") vol = 0x10;
      else if (volume === "level") vol = SPEECH_LEVEL[role];
      else vol = volume;
      regs[2 * ch] = tp & 0xff; regs[2 * ch + 1] = tp >> 8;
      regs[8 + ch] = vol;
      tones.push({ role, period: tp, freq, harmonic, exact });
    });
    regs[6] = noise ? noise[0] : whisper ? 1 : rasp ? v.noise.period : 0;
    regs[7] = mixer & 0x3f;
    regs[11] = ep & 0xff; regs[12] = ep >> 8;
    regs[13] = v.shape;
    const silent = !voice && !noise;
    return { regs, vowel: silent ? "-" : state.label, pitch: envelopePitch(ep, v.shape, v.clock),
      targets: f ? formants.map((x) => Math.round(x)) : [], tones, voicing: voice, noise };
  }

  // text -> {frames, phonemes (label, start frame, word), words}.
  // Each frame: regs R0..R13 and `shape` (write R13: restart the envelope).
  function speak(voice, text, mode = "text") {
    const v = withDefaults(voice);
    const { tokens, words } = mode === "phonemes" ? parsePhonemes(text) : parseText(text);
    const states = phonemeStates(tokens, v.rate);
    const pitches = intonation(v, states);
    const frames = [], phonemes = [];
    states.forEach((state, t) => {
      let f0 = pitches[t];
      f0 *= 1 + v.vibrato.depth * Math.sin(2 * Math.PI * v.vibrato.rate * t / FRAME_RATE);
      frames.push(speechFrame(v, state, f0));
      if (state.first) {
        phonemes.push({ label: state.label + (state.stress === null || state.stress === undefined ? "" : String(state.stress)),
          start: t, word: state.word });
      }
    });
    let voicedBefore = false;
    for (const frame of frames) {
      const isVoiced = frame.regs.slice(8, 11).some((r) => r & 0x10);
      frame.shape = isVoiced && !voicedBefore;          // restart the envelope at each voice onset
      voicedBefore = isVoiced;
    }
    return { frames, phonemes, words, tokens, states };
  }

  // --- storage, for the size comparison --------------------------------------
  // The compact cartridge format: runs of identical states (voicing kind,
  // noise, F1 and F2 in 16 Hz units), one header byte and 0-3 operand bytes
  // per run of up to 15 frames, $FF at the end. Registers are rebuilt from
  // a state each frame (the lock needs the pitch).
  //   header  bit 7     formant bytes follow (F1, then F2 for kinds 1 and 2);
  //                     clear: keep the previous run's formants
  //           bit 6     a noise byte follows (an index into the noise table)
  //           bits 5-4  kind: 0 silent, 1 voiced, 2 nasal, 3 F1 only
  //           bits 3-0  frames - 1 (runs are split at 15 frames)
  //   $FF     end
  const KINDS = { full: 1, murmur: 2, low: 3, bar: 3 };
  const KIND_NAMES = ["silent", "voiced: F1 and F2", "nasal: F1 and a weak F2", "F1 only: a voiced fricative or closure"];
  // `noiseTable`: a shared table of [period, volume] pairs (a cartridge has
  // one for all its words); without it the noises are listed as they come.
  function encodeRuns(states, noiseTable = []) {
    const runs = [];
    states.forEach((s, i) => {
      const kind = KINDS[s.voice] || 0, f = s.f || [500, 1500, 2500];
      const q1 = kind ? formantUnits(f[0]) : 0, q2 = kind === 1 || kind === 2 ? formantUnits(f[1]) : 0;
      const noise = s.noise ? s.noise.join(",") : "";
      const key = [kind, noise, q1, q2].join("|"), last = runs[runs.length - 1];
      if (last && last.key === key && last.frames < 15) last.frames++;
      else runs.push({ key, kind, noise: s.noise ? s.noise.slice() : null, q1, q2, start: i, frames: 1, label: s.label });
    });
    const bytes = [];
    let h1 = null, h2 = null;
    runs.forEach((r, k) => {
      r.bytes = [];
      const formants = (r.kind === 1 || r.kind === 2) ? (r.q1 !== h1 || r.q2 !== h2) : r.kind === 3 ? r.q1 !== h1 : false;
      const header = (formants ? 0x80 : 0) | (r.noise ? 0x40 : 0) | (r.kind << 4) | (r.frames - 1);
      r.bytes.push({ value: header, role: "header", run: k });
      if (formants) {
        r.bytes.push({ value: r.q1, role: "f1", run: k });
        h1 = r.q1;
        if (r.kind !== 3) { r.bytes.push({ value: r.q2, role: "f2", run: k }); h2 = r.q2; }
      }
      if (r.noise) {
        const key = r.noise.join(",");
        let index = noiseTable.findIndex((n) => n.join(",") === key);
        if (index < 0) { noiseTable.push(r.noise.slice()); index = noiseTable.length - 1; }
        r.bytes.push({ value: index, role: "noise", run: k });
      }
      bytes.push(...r.bytes);
    });
    bytes.push({ value: 0xff, role: "end", run: null });
    return { runs, bytes, noiseTable };
  }
  // --- SpeakJet-style input ---------------------------------------------------
  // The SpeakJet chip's allophone codes (user manual, "MSA Sound Allophone
  // Component List") as VTX phonemes: "\HE \EH \LE \OWWW" or "183 131 145 164"
  // -> "HH EH L OW". The same table and rules as vectrex/vtxspeech/speakjet.py.
  const SJ_ALLOPHONES = ("IY IH EY EH AY AX UX OH AW OW UH UW MM NE NO NGE NGO LE LO WW RR IYRR EYRR AXRR AWRR " +
    "OWRR EYIY OHIY OWIY OHIH IYEH EHLL IYUW AXUW IHWW AYWW OWWW JH VV ZZ ZH DH BE BO EB OB DE DO ED OD GE GO " +
    "EG OG CH HE HO WH FF SE SO SH TH TT TU TS KE KO EK OK PE PO").split(" ");          // codes 128..199
  const SJ_SOUNDS = {
    IY: ["IY"], IH: ["IH"], EY: ["EH"], EH: ["EH"], AY: ["AE"], AX: ["AX"], UX: ["AH"], OH: ["AA"], AW: ["AO"],
    OW: ["OW"], UH: ["UH"], UW: ["UW"], MM: ["M"], NE: ["N"], NO: ["N"], NGE: ["NG"], NGO: ["NG"],
    LE: ["L"], LO: ["L"], WW: ["W"], RR: ["R"],
    IYRR: ["IY", "ER"], EYRR: ["EH", "ER"], AXRR: ["ER"], AWRR: ["AA", "ER"], OWRR: ["AO", "ER"],
    EYIY: ["EY"], OHIY: ["AY"], OWIY: ["OY"], OHIH: ["AY"], IYEH: ["Y", "EH"], EHLL: ["AX", "L"],
    IYUW: ["Y", "UW"], AXUW: ["AW"], IHWW: ["UW"], AYWW: ["AW"], OWWW: ["OW"],
    JH: ["JH"], VV: ["V"], ZZ: ["Z"], ZH: ["ZH"], DH: ["DH"],
    BE: ["B"], BO: ["B"], EB: ["B"], OB: ["B"], DE: ["D"], DO: ["D"], ED: ["D"], OD: ["D"],
    GE: ["G"], GO: ["G"], EG: ["G"], OG: ["G"],
    CH: ["CH"], HE: ["HH"], HO: ["HH"], WH: ["HH"], FF: ["F"], SE: ["S"], SO: ["S"], SH: ["SH"], TH: ["TH"],
    TT: ["T"], TU: ["T"], TS: ["T", "S"], KE: ["K"], KO: ["K"], EK: ["K"], OK: ["K"], PE: ["P"], PO: ["P"],
  };
  const SJ_PAUSE_FRAMES = [0, 5, 10, 35, 2, 3, 4];               // 0, 100, 200, 700, 30, 60, 90 ms
  const SJ_CONTROLS = { FAST: 7, SLOW: 8, STRESS: 14, RELAX: 15, WAIT: 16, SOFT: 18, VOLUME: 20, SPEED: 21,
    PITCH: 22, BEND: 23, PORTCTR: 24, PORT: 25, REPEAT: 26, CALLPHRASE: 28, GOTOPHRASE: 29, DELAY: 30, RESET: 31 };
  const SJ_WITH_VALUE = new Set([20, 21, 22, 23, 24, 25, 26, 28, 29, 30]);
  const isSpeakJet = (text) => text.split(/\s+/).some((t) => t.startsWith("\\"));
  function sjCode(token) {
    const name = token.replace(/^\\/, "").toUpperCase();
    if (/^\d+$/.test(name)) return +name;
    if (/^P[0-6]$/.test(name)) return +name[1];
    if (name in SJ_CONTROLS) return SJ_CONTROLS[name];
    const effect = /^([RABC])([0-9])$|^M([0-2])$/.exec(name);          // sound effects R0..C9, M0..M2
    if (effect) return effect[3] ? 252 + +effect[3] : 200 + 10 * "RABC".indexOf(effect[1]) + +effect[2];
    const i = SJ_ALLOPHONES.indexOf(name);
    if (i >= 0) return 128 + i;
    throw new SpeechError(`"${token}" is not a SpeakJet code`);
  }
  // `options.pitch`: keep \PITCH n as a pitch mark (^n Hz) for the playground,
  // which can follow any pitch; the cartridge's exporter turns it into voices.
  function speakJetToPhonemes(text, options = {}) {
    const out = [], tokens = text.split(/\s+/).filter(Boolean);
    let factor = 1, stress = null;
    for (let i = 0; i < tokens.length;) {
      const code = sjCode(tokens[i++]);
      if (SJ_WITH_VALUE.has(code)) {
        if (i >= tokens.length || !/^\\?\d+$/.test(tokens[i])) throw new SpeechError(`"${tokens[i - 1]}" needs a value after it`);
        const value = +tokens[i++].replace(/^\\/, "");
        if (code === 30 && pyRound(value / 2) > 0) out.push(`,:${pyRound(value / 2)}`);   // Delay: n x 10 ms
        if (code === 22 && options.pitch && value > 0) out.push(`^${value}`);                // Pitch, in Hz
        continue;
      }
      if (code <= 6) { if (SJ_PAUSE_FRAMES[code]) out.push(`,:${SJ_PAUSE_FRAMES[code]}`); }
      else if (code === 7) factor = 0.5;
      else if (code === 8) factor = 1.5;
      else if (code === 14) stress = 1;
      else if (code === 15) stress = 0;
      else if (code >= 128 && code <= 199) {
        for (const sym of SJ_SOUNDS[SJ_ALLOPHONES[code - 128]]) {
          let token = sym;
          if (P[sym].kind === "vowel" && stress !== null) token += String(stress);
          if (factor !== 1) token += `:${Math.max(1, pyRound(P[sym].frames * factor))}`;
          out.push(token);
        }
        factor = 1; stress = null;
      } else if (code >= 200 && code <= 254) throw new SpeechError(`SpeakJet sound effects (${code}) are not supported`);
      else if (code < 32) { /* Wait, Soft, Reset: nothing to say */ }
      else throw new SpeechError(`"${tokens[i - 1]}" is not a SpeakJet code`);
    }
    if (!out.some((t) => !t.startsWith(","))) throw new SpeechError("the SpeakJet text says nothing");
    return out.join(" ");
  }

  // One word's frame states, as the cartridge format stores them: `text` is
  // English, /phonemes/ or SpeakJet codes; `length` stretches the word (1 = the model's own).
  function wordStates(text, length = 1, rate = 1) {
    const { tokens } = isSpeakJet(text) ? parsePhonemes(speakJetToPhonemes(text))
      : text.startsWith("/") ? parsePhonemes(text.slice(1, -1)) : parseText(text);
    return phonemeStates(tokens, rate / length);
  }
  function stateRunBytes(states) {
    const e = encodeRuns(states);
    return { bytes: e.bytes.length, runs: e.runs.length };
  }

  // How much the frames change, and the four storage options in bytes.
  function storage(result) {
    const frames = result.frames;
    let changed = 0, writesMax = 0, prev = null;
    const writes = frames.map((fr) => {
      let n = 0;
      for (let r = 0; r < 13; r++) if (!prev || prev[r] !== fr.regs[r]) n++;
      if (fr.shape) n++;                                 // R13 is written only to restart the envelope
      prev = fr.regs;
      changed += n;
      writesMax = Math.max(writesMax, n);
      return n;
    });
    const phonemeBytes = result.tokens.filter((t) => "p" in t || "pause" in t).length;
    return {
      frames: frames.length,
      seconds: frames.length / FRAME_RATE,
      raw: frames.length * 14,
      changed: frames.length * 2 + changed,              // a 14-bit mask, then the changed values
      runs: stateRunBytes(result.states),
      phonemes: phonemeBytes,
      writes, writesMean: frames.length ? changed / frames.length : 0, writesMax,
    };
  }

  const api = {
    FRAME_RATE, DEFAULT_CLOCK, MIXER_SILENT, P, DEFAULT_VOICE, SpeechError,
    pyRound, loadDictionary, dictionarySize: () => DICT.size, pronounce, guess, numberWords,
    parseText, parsePhonemes, withDefaults, envelopePeriod, envelopePitch, tonePeriod,
    formantUnits, nearestK, lockedPeriod, cycleClocks, speak, storage, encodeRuns, wordStates, isSpeakJet, speakJetToPhonemes, KIND_NAMES, NEAREST_RECIP,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Speech = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

// Phrases -> speech data for the Vectrex player (vectrex/vtx_speech.asm), as
// AS09 source. The same bytes as the VTX project's exporter
// (tools/vtx_speech/verzerk_speech.py); dev/vectrex_check.py proves it.
//
// Input, one phrase per line:
//
//     ; a comment
//     Say_Hello = ^c3 hello there
//     Say_Taunt = ^c? {get|kill|destroy} {the humanoid|it}
//     @vtx      = /V IY1 T IY1 EH1 K S/        a word's own pronunciation
//     @shoot    = shoot *1.2                   ... or its length (x1.2)
//     @hello    = \HE \EH \LE \OWWW            SpeakJet codes (mnemonics or numbers)
//     Say_Hi    = ^c3 \HE \EH \LE \OWWW world  ... also inline: a run of codes is one word
//     Say_Ph    = ^c3 /HH AH0 L OW1/ world     ... and a /phoneme group/ is one word
//     #speed    1.2                            every word 1.2 times as fast (0.5..2)
//     #voices   70 160                         voice 0 at 70 Hz up to voice 7 at 160 Hz
//     #voicespeed flat                         every voice at the same speed (only the pitch changes)
//
// A phrase is words (letters and '), ^c0..^c7 (a voice: pitch and speed),
// ^c? (a random voice), ,:N (N frames of silence, 1..62) and {a b|c} (one of
// the alternatives, chosen at random when the phrase plays).
//
// Works in the browser (window.VectrexExport) and in Node (module.exports).
(function (root) {
  "use strict";
  const Speech = root.Speech || (typeof require !== "undefined" ? require("./speech.js") : null);

  const END = 0xff, CLOCK = 0x80, RANDOM_CLOCK = 0x88, CHOOSE = 0x89, PAUSE = 0xc0;
  const WORD_LIMIT = 64;          // the player indexes the word table with a signed byte
  const CLOCK_PITCH = 1220;       // voice c: pitch 1220 / (16 - c) Hz, speed x 16 / (16 - c)
  const REGISTER_NAMES = new Set(["a", "b", "d", "x", "y", "u", "s", "pc", "dp", "cc"]);

  // Envelope period (R11) and run-length scale 8 * (16 - c) for the voices 0..7.
  const CLOCK_EP = Array.from({ length: 8 }, (_, c) => Speech.envelopePeriod(CLOCK_PITCH / (16 - c), 8, 1500000));
  const CLOCK_SCALE = Array.from({ length: 8 }, (_, c) => 8 * (16 - c));

  // The 8 voices' pitches (Hz): the arcade's 1220 / (16 - c), or with
  // "#voices low high" a geometric run from low (voice 0) to high (voice 7).
  function voicePitches(settings) {
    if (settings.voices) {
      const [low, high] = settings.voices;
      return Array.from({ length: 8 }, (_, c) => low * Math.pow(high / low, c / 7));
    }
    return Array.from({ length: 8 }, (_, c) => CLOCK_PITCH / (16 - c));
  }
  const clockEp = (settings) => voicePitches(settings).map((f) => Speech.envelopePeriod(f, 8, 1500000));
  // Each voice's run-length scale, 8 * (16 - c): higher voices play faster, as
  // on the arcade's chip. "#voicespeed flat": every voice at voice 0's speed
  // (128: a run lasts exactly its frames), so a voice changes only the pitch.
  const clockScale = (settings) => (settings.voicespeed === "flat" ? Array(8).fill(128) : CLOCK_SCALE.slice());
  // Per-phoneme @pitch has no place in a word track (only the voice sets the
  // pitch), so it is dropped: say so rather than lose it quietly.
  const pitchWarnings = (names, overrides) => names.filter((n) => {
    const say = (overrides[n] || { say: n }).say;
    return say.startsWith("/") && /@\d/.test(say);
  }).map((n) => `word "${n}": @pitch is not kept on the cartridge (only the voice, ^c0..^c7, sets the pitch)`);

  // A phrase's tokens: strings, and for each {a b|c} a list of alternatives.
  function tokens(text) {
    const out = [], re = /\{([^{}]*)\}|([^\s{}]+)|([{}])/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[3]) throw new Error(`unmatched "${m[3]}"`);
      if (m[1] !== undefined) {
        const alternatives = m[1].split("|").map((a) => joinGroups(a.trim().split(/\s+/).filter(Boolean)));
        if (alternatives.length < 2 || alternatives.some((a) => !a.length)) throw new Error("a {group} needs two or more alternatives, split by |");
        if (alternatives.length > 32) throw new Error("at most 32 alternatives in a {group}");
        out.push(alternatives);
      } else out.push(m[2]);
    }
    return joinGroups(out);
  }
  // Several tokens that make one word: a run of SpeakJet codes (\he \eh 183
  // ...: from a \code, with the numbers after it) or a /phoneme group/ with
  // spaces in it (from the token that opens it to the one that closes it).
  function joinGroups(list) {
    const out = [];
    for (const t of list) {
      const last = out[out.length - 1];
      if (typeof t === "string" && typeof last === "string" && (
        (last.startsWith("\\") && (t.startsWith("\\") || /^\d+$/.test(t))) ||
        (last.startsWith("/") && !(last.length > 1 && last.endsWith("/"))))) {
        out[out.length - 1] = last + " " + t;
      } else out.push(t);
    }
    return out;
  }
  const flat = (toks) => toks.flatMap((t) => (typeof t === "string" ? [t] : t.flat()));
  // An English word, a run of SpeakJet codes, or a /phoneme group/.
  const isWord = (t) => /^[a-z']+$/.test(t) || t.startsWith("\\") || t.startsWith("/");

  // Reads the phrase list. Returns {phrases: [{label, text}], words: {name: {say, length}}, problems,
  // settings: {speed, voices}}. Settings lines: "#speed 1.2", "#voices 70 160".
  function parse(source) {
    const phrases = [], words = {}, problems = [], settings = {};
    source.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/;.*$/, "").trim();
      if (!line) return;
      if (line.startsWith("#")) {
        const parts = line.slice(1).split(/\s+/).filter(Boolean);
        let values = parts.slice(1).map(Number);
        if (values.some((v) => !Number.isFinite(v))) values = [];
        if (parts[0] === "speed" && values.length === 1 && values[0] >= 0.5 && values[0] <= 2) settings.speed = values[0];
        else if (parts[0] === "voices" && values.length === 2 && values[0] >= 30 && values[0] < values[1] && values[1] <= 600) settings.voices = values;
        else if (parts.length === 2 && parts[0] === "voicespeed" && parts[1] === "flat") settings.voicespeed = "flat";
        else if (parts.length === 2 && parts[0] === "voicespeed" && parts[1] === "arcade") { /* the default */ }
        else problems.push(`line ${i + 1}: write #speed 0.5..2, #voices low high (30..600 Hz, low < high) or #voicespeed flat`);
        return;
      }
      const m = /^(@?[A-Za-z_'][\w']*)\s*=\s*(.*)$/.exec(line);
      if (!m) {
        const spaced = /^([A-Za-z_][\w ]*?\s[\w ]*?)\s*=/.exec(line);
        if (spaced) problems.push(`line ${i + 1}: a label can't have spaces: try "${spaced[1].trim().replace(/ +/g, "_")}"`);   // "Say Hello = ..."
        else problems.push(`line ${i + 1}: write label = phrase`);
        return;
      }
      if (m[1].startsWith("@")) {
        const name = m[1].slice(1).toLowerCase();
        let say = m[2].trim(), length = 1;
        const stretch = /\s*\*\s*([\d.]+)\s*$/.exec(say);
        if (stretch) { length = +stretch[1]; say = say.slice(0, stretch.index).trim(); }
        if (!isWord(name)) problems.push(`line ${i + 1}: a word name is lower-case letters`);
        if (!(length >= 0.25 && length <= 4)) problems.push(`line ${i + 1}: a length is 0.25..4`);
        words[name] = { say: say || name, length };
        return;
      }
      if (!/^[A-Za-z_]\w*$/.test(m[1]) || REGISTER_NAMES.has(m[1].toLowerCase())) {
        problems.push(`line ${i + 1}: "${m[1]}" is not a usable assembler label`);
        return;
      }
      if (/^(VS_|Speech_)/.test(m[1])) {          // the player's and the data's own labels
        problems.push(`line ${i + 1}: "${m[1]}": labels starting VS_ or Speech_ belong to the player`);
        return;
      }
      phrases.push({ label: m[1], text: m[2].toLowerCase().replace(/\^C/g, "^c"), line: i + 1 });
    });
    return { phrases, words, problems, settings };
  }

  // SpeakJet's \PITCH n (n in Hz) becomes the nearest voice: a voice can only
  // change between words, so a run of codes is split there, as
  // "\he \pitch 120 \eh \le" -> "\he", "^c6", "\eh \le". \SPEED n stays in the
  // run, where it is ignored (`notes` records both, for warnings).
  const isCode = (t, name, number) => t.replace(/^\\+/, "").toUpperCase() === name || (t.startsWith("\\") && t.slice(1) === String(number));
  function splitSpeakJetPitch(toks, pitches, notes) {
    const out = [];
    for (const t of toks) {
      if (typeof t !== "string") { out.push(t.map((a) => splitSpeakJetPitch(a, pitches, notes))); continue; }
      if (!t.startsWith("\\")) { out.push(t); continue; }
      const parts = [], codes = t.split(/\s+/);
      let run = [];
      for (let i = 0; i < codes.length;) {
        const c = codes[i];
        if (isCode(c, "PITCH", 22) && i + 1 < codes.length && /^\d+$/.test(codes[i + 1].replace(/^\\+/, ""))) {
          const hz = +codes[i + 1].replace(/^\\+/, "");
          if (run.length) parts.push(run);
          run = [];
          if (hz > 0) {
            let nearest = 0;
            for (let v = 1; v < 8; v++) if (Math.abs(Math.log(pitches[v] / hz)) < Math.abs(Math.log(pitches[nearest] / hz))) nearest = v;
            parts.push(`^c${nearest}`);
          }
          notes.add("pitch");
          i += 2;
          continue;
        }
        if (isCode(c, "SPEED", 21)) notes.add("speed");
        run.push(c);
        i++;
      }
      if (run.length) parts.push(run);
      for (const part of parts) {
        if (typeof part === "string") out.push(part);
        else out.push([part[0].startsWith("\\") ? part[0] : "\\" + part[0], ...part.slice(1)].join(" "));   // a run starts with a \code
      }
    }
    return out;
  }
  // What SpeakJet codes could not keep: \SPEED (no speed per phrase on the
  // cartridge), \PITCH inside an @word (a voice changes only between words),
  // and \PITCH without #voicespeed flat (a voice also sets the speed).
  function speakJetWarnings(notes, overrides, settings) {
    const out = [], sj = (say) => Speech.isSpeakJet(say);
    if (notes.has("speed") || Object.values(overrides).some((w) => sj(w.say) && /\\(speed|21)\b/i.test(w.say))) {
      out.push("SpeakJet \\SPEED is not kept: the cartridge has no speed per phrase (use #speed)");
    }
    for (const [name, w] of Object.entries(overrides)) {
      if (sj(w.say) && /\\(pitch|22)\b/i.test(w.say)) out.push(`word "${name}": SpeakJet \\PITCH inside a word is ignored; write the codes in the phrase`);
    }
    if (notes.has("pitch") && settings.voicespeed !== "flat") {
      out.push("SpeakJet \\PITCH picks voices, which also change the speed; add #voicespeed flat to keep the timing");
    }
    return out;
  }

  // Everything as bytes. `wordOrder` fixes the word table's order (the
  // checks use the reference's); by default words are listed as they first appear.
  function compile(source, wordOrder) {
    const { phrases, words: overrides, problems, settings } = parse(source);
    const parsed = [], notes = new Set(), pitches = voicePitches(settings);
    for (const p of phrases) {
      try {
        const toks = splitSpeakJetPitch(tokens(p.text), pitches, notes);
        for (const t of flat(toks)) {
          if (!(isWord(t) || /^\^c[0-7?]$/.test(t) || /^,:\d+$/.test(t))) problems.push(`line ${p.line}: cannot read "${t}"`);
          else if (t.startsWith(",:") && !(+t.slice(2) >= 1 && +t.slice(2) <= 62)) problems.push(`line ${p.line}: a pause is 1..62 frames`);
          else if (t.startsWith("/") && !(t.length > 2 && t.endsWith("/"))) problems.push(`line ${p.line}: a phoneme group "${t}" needs its closing /`);
        }
        if (!flat(toks).some(isWord)) problems.push(`line ${p.line}: says nothing`);
        parsed.push({ ...p, toks });
      } catch (e) { problems.push(`line ${p.line}: ${e.message}`); }
    }
    if (new Set(phrases.map((p) => p.label)).size !== phrases.length) problems.push("two phrases have the same label");
    const names = wordOrder ? wordOrder.slice() : [];
    for (const p of parsed) for (const t of flat(p.toks)) if (isWord(t) && !names.includes(t)) names.push(t);
    if (names.length > WORD_LIMIT) problems.push(`${names.length} different words: at most ${WORD_LIMIT}`);
    const states = {};
    for (const n of names) {
      const w = overrides[n] || { say: n, length: 1 };
      try { states[n] = Speech.wordStates(w.say, w.length, settings.speed || 1); } catch (e) { problems.push(`word "${n}": ${e.message}`); }
    }
    if (problems.length) return { problems };

    // One noise table for every word: the distinct (period, volume) pairs, sorted.
    const noiseKeys = new Set();
    for (const n of names) for (const s of states[n]) if (s.noise) noiseKeys.add(s.noise.join(","));
    const noises = [...noiseKeys].map((k) => k.split(",").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const wordBytes = names.map((n) => Speech.encodeRuns(states[n], noises).bytes.map((b) => b.value));

    // Sequences: each phrase, and each alternative of a {group} (shared by its text).
    const seqs = [], byKey = new Map();
    const add = (label, items) => { seqs.push({ label, items }); return seqs.length - 1; };
    const encode = (toks) => toks.flatMap((t) => {
      if (typeof t !== "string") return [CHOOSE, t.length, ...t.map((a) => ({ ref: alternative(a) }))];
      if (t === "^c?") return [RANDOM_CLOCK];
      if (t.startsWith("^c")) return [CLOCK + +t[2]];
      if (t.startsWith(",:")) return [PAUSE + +t.slice(2)];
      return [names.indexOf(t)];
    });
    const alternative = (toks) => {
      const key = toks.join(" ");
      if (!byKey.has(key)) byKey.set(key, add(`VS_Alt_${byKey.size}`, encode(toks).concat([END])));
      return byKey.get(key);
    };
    const out = parsed.map((p) => ({ label: p.label, text: p.text, seq: add(p.label, encode(p.toks).concat([END])) }));
    // Host bytes: a reference is the sequence's index, big-endian (the cartridge holds its address there).
    for (const sq of seqs) sq.bytes = sq.items.flatMap((it) => (typeof it === "number" ? [it] : [it.ref >> 8, it.ref & 0xff]));
    return { names, noises, words: wordBytes, seqs, phrases: out, problems: [], settings, clockEp: clockEp(settings),
      clockScale: clockScale(settings), warnings: pitchWarnings(names, overrides).concat(speakJetWarnings(notes, overrides, settings)) };
  }

  const hex = (b) => "$" + b.toString(16).toUpperCase().padStart(2, "0");
  const fcb = (bytes) => {
    const lines = [];
    for (let k = 0; k < bytes.length; k += 16) lines.push("        fcb     " + bytes.slice(k, k + 16).map(hex).join(","));
    return lines;
  };
  // Word labels: VS_Word_<word>; VS_Word_sj<k> for the k-th run of SpeakJet
  // codes and VS_Word_ph<k> for the k-th /phoneme group/.
  function wordLabels(names) {
    let sj = 0, ph = 0;
    return names.map((n) => (n.startsWith("\\") ? `VS_Word_sj${sj++}` : n.startsWith("/") ? `VS_Word_ph${ph++}`
      : "VS_Word_" + n.replace(/'/g, "_")));
  }
  const voicesNote = (c) => (c.settings.voices ? `pitch ${c.settings.voices[0]} to ${c.settings.voices[1]} Hz, #voices`
    : "pitch 1220 / (16 - c) Hz");

  // The AS09 source for vectrex/vtx_speech.asm.
  function toAsm(c, note = "") {
    const labels = wordLabels(c.names);
    const total = c.words.reduce((t, w) => t + w.length, 0), seqBytes = c.seqs.reduce((t, s) => t + s.items.reduce((u, it) => u + (typeof it === "number" ? 1 : 2), 0), 0);
    const lines = [
      "; VTX Speech data for vectrex/vtx_speech.asm (AS09).",
      "; Generated by the VTX Speech exporter" + (note ? `: ${note}` : "") + ". Edit the phrases and export again.",
      `; ${c.names.length} words (${total} bytes), ${c.phrases.length} phrases (${seqBytes} bytes with alternatives), ` +
        `${c.noises.length} noises, ${16 + 2 * c.names.length + 2 * c.noises.length} bytes of tables.`,
      ";",
      "; Say a phrase with:   ldx #<label>   jsr Speech_Say",
      "",
      `; Voices 0..7 (^c0..^c7): envelope period (${voicesNote(c)}) and run scale ` +
        `${c.settings.voicespeed === "flat" ? "128, #voicespeed flat" : "8 * (16 - c)"}.`,
      "VS_Clock_EP:", ...fcb(c.clockEp),
      "VS_Clock_Scale:", ...fcb(c.clockScale),
      "; Noise sounds: (R6 noise period, channel B volume) pairs.",
      "VS_Noises:", ...(c.noises.length ? fcb(c.noises.flat()) : ["        fcb     0,0"]),
      "; Word table: word number -> its track.",
      "VS_Words:", ...labels.map((l) => `        fdb     ${l}`),
      "",
      "; Word tracks: runs of identical 50 Hz frames (header byte: bit 7 formant bytes follow,",
      "; bit 6 a noise byte follows, bits 5-4 kind, bits 3-0 frames - 1), $FF at the end.",
    ];
    c.names.forEach((n, i) => lines.push(`${labels[i]}:${" ".repeat(Math.max(1, 23 - labels[i].length))}; ${n}`, ...fcb(c.words[i])));
    lines.push("", "; Phrases: word numbers $00-$3F, voice $80-$87, random voice $88, one of n alternatives",
      "; $89 n <addresses>, silence $C1-$FE (1..62 frames), $FF end.");
    const texts = new Map(c.phrases.map((p) => [p.seq, p.text]));
    c.seqs.forEach((sq, k) => {
      lines.push(`${sq.label}:${" ".repeat(Math.max(1, 23 - sq.label.length))}; ${texts.has(k) ? texts.get(k) : c.seqs[k].label.startsWith("VS_Alt") ? "(an alternative)" : ""}`);
      let run = [];
      for (const it of sq.items.concat([null])) {
        if (typeof it === "number") { run.push(it); continue; }
        lines.push(...fcb(run));
        run = [];
        if (it) lines.push(`        fdb     ${c.seqs[it.ref].label}`);
      }
    });
    return lines.join("\n") + "\n";
  }

  const api = { parse, compile, toAsm, tokens, voicePitches, clockEp, CLOCK_EP, CLOCK_SCALE, WORD_LIMIT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VectrexExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

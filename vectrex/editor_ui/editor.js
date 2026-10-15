// VTX Speech editor page. The phrase file is the one source of truth: every
// box, slider and button here rewrites its lines, and the server
// (vectrex/editor.py) checks the result, makes the cartridge's frames for
// listening and writes the files. Sound is the cartridge's own frames played
// through Ayumi; the picture is drawn from the same frames.
(function () {
  "use strict";
  const RATE = 44100, CHIP = { clock: 1500000, ym: false }, MAX_HZ = 4000;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const BS = String.fromCharCode(92);          // a backslash, for SpeakJet codes
  const MODES = { english: "English", phonemes: "Phonemes", speakjet: "SpeakJet" };
  const EXAMPLE = { english: "hello there", phonemes: "/HH AH0 L OW1/ /DH EH1 R/", speakjet: [BS + "HE", BS + "EH", BS + "LE", BS + "OWWW"].join(" ") };

  let lines = [], saved = "", report = null, newMode = "english";
  const modeHint = {};                          // label -> mode, for a phrase whose text is empty
  const texts = {};                             // label -> {mode: text}: each phrase's text in each mode
  let voices = null;                            // the voices' pitches, kept while the file has problems

  // --- the phrase file ---------------------------------------------------------------
  const source = () => lines.join("\n");
  const setSource = (text) => { lines = text.split("\n"); };
  const dirty = () => source() !== saved;
  const PHRASE = /^(\s*)([A-Za-z_]\w*)(\s*=\s*)([^;]*?)(\s*;.*)?$/;

  function phraseLines() {
    const out = [];
    lines.forEach((line, idx) => {
      if (/^\s*[@#;]/.test(line)) return;
      const m = PHRASE.exec(line);
      if (m) out.push({ idx, label: m[2], text: m[4], comment: m[5] || "" });
    });
    return out;
  }
  function writePhrase(idx, label, text) {
    const m = PHRASE.exec(lines[idx]) || ["", "", label, " = ", "", ""];
    lines[idx] = `${m[1]}${label}${m[3] || " = "}${text}${m[5] || ""}`;
    changed();
  }

  // A phrase's text: an optional voice (^c0..^c7, ^c?) and how it is written.
  function splitVoice(text) {
    const m = /^\s*\^c([0-7?])\s*/i.exec(text);
    return m ? { voice: m[1] === "?" ? 8 : +m[1], body: text.slice(m[0].length), hasVoice: true }
      : { voice: 0, body: text.trim(), hasVoice: false };
  }
  const voiceToken = (v) => (v === 8 ? "^c?" : `^c${v}`);
  function detectMode(body, label) {
    const toks = body.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) return modeHint[label] || "english";
    if (/^(\s*(\/[^/]*\/|,:\d+|\^c[0-7?]))+\s*$/i.test(body) && body.includes("/")) return "phonemes";
    if (toks.every((t) => t.startsWith(BS) || /^\d+$/.test(t) || /^,:\d+$/.test(t)) && toks.some((t) => t.startsWith(BS))) return "speakjet";
    return "english";
  }
  // What the phrase's box shows for its mode, and back.
  // Phonemes show as groups split by |; a pause (,:8) and a voice change (^c3)
  // go in front of the group they come before: "^c0 SH AE1 L | ^c3 L | ,:8 W IY1".
  function shown(body, mode) {
    if (mode !== "phonemes") return body;
    const items = body.match(/\/[^/]*\/|,:\d+|\^c[0-7?]/gi) || [], out = [];
    let lead = [];
    for (const t of items) {
      if (t.startsWith("/")) { out.push(lead.concat([t.slice(1, -1).trim().toUpperCase()]).join(" ")); lead = []; }
      else lead.push(t.toLowerCase());
    }
    if (lead.length) out.push(lead.join(" "));
    return out.join(" | ");
  }
  function composed(display, mode) {
    if (mode !== "phonemes") return display.trim();
    const out = [];
    for (const segment of display.split("|")) {
      let group = [];
      const flush = () => { if (group.length) out.push(`/${group.join(" ")}/`); group = []; };
      for (const t of segment.trim().split(/\s+/).filter(Boolean)) {
        if (/^,:\d+$/.test(t) || /^\^c[0-7?]$/i.test(t)) { flush(); out.push(t.toLowerCase()); } else group.push(t.toUpperCase());
      }
      flush();
    }
    return out.join(" ");
  }

  // --- settings (#speed, #voices) and word lines (@word) --------------------------------
  function setLine(test, text) {
    const at = lines.findIndex((l) => test.test(l)), before = lines.length;
    if (at >= 0) { if (text === null) lines.splice(at, 1); else lines[at] = text; }
    else if (text !== null) {
      let k = 0;
      while (k < lines.length && /^\s*(;|$)/.test(lines[k])) k++;        // after the opening comments
      lines.splice(k, 0, text);
    }
    changed();
    if (lines.length !== before && !$("listView").hidden) renderPhrases();   // the phrases' lines moved
  }
  const setSetting = (name, value) => setLine(new RegExp(`^\\s*#${name}\\b`), value === null ? null : `#${name} ${value}`);
  function setWord(name, say, length) {
    const text = say === name && Math.abs(length - 1) < 1e-9 ? null : `@${name} = ${say}${Math.abs(length - 1) < 1e-9 ? "" : ` *${+length.toFixed(2)}`}`;
    setLine(new RegExp(`^\\s*@${name.replace(/[^a-z']/g, "")}\\s*=`, "i"), text);
    renderPhrases();
  }
  function readSettings() {
    const get = (name) => { const l = lines.find((x) => new RegExp(`^\\s*#${name}\\b`).test(x)); return l ? l.trim().split(/\s+/).slice(1).map(Number) : null; };
    const speed = get("speed"), voices = get("voices");
    $("speed").value = speed ? speed[0] : 1;
    $("flatSpeed").checked = lines.some((x) => /^\s*#voicespeed\s+flat\b/.test(x));
    $("arcadeVoices").checked = !voices;
    if (voices) { $("voiceLow").value = voices[0]; $("voiceHigh").value = voices[1]; }
    showSettings();
  }
  function showSettings() {
    $("speedOut").textContent = `×${(+$("speed").value).toFixed(2)}`;
    $("voiceLowOut").textContent = `${$("voiceLow").value} Hz`;
    $("voiceHighOut").textContent = `${$("voiceHigh").value} Hz`;
    $("voiceLow").disabled = $("voiceHigh").disabled = false;
  }
  function voicesChanged() {
    let low = +$("voiceLow").value, high = +$("voiceHigh").value;
    if (high <= low) { high = low + 1; $("voiceHigh").value = high; }
    $("arcadeVoices").checked = false;
    showSettings();
    setSetting("voices", `${low} ${high}`);
  }

  // --- the phrases panel --------------------------------------------------------------
  function renderPhrases() {
    const host = $("phrases");
    host.innerHTML = "";
    for (const p of phraseLines()) {
      const { voice, body, hasVoice } = splitVoice(p.text);
      const mode = detectMode(body, p.label);
      const row = document.createElement("div");
      row.className = "phrase";
      row.dataset.idx = p.idx;
      row.dataset.mode = mode;
      row.dataset.label = p.label;
      row.dataset.hasVoice = hasVoice ? "1" : "";      // write a starting voice only if it had one or the slider moves
      row.innerHTML = `
        <input class="label" type="text" value="${esc(p.label)}" aria-label="Label" spellcheck="false">
        <div class="seg">${Object.entries(MODES).map(([m, t]) => `<button data-mode="${m}" class="${m === mode ? "on" : ""}">${t}</button>`).join("")}</div>
        <div class="voice"><span>voice</span><input type="range" min="0" max="8" step="1" value="${voice}" aria-label="Starting voice"><output></output></div>
        <div class="actions"><button class="small play" title="Play">▶</button><button class="small icon" title="Delete">✕</button></div>
        <input class="say" type="text" spellcheck="false" value="${esc(shown(body, mode))}" placeholder="${esc(mode === "english" ? EXAMPLE.english : mode === "phonemes" ? "HH AH0 L OW1 | DH EH1 R" : EXAMPLE.speakjet)}" aria-label="What it says">
        <div class="meta"></div>`;
      host.appendChild(row);
      bindPhrase(row);
    }
    showReport();
  }
  function rowState(row) {
    return { idx: +row.dataset.idx, label: $$(".label", row)[0].value.trim(), mode: row.dataset.mode,
      voice: +$$(".voice input", row)[0].value, display: $$(".say", row)[0].value };
  }
  function commit(row) {
    const s = rowState(row);
    // The row's line: where it was listed, unless lines have moved since; then by its label.
    let idx = s.idx;
    const m = PHRASE.exec(lines[idx] || "");
    if (!m || m[2] !== row.dataset.label) {
      idx = lines.findIndex((l) => { const x = PHRASE.exec(l); return x && !/^\s*[@#;]/.test(l) && x[2] === row.dataset.label; });
      if (idx < 0) return;
      row.dataset.idx = idx;
    }
    if (texts[row.dataset.label] && row.dataset.label !== s.label) { texts[s.label] = texts[row.dataset.label]; delete texts[row.dataset.label]; }
    row.dataset.label = s.label;
    // An empty phrase is not written: the file keeps what it said until there is something to say.
    if (!composed(s.display, s.mode)) {
      $$(".meta", row)[0].innerHTML = `<span class="dim">Type what it says (${MODES[s.mode]}); the file keeps the old text until then.</span>`;
      return;
    }
    const voice = row.dataset.hasVoice ? `${voiceToken(s.voice)} ` : "";
    writePhrase(idx, s.label, `${voice}${composed(s.display, s.mode)}`.trim());
  }
  function voiceText(v) { return v === 8 ? "? random" : `${v} · ${voices ? Math.round(voices[v]) + " Hz" : ""}`; }
  function bindPhrase(row) {
    const range = $$(".voice input", row)[0], out = $$(".voice output", row)[0];
    out.textContent = voiceText(+range.value);
    range.addEventListener("input", () => { out.textContent = voiceText(+range.value); row.dataset.hasVoice = "1"; commit(row); });
    $$(".label", row)[0].addEventListener("input", (e) => {
      const box = e.target, at = box.selectionStart;    // a label is an assembler label: a space becomes _
      if (/\s/.test(box.value)) { box.value = box.value.replace(/\s/g, "_"); box.setSelectionRange(at, at); }
      commit(row);
    });
    $$(".say", row)[0].addEventListener("input", () => commit(row));
    $$(".play", row)[0].addEventListener("click", () => { stop(); say({ label: row.dataset.label }, row); });
    $$(".icon", row)[0].addEventListener("click", () => {
      if (!confirm(`Delete ${row.dataset.label}?`)) return;
      lines.splice(+row.dataset.idx, 1);
      changed();
      renderPhrases();
    });
    $$(".seg button", row).forEach((b) => b.addEventListener("click", () => switchMode(row, b.dataset.mode)));
  }
  // Switching a phrase to Phonemes converts what it says (English or SpeakJet ->
  // phonemes, on the server). Other switches start the text afresh.
  // Switching converts what the phrase says: English or SpeakJet -> Phonemes,
  // English or Phonemes -> SpeakJet (the server). Nothing converts back to
  // English, so each phrase's text in every mode is remembered, and switching
  // back to English brings its English back.
  async function switchMode(row, mode) {
    const s = rowState(row);
    if (mode === s.mode) return;
    const remembered = (texts[s.label] = texts[s.label] || {});
    remembered[s.mode] = s.display;
    let display = remembered[mode] || "";
    if (mode !== "english" && s.display.trim()) {
      const r = await api("/api/convert", { text: s.display, mode: s.mode, to: mode });
      if (r.problems) { status(r.problems.join("; "), true); return; }
      display = r.text;
    }
    modeHint[s.label] = mode;
    row.dataset.mode = mode;
    $$(".seg button", row).forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    const box = $$(".say", row)[0];
    box.value = display;
    box.placeholder = mode === "english" ? EXAMPLE.english : mode === "phonemes" ? "HH AH0 L OW1 | DH EH1 R" : EXAMPLE.speakjet;
    commit(row);
    box.focus();
  }
  function addPhrase() {
    const labels = new Set(phraseLines().map((p) => p.label));
    let n = labels.size + 1;
    while (labels.has(`Say_${n}`)) n++;
    const label = `Say_${n}`, after = phraseLines().reduce((m, p) => Math.max(m, p.idx), lines.length - 1);
    modeHint[label] = newMode;
    lines.splice(after + 1, 0, `${label} = ^c3 ${EXAMPLE[newMode]}`);
    changed();
    renderPhrases();
    const row = $$(".phrase").find((r) => r.dataset.label === label);
    if (row) { row.scrollIntoView({ block: "nearest" }); $$(".say", row)[0].focus(); }
  }

  // --- the report: problems, phrase sizes, words, voices, size tiles ----------------
  function showReport() {
    const r = report;
    if (!r) return;
    if (r.voices) voices = r.voices;                  // before the rows show their voices' Hz
    const lineProblems = {}, other = [];
    for (const p of r.problems || []) {
      const m = /^line (\d+): (.*)$/.exec(p);
      if (m) (lineProblems[+m[1] - 1] = lineProblems[+m[1] - 1] || []).push(m[2]); else other.push(p);
    }
    const bytes = {};
    for (const p of r.phrases || []) bytes[p.label] = p.bytes;
    for (const row of $$(".phrase")) {
      const errs = lineProblems[+row.dataset.idx] || [];
      $$(".voice output", row)[0].textContent = voiceText(+$$(".voice input", row)[0].value);
      $$(".meta", row)[0].innerHTML = errs.length ? errs.map((e) => `<span class="err">${esc(e)}</span>`).join("")
        : `<span>${bytes[row.dataset.label] !== undefined ? bytes[row.dataset.label] + " bytes" : ""}</span>`;
    }
    const listed = new Set($$(".phrase").map((r) => +r.dataset.idx));
    const unbound = Object.entries(lineProblems).filter(([i]) => !listed.has(+i) || $("fileView").hidden === false)
      .flatMap(([i, es]) => es.map((e) => `line ${+i + 1}: ${e}`));
    $("problems").innerHTML = other.concat(unbound).map((p) => `<div>${esc(p)}</div>`).join("") +
      (r.warnings || []).map((p) => `<div class="warn">${esc(p)}</div>`).join("");
    if (r.problems && r.problems.length) return;
    $("voices").innerHTML = r.voices.map((f, v) => `<span>${v}: ${Math.round(f)} Hz</span>`).join("");
    renderWords(r.words);
    const s = r.sizes;
    $("tiles").innerHTML = [[s.total, "bytes of data"], [r.words.length + " / 64", "words"], [r.phrases.length, "phrases"], [787, "bytes of player"]]
      .map(([n, l]) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`).join("");
  }

  // --- the words panel ---------------------------------------------------------------
  const tagClass = (how) => (how === "SpeakJet" ? "speakjet" : how === "phonemes" ? "phonemes" : how === "guessed" ? "guessed"
    : how === "derived" ? "derived" : how === "project" ? "project" : "");
  let editing = null;
  function renderWords(words) {
    const body = $("words").tBodies[0];
    body.innerHTML = "";
    words.forEach((w, i) => {
      const tr = document.createElement("tr");
      const variants = w.variants > 1 ? `<select class="choice" title="The dictionary has ${w.variants} pronunciations">` +
        Array.from({ length: w.variants }, (_, k) => `<option value="${k + 1}"${k + 1 === w.choice ? " selected" : ""}>${k + 1} of ${w.variants}</option>`).join("") + "</select>" : "";
      tr.innerHTML = `<td class="name" title="${esc(w.name)}">${esc(w.inline ? w.name.toUpperCase() : w.name)}</td><td class="phon">${esc(w.phonemes)}</td>` +
        `<td class="from">${w.how.split(", ").map((h) => `<span class="tag ${tagClass(h)}">${esc(h)}</span>`).join(" ")}${variants}</td>` +
        `<td><div class="len"><input type="range" min="0.25" max="4" step="0.05" value="${w.length}" ${w.inline ? "disabled" : ""} aria-label="Length"><output>×${(+w.length).toFixed(2)}</output></div></td>` +
        `<td class="num">${w.frames * 20}</td><td class="num">${w.bytes}</td>` +
        `<td><button class="small play" title="Play">▶</button>${w.inline ? "" : ` <button class="small icon" title="Say it differently">✎</button>`}</td>`;
      body.appendChild(tr);
      const len = $$(".len input", tr)[0], out = $$(".len output", tr)[0];
      len.addEventListener("input", () => { out.textContent = `×${(+len.value).toFixed(2)}`; });
      len.addEventListener("change", () => setWord(w.name, w.say, +len.value));
      const sel = $$(".choice", tr)[0];
      if (sel) sel.addEventListener("change", () => setWord(w.name, `${w.name}#${sel.value}`, w.length));
      $$(".play", tr)[0].addEventListener("click", () => { stop(); say({ word: w.name }, tr); });
      const edit = $$(".icon", tr)[0];
      if (edit) edit.addEventListener("click", () => { editing = editing === w.name ? null : w.name; renderWords(words); });
      if (editing === w.name) body.appendChild(editRow(w));
    });
  }
  function editRow(w) {
    const tr = document.createElement("tr");
    tr.className = "edit";
    let mode = w.mode;
    const value = (m) => (m === "phonemes" ? w.say.replace(/^\/|\/$/g, "").toUpperCase() : w.say);
    tr.innerHTML = `<td colspan="7"><div class="edit-say"><span class="dim">Say “${esc(w.name)}” as</span>
      <div class="seg">${Object.entries(MODES).map(([m, t]) => `<button data-mode="${m}" class="${m === mode ? "on" : ""}">${t}</button>`).join("")}</div>
      <input type="text" spellcheck="false" value="${esc(value(mode))}"><button class="primary small">Apply</button><button class="small">Reset</button></div></td>`;
    const box = $$("input", tr)[0];
    $$(".seg button", tr).forEach((b) => b.addEventListener("click", async () => {
      const to = b.dataset.mode;
      if (to === mode) return;
      if (to !== "english" && box.value.trim()) {
        const r = await api("/api/convert", { text: mode === "phonemes" ? box.value.replace(/\|/g, " ") : box.value, mode, to });
        if (r.problems) { status(r.problems.join("; "), true); return; }
        box.value = r.text;
      } else box.value = to === "english" ? w.name : "";
      mode = to;
      $$(".seg button", tr).forEach((x) => x.classList.toggle("on", x.dataset.mode === mode));
      box.focus();
    }));
    const apply = () => {
      const t = box.value.trim();
      if (!t) return;
      editing = null;
      setWord(w.name, mode === "phonemes" ? `/${t.replace(/\|/g, " ")}/` : mode === "english" ? t.toLowerCase() : t, w.length);
    };
    $$("button.primary", tr)[0].addEventListener("click", apply);
    box.addEventListener("keydown", (e) => { if (e.key === "Enter") apply(); });
    $$("button.small:not(.primary)", tr).slice(-1)[0].addEventListener("click", () => { editing = null; setWord(w.name, w.name, 1); });
    return tr;
  }

  // --- listening and the picture -----------------------------------------------------
  let audio = null, sourceNode = null, run = 0, view = null;
  function stop() {
    run++;
    if (sourceNode) { sourceNode.onended = null; try { sourceNode.stop(); } catch (e) { /* stopped */ } sourceNode = null; }
    $$(".playing").forEach((el) => el.classList.remove("playing"));
  }
  function playSamples(samples, onTick) {
    return new Promise((resolve) => {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      const buffer = audio.createBuffer(1, samples.length, RATE);
      buffer.copyToChannel(samples, 0);
      sourceNode = audio.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.connect(audio.destination);
      const start = audio.currentTime, me = sourceNode;
      sourceNode.onended = () => { if (sourceNode === me) sourceNode = null; onTick(null); resolve(); };
      sourceNode.start();
      const tick = () => { if (sourceNode !== me) return; onTick(audio.currentTime - start); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
  }
  async function say(what, row) {
    const listen = +$("listenVoice").value;
    const r = await api("/api/frames", Object.assign({ source: source(), voice: listen === 8 ? "random" : listen }, what));
    if (r.problems && r.problems.length) { status(r.problems.join("; "), true); return false; }
    const samples = Render.render(r.frames, RATE, CHIP, window.Ayumi);
    view = { frames: r.frames, names: r.names, samples, image: null, sel: 0, title: what.label || what.word };
    $("nowPlaying").textContent = `${what.label ? "Phrase " + what.label : "Word " + what.word}: ${r.frames.length} frames, ${(r.frames.length / 50).toFixed(2)} s`;
    drawView(null);
    showRegs(0);
    if (row) row.classList.add("playing");
    await playSamples(samples, (t) => drawView(t === null ? null : t * 50));
    if (row) row.classList.remove("playing");
    return true;
  }
  async function playAll() {
    stop();
    const mine = run;
    for (const row of $$(".phrase")) {
      if (run !== mine) return;
      if (!(await say({ label: row.dataset.label }, row))) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function sized(canvas) {
    const dpr = window.devicePixelRatio || 1;
    if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute("height");
    canvas.style.height = canvas.dataset.h + "px";
    const w = Math.max(10, Math.round(canvas.clientWidth * dpr)), h = Math.round(+canvas.dataset.h * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    return { ctx: canvas.getContext("2d"), w, h, dpr };
  }
  const rgb = (hex) => { const v = parseInt(hex.replace("#", ""), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };
  function image(w, h) {
    const n = view.frames.length, sg = Render.spectrogram(view.samples, RATE, n, MAX_HZ);
    let peak = -1e9;
    for (const col of sg.cols) for (const v of col) peak = Math.max(peak, v);
    const lo = rgb(css("--bg")), mid = rgb(css("--accent")), hi = rgb(css("--text"));
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const c = off.getContext("2d"), img = c.createImageData(w, h), bins = sg.cols.length ? sg.cols[0].length : 1;
    for (let x = 0; x < w; x++) {
      const col = sg.cols[Math.min(n - 1, Math.floor(x / w * n))];
      for (let y = 0; y < h; y++) {
        const bin = Math.min(bins - 1, Math.floor((1 - (y + 0.5) / h) * MAX_HZ / sg.hzPerBin));
        const t = col ? Math.max(0, Math.min(1, (col[bin] - peak + 60) / 60)) : 0;
        const a = t < 0.55 ? lo : mid, b = t < 0.55 ? mid : hi, u = t < 0.55 ? t / 0.55 : (t - 0.55) / 0.45;
        const k = (y * w + x) * 4;
        img.data[k] = a[0] + (b[0] - a[0]) * u; img.data[k + 1] = a[1] + (b[1] - a[1]) * u; img.data[k + 2] = a[2] + (b[2] - a[2]) * u; img.data[k + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    c.lineWidth = 2 * dpr; c.lineJoin = c.lineCap = "round";
    [[0, css("--f1")], [1, css("--f2")]].forEach(([j, color]) => {
      c.strokeStyle = color;
      c.beginPath();
      let on = false;
      view.frames.forEach((f, i) => {
        if (f.targets.length <= j) { on = false; return; }
        const x = (i + 0.5) / n * w, y = h * (1 - f.targets[j] / MAX_HZ);
        if (on) c.lineTo(x, y); else c.moveTo(x, y);
        on = true;
      });
      c.stroke();
    });
    c.fillStyle = css("--noise");
    view.frames.forEach((f, i) => { if (f.noise) c.fillRect(i / n * w, h - 5 * dpr, w / n + 1, 5 * dpr); });
    return off;
  }
  function drawView(playFrame) {
    if (!view) return;
    const { ctx, w, h, dpr } = sized($("spectro"));
    if (!view.image || view.image.width !== w || view.image.height !== h) view.image = image(w, h);
    ctx.drawImage(view.image, 0, 0);
    const n = view.frames.length;
    ctx.fillStyle = css("--text-2");
    ctx.fillRect((view.sel + 0.5) / n * w - dpr / 2, 0, dpr, h);
    if (playFrame !== null) { ctx.fillStyle = css("--play"); ctx.fillRect(playFrame / n * w - dpr, 0, 2 * dpr, h); }
    ctx.fillStyle = css("--muted");
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const hz of [1000, 2000, 3000]) ctx.fillText(`${hz / 1000} kHz`, 4 * dpr, h * (1 - hz / MAX_HZ) - 3 * dpr);
    // The words along the bottom strip, coloured by how each is written.
    const s = sized($("strip"));
    s.ctx.clearRect(0, 0, s.w, s.h);
    s.ctx.font = `${12 * s.dpr}px ui-monospace, Consolas, monospace`;
    s.ctx.textBaseline = "middle";
    let k = 0;
    while (k < n) {
      const word = view.frames[k].word;
      let e = k;
      while (e < n && view.frames[e].word === word) e++;
      if (word !== null) {
        const name = view.names[word], x0 = k / n * s.w, x1 = e / n * s.w;
        const mode = name.startsWith(BS) ? "--speakjet" : name.startsWith("/") ? "--phonemes" : "--english";
        s.ctx.fillStyle = css(mode);
        s.ctx.globalAlpha = 0.35;
        s.ctx.fillRect(x0 + s.dpr, 2 * s.dpr, x1 - x0 - 2 * s.dpr, s.h - 4 * s.dpr);
        s.ctx.globalAlpha = 1;
        s.ctx.fillStyle = css("--text");
        const label = name.startsWith(BS) || name.startsWith("/") ? name.toUpperCase() : name;
        if (s.ctx.measureText(label).width < x1 - x0 - 6 * s.dpr) s.ctx.fillText(label, x0 + 4 * s.dpr, s.h / 2);
      }
      k = e;
    }
  }
  function showRegs(i) {
    if (!view) return;
    i = Math.max(0, Math.min(view.frames.length - 1, i));
    view.sel = i;
    const f = view.frames[i], r = f.regs;
    const tp = (ch) => r[2 * ch] | (r[2 * ch + 1] << 8);
    const hz = (p) => (p ? `${Math.round(CHIP.clock / (16 * p))} Hz` : "off");
    const ep = r[11] | (r[12] << 8);
    const rows = [
      ["R0–R1", `tone A ${tp(0)}`, `${hz(tp(0))} (F1)`], ["R2–R3", `tone B ${tp(1)}`, `${hz(tp(1))} (F2)`],
      ["R6", `noise ${r[6]}`, f.noise ? "on, channel B" : ""], ["R7", `$${r[7].toString(16).toUpperCase().padStart(2, "0")}`, "mixer"],
      ["R8–R9", `${r[8] & 16 ? "env" : r[8]} / ${r[9] & 16 ? "env" : r[9]}`, "volume A / B"],
      ["R11–R13", `${ep}, shape ${r[13]}`, `pitch ${Math.round(CHIP.clock / (256 * ep))} Hz, voice ${f.clock}${f.shape ? ", restarts" : ""}`],
    ];
    $("regs").innerHTML = `<tr><td colspan="3" class="m">Frame ${i} (${i * 20} ms)</td></tr>` +
      rows.map(([a, b, c]) => `<tr><td>${a}</td><td>${esc(b)}</td><td class="m">${esc(c)}</td></tr>`).join("");
    drawView(null);
  }

  // --- the cartridge check (MAME) ---------------------------------------------------------
  // Finds MAME (or asks where it is, once), then says every phrase on the
  // emulated cartridge and compares every frame with what this page plays.
  async function runCheck() {
    $("checkPanel").hidden = false;
    $("checkPanel").scrollIntoView({ block: "nearest", behavior: "smooth" });
    const m = await api("/api/mame");
    showMame(m);
    if (!m.found) return;
    $("checkResult").innerHTML = `<p class="dim">Building and running in MAME…</p>`;
    $("check").disabled = true;
    status("checking in MAME…");
    let r;
    try { r = await api("/api/check", { source: source() }); } finally { $("check").disabled = false; }
    status(r.ok ? "check: OK" : "check: failed", !r.ok);
    showCheck(r);
  }
  // After an export: where the two files are, and the lines that use them.
  function showUse(r) {
    const first = phraseLines()[0];
    $("usePanel").hidden = false;
    $("useFiles").innerHTML = `Exported <code>${esc(r.exported)}</code>. Player: <code>${esc(r.player)}</code> (${esc(r.player_note)}).`;
    $("snippet").textContent = [
      "VS_RAM   equ  $CA80          ; 22 bytes of free RAM",
      "VS_DUCK  equ  4              ; lower your channel C while speaking (0: don't)",
      "",
      "         include \"vtx_speech.asm\"",
      "         include \"speech_data.asm\"",
      "",
      "; once at start:",
      "         jsr  Speech_Init",
      "; to speak:",
      `         ldx  #${first ? first.label : "Say_Hello"}`,
      "         jsr  Speech_Say",
      "; every frame, after your sound code:",
      "         jsr  Speech_Service",
      "         jsr  Do_Sound",
    ].join("\n");
    $("usePanel").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async function runInMame() {
    const m = await api("/api/mame");
    if (!m.found) { $("checkPanel").hidden = false; showMame(m); $("checkPanel").scrollIntoView({ block: "nearest" }); return; }
    status("building and starting MAME…");
    await save("run");
  }
  function showMame(m) {
    $("mameInfo").textContent = m.found ? `MAME ${m.version} · ${m.path}` : "";
    $("mameAsk").hidden = !!m.found;
    if (!m.found) { $("mameProblem").textContent = m.problem || "MAME not found."; $("checkResult").innerHTML = ""; $("mamePath").focus(); }
  }
  async function useMame() {
    const path = $("mamePath").value.trim();
    if (!path) return;
    const m = await api("/api/mame", { path });
    showMame(m);
    if (m.found) runCheck();
  }
  function showCheck(r) {
    const parts = [];
    if (r.problems && r.problems.length) parts.push(...r.problems.map((p) => `<div class="problems"><div>${esc(p)}</div></div>`));
    if (r.frames_compared !== undefined) {
      parts.push(`<div class="verdict ${r.ok ? "ok" : "bad"}">${r.ok ? "✓ Cartridge matches the editor"
        : `✕ ${r.mismatches} of ${r.frames_compared} frames differ`}</div>`);
      parts.push(`<p class="dim">${r.phrases_played}/${r.of} plays, ${r.frames_compared} frames, A/B silent after each: ` +
        `${r.silent_after_every_phrase === false ? "no" : "yes"}${r.cycles ? `. Player ${r.cycles.mean} cycles/frame mean, ${r.cycles.max} max` : ""}. ` +
        `<button class="small" id="runAfterCheck">▶ Run in MAME</button></p>`);
      parts.push(`<table class="check"><tr><th>Phrase</th><th class="num">Plays</th><th class="num">Frames</th><th class="num">Differ</th></tr>` +
        Object.entries(r.per_phrase || {}).map(([label, p]) => `<tr><td class="mono">${esc(label)}</td><td class="num">${p.plays}</td>` +
          `<td class="num">${p.frames}</td><td class="num ${p.mismatches ? "bad" : ""}">${p.mismatches}</td></tr>`).join("") + "</table>");
      if (r.first_mismatch) {
        const f = r.first_mismatch;
        parts.push(`<p class="dim">First: ${esc(f.phrase)} frame ${f.frame}. R0–R13 expected ${esc(JSON.stringify(f.expected))}, got ${esc(JSON.stringify(f.cartridge))}.</p>`);
      }
    }
    $("checkResult").innerHTML = parts.join("");
    const again = $("runAfterCheck");
    if (again) again.addEventListener("click", runInMame);
  }

  // --- folding panels and the help ----------------------------------------------------
  // Every panel's title folds it; which are folded, and whether the help is
  // shown, are remembered in this browser (and simply reset if storage is off).
  const remembered = (key, fallback) => { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } };
  const remember = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* no storage */ } };
  function setupPanels() {
    const folded = new Set(remembered("vtxEditorFolded", []));
    for (const panel of $$(".panel")) {
      const head = panel.querySelector(":scope > .panel-head");
      const h2 = head ? head.querySelector("h2") : panel.querySelector(":scope > h2");
      if (!h2) continue;
      const key = panel.dataset.key || h2.textContent.trim().toLowerCase();
      const body = document.createElement("div");
      body.className = "panel-body";
      for (let n = (head || h2).nextSibling; n;) { const next = n.nextSibling; body.appendChild(n); n = next; }
      panel.appendChild(body);
      h2.classList.add("toggle");
      h2.tabIndex = 0;
      h2.title = "Fold or unfold";
      h2.setAttribute("role", "button");
      const fold = (on) => {
        panel.classList.toggle("collapsed", on);
        h2.setAttribute("aria-expanded", String(!on));
        if (on) folded.add(key); else folded.delete(key);
        remember("vtxEditorFolded", [...folded]);
        if (!on) window.dispatchEvent(new Event("resize"));        // redraw the pictures at their size
      };
      fold(folded.has(key));
      h2.addEventListener("click", () => fold(!panel.classList.contains("collapsed")));
      h2.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fold(!panel.classList.contains("collapsed")); } });
    }
    const showHelp = (on) => { $("helpPanel").hidden = !on; $("helpToggle").classList.toggle("on", on); remember("vtxEditorHelp", on); };
    showHelp(remembered("vtxEditorHelp", true));
    $("helpToggle").addEventListener("click", () => {
      const on = $("helpPanel").hidden;
      showHelp(on);
      if (on) { $("helpPanel").classList.remove("collapsed"); $("helpPanel").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    });
    $("helpClose").addEventListener("click", () => showHelp(false));
  }

  // --- server, files, wiring ---------------------------------------------------------
  async function api(path, body) {
    const r = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    return r.json();
  }
  function status(text, error = false) { $("status").textContent = text; $("status").className = error ? "error" : ""; }
  let timer = null;
  function changed() {
    document.title = (dirty() ? "* " : "") + "VTX Speech Editor";
    if (!$("fileView").hidden) return compileSoon();
    $("source").value = source();
    compileSoon();
  }
  function compileSoon() {
    clearTimeout(timer);
    timer = setTimeout(async () => { report = await api("/api/compile", { source: source() }); showReport(); }, 200);
  }
  async function save(action) {
    status(action === "build" ? "building…" : "saving…");
    const r = await api(`/api/${action}`, { source: source() });
    saved = source();
    document.title = "VTX Speech Editor";
    if (r.problems && r.problems.length) { status(r.problems.join("; "), true); return; }
    if (action === "run") {
      status(r.started ? "MAME running: button 1 (Left Ctrl) next phrase, button 2 (Left Alt) again"
        : "MAME did not start");
      return;
    }
    status(r.built ? `built ${r.built} (${r.bytes} bytes)` : r.exported ? `exported ${r.exported}` : `saved ${r.saved}`);
    if (r.exported) showUse(r);
  }
  function setView(which) {
    $$("#viewSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.view === which));
    $("listView").hidden = which !== "list";
    $("fileView").hidden = which !== "file";
    if (which === "file") $("source").value = source();
    else { renderPhrases(); readSettings(); }
  }

  async function init() {
    try { const t = localStorage.getItem("vtxSpeechTheme"); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* no storage */ }
    setupPanels();
    const p = await api("/api/project");
    $("path").textContent = p.path;
    setSource(p.source);
    saved = p.source;
    report = p.report;
    if (!p.as09) { $("build").disabled = true; $("build").title = "Building needs Windows (the bundled AS09 is a Windows program)"; }
    readSettings();
    renderPhrases();
    $("source").value = source();
    $("source").addEventListener("input", () => { setSource($("source").value); changed(); });
    $$("#viewSwitch button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
    $$("#newMode button").forEach((b) => b.addEventListener("click", () => {
      newMode = b.dataset.mode;
      $$("#newMode button").forEach((x) => x.classList.toggle("on", x === b));
    }));
    $("addPhrase").addEventListener("click", addPhrase);
    $("flatSpeed").addEventListener("change", () => setSetting("voicespeed", $("flatSpeed").checked ? "flat" : null));
    $("speed").addEventListener("input", showSettings);
    $("speed").addEventListener("change", () => setSetting("speed", +$("speed").value === 1 ? null : (+$("speed").value).toFixed(2)));
    $("arcadeVoices").addEventListener("change", () => { if ($("arcadeVoices").checked) setSetting("voices", null); else voicesChanged(); });
    for (const id of ["voiceLow", "voiceHigh"]) {
      $(id).addEventListener("input", showSettings);
      $(id).addEventListener("change", voicesChanged);
    }
    const lv = () => { const v = +$("listenVoice").value; $("listenVoiceOut").textContent = v === 8 ? "random" : `voice ${v}`; };
    $("listenVoice").addEventListener("input", lv);
    lv();
    $("save").addEventListener("click", () => save("save"));
    $("export").addEventListener("click", () => save("export"));
    $("build").addEventListener("click", () => save("build"));
    $("check").addEventListener("click", runCheck);
    $("copySnippet").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText($("snippet").textContent); status("copied"); } catch (e) { status("copy failed: select the text", true); }
    });
    $("run").addEventListener("click", runInMame);
    $("mameUse").addEventListener("click", useMame);
    $("mamePath").addEventListener("keydown", (e) => { if (e.key === "Enter") useMame(); });
    if (!p.as09) { $("run").disabled = true; $("run").title = "Building the cartridge needs Windows (the bundled AS09)"; }
    if (!p.as09) { $("check").disabled = true; $("check").title = "The check builds a test cartridge, which needs Windows (the bundled AS09)"; }
    $("playAll").addEventListener("click", playAll);
    $("stop").addEventListener("click", stop);
    $("theme").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("vtxSpeechTheme", next); } catch (e) { /* no storage */ }
      if (view) { view.image = null; drawView(null); }
    });
    $("spectro").addEventListener("click", (e) => {
      if (!view) return;
      const rect = e.target.getBoundingClientRect();
      showRegs(Math.floor((e.clientX - rect.left) / rect.width * view.frames.length));
    });
    $("spectro").addEventListener("keydown", (e) => {
      if (!view) return;
      if (e.key === "ArrowRight") { showRegs(view.sel + 1); e.preventDefault(); }
      if (e.key === "ArrowLeft") { showRegs(view.sel - 1); e.preventDefault(); }
    });
    window.addEventListener("resize", () => { if (view) { view.image = null; drawView(null); } });
    document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); save("save"); } });
    window.addEventListener("beforeunload", (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } });
  }
  init();
})();

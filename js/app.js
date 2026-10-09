// The page: playground, explainer widgets and diagrams.
(function () {
  "use strict";
  const RATE = 44100;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x) => (x * 100 < 10 ? fmt(x * 100, 1) : fmt(x * 100, 0)) + "%";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MACHINES = Machines.MACHINES;
  const mhz = (hz) => String(+(hz / 1e6).toFixed(4));

  // --- canvas helpers ------------------------------------------------------
  function sized(canvas) {
    const dpr = window.devicePixelRatio || 1;
    if (!canvas.dataset.h) canvas.dataset.h = canvas.getAttribute("height");
    const cssH = +canvas.dataset.h;
    canvas.style.height = cssH + "px";
    const w = Math.max(10, Math.round(canvas.clientWidth * dpr)), h = Math.round(cssH * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return { ctx, w, h, dpr };
  }
  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const v = m ? parseInt(m[1], 16) : 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // --- audio ---------------------------------------------------------------
  let audio = null, source = null, playStart = 0, playLen = 0, onTick = null;
  function play(samples, tick) {
    stop();
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
    const buf = audio.createBuffer(1, samples.length, RATE);
    buf.copyToChannel(samples, 0);
    source = audio.createBufferSource();
    source.buffer = buf;
    source.connect(audio.destination);
    source.start();
    playStart = audio.currentTime;
    playLen = samples.length / RATE;
    onTick = tick || null;
    const me = source;
    source.onended = () => { if (source === me) { source = null; if (onTick) onTick(null); } };
    if (onTick) requestAnimationFrame(loop);
  }
  function loop() {
    if (!source || !onTick) return;
    const t = audio.currentTime - playStart;
    if (t <= playLen) { onTick(t); requestAnimationFrame(loop); }
  }
  function stop() {
    if (source) { const s = source; source = null; try { s.stop(); } catch (e) { /* already stopped */ } }
    if (onTick) { const f = onTick; onTick = null; f(null); }
  }

  // --- dictionary ----------------------------------------------------------
  async function loadDictionary() {
    const status = $("#dictStatus");
    status.textContent = "loading the dictionary…";
    try {
      const res = await fetch("vendor/cmudict.dict.gz");
      if (!res.ok) throw new Error(res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      let text;
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);   // the server already unpacked it
      }
      const n = Speech.loadDictionary(text);
      status.textContent = `dictionary: ${fmt(n)} words`;
    } catch (e) {
      status.textContent = "dictionary not loaded (open the page through a web server); words are guessed from spelling";
    }
  }

  // --- examples ------------------------------------------------------------
  const FLAT = { stress: 0, fall: 0, question: 0 };
  const DAISY = "D:3@147 AY1:42@147 | Z:4@123 IY0:40@123 ,:6 D:3@98 AY1:42@98 | Z:4@73 IY0:40@73 ,:6 " +
    "G:3@82 IH1:12@82 V:3@82 | M:3@92 IY1:12@92 | Y:3@98 AO1:10@98 R:4@98 | AE1:24@82 N:3@82 S:4 ER0:12@98 | D:3@73 UW1:70@73 .";
  const SCREAM = "AE1:4@300 AA1:8@520 AA1:40@560 AA1:20@500 AA1:15@380 AA0:10@250";
  const PRESETS = [
    // Word lengths and pitches measured from the film's line (dev/analyse_reference.js), with word
    // boundaries from its formants: each word on its own pitch, "game" on the final rise.
    { name: "Shall we play a game?", text: ",:1 SH:7@68 AE1:5@68 AA1:6@68 L:6@89 | W:4@84 IY1:12@68 | P:1 L:2@108 EY1:16@90 | AH0:15@90 | G:7@90 EY1:8@125 M:9@127 ?", mode: "phonemes", voice: { intonation: FLAT } },
    { name: "Shall we play a game? (plain English)", text: "Shall we play a game?", voice: {} },
    { name: "Hello", text: "Hello. I am a sound chip, and I can talk.", voice: {} },
    { name: "A question", text: "Is anybody out there? Can you hear me?", voice: {} },
    { name: "Numbers", text: "Self destruct in 10 seconds. 9, 8, 7, 6, 5, 4, 3, 2, 1.", voice: {} },
    { name: "Tongue twister", text: "She sells sea shells by the sea shore.", voice: {} },
    { name: "Robot monotone", text: "I am a robot. I have no feelings, and no samples.", voice: { pitch: 90, rate: 0.9, intonation: FLAT } },
    { name: "Small voice", text: "Hello! Shall I tell you a story?", voice: { pitch: 220, formantScale: 1.18 } },
    { name: "Singing: Daisy Bell", text: DAISY, mode: "phonemes", voice: { intonation: FLAT, vibrato: { depth: 0.015, rate: 5.5 } } },
    { name: "Scream", text: SCREAM, mode: "phonemes", voice: { pitch: 420, vibrato: { depth: 0.05, rate: 9 }, intonation: FLAT,
      channels: [{ role: "F1", volume: "env" }, { role: "F2", volume: "env" }, { role: "F3", volume: 10 }], noise: { period: 6, channels: [2] } } },
    { name: "Alien scream", text: "IY1:4@500 AE1:10@900 AE1:35@950 AE1:15@800 HH:10 S:12", mode: "phonemes",
      voice: { pitch: 600, vibrato: { depth: 0.08, rate: 13 }, intonation: FLAT,
        channels: [{ role: "F1", volume: "env" }, { role: "F2", volume: "env" }, { role: "F3", volume: 12 }], noise: { period: 3, channels: [1, 2] } } },
    { name: "Whisper (experiment)", text: "Can you keep a secret?", voice: { whisper: true } },
  ];

  // --- playground state ----------------------------------------------------
  const ctl = {
    pitch: $("#pitch"), rate: $("#rate"), stress: $("#stress"), fall: $("#fall"), question: $("#question"),
    vdepth: $("#vdepth"), vrate: $("#vrate"), fscale: $("#fscale"), lock: $("#lock"), shape: $("#shape"),
    f3: $("#f3"), layout: $("#layout"), whisper: $("#whisper"), machine: $("#machine"),
  };
  let extra = {};             // preset-only voice settings (noise, numeric F3) until the user changes them
  let current = null;         // {result, samples, storage, machine, sel, image}
  const mode = () => $("input[name=mode]:checked").value;
  const machine = () => MACHINES.find((m) => m.id === ctl.machine.value) || MACHINES[0];

  function voiceFromControls() {
    const f3 = ctl.f3.value;
    const v = {
      pitch: +ctl.pitch.value, rate: +ctl.rate.value,
      intonation: { stress: +ctl.stress.value, fall: +ctl.fall.value, question: +ctl.question.value },
      vibrato: { depth: +ctl.vdepth.value, rate: +ctl.vrate.value },
      formantScale: +ctl.fscale.value, lock: ctl.lock.value, shape: +ctl.shape.value, layout: ctl.layout.value,
      whisper: ctl.whisper.checked,
      channels: [{ role: "F1", volume: "env" }, { role: "F2", volume: "env" },
        f3 === "off" ? { role: "off", volume: 0 } : { role: "F3", volume: f3 }],
      clock: machine().clock,
    };
    if (extra.channels) v.channels = extra.channels;
    if (extra.noise) v.noise = extra.noise;
    return v;
  }

  function setControls(voice) {
    const v = Speech.withDefaults(voice);
    ctl.pitch.value = v.pitch; ctl.rate.value = v.rate;
    ctl.stress.value = v.intonation.stress; ctl.fall.value = v.intonation.fall; ctl.question.value = v.intonation.question;
    ctl.vdepth.value = v.vibrato.depth; ctl.vrate.value = v.vibrato.rate;
    ctl.fscale.value = v.formantScale || 1; ctl.lock.value = v.lock; ctl.shape.value = String(v.shape);
    ctl.layout.value = v.layout; ctl.whisper.checked = !!v.whisper;
    const c = v.channels[2];
    ctl.f3.value = c.role === "off" ? "off" : c.volume === "env" ? "env" : "level";
    extra = {};
    if (voice.channels) extra.channels = voice.channels;
    if (voice.noise) extra.noise = voice.noise;
    showOutputs();
  }

  function showOutputs() {
    const show = { pitch: (x) => `${x} Hz`, rate: (x) => `×${(+x).toFixed(2)}`, stress: (x) => pct(+x), fall: (x) => pct(+x),
      question: (x) => pct(+x), vdepth: (x) => pct(+x), vrate: (x) => `${x} Hz`, fscale: (x) => `×${(+x).toFixed(2)}` };
    for (const [id, f] of Object.entries(show)) { const o = document.querySelector(`output[for=${id}]`); if (o) o.textContent = f(ctl[id].value); }
  }

  // --- speak ---------------------------------------------------------------
  function build() {
    $("#error").textContent = "";
    const text = $("#say").value;
    let result;
    try { result = Speech.speak(voiceFromControls(), text, mode()); } catch (e) {
      $("#error").textContent = e.message;
      return null;
    }
    const m = machine();
    const samples = Render.render(result.frames, RATE, { clock: m.clock, ym: m.ym }, Ayumi);
    current = { result, samples, storage: Speech.storage(result), machine: m, sel: 0, image: null };
    showWords(result.words);
    drawSpectro();
    drawStrip($("#strip"), result, current.result.frames.length);
    showRegs(0);
    showStats();
    showMachines();
    showStorage();
    showBytes();
    return current;
  }

  function speakNow() {
    const c = build();
    if (!c) return;
    play(c.samples, (t) => {
      if (t === null) { drawSpectroOverlay(null); return; }
      const f = Math.min(c.result.frames.length - 1, Math.floor(t * 50));
      drawSpectroOverlay(t * 50);
      if (f !== c.sel) showRegs(f);
    });
  }

  function showWords(words) {
    const out = $("#pronounced");
    out.innerHTML = "";
    words.forEach((w) => {
      const span = document.createElement("span");
      span.className = "w" + (w.how === "guessed" ? " guessed" : "");
      const variants = w.variants > 1 && w.span;
      span.innerHTML = `<b class="${variants ? "choice" : ""}">${esc(w.word)}</b> <span class="ph">${esc(w.phonemes.join(" "))}</span>` +
        (w.how === "dictionary" ? "" : ` <span class="how">${esc(w.how)}</span>`) +
        (variants ? ` <span class="how">${w.choice}/${w.variants}</span>` : "");
      if (variants) {
        span.querySelector("b").title = "Click for the other pronunciation";
        span.querySelector("b").addEventListener("click", () => {
          const text = $("#say").value, next = (w.choice % w.variants) + 1;
          const original = text.slice(w.span[0], w.span[1]).split("#")[0];
          $("#say").value = text.slice(0, w.span[0]) + `${original}#${next}` + text.slice(w.span[1]);
          speakNow();
        });
      }
      out.appendChild(span);
    });
  }

  function toPhonemes() {
    if (mode() === "phonemes") return;
    let tokens;
    try { tokens = Speech.parseText($("#say").value).tokens; } catch (e) { $("#error").textContent = e.message; return; }
    const parts = [];
    for (const t of tokens) {
      if (t.gap) parts.push("|");
      else if ("p" in t) parts.push(t.p + (t.stress === null ? "" : t.stress) + (t.frames ? `:${t.frames}` : "") + (t.pitch ? `@${t.pitch}` : ""));
      else if ("pause" in t) parts.push(t.fixed ? `,:${t.pause}` : t.rise ? "?" : t.pause > 8 ? "." : ",");
      else if ("base" in t) parts.push(t.base === null ? "^" : `^${t.base}`);
    }
    $("#say").value = parts.join(" ");
    $("input[name=mode][value=phonemes]").checked = true;
    speakNow();
  }

  // --- spectrogram ---------------------------------------------------------
  const MAX_HZ = 4000;
  function spectroImage(canvas, result, samples) {
    const { w, h } = sized(canvas);
    const frames = result.frames.length;
    const sg = Render.spectrogram(samples, RATE, frames, MAX_HZ);
    let peak = -1e9;
    for (const col of sg.cols) for (const v of col) peak = Math.max(peak, v);
    const floor = peak - 60, lo = hexRgb(css("--spectro-lo")), hi = hexRgb(css("--spectro-hi"));
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    const octx = off.getContext("2d"), img = octx.createImageData(w, h);
    const bins = sg.cols.length ? sg.cols[0].length : 0;
    for (let x = 0; x < w; x++) {
      const col = sg.cols[Math.min(frames - 1, Math.floor(x / w * frames))];
      for (let y = 0; y < h; y++) {
        const bin = Math.min(bins - 1, Math.floor((1 - (y + 0.5) / h) * MAX_HZ / sg.hzPerBin));
        const t = col ? Math.pow(Math.max(0, Math.min(1, (col[bin] - floor) / 60)), 1.4) : 0;
        const k = (y * w + x) * 4;
        img.data[k] = lo[0] + (hi[0] - lo[0]) * t;
        img.data[k + 1] = lo[1] + (hi[1] - lo[1]) * t;
        img.data[k + 2] = lo[2] + (hi[2] - lo[2]) * t;
        img.data[k + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    // The formant targets as 2 px lines, where a frame is voiced.
    const colors = [css("--s1"), css("--s2"), css("--s3")], dpr = window.devicePixelRatio || 1;
    octx.lineWidth = 2 * dpr; octx.lineCap = "round"; octx.lineJoin = "round";
    for (let j = 0; j < 3; j++) {
      octx.strokeStyle = colors[j];
      octx.beginPath();
      let drawing = false;
      result.frames.forEach((fr, i) => {
        const voiced = fr.targets.length && fr.tones.some((t) => /^F/.test(t.role));
        if (!voiced) { drawing = false; return; }
        const x = (i + 0.5) / frames * w, y = h * (1 - fr.targets[j] / MAX_HZ);
        if (drawing) octx.lineTo(x, y); else octx.moveTo(x, y);
        drawing = true;
      });
      octx.stroke();
    }
    return off;
  }
  function drawSpectro() {
    if (!current) return;
    current.image = spectroImage($("#spectro"), current.result, current.samples);
    drawSpectroOverlay(null);
  }
  function drawSpectroOverlay(playFrame) {
    if (!current || !current.image) return;
    const { ctx, w, h, dpr } = sized($("#spectro"));
    ctx.drawImage(current.image, 0, 0, w, h);
    const n = current.result.frames.length;
    ctx.fillStyle = css("--text-2");
    ctx.fillRect((current.sel + 0.5) / n * w - dpr / 2, 0, dpr, h);
    if (playFrame !== null) {
      ctx.fillStyle = css("--accent");
      ctx.fillRect(playFrame / n * w - dpr, 0, 2 * dpr, h);
    }
    ctx.fillStyle = css("--muted");
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    for (const hz of [1000, 2000, 3000]) ctx.fillText(`${hz / 1000} kHz`, 4 * dpr, h * (1 - hz / MAX_HZ) - 3 * dpr);
  }
  function drawStrip(canvas, result, frames) {
    const { ctx, w, h, dpr } = sized(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${12 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = "middle";
    result.phonemes.forEach((p, i) => {
      const x = p.start / frames * w;
      const next = i + 1 < result.phonemes.length ? result.phonemes[i + 1].start / frames * w : w;
      ctx.fillStyle = css("--line");
      ctx.fillRect(x, 0, dpr, h);
      if (p.label === "pause") return;
      ctx.fillStyle = css("--text-2");
      const label = p.label;
      if (ctx.measureText(label).width < next - x - 3 * dpr) ctx.fillText(label, x + 3 * dpr, h / 2);
      else if (ctx.measureText(label[0]).width < next - x - 2 * dpr) ctx.fillText(label[0], x + 2 * dpr, h / 2);
    });
    if (w > 600 * dpr) {
      ctx.fillStyle = css("--muted");
      ctx.textAlign = "right";
      ctx.fillText(`${fmt(frames / 50, 2)} s`, w - 4 * dpr, h / 2);
      ctx.textAlign = "left";
    }
  }

  // --- registers -----------------------------------------------------------
  function showRegs(i) {
    if (!current) return;
    const frames = current.result.frames;
    i = Math.max(0, Math.min(frames.length - 1, i));
    current.sel = i;
    $("#frameNo").textContent = `${i} (${fmt(i * 20)} ms)`;
    const fr = frames[i], prev = i ? frames[i - 1].regs : null, r = fr.regs, clock = current.machine.clock;
    const tp = (ch) => r[2 * ch] | (r[2 * ch + 1] << 8);
    const toneText = (ch) => {
      const t = fr.tones[ch];
      if (!tp(ch)) return `${"ABC"[ch]}: no tone`;
      return `${"ABC"[ch]} period ${tp(ch)} = ${fmt(clock / (16 * tp(ch)))} Hz (${t.role}${t.harmonic ? `, harmonic ${t.harmonic}` : ""})`;
    };
    const ep = r[11] | (r[12] << 8);
    const on = (bits) => [0, 1, 2].filter((c) => !((r[7] >> (c + bits)) & 1)).map((c) => "ABC"[c]).join(" ") || "none";
    const vol = (c) => (r[8 + c] & 0x10 ? "follows the envelope" : `volume ${r[8 + c]}`);
    const rows = [
      ["R0", toneText(0)], ["R1", ""], ["R2", toneText(1)], ["R3", ""], ["R4", toneText(2)], ["R5", ""],
      ["R6", `noise period ${r[6]}`], ["R7", `tone on: ${on(0)}; noise on: ${on(3)}`],
      ["R8", `A ${vol(0)}`], ["R9", `B ${vol(1)}`], ["R10", `C ${vol(2)}`],
      ["R11", `envelope period ${ep} → pitch ${fmt(fr.pitch, 1)} Hz`], ["R12", ""],
      ["R13", `shape ${r[13]}${fr.shape ? ": written, restarts the envelope" : ": not written"}`],
    ];
    $("#regs tbody").innerHTML = rows.map(([name, meaning], k) => {
      const changed = (k === 13 && fr.shape) || (k < 13 && (!prev || prev[k] !== r[k]));
      return `<tr class="${changed ? "changed" : ""}"><td>${name}</td><td>$${r[k].toString(16).toUpperCase().padStart(2, "0")}</td><td class="meaning">${esc(meaning)}</td></tr>`;
    }).join("");
    drawSpectroOverlay(null);
  }

  function showStats() {
    const s = current.storage, words = current.result.words;
    const guessed = words.filter((w) => w.how === "guessed").length;
    $("#stats").innerHTML = [
      `<span><b>${fmt(s.seconds, 2)} s</b>, ${fmt(s.frames)} frames</span>`,
      `<span><b>${fmt(s.writesMean, 1)}</b> register writes per frame (max ${s.writesMax})</span>`,
      `<span><b>${fmt(s.runs.bytes)}</b> bytes as state runs</span>`,
      guessed ? `<span>${guessed} word${guessed > 1 ? "s" : ""} guessed from spelling</span>` : "",
    ].join("");
    $("#writesMean").textContent = fmt(s.writesMean, 1);
  }

  // --- other machines ------------------------------------------------------
  function machineRows() {
    const r = current.result, s = current.storage, changed = $("#changedOnly").checked;
    const writes = changed ? s.writes : r.frames.map((f) => 13 + (f.shape ? 1 : 0));
    const lockOff = Speech.withDefaults(voiceFromControls()).lock === "off";
    return MACHINES.map((m) => ({ m, cost: Machines.phraseCost(m, r, writes, lockOff) }));
  }
  function showMachines() {
    if (!current) return;
    const rows = machineRows();
    const scale = Math.max(0.05, ...rows.map((x) => x.cost.maxShare)) * 1.1;
    $("#machineTable tbody").innerHTML = rows.map(({ m, cost }) => {
      const measured = m.measured ? `<div class="meter-label">measured player: ${fmt(m.measured.mean)} / ${fmt(m.measured.max)} cycles <span class="measured">MAME</span></div>` : "";
      return `<tr>
        <td><b>${esc(m.name)}</b><br><button class="small" data-hear="${m.id}">Hear it</button></td>
        <td>${esc(m.chip)}<br><span class="dim">${mhz(m.clock)} MHz</span></td>
        <td>${esc(m.cpu)}<br><span class="dim">${fmt(m.frame)} ${esc(m.unit)} a frame</span></td>
        <td class="mono">${fmt(cost.mean)} / ${fmt(cost.max)} ${esc(m.unit)}${measured}</td>
        <td><div class="meter" title="mean ${pct(cost.meanShare)}, max ${pct(cost.maxShare)}">
              <div class="fill" style="width:${cost.meanShare / scale * 100}%"></div>
              <div class="max" style="left:${cost.maxShare / scale * 100}%"></div></div>
            <div class="meter-label">${pct(cost.meanShare)} mean, ${pct(cost.maxShare)} max (estimate)</div></td>
        <td>about ${pct(m.samples)} of the CPU while speaking</td></tr>`;
    }).join("");
    $$("[data-hear]").forEach((b) => b.addEventListener("click", () => {
      ctl.machine.value = b.dataset.hear;
      machineChanged();
      speakNow();
      $("#try").scrollIntoView({ behavior: "smooth" });
    }));
  }
  function machineNotes() {
    $("#machineNotes").innerHTML = MACHINES.map((m) => `<div class="card"><h4>${esc(m.name)}</h4><p>${esc(m.access)}</p><p>${esc(m.notes)}</p></div>`).join("");
  }
  function machineChanged() {
    const m = machine();
    $("#machineNote").textContent = `${m.chip} at ${mhz(m.clock)} MHz${m.ym ? ", YM volume curve and 32-step envelope" : ""}. ${m.notes}`;
  }

  // --- storage chart -------------------------------------------------------
  function showStorage() {
    const s = current.storage;
    const items = [
      ["Samples, 8 kHz 4-bit", Math.round(s.seconds * 4000)],
      ["Raw registers, 14 per frame", s.raw],
      ["Changed registers only", s.changed],
      ["State runs (cartridge format)", s.runs.bytes],
      ["One byte per phoneme", s.phonemes],
    ];
    // Linear: the largest bar fills 75%, leaving room for its label. Very
    // small values keep a 2 px sliver so the bar can still be seen.
    const max = Math.max(...items.map((x) => x[1])), samples = items[0][1];
    $("#storageChart").innerHTML = items.map(([label, v], i) => {
      const width = v / max * 75;
      const share = i ? ` · ${v / samples < 0.01 ? fmt(v / samples * 100, 2) : fmt(v / samples * 100, 1)}%` : "";
      return `<div class="hbar"><span>${esc(label)}</span><div class="track" title="${fmt(v)} bytes">
        <div class="bar" style="width:max(2px, ${width}%)"></div><span class="val" style="left:calc(max(2px, ${width}%) + 6px)">${fmt(v)} B · ${fmt(v / Math.max(0.02, s.seconds))} B/s${share}</span></div></div>`;
    }).join("");
  }

  // --- the byte map: how the state runs are stored --------------------------
  let encoded = null, selRun = 0, selByte = 0;
  const hex = (v) => "$" + v.toString(16).toUpperCase().padStart(2, "0");
  function showBytes() {
    encoded = Speech.encodeRuns(current.result.states);
    const grid = $("#byteGrid");
    grid.innerHTML = encoded.bytes.map((b, i) => {
      const next = encoded.bytes[i + 1];
      const end = !next || next.run !== b.run;
      return `<button class="byte ${b.role}${end ? " run-end" : ""}" data-b="${i}" title="${b.role} ${hex(b.value)}">${b.value.toString(16).toUpperCase().padStart(2, "0")}</button>`;
    }).join("");
    grid.querySelectorAll(".byte").forEach((el) => el.addEventListener("click", () => {
      const i = +el.dataset.b, b = encoded.bytes[i];
      selectRun(b.run === null ? encoded.runs.length - 1 : b.run, i);
    }));
    selectRun(0, 0, false);
  }
  function drawRunStrip() {
    if (!encoded) return;
    const { ctx, w, h, dpr } = sized($("#runStrip"));
    const total = current.result.frames.length;
    ctx.clearRect(0, 0, w, h);
    ctx.font = `${11 * dpr}px ui-monospace, Consolas, monospace`;
    ctx.textBaseline = "middle";
    const barTop = 16 * dpr, barH = h - barTop - 2 * dpr;
    encoded.runs.forEach((r, k) => {
      const x = r.start / total * w, rw = Math.max(dpr, r.frames / total * w - dpr);
      ctx.fillStyle = k === selRun ? css("--accent") : r.kind ? css("--muted") : css("--line");
      ctx.globalAlpha = k === selRun ? 1 : k % 2 ? 0.55 : 0.8;
      ctx.fillRect(x, barTop, rw, barH);
      ctx.globalAlpha = 1;
      const first = k === 0 || encoded.runs[k - 1].label !== r.label;
      if (first && r.label !== "pause") {
        let span = 0;
        for (let j = k; j < encoded.runs.length && encoded.runs[j].label === r.label; j++) span += encoded.runs[j].frames;
        if (ctx.measureText(r.label).width < span / total * w - 2 * dpr) { ctx.fillStyle = css("--text-2"); ctx.fillText(r.label, x + dpr, 7 * dpr); }
      }
    });
  }
  // Selects run k (and one of its bytes); `follow` moves the playground's
  // register view to the run's first frame.
  function selectRun(k, byteIndex, follow = true) {
    selRun = k;
    const r = encoded.runs[k];
    selByte = byteIndex === undefined ? encoded.bytes.findIndex((b) => b.run === k) : byteIndex;
    $$("#byteGrid .byte").forEach((el) => {
      const b = encoded.bytes[+el.dataset.b];
      el.classList.toggle("in-run", b.run === k);
      el.classList.toggle("sel", +el.dataset.b === selByte);
    });
    drawRunStrip();
    if (follow) showRegs(r.start);

    const b = encoded.bytes[selByte], header = r.bytes[0].value;
    const end = r.start + r.frames - 1, ms = (f) => fmt(f * 20);
    const explain = (x) => {
      if (x.role === "header") return `<b>header ${hex(x.value)}</b>: ${x.value & 0x80 ? "formant bytes follow" : "no formant bytes (the previous run's are kept)"}, ` +
        `${x.value & 0x40 ? "a noise byte follows" : "no noise"}, kind ${(x.value >> 4) & 3} (${Speech.KIND_NAMES[(x.value >> 4) & 3]}), ${(x.value & 15) + 1} frame${x.value & 15 ? "s" : ""}`;
      if (x.role === "f1" || x.role === "f2") return `<b>${x.role.toUpperCase()} ${hex(x.value)}</b> = ${x.value} × 16 Hz = ${fmt(x.value * 16)} Hz`;
      if (x.role === "noise") { const n = encoded.noiseTable[x.value]; return `<b>noise ${hex(x.value)}</b>: entry ${x.value} of the noise table, period ${n[0]}, volume ${n[1]}`; }
      return `<b>end ${hex(x.value)}</b>: the phrase stops here`;
    };
    const bits = [...header.toString(2).padStart(8, "0")].map((c) => `<span>${c}</span>`).join("");
    const rawCells = Array.from({ length: r.frames * 14 }, () => "<i></i>").join("");
    const stored = r.bytes.map(() => "<i></i>").join("");
    $("#byteDetail").innerHTML = `
      <h4>Run ${k + 1} of ${encoded.runs.length}: frames ${r.start}–${end} (${ms(r.start)}–${ms(end + 1)} ms), ${r.label === "pause" ? "a pause" : `phoneme ${esc(r.label)}`}</h4>
      <div class="bits" aria-label="header bits">${bits}<em style="grid-column: 1">F</em><em style="grid-column: 2">N</em><em style="grid-column: 3 / 5">kind</em><em style="grid-column: 5 / 9">frames − 1</em></div>
      <ul>${r.bytes.map((x) => `<li>${explain(x)}</li>`).join("")}${b.role === "end" ? `<li>${explain(b)}</li>` : ""}</ul>
      <div class="compare">
        <span>Raw registers for ${r.frames} frame${r.frames > 1 ? "s" : ""}: <b>${fmt(14 * r.frames)} B</b></span><div class="cells raw">${rawCells}</div>
        <span>Stored as a run: <b>${r.bytes.length} B</b></span><div class="cells stored">${stored}</div>
      </div>
      <p class="dim">The whole phrase: ${fmt(encoded.bytes.length)} bytes in ${encoded.runs.length} runs, plus a ${encoded.noiseTable.length}-entry noise table shared by all speech (2 bytes an entry). On the cartridge each word is stored once like this, and a phrase is a list of word numbers.</p>`;
  }

  // --- the chip diagram ----------------------------------------------------
  function chipDiagram() {
    const box = (x, y, w, h, title, sub, cls = "") => `<rect class="box ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>` +
      `<text x="${x + w / 2}" y="${y + h / 2 - (sub ? 6 : -4)}" text-anchor="middle" font-weight="600">${title}</text>` +
      (sub ? `<text class="muted" x="${x + w / 2}" y="${y + h / 2 + 13}" text-anchor="middle" font-size="12">${sub}</text>` : "");
    const arrow = (d) => `<path class="wire" d="${d}" marker-end="url(#arr)"/>`;
    $("#chipDiagram").innerHTML += `
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="var(--text-2)"/></marker></defs>
      <text class="muted" x="20" y="22" font-size="12">Channel A shown; channels B and C have their own tone, mixer and level.</text>
      ${box(20, 50, 160, 56, "Tone A", "12-bit period (R0, R1)")}
      ${box(20, 140, 160, 56, "Noise", "5-bit period (R6), shared")}
      ${box(230, 90, 140, 66, "Mixer (R7)", "tone AND noise")}
      ${box(420, 90, 140, 66, "Level", "volume 0–15 (R8)", "hi")}
      ${box(420, 214, 140, 66, "Envelope", "R11–R13, shared")}
      ${box(600, 90, 100, 66, "DAC + sum", "A + B + C")}
      ${arrow("M180,78 L205,78 L205,110 L228,110")}
      ${arrow("M180,168 L205,168 L205,136 L228,136")}
      ${arrow("M370,123 L418,123")}
      ${arrow("M490,214 L490,158")}
      <text class="muted" x="482" y="190" font-size="12" text-anchor="end">or follow the envelope</text>
      ${arrow("M560,123 L598,123")}
      <text x="650" y="186" text-anchor="middle" font-size="12" class="muted">to the speaker</text>
      ${arrow("M650,156 L650,172")}`;
  }

  // --- the pipeline diagram ------------------------------------------------
  function pipeDiagram() {
    const steps = [
      ["Text", "\"hello\""], ["Words", "dictionary,", "rules"], ["Phonemes", "HH AH0 L OW1"],
      ["Frame states", "voicing, F1–F3,", "noise, pitch"], ["Registers", "R0–R13,", "50 per second"], ["AY chip", "sound"],
    ];
    const w = 112, gap = (760 - 16 - 6 * 112) / 5;
    let s = `<defs><marker id="arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="var(--text-2)"/></marker></defs>`;
    steps.forEach(([title, a, b], i) => {
      const x = 8 + i * (w + gap);
      s += `<rect class="box${i >= 4 ? " hi" : ""}" x="${x}" y="30" width="${w}" height="86" rx="6"/>
        <text x="${x + w / 2}" y="58" text-anchor="middle" font-weight="600">${title}</text>
        <text class="muted" x="${x + w / 2}" y="82" text-anchor="middle" font-size="12">${a}</text>
        ${b ? `<text class="muted" x="${x + w / 2}" y="98" text-anchor="middle" font-size="12">${b}</text>` : ""}`;
      if (i < steps.length - 1) s += `<path class="wire" d="M${x + w + 1},73 L${x + w + gap - 2},73" marker-end="url(#arr2)"/>`;
    });
    const span = (from, to, y, label) => {
      const x1 = 8 + from * (w + gap), x2 = 8 + to * (w + gap) + w;
      return `<path class="wire" d="M${x1},${y - 8} L${x1},${y} L${x2},${y} L${x2},${y - 8}"/>
        <text x="${(x1 + x2) / 2}" y="${y + 20}" text-anchor="middle" font-size="13">${label}</text>`;
    };
    s += span(0, 3, 146, "offline on a PC, or once per phrase");
    s += span(4, 4, 146, "each frame");
    s += `<text class="muted" x="${8 + 5 * (w + gap) + w / 2}" y="166" text-anchor="middle" font-size="12">by itself</text>`;
    $("#pipeDiagram").innerHTML += s;
  }

  // --- the vowel chart -----------------------------------------------------
  const VOWELS = [["IY", "heed"], ["IH", "hid"], ["EH", "head"], ["AE", "had"], ["AA", "hod"], ["AO", "hawed"],
    ["UH", "hood"], ["UW", "who'd"], ["AH", "hud"], ["ER", "heard"]];
  function vowelChart() {
    const svg = $("#vowelChart"), L = 70, R = 610, T = 30, B = 330;
    const x = (f2) => L + (2500 - f2) / (2500 - 700) * (R - L), y = (f1) => T + (f1 - 200) / (800 - 200) * (B - T);
    let s = "";
    for (let f1 = 200; f1 <= 800; f1 += 100) s += `<line class="grid" x1="${L}" x2="${R}" y1="${y(f1)}" y2="${y(f1)}"/><text class="muted" x="${L - 8}" y="${y(f1) + 4}" text-anchor="end" font-size="12">${f1}</text>`;
    for (let f2 = 800; f2 <= 2400; f2 += 400) s += `<line class="grid" y1="${T}" y2="${B}" x1="${x(f2)}" x2="${x(f2)}"/><text class="muted" x="${x(f2)}" y="${B + 18}" text-anchor="middle" font-size="12">${fmt(f2)}</text>`;
    s += `<text class="muted" x="${(L + R) / 2}" y="${B + 40}" text-anchor="middle" font-size="12">F2, second formant (Hz) ← front of the mouth · back →</text>`;
    s += `<text class="muted" transform="translate(18 ${(T + B) / 2}) rotate(-90)" text-anchor="middle" font-size="12">F1 (Hz): closed ↑ · open ↓</text>`;
    for (const [sym, word] of VOWELS) {
      const f = Speech.P[sym].f, cx = x(f[1]), cy = y(f[0]);
      const anchor = cx > R - 70 ? "end" : "start", dx = anchor === "end" ? -10 : 10;
      s += `<g class="vowel" tabindex="0" role="button" data-v="${sym}" aria-label="Play ${word}, F1 ${f[0]} Hz, F2 ${f[1]} Hz">
        <circle cx="${cx}" cy="${cy}" r="6"/><circle class="hit" cx="${cx}" cy="${cy}" r="16"/>
        <text x="${cx + dx}" y="${cy - 8}" text-anchor="${anchor}" font-weight="600">${word}</text>
        <text class="muted" x="${cx + dx}" y="${cy + 8}" text-anchor="${anchor}" font-size="12">${sym} · ${f[0]} / ${fmt(f[1])}</text></g>`;
    }
    svg.innerHTML += s;
    svg.querySelectorAll(".vowel").forEach((g) => {
      const go = () => {
        const v = Object.assign(voiceFromControls(), { intonation: FLAT, vibrato: { depth: 0.01, rate: 5 } });
        const r = Speech.speak(v, `${g.dataset.v}1:45`, "phonemes");
        const m = machine();
        svg.querySelectorAll(".vowel").forEach((o) => o.classList.remove("playing"));
        g.classList.add("playing");
        play(Render.render(r.frames, RATE, { clock: m.clock, ym: m.ym }, Ayumi), (t) => { if (t === null) g.classList.remove("playing"); });
      };
      g.addEventListener("click", go);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }

  // --- the buzz widget -----------------------------------------------------
  const BZ_CLOCK = 1500000;
  let bzMode = "voice";
  function bzParams() {
    const f0 = +$("#bzPitch").value, F = +$("#bzFormant").value, lock = $("#bzLock").checked;
    const ep = Speech.envelopePeriod(f0, 8, BZ_CLOCK);
    const [tp, n, exact] = Speech.lockedPeriod(F, ep, lock ? "nearest" : "off", 8, BZ_CLOCK);
    return { f0, F, lock, ep, tp, n, exact, pitch: Speech.envelopePitch(ep, 8, BZ_CLOCK), freq: BZ_CLOCK / (16 * tp) };
  }
  function bzFrames(p, which, seconds = 1) {
    const regs = new Array(14).fill(0);
    regs[0] = p.tp & 255; regs[1] = p.tp >> 8;
    // Tone A on, except for the envelope alone: with tone and noise both off
    // the channel is always "on", so its output is the bare envelope.
    regs[7] = which === "env" ? 0x3f : 0x3e;
    regs[8] = which === "tone" ? 13 : 0x10;
    regs[11] = p.ep & 255; regs[12] = p.ep >> 8; regs[13] = 8;
    return Array.from({ length: Math.round(seconds * 50) }, (_, i) => ({ regs, shape: i === 0 }));
  }
  function drawBuzz() {
    const p = bzParams();
    $("output[for=bzPitch]").textContent = `${p.f0} Hz`;
    $("output[for=bzFormant]").textContent = `${p.F} Hz`;
    // Traces from the emulator's own counters: one value per 8 clocks.
    const ay = new Ayumi();
    ay.configure(false, BZ_CLOCK, RATE);
    ay.setTone(0, p.tp);
    ay.setMixer(0, bzMode === "env" ? 1 : 0, 1, bzMode === "tone" ? 0 : 1);
    ay.setVolume(0, 13);
    ay.setEnvelope(p.ep);
    ay.setEnvelopeShape(8);
    const ticks = 3 * 32 * p.ep, env = new Float32Array(ticks), tone = new Uint8Array(ticks), out = new Float32Array(ticks);
    for (let i = 0; i < ticks; i++) {
      ay.updateMixer();
      env[i] = ay.envelope / 31;
      tone[i] = ay.channels[0].tone;
      out[i] = ay.left;
    }
    const { ctx, w, h, dpr } = sized($("#bzTrace"));
    ctx.clearRect(0, 0, w, h);
    const lanes = [["envelope level", env, css("--s1"), bzMode !== "tone"], ["tone (on/off)", tone, css("--s2"), bzMode !== "env"],
      ["channel output", out, css("--text"), true]];
    const laneH = h / 3, pad = 8 * dpr, labelW = 0;
    lanes.forEach(([label, data, color, active], k) => {
      const top = k * laneH + pad + 16 * dpr, bottom = (k + 1) * laneH - pad;
      ctx.fillStyle = css("--grid");
      ctx.fillRect(labelW, bottom, w, dpr);
      ctx.strokeStyle = active ? color : css("--line");
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const a = Math.floor(x / w * ticks), b = Math.max(a + 1, Math.floor((x + 1) / w * ticks));
        let lo = Infinity, hi = -Infinity;
        for (let i = a; i < b && i < ticks; i++) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
        const yv = (v) => bottom - v * (bottom - top);
        if (x === 0) ctx.moveTo(x, yv(lo)); else ctx.lineTo(x, yv(lo));
        if (hi !== lo) ctx.lineTo(x, yv(hi));
      }
      ctx.stroke();
      ctx.fillStyle = css("--text-2");
      ctx.font = `${12 * dpr}px system-ui, sans-serif`;
      ctx.fillText(label + (active ? "" : " (not used)"), 6 * dpr, top - 5 * dpr);
    });
    // Spectrum of one second, with the harmonic grid and the formant target.
    const samples = Render.render(bzFrames(p, bzMode), RATE, { clock: BZ_CLOCK }, Ayumi);
    // 2.7 Hz bins: coarser bins smear each harmonic past the ±6 Hz test band.
    const spec = Render.spectrum(samples, RATE, Math.round(RATE * 0.1), samples.length, 16384);
    const harm = Render.harmonicity(spec, p.pitch);
    const s2 = sized($("#bzSpec")), c = s2.ctx, W = s2.w, H = s2.h, top = 3000;
    c.clearRect(0, 0, W, H);
    c.fillStyle = css("--grid");
    for (let k = 1; k * p.pitch < top; k++) c.fillRect(k * p.pitch / top * W, 0, s2.dpr, H);
    let peak = 1e-12;
    for (let i = 1; i * spec.hz < top; i++) peak = Math.max(peak, spec.power[i]);
    c.strokeStyle = css("--s1"); c.lineWidth = 2 * s2.dpr; c.lineJoin = "round";
    c.beginPath();
    for (let i = 1; i * spec.hz < top; i++) {
      const db = Math.max(-60, 10 * Math.log10(spec.power[i] / peak + 1e-12));
      const x = i * spec.hz / top * W, y = H - 14 * s2.dpr - (db + 60) / 60 * (H - 24 * s2.dpr);
      if (i === 1) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    if (bzMode !== "env") {
      c.fillStyle = css("--s2");
      c.fillRect(p.F / top * W - s2.dpr, 0, 2 * s2.dpr, H);
      c.font = `${12 * s2.dpr}px system-ui, sans-serif`;
      c.fillText(`target ${p.F} Hz`, p.F / top * W + 5 * s2.dpr, 14 * s2.dpr);
    }
    c.fillStyle = css("--muted");
    c.font = `${11 * s2.dpr}px system-ui, sans-serif`;
    for (let hz = 500; hz < top; hz += 500) c.fillText(`${hz}`, hz / top * W + 3 * s2.dpr, H - 3 * s2.dpr);
    const lockText = p.lock ? `harmonic n = ${p.n}, TP = ${p.tp}${p.exact ? " (exact)" : " (nearest; not an exact divisor)"}` : `TP = ${p.tp} (free running)`;
    $("#bzReadout").innerHTML = `EP <b>${p.ep}</b> → pitch <b>${fmt(p.pitch, 1)} Hz</b> · formant ${p.F} Hz → ${lockText} → <b>${fmt(p.freq, 1)} Hz</b><br>` +
      `Energy on harmonics of the pitch (60 Hz–5 kHz): <b>${pct(harm)}</b>` + (bzMode === "tone" ? " (a fixed tone has no relation to the pitch)" : "");
    return samples;
  }

  // --- consonant cards -----------------------------------------------------
  const CONSONANTS = [
    ["Fricatives", "Noise on channel C. A short noise period is bright (\"s\"), a longer one darker (\"sh\"); \"f\" and \"th\" are quieter.", "see, she, fee."],
    ["Voiced fricatives", "The same noise with F1 voiced underneath: z, v, zh.", "zoo, view, vision."],
    ["Plosives", "A closure (silence, or a low voice bar for b, d, g), a one- or two-frame burst of noise, a breath for p, t, k, then the next vowel's formants slide in from the consonant's locus.", "pea, tea, key, bee, dee."],
    ["Nasals", "A low hum: F1 on the envelope and a weak steady F2.", "me, now, sing."],
    ["Liquids and glides", "Short voiced sounds moving into the next vowel: w, y, l, r (r pulls F3 down).", "we, you, low, row."],
    ["H", "Quiet noise while the next vowel's formants are already in place.", "he, who, high."],
  ];
  function consonantCards() {
    $("#consonantCards").innerHTML = CONSONANTS.map(([title, text, say], i) =>
      `<div class="card"><h4>${title}</h4>${esc(text)}<br><button class="small" data-cons="${i}">Play “${esc(say)}”</button></div>`).join("");
    $$("[data-cons]").forEach((b) => b.addEventListener("click", () => playMini(CONSONANTS[+b.dataset.cons][2])));
  }
  function playMini(text, sound = true) {
    let r;
    try { r = Speech.speak(voiceFromControls(), text, "text"); } catch (e) { return; }
    const m = machine(), samples = Render.render(r.frames, RATE, { clock: m.clock, ym: m.ym }, Ayumi);
    const img = spectroImage($("#miniSpectro"), r, samples);
    const paint = (t) => {
      const { ctx, w, h, dpr } = sized($("#miniSpectro"));
      ctx.drawImage(img, 0, 0, w, h);
      if (t !== null) { ctx.fillStyle = css("--accent"); ctx.fillRect(t * 50 / r.frames.length * w - dpr, 0, 2 * dpr, h); }
    };
    paint(null);
    drawStrip($("#miniStrip"), r, r.frames.length);
    if (sound) play(samples, paint);
  }

  // --- Vectrex tiles -------------------------------------------------------
  function tiles() {
    const v = MACHINES[0].measured;
    $("#vectrexTiles").innerHTML = [
      [fmt(v.mean), "cycles per frame, mean"], [fmt(v.p95), "cycles, 95th percentile"], [fmt(v.max), "cycles, worst frame"],
      [pct(v.mean / 30000), "of a 50 Hz frame (mean)"], ["20", "bytes of RAM"],
    ].map(([n, l]) => `<div class="tile"><div class="num">${n}</div><div class="lbl">${l}</div></div>`).join("");
  }

  // --- wiring --------------------------------------------------------------
  function init() {
    PRESETS.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = p.name; $("#preset").appendChild(o); });
    MACHINES.forEach((m) => { const o = document.createElement("option"); o.value = m.id; o.textContent = `${m.name} (${m.chip})`; ctl.machine.appendChild(o); });
    chipDiagram(); pipeDiagram(); vowelChart(); consonantCards(); tiles(); machineNotes(); machineChanged(); showOutputs();

    $("#speak").addEventListener("click", speakNow);
    $("#stop").addEventListener("click", stop);
    $("#say").addEventListener("keydown", (e) => { if (e.key === "Enter") speakNow(); });
    $("#toPhonemes").addEventListener("click", toPhonemes);
    $$("input[name=mode]").forEach((r) => r.addEventListener("change", build));
    $("#preset").addEventListener("change", (e) => {
      const p = PRESETS[+e.target.value];
      if (!p) return;
      $("#say").value = p.text;
      $(`input[name=mode][value=${p.mode || "text"}]`).checked = true;
      setControls(p.voice);
      speakNow();
    });
    let timer = null;
    Object.entries(ctl).forEach(([key, el]) => el.addEventListener("input", () => {
      if (key === "f3" || key === "layout") delete extra.channels;
      if (key === "machine") machineChanged();
      showOutputs();
      clearTimeout(timer);
      timer = setTimeout(build, 120);
    }));
    $("#spectro").addEventListener("click", (e) => {
      if (!current) return;
      const rect = e.target.getBoundingClientRect();
      showRegs(Math.floor((e.clientX - rect.left) / rect.width * current.result.frames.length));
    });
    $("#spectro").tabIndex = 0;
    $("#spectro").addEventListener("keydown", (e) => {
      if (!current) return;
      if (e.key === "ArrowRight") { showRegs(current.sel + 1); e.preventDefault(); }
      if (e.key === "ArrowLeft") { showRegs(current.sel - 1); e.preventDefault(); }
    });
    $("#wav").addEventListener("click", () => {
      if (!current) return;
      download(new Blob([Render.wav(current.samples, RATE)], { type: "audio/wav" }), "vtx_speech.wav");
    });
    $("#regsOut").addEventListener("click", () => {
      if (!current) return;
      const data = { clock: current.machine.clock, frameRate: 50, text: $("#say").value, mode: mode(),
        note: "regs are R0..R13 per 50 Hz frame; write R13 only when shape is true (it restarts the envelope)",
        frames: current.result.frames.map((f) => ({ regs: f.regs, shape: f.shape })) };
      download(new Blob([JSON.stringify(data)], { type: "application/json" }), "vtx_speech_registers.json");
    });
    $("#changedOnly").addEventListener("change", showMachines);
    $("#runStrip").addEventListener("click", (e) => {
      if (!encoded) return;
      const rect = e.target.getBoundingClientRect(), f = (e.clientX - rect.left) / rect.width * current.result.frames.length;
      const k = encoded.runs.findIndex((r) => f >= r.start && f < r.start + r.frames);
      if (k >= 0) selectRun(k);
    });

    ["#bzPitch", "#bzFormant", "#bzLock"].forEach((s) => $(s).addEventListener("input", drawBuzz));
    $$("[data-bz]").forEach((b) => b.addEventListener("click", () => {
      bzMode = b.dataset.bz;
      $$("[data-bz]").forEach((o) => o.classList.toggle("primary", o === b));
      play(drawBuzz());
    }));
    let resize = null;
    window.addEventListener("resize", () => { clearTimeout(resize); resize = setTimeout(() => { drawSpectro(); if (current) drawStrip($("#strip"), current.result, current.result.frames.length); drawRunStrip(); drawBuzz(); }, 150); });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawSpectro(); drawBuzz(); });

    drawBuzz();
    loadDictionary().then(() => { build(); playMini(CONSONANTS[0][2], false); });
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  init();
})();

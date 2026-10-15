// The editor page in headless Chrome, against its real server on a scratch
// phrase file: modes, conversion, sliders, word edits, listening, export.
//   node test/editor_browser.mjs          (Node 22+, Python, Chrome)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, "build", "editor_browser");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const PHRASES = path.join(WORK, "phrases.txt");
fs.copyFileSync(path.join(ROOT, "vectrex", "example", "phrases.txt"), PHRASES);
const PORT = 8790, CDP = 9343;
const server = spawn("python", [path.join(ROOT, "vectrex", "editor.py"), PHRASES, "--port", String(PORT), "--no-browser"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/`); break; } catch { await sleep(200); } }

const CHROME = [process.env.CHROME, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((c) => c && fs.existsSync(c));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-editor-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "--window-size=1500,1100", "about:blank"], { stdio: "ignore" });
let ws, opened, id = 0;
const waiting = new Map(), errors = [];
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find((t) => t.type === "page");
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); opened = new Promise((r) => (ws.onopen = r)); }
  } catch { /* not up yet */ }
  if (!ws) await sleep(200);
}
await opened;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error" && !/favicon/.test(d.params.entry.url || "")) errors.push(d.params.entry.text);
};
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; };
const file = () => fs.readFileSync(PHRASES, "utf8");

await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
// Downloads go into build/, never into the person's Downloads folder.
const DOWNLOADS = path.join(ROOT, "build", "test_downloads");
fs.rmSync(DOWNLOADS, { recursive: true, force: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOADS, eventsEnabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
await sleep(1500);

check(await js("document.querySelectorAll('.phrase').length === 4"), "four phrases listed");
check(await js("document.getElementById('flatSpeed').checked && !document.getElementById('arcadeVoices').checked"),
  "the example's #voicespeed flat and #voices show in the Voice panel");
check(await js("document.querySelectorAll('#words tbody tr').length === 20"), "twenty words listed");
check(await js("document.querySelector('.phrase').dataset.mode === 'phonemes' && document.querySelector('.phrase .say').value.includes('| ^c7 EY1:8 M:9')"),
  "the film line shows as Phonemes, voice changes included");
check(await js("document.querySelectorAll('.phrase')[1].dataset.mode === 'english'"), "English phrases marked English");

// Touching the film line writes it back unchanged.
await js("(() => { const b = document.querySelector('.phrase .say'); b.dispatchEvent(new Event('input')); })()");
await js("document.getElementById('save').click()");
await sleep(500);
check(file().includes("Say_Game  = ,:1 ^c0 /SH:7 AE1:5 AA1:6/ ^c3 /L:6/ ^c2 /W:4 IY1:5/ ^c0 /IY1:7/ ^c5 /P:1 L:2/ ^c3 /EY1:16 AH0:15 G:7/ ^c7 /EY1:8 M:9/"),
  "the film line round-trips exactly");

// Switch an English phrase to Phonemes: its words are converted, its pause kept.
const helloRow = "[...document.querySelectorAll('.phrase')].find((r) => r.dataset.label === 'Say_Hello')";
await js(`${helloRow}.querySelector('.seg button[data-mode=phonemes]').click()`);
await sleep(800);
check(await js(`${helloRow}.querySelector('.say').value.startsWith('HH AH0 L OW1 | ,:8 | AY1')`), "English converted to phonemes");
await js("document.getElementById('save').click()");
await sleep(500);
check(/Say_Hello\s*=\s*\^c5 \/HH AH0 L OW1\/ ,:8 \/AY1\//.test(file()), "saved as /phoneme/ groups");

// Switch an English phrase to SpeakJet and back: converted, never emptied, English restored.
const alertRow = "[...document.querySelectorAll('.phrase')].find((r) => r.dataset.label === 'Say_Alert')";
await js(`${alertRow}.querySelector('.seg button[data-mode=speakjet]').click()`);
await sleep(900);
check(await js(`${alertRow}.querySelector('.say').value.startsWith(String.fromCharCode(92) + 'IH ' + String.fromCharCode(92) + 'NO') && ${alertRow}.querySelector('.say').value.includes('P1')`), "English converted to SpeakJet codes, pause kept");
check(await js(`!${alertRow}.textContent.includes('says nothing') && ${alertRow}.querySelector('.voice output').textContent.endsWith(' Hz')`), "no 'says nothing', the voice keeps its Hz");
await js(`${alertRow}.querySelector('.seg button[data-mode=english]').click()`);
await sleep(900);
check(await js(`${alertRow}.querySelector('.say').value === 'intruder alert ,:6 intruder alert'`), "switching back restores the English");

// A space typed in a label becomes _.
await js(`(() => { const b = ${alertRow}.querySelector('.label'); b.value = 'Say Alert'; b.dispatchEvent(new Event('input')); })()`);
check(await js(`${alertRow} === undefined || [...document.querySelectorAll('.phrase .label')].some((b) => b.value === 'Say_Alert')`), "a space in a label becomes _");

// Add a SpeakJet phrase.
await js("document.querySelector('#newMode button[data-mode=speakjet]').click()");
await js("document.getElementById('addPhrase').click()");
await sleep(800);
check(await js("document.querySelectorAll('.phrase').length === 5 && document.querySelectorAll('.phrase')[4].dataset.mode === 'speakjet'"), "a SpeakJet phrase added");
check(await js("[...document.querySelectorAll('#words .tag')].some((t) => t.textContent === 'SpeakJet')"), "its word is tagged SpeakJet");

// Sliders: speed, voices, a phrase's voice, a word's length.
await js("(() => { const s = document.getElementById('speed'); s.value = 1.25; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()");
await js("(() => { const s = document.getElementById('voiceLow'); s.value = 70; s.dispatchEvent(new Event('change')); })()");
await js("(() => { const s = document.querySelectorAll('.phrase .voice input')[1]; s.value = 8; s.dispatchEvent(new Event('input')); })()");
await sleep(800);
await js("(() => { const r = [...document.querySelectorAll('#words tbody tr')].find((tr) => tr.querySelector('.name').textContent === 'intruder'); const s = r.querySelector('.len input'); s.value = 1.5; s.dispatchEvent(new Event('change')); })()");
await sleep(800);
await js("document.getElementById('save').click()");
await sleep(500);
const f = file();
check(/^#speed 1\.25$/m.test(f), "#speed written");
check(/^#voices 70 127$/m.test(f), "#voices written");
check(/Say_Hello\s*=\s*\^c\? \/HH/.test(f) && (f.match(/Say_Hello/g) || []).length === 1, "a phrase's voice slider writes ^c?, on its own line");
check(/^@intruder = intruder \*1\.5$/m.test(f), "a word's length slider writes @intruder");
check(await js("document.getElementById('voices').textContent.includes('0: 70 Hz')"), "the voices show the new range");

// Say a word differently, and pick a pronunciation.
await js("(() => { const r = [...document.querySelectorAll('#words tbody tr')].find((tr) => tr.querySelector('.name').textContent === 'alert'); r.querySelector('button.icon').click(); })()");
await sleep(300);
await js("(() => { const e = document.querySelector('#words tr.edit'); e.querySelector('input').value = 'alurt'; e.querySelector('button.primary').click(); })()");
await sleep(800);
check(await js("[...document.querySelectorAll('#words tbody tr')].some((tr) => tr.querySelector('.name').textContent === 'alert' && /guessed/.test(tr.textContent))"), "a word said differently");
await js("(() => { const s = [...document.querySelectorAll('#words select.choice')][0]; s.value = '2'; s.dispatchEvent(new Event('change')); })()");
await sleep(800);

// Listen: the picture and the registers appear.
await js("document.querySelector('.phrase .play').click()");
await sleep(1500);
check(await js("/frames/.test(document.getElementById('nowPlaying').textContent) && document.querySelectorAll('#regs tr').length === 7"), "playing shows the frames and registers");
const ink = await js(`(() => { const c = document.getElementById('spectro'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let lo = 255, hi = 0; for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i + 2]); hi = Math.max(hi, d[i + 2]); } return hi - lo; })()`);
check(ink > 100, "the spectrogram is drawn");

// The file view, then export.
await js("document.querySelector('#viewSwitch button[data-view=file]').click()");
await sleep(200);
check(await js("document.getElementById('source').value.includes('#speed 1.25')"), "the file view shows the file");
await js("document.querySelector('#viewSwitch button[data-view=list]').click()");
await js("document.getElementById('export').click()");
await sleep(1200);
check(fs.existsSync(path.join(WORK, "speech_data.asm")) && /pitch 70 to 127 Hz/.test(fs.readFileSync(path.join(WORK, "speech_data.asm"), "utf8")), "exported with the voice range");
check(fs.existsSync(path.join(WORK, "vtx_speech.asm")), "the player was put beside the data");
check(await js("!document.getElementById('usePanel').hidden && document.getElementById('snippet').textContent.includes('include \"speech_data.asm\"')"), "the Use in your game box shows the include lines");

// The cartridge check in MAME (when MAME is known on this machine).
const mame = await (await fetch(`http://127.0.0.1:${PORT}/api/mame`)).json();
if (mame.found) {
  await js("document.getElementById('check').click()");
  for (let i = 0; i < 120 && !(await js("/✓|✕|problems/.test(document.getElementById('checkResult').innerHTML) && !document.getElementById('check').disabled")); i++) await sleep(500);
  check(await js("document.getElementById('checkResult').textContent.includes('Cartridge matches the editor')"), "Check in MAME: the cartridge matches");
} else console.log("skip Check in MAME: MAME is not known here");

// The help shows, hides and comes back; panels fold, and both are remembered after a reload.
check(await js("!document.getElementById('helpPanel').hidden && document.getElementById('helpPanel').textContent.includes('letter rules')"), "the help is shown, with the phrase guide");
await js("document.getElementById('helpClose').click()");
check(await js("document.getElementById('helpPanel').hidden"), "the help hides");
const voiceTitle = "[...document.querySelectorAll('.panel h2.toggle')].find((h) => h.textContent.trim() === 'Voice')";
await js(`${voiceTitle}.click()`);
check(await js(`${voiceTitle}.closest('.panel').classList.contains('collapsed') && document.getElementById('speed').offsetParent === null`), "a panel folds");
await send("Page.reload");
await sleep(1500);
check(await js(`document.getElementById('helpPanel').hidden && ${voiceTitle}.closest('.panel').classList.contains('collapsed')`), "folding and the hidden help are remembered");
check(await js("[...document.querySelectorAll('.phrase .voice output')].filter((o) => !o.textContent.startsWith('?')).every((o) => o.textContent.endsWith(' Hz'))"), "after loading, every voice shows its Hz");
await js("document.getElementById('helpToggle').click()");
await js(`${voiceTitle}.click()`);
check(await js(`!document.getElementById('helpPanel').hidden && !${voiceTitle}.closest('.panel').classList.contains('collapsed') && document.getElementById('speed').offsetParent !== null`), "? Help shows it again, and the panel unfolds");

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
fs.writeFileSync(path.join(WORK, "editor.png"), Buffer.from(shot.result.data, "base64"));
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await js("document.getElementById('theme').click()");
await sleep(300);
const shot2 = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
fs.writeFileSync(path.join(WORK, "editor_light.png"), Buffer.from(shot2.result.data, "base64"));

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
console.log(`${failures ? failures + " failed" : "all passed"}; screenshots in ${WORK}`);
ws.close(); chrome.kill(); server.kill();
process.exit(failures ? 1 : 0);

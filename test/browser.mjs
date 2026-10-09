// Loads the page in headless Chrome, exercises it and takes screenshots.
//   node test/browser.mjs [screenshot dir]      (Node 22+, no packages)
// Serves the folder itself, so it also checks the page works over HTTP.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "build", "screens"));
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".gz": "application/gzip" };
const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  const target = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, "index.html") : file;
  if (!fs.existsSync(target)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
}).listen(0);
const URL_ = `http://127.0.0.1:${server.address().port}/`;

const CHROME = [process.env.CHROME, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((c) => c && fs.existsSync(c));
if (!CHROME) { console.error("no Chrome found (set CHROME)"); process.exit(2); }
const PORT = 9341;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-speech-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const waiting = new Map(), errors = [];
let opened;
for (let i = 0; i < 50 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); opened = new Promise((r) => (ws.onopen = r)); }
  } catch { /* not up yet */ }
  if (!ws) await sleep(200);
}
await opened;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push(d.params.args.map((a) => a.value).join(" "));
  if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push(d.params.entry.text + " " + (d.params.entry.url || ""));
};
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
}
async function view(width, height, dark) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await sleep(400);
}
// The whole page, in sections of `part` CSS pixels: name_0.png, name_1.png ...
async function shot(name, part = 1400) {
  const size = (await send("Page.getLayoutMetrics")).result.cssContentSize;
  for (let y = 0, i = 0; y < size.height; y += part, i++) {
    const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
      clip: { x: 0, y, width: size.width, height: Math.min(part, size.height - y), scale: 1 } });
    fs.writeFileSync(path.join(OUT, `${name}_${i}.png`), Buffer.from(r.result.data, "base64"));
  }
}
let failures = 0;
function check(ok, what) { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failures++; }

await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
await view(1280, 900, false);
await send("Page.navigate", { url: URL_ });
for (let i = 0; i < 100; i++) {
  await sleep(200);
  if (await js("/dictionary: /.test(document.getElementById('dictStatus').textContent)").catch(() => false)) break;
}
check(await js("/dictionary: 12\\d,\\d{3} words/.test(document.getElementById('dictStatus').textContent)"), "dictionary loaded");
check(await js("document.querySelectorAll('#pronounced .w').length === 5"), "the default text was pronounced");
const ink = () => js(`(() => { const c = document.getElementById("spectro"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let lo = 255, hi = 0; for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } return hi - lo; })()`);
check(await ink() > 100, "the spectrogram has contrast");
check(await js("document.querySelectorAll('#regs tbody tr').length === 14"), "register table");
check(await js("document.querySelectorAll('#machineTable tbody tr').length === 5"), "machine table");
check(await js("document.querySelectorAll('#storageChart .hbar').length === 5"), "storage chart");
check(await js("document.querySelectorAll('#vowelChart .vowel').length === 10"), "vowel chart");
check(await js("document.querySelectorAll('#byteGrid .byte').length === parseInt(document.querySelectorAll('#stats b')[2].textContent.split(',').join(''))"), "byte map has every stored byte");
await js("document.querySelectorAll('#byteGrid .byte')[5].click()");
check(await js("!!document.querySelector('#byteGrid .byte.sel') && document.getElementById('byteDetail').textContent.includes('Run 3 of ')"), "clicking a byte explains its run");
check(await js("/Energy on harmonics/.test(document.getElementById('bzReadout').textContent)"), "buzz widget readout");

// Every example, every machine.
const presets = await js("document.getElementById('preset').options.length - 1");
for (let i = 0; i < presets; i++) {
  await js(`(() => { const s = document.getElementById('preset'); s.value = '${i}'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(150);
  const name = await js(`document.getElementById('preset').options[${i + 1}].text`);
  check(await js("document.getElementById('error').textContent === ''") && (await ink()) > 60, `example "${name}"`);
}
await js(`(() => { const s = document.getElementById('preset'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
for (const m of ["vectrex", "spectrum", "cpc", "msx", "st"]) {
  await js(`(() => { const s = document.getElementById('machine'); s.value = '${m}'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  check(await js("document.getElementById('error').textContent === ''") && (await ink()) > 60, `machine ${m}`);
}
await js(`(() => { const s = document.getElementById('machine'); s.value = 'vectrex'; s.dispatchEvent(new Event('input')); })()`);
// A guessed word, a word with two pronunciations, and phoneme editing.
await js(`(() => { const s = document.getElementById('say'); s.value = 'I live near the zorblax.'; document.querySelector('input[name=mode][value=text]').checked = true; document.getElementById('speak').click(); })()`);
await sleep(300);
check(await js("document.querySelector('#pronounced .guessed') !== null"), "a guessed word is marked");
await js("document.querySelector('#pronounced .choice').click()");
await sleep(300);
check(await js("/live#1/.test(document.getElementById('say').value)"), "clicking a word switches its pronunciation");
await js("document.getElementById('toPhonemes').click()");
await sleep(300);
check(await js("document.querySelector('input[name=mode]:checked').value === 'phonemes' && /L AY1 V/.test(document.getElementById('say').value)"), "edit as phonemes");
await js(`(() => { const s = document.getElementById('say'); s.value = 'Shall we play a game?'; document.querySelector('input[name=mode][value=text]').checked = true; document.getElementById('speak').click(); })()`);
await sleep(300);

// The buzz: locked vs free energy on harmonics.
const harm = () => js("parseFloat(document.getElementById('bzReadout').textContent.match(/harmonics[^:]*: ([\\d.]+)%/)[1])");
await js("document.querySelector('[data-bz=voice]').click()");
await sleep(200);
const locked = await harm();
await js("(() => { const c = document.getElementById('bzLock'); c.checked = false; c.dispatchEvent(new Event('input')); })()");
await sleep(200);
const free = await harm();
check(locked > 98 && free < locked - 20, `buzz: ${locked}% on harmonics locked, ${free}% free`);
await js("(() => { const c = document.getElementById('bzLock'); c.checked = true; c.dispatchEvent(new Event('input')); })()");

check(await js("document.documentElement.scrollWidth <= window.innerWidth"), "no horizontal scroll at 1280");
await shot("desktop_light");
await view(1280, 900, true);
await js("window.dispatchEvent(new Event('resize'))"); await sleep(500);
await shot("desktop_dark");
await view(390, 844, false);
await js("window.dispatchEvent(new Event('resize'))"); await sleep(500);
check(await js("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal scroll at 390");
await shot("phone_light", 1600);

check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
console.log(`${failures ? failures + " failed" : "all passed"}; screenshots in ${OUT}`);
ws.close(); chrome.kill(); server.close();
process.exit(failures ? 1 : 0);

# VTX Speech: a talking AY chip

An interactive explainer and playground for speech made by the
AY-3-8910/8912 and YM2149 sound chips alone, with no samples: the CPU sets the
chip's registers once per 50 Hz frame. Type any English text and hear it
through an AY emulator. The page also shows how the buzz is made, what the CPU
has to do, and estimates for the Vectrex, ZX Spectrum 128, Amstrad CPC, MSX
and Atari ST.

Everything is static: HTML, CSS and JavaScript, with no build step and no
server code.

## Running it locally

The pronunciation dictionary is fetched, so open the page through a web
server rather than as a file:

```powershell
python -m http.server 8000
# then open http://localhost:8000/
```

Opened as a file, the page still works, but words are only guessed from
their spelling.

## Hosting on GitHub Pages

1. Create a repository on GitHub (for example `vtx-speech`) and push this
   folder to its `main` branch.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy
   from a branch**, then choose `main` and `/ (root)`, and save.
3. After a minute the site is at `https://<user>.github.io/vtx-speech/`.

`.nojekyll` tells Pages to serve the files as they are.

## Files

| Path | What |
|---|---|
| `index.html`, `css/site.css` | the page |
| `js/speech.js` | the voice model: text → phonemes → frame states → AY registers |
| `js/render.js` | registers → sound through Ayumi; spectra |
| `js/machines.js` | the machines and the per-frame cost model (estimates; see the file) |
| `js/app.js` | playground, widgets and diagrams |
| `vendor/` | Ayumi and the CMU Pronouncing Dictionary, unmodified, with their licences |
| `test/parity.test.js` | the model gives exactly the reference model's registers |
| `test/browser.mjs` | loads the page in headless Chrome, exercises it, takes screenshots |
| `dev/make_fixtures.py` | regenerates the parity fixtures from the reference Python model |

## Tests

```powershell
node test/parity.test.js          # 16 cases, 2,631 frames, all exact
node test/browser.mjs             # needs Chrome; screenshots in build/screens
```

The voice model is a port of the reference model in the VTX project
(`tools/vtx_speech`). To regenerate the fixtures after a change there:

```powershell
python dev/make_fixtures.py C:\path\to\VXT_VSCodeProject
```

Two additions here are not in the reference model, and the parity test does
not cover them: **voice size** (formant scaling) and **whisper**. Both are
off by default. The word "AY" is also pronounced as its letters.

## Licence and credits

MIT (`LICENSE`). Third-party files in `vendor/` keep their own licences;
see `NOTICE.md`.

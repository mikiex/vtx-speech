# VTX Speech

Speech from the AY-3-8910/8912 and YM2149 sound chips alone: no samples, the
registers are set once per 50 Hz frame. Two parts:

- **A Vectrex speech kit** (`vectrex/`): a 6809 player (AS09 source, 787
  bytes), a phrase-file exporter, a local web editor, and a MAME check that
  compares the cartridge with the editor frame by frame.
- **An explainer and playground** (the website,
  <https://mikiex.github.io/vtx-speech/>): how the voice is made, and cost
  estimates for other AY machines.

## Requirements

| For | Needs |
|---|---|
| Exporting (`export.py`) | Python 3.8+ (tested on 3.10), standard library only |
| The editor (`editor.py`) | the same, plus a web browser |
| Building cartridges | AS09, bundled as a Windows program (`vectrex/as09/`). The editor's Build, Run and Check need Windows; elsewhere assemble by hand (Wine, untested) |
| Run / Check in MAME | MAME 0.227+ with the Vectrex BIOS (`vectrex.zip`) in its ROM folder |
| `export.js`, tests | Node 18+; the browser tests need Chrome or Edge |

Nothing to install with pip, and no network access at run time: the
pronunciation dictionary is included (`vendor/cmudict.dict.gz`).

## Install

```powershell
git clone https://github.com/mikiex/vtx-speech.git
cd vtx-speech
```

Or download the ZIP from GitHub and unpack it. The scripts find their own
files, so they can be run from any folder by path.

## Command line

```powershell
# phrases -> speech_data.asm; --player also copies vtx_speech.asm beside it
python vectrex/export.py my_game\phrases.txt my_game\speech_data.asm --player

# to standard output
python vectrex/export.py phrases.txt > speech_data.asm

# say every phrase on the emulated cartridge and compare every frame (MAME)
python vectrex/mame_check.py phrases.txt [--mame C:\mame\mame.exe]
```

Problems (bad labels or tokens, more than 64 words, ...) are printed to
stderr with exit code 1 and nothing is written. Warnings go to stderr and the
file is still written. `node vectrex/export.js` writes the same file.

## Editor (local server)

```powershell
python vectrex/editor.py my_game\phrases.txt     # the file is made if missing
python vectrex/editor.py phrases.txt --port 8800 --no-browser
```

It serves `http://127.0.0.1:8768/` and opens it. Write phrases as English,
phonemes or SpeakJet codes, set voices and word lengths, and listen through
an AY emulator (Ayumi).

| Button | Does |
|---|---|
| Save | writes the phrase file; the old one goes to `.editor_backups/` |
| Export | writes `speech_data.asm`, and `vtx_speech.asm` if absent, beside the phrase file |
| Build test cartridge | `speech_test/speech_test.bin`: button 1 next phrase, button 2 again |
| Run in MAME | builds it and opens it in MAME (Left Ctrl, Left Alt) |
| Check in MAME | as `mame_check.py` |

The server listens on 127.0.0.1 only and refuses requests from other sites.
Ctrl+C stops it. MAME is found through the saved location
(`~/.vtx_speech.json`), `MAME_PATH`, `PATH`, then common install folders;
otherwise the editor asks once.

## Using the player

```asm
VS_RAM   equ  $CA80          ; 22 bytes
VS_DUCK  equ  4              ; channel C volume reduction while speaking
         include "vtx_speech.asm"
         include "speech_data.asm"

         jsr  Speech_Init
         ldx  #Say_Hello
         jsr  Speech_Say
; every frame, after your sound code fills Vec_Music_Work:
         jsr  Speech_Service
         jsr  Do_Sound
```

Phrase file syntax, routines, AY register use and measurements:
[`vectrex/README.md`](vectrex/README.md). `vectrex/example/` is a complete
cartridge (`example.bin` is prebuilt).

## The website

Static HTML, CSS and JavaScript. The dictionary is fetched, so run it
through a server rather than opening the file:

```powershell
python -m http.server 8000      # then open http://localhost:8000/
```

GitHub Pages serves the root of `main` (`.nojekyll` is included). The site
has its own Vectrex exporter, which writes the same `speech_data.asm`.

## Files

| Path | What |
|---|---|
| `vectrex/vtx_speech.asm` | the player |
| `vectrex/export.py`, `vectrex/export.js` | exporters (identical output) |
| `vectrex/editor.py`, `vectrex/editor_ui/` | the editor |
| `vectrex/mame_check.py` | the cartridge check in MAME |
| `vectrex/vtxspeech/` | voice model, pronunciation, SpeakJet mapping (Python) |
| `vectrex/as09/` | AS09 1.42 and its manual |
| `vectrex/example/` | example cartridge and phrase files |
| `index.html`, `css/`, `js/` | the website; `js/speech.js` is the voice model in JavaScript |
| `vendor/` | Ayumi and the CMU Pronouncing Dictionary, unmodified |
| `test/` | tests |
| `dev/` | maintainer scripts: fixtures and checks against the VTX project, recording analysis |

## Tests

```powershell
python test/test_export_python.py # Python and JavaScript exporters agree (needs Node)
python test/test_editor.py        # the editor's server
node test/vectrex_export.test.js  # exporter bytes equal the reference
node test/parity.test.js          # JS voice model equals the reference: 16 cases, 2,631 frames
node test/editor_browser.mjs      # the editor in Chrome
node test/browser.mjs             # the website in Chrome; screenshots in build/
python vectrex/mame_check.py vectrex/example/phrases.txt
```

The voice model was ported from the VTX project, which the fixtures come
from (`dev/make_fixtures.py` and `dev/make_export_fixture.py` take its
path). It is not needed to use the kit or run the tests.

## Licences

| | Licence |
|---|---|
| This project: player, tools, website | MIT, `LICENSE` |
| Ayumi (`vendor/ayumi.js`) | MIT, `vendor/AYUMI_LICENSE` |
| CMU Pronouncing Dictionary (`vendor/cmudict.dict.gz`) | BSD-style, `vendor/CMUDICT_LICENSE` |
| AS09 (`vectrex/as09/`) | freely distributable with its manual, not for sale; terms in `vectrex/as09/as09.man.txt` |

SpeakJet code numbers and mnemonics are used as an input format only.
Sources, versions and checksums: `NOTICE.md`.

The player can go into any cartridge, including commercial ones (MIT: keep
the licence notice with copies of the source). The data exported from your
phrases is yours.

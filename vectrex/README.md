# VTX Speech for the Vectrex (AS09)

Formant speech on the Vectrex's AY-3-8912, no extra hardware. One AS09 source
file; data from a phrase file. Background: https://mikiex.github.io/vtx-speech/

| | |
|---|---|
| Player | `vtx_speech.asm`, 787 bytes incl. tables |
| RAM | 22 bytes at `VS_RAM` |
| CPU | 642 cycles/frame mean while speaking, 1,180 worst (MAME) |
| AY | A, B, noise, envelope while speaking; C is yours |
| Data | ~35 bytes per word; ~1 byte per word per phrase |

## Files

| | |
|---|---|
| `vtx_speech.asm` | the player |
| `editor.py` | local web editor: edit, listen, export, build, run/check in MAME |
| `export.py` | phrase file → `speech_data.asm` (Python 3.8+, stdlib only) |
| `export.js` | same output, Node |
| `mame_check.py` | runs every phrase in MAME and compares every frame with the editor's player |
| `vtxspeech/` | the voice model (Python) |
| `as09/` | AS09 1.42 (Windows) and its manual |
| `example/` | demo cartridge: buttons 1–4 say a phrase; `example.bin` prebuilt |

## Phrase file

```text
; comment
#voices 68 127
#voicespeed flat
Say_Game  = ,:1 ^c0 /SH:7 AE1:5 AA1:6/ ^c3 /L:6/ ...
Say_Hello = ^c5 hello ,:8 i am a vectrex
Say_Taunt = ^c? {get|kill|destroy} {the humanoid|it}
@live     = live#1
@shoot    = shoot *1.2
```

`Label = phrase`. Labels are assembler labels (`[A-Za-z_]\w*`, not a
register name, not `VS_*` or `Speech_*`).

| Token | |
|---|---|
| `hello` | English word |
| `/HH AH0 L OW1/` | ARPAbet word; `:n` frames per sound, stress 0–2 |
| `\HE \EH \LE \OWWW` | SpeakJet codes (mnemonics or 128–199); a run is one word |
| `^c0` … `^c7` | voice: pitch and speed (default 76–136 Hz) |
| `^c?` | random voice, drawn per play |
| `,:n` | n frames silence, 1–62 (50 fps) |
| `{a b\|c}` | one alternative at random, ≤ 32 |
| `@word = …` | a word's pronunciation (English, `/…/`, SpeakJet, `word#n`) and `*length` (0.25–4) |
| `#speed x` | all lengths ÷ x (0.5–2) |
| `#voices lo hi` | voice 0..7 pitches, geometric lo..hi Hz (30–600) |
| `#voicespeed flat` | voices change pitch only, not speed |

Limits: 64 distinct words. Pitch is per voice only: `@pitch` inside phonemes
is dropped (warned). To step pitch inside a word, split it into groups with a
voice before each; `Say_Game` in `example/phrases.txt` does this to match the
film's cadence.

English: CMU dictionary, then known word + ending (-s, -ed, -ing, -er, -ly,
…), then two known words joined, then letter rules (reported as guessed).
Heteronyms take the common reading; `word#n` picks the dictionary's n-th.

SpeakJet: each allophone maps to the nearest VTX phoneme (one or two).
`\P0`–`\P6` and `\DELAY n` are pauses; `\FAST`/`\SLOW` scale the next sound
×0.5/×1.5; `\STRESS`/`\RELAX` lengthen/shorten the next vowel; `\PITCH n` (Hz)
becomes the nearest voice, splitting the run there (use `#voicespeed flat`);
`\SPEED` is dropped (warned); `\VOLUME`, `\BEND` etc. are ignored; sound
effects (200–254) are an error. Mapping: `vtxspeech/speakjet.py`.

## Export

```powershell
python vectrex/editor.py phrases.txt                                   # editor (browser)
python vectrex/export.py phrases.txt game/speech_data.asm --player     # CLI; --player copies vtx_speech.asm too
python vectrex/mame_check.py phrases.txt [--mame path]                 # verify in MAME
```

The editor's Export writes `speech_data.asm` and `vtx_speech.asm` beside the
phrase file (an existing, different `vtx_speech.asm` is kept). Build test
cartridge assembles `speech_test/speech_test.bin`: button 1 next phrase,
button 2 again. Run in MAME opens it (MAME default keys: Left Ctrl, Left Alt).
Check in MAME runs every phrase twice headless and compares the AY registers
frame by frame, and checks A/B are silent after each phrase. Saves keep the
old file in `.editor_backups`.

MAME 0.227+ and `vectrex.zip` are needed for the MAME features. MAME is found
via the saved location (`~/.vtx_speech.json`), `MAME_PATH`, `PATH`, then common
install folders; otherwise the editor asks once. Building needs Windows (AS09).

The website's exporter writes the same file; in Chrome/Edge it can save into
a folder, elsewhere it downloads.

## Using it

```asm
VS_RAM   equ  $CA80          ; 22 bytes
VS_DUCK  equ  4              ; channel C volume reduction while speaking (0 = none)
         include "vtx_speech.asm"
         include "speech_data.asm"

         jsr  Speech_Init     ; once
         ldx  #Say_Hello      ; start a phrase (replaces any playing)
         jsr  Speech_Say
; each frame, after your sound code fills Vec_Music_Work:
         jsr  Speech_Service
         jsr  Do_Sound        ; DP = $D0
```

| Routine | |
|---|---|
| `Speech_Init` | once |
| `Speech_Say` | X = phrase; starts at the next service |
| `Speech_Busy` | Z = 1 when silent |
| `Speech_Stop` | silence now |
| `Speech_Service` | once per frame |
| `Speech_Wait_Recal` | optional `Wait_Recal` replacement: steps speech by the 50 Hz frames that passed (VIA T2), for games that run late |

All routines may clobber A, B, X; DP is preserved, any value on entry.

AY use while speaking: R0–R3, R6, R8, R9, R11–R13 and the A/B bits of R7.
C (R4, R5, R10, C's R7 bits) is kept, reduced by `VS_DUCK`. At the end of a
phrase, or on `Speech_Stop`, A and B are disabled in the mixer and set to
volume 0. Don't use A, B or the envelope for effects while a phrase plays.

Build the example: `cd vectrex\example` then `..\as09\as09_14.exe -l example.asm`.

## Verification

- Python and JS exporters: identical output; byte-identical to the VTX
  exporter on the Verzerk phrase set (`test/test_export_python.py`,
  `test/vectrex_export.test.js`).
- Player (AS09 build) in MAME vs the reference player, every frame: Verzerk
  set ×3, 3,733 frames, 0 mismatches; also with `#voices`/`#speed` (3,157)
  and `#voices`/`#voicespeed flat` (4,377); SpeakJet `\PITCH` phrases (540);
  the example (992). `dev/vectrex_check.py`, `mame_check.py`.
- Not yet heard on real hardware.

MIT (`../LICENSE`). AS09 and the CMU dictionary keep their own terms
(`../NOTICE.md`).

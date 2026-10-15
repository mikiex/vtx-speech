"""Is the standalone Vectrex player exact? A MAME check against the reference.

    python dev/vectrex_check.py C:/path/to/VXT_VSCodeProject [phrases.txt] [settings lines]

With a phrase file, its phrases are played instead of the Verzerk set.

With settings (for example "#voices 70 160" "#speed 1.2") they are added to
the phrase set, and the reference is the editor's host player (word_track's
player with the settings' voice table).

Builds a test cartridge with AS09 around vectrex/vtx_speech.asm and the data
the site's exporter makes from the Verzerk phrase set (the export fixture:
words, random voices, alternatives, pauses). In MAME it says every phrase
three times, one Speech_Service per 50 Hz frame, and logs the registers the
player put in the BIOS sound buffer after every service, the random bytes it
drew and whether it restarted the envelope. Every frame must equal the VTX
project's host player (tools/vtx_speech/word_track.play) for the same bytes
and random draws. Also measures one service's cycles.

Needs the VTX project (its MAME runner, as09_14.exe and word_track) and
MAME. Writes build/vectrex_check/report.json.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
VTX = Path(sys.argv[1]).resolve()
PHRASES = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 and sys.argv[2].endswith(".txt") else None
SETTINGS = sys.argv[3:] if PHRASES else sys.argv[2:]
for d in (VTX, VTX / "src"):
    sys.path.insert(0, str(d))
sys.path.insert(0, str(HERE / "vectrex"))

from src.emulator import MameRunner  # noqa: E402
from tools.vtx_speech import word_track as W  # noqa: E402

WORK = HERE / "build" / "vectrex_check"
REGS = range(0xC83F, 0xC84D)                     # Vec_Music_Work: R13 .. R0
PASSES = 3


def compile_fixture() -> dict:
    """The site's exporter on the fixture's phrases: bytes as JSON, and the AS09 data."""
    script = r"""
const fs = require("fs"), zlib = require("zlib"), path = require("path");
const root = process.argv[1];
const Speech = require(path.join(root, "js", "speech.js")), Export = require(path.join(root, "js", "vectrex_export.js"));
Speech.loadDictionary(zlib.gunzipSync(fs.readFileSync(path.join(root, "vendor", "cmudict.dict.gz"))).toString("utf8"));
const fixture = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "vectrex_export.json"), "utf8"));
const c = Export.compile(process.argv[3] + "\n" + (process.argv[4] ? fs.readFileSync(process.argv[4], "utf8") : fixture.source));
if (c.problems.length) { console.error(c.problems.join("\n")); process.exit(1); }
fs.writeFileSync(process.argv[2], Export.toAsm(c, "the Verzerk phrase set (dev/vectrex_check.py)"));
console.log(JSON.stringify({ noises: c.noises, words: c.words, seqs: c.seqs.map((s) => ({ label: s.label, bytes: s.bytes })),
  phrases: c.phrases, clock_ep: c.clockEp, clock_scale: c.clockScale }));
"""
    WORK.mkdir(parents=True, exist_ok=True)
    out = subprocess.run(["node", "-e", script, str(HERE), str(WORK / "speech_data.asm"), "\n".join(SETTINGS),
                          str(PHRASES or "")],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def cart(labels: list[str]) -> str:
    table = "\n".join(f"        fdb     {label}" for label in labels)
    return f"""; Test cartridge for dev/vectrex_check.py: says every phrase in turn.
Wait_Recal      equ    $F192
Do_Sound        equ    $F289
Vec_Music_Work  equ    $C83F
VS_RAM          equ    $C880
VS_DUCK         equ    0
vtNext          equ    $C8A0
vtCount         equ    $C8A2

        org    0
        fcc    "g GCE 2026"
        fcb    $80
        fdb    $FD0D
        fcb    $F8,$50,$20,-$56
        fcc    "SPEECH CHECK"
        fcb    $80
        fcb    0
        ldx    #Vec_Music_Work
        ldb    #14
vt_clear:
        clr    ,x+
        decb
        bne    vt_clear
        lda    #$3F
        sta    Vec_Music_Work+6
        jsr    Speech_Init
        ldx    #VT_List
        stx    vtNext
        ldd    #0
        std    vtCount
vt_loop:
        jsr    Wait_Recal
        jsr    Speech_Busy
        bne    vt_play
        ldx    vtNext
        ldd    ,x++
        bne    vt_start
        ldx    #VT_List
        ldd    ,x++
vt_start:
        stx    vtNext
        tfr    d,x
        jsr    Speech_Say
vt_play:
        jsr    Speech_Service
vt_logged:
        ldd    vtCount
        addd   #1
        std    vtCount
        jsr    Do_Sound
        bra    vt_loop

VT_List:
{table}
        fdb    0

        include "{(HERE / 'vectrex' / 'vtx_speech.asm').as_posix()}"
        include "speech_data.asm"
"""


def symbol(lst: str, name: str) -> int:
    m = re.search(rf"^\s*{re.escape(name)}\s*:\s*\$([0-9A-Fa-f]{{4}})", lst, re.M)
    if not m:
        raise SystemExit(f"no symbol {name} in the listing")
    return int(m[1], 16)


def main() -> None:
    c = compile_fixture()
    alts = [bytes(s["bytes"]) for s in c["seqs"]]
    words = [bytes(w) for w in c["words"]]
    noises = [tuple(n) for n in c["noises"]]
    items = [(p["label"], alts[p["seq"]], p["text"]) for p in c["phrases"]]
    (WORK / "check.asm").write_text(cart([label for label, _, _ in items]), encoding="ascii")
    shutil.copy(VTX / "as09_14.exe", WORK / "as09_14.exe")
    built = subprocess.run([str(WORK / "as09_14.exe"), "-w200", "-h0", "-l", "-mctiz", "check.asm"],
                           cwd=WORK, capture_output=True, text=True)
    lst_path = WORK / "check.lst"
    if not (WORK / "check.bin").exists() or "No errors in pass 2" not in lst_path.read_text(errors="replace"):
        raise SystemExit("AS09 failed:\n" + built.stdout[-2000:] + built.stderr[-2000:])
    lst = lst_path.read_text(errors="replace")
    a = {n: symbol(lst, n) for n in ("vt_play", "vt_logged", "vtCount", "VS_Busy", "VS_Clock", "VS_Head",
                                    "VS_Random_Got", "VS_RAM", "VS_Tone", "VS_Clock_EP", "Speech_Service")}
    state = a["VS_RAM"] + 20
    nl = chr(92) + "n"
    regs = "".join(f",b@{r:X}" for r in REGS)
    (WORK / "debug.txt").write_text(
        f'bp ${a["vt_play"]:04X},1,{{ temp1=totalcycles ; g }}\n'
        f'bp ${a["vt_logged"]:04X},1,{{ logerror "VS %d %04X %02X %02X %02X {"%02X" * 14} %d{nl}",'
        f'w@{a["vtCount"]:X},w@{state:X},b@{a["VS_Clock"]:X},b@{a["VS_Head"]:X},b@C80D{regs},totalcycles-temp1 ; g }}\n'
        f'bp ${a["VS_Random_Got"]:04X},1,{{ logerror "R %02X{nl}",a ; g }}\n'
        "go\n", encoding="ascii")
    rough = sum(len(W.play(b, words, noises, iter([0] * 64), alts)) + 1 for _, b, _ in items)
    frames_60 = rough * 2 * PASSES + 600
    (WORK / "stop.lua").write_text(f"""local n=0
emu.register_frame_done(function()
  n=n+1
  if n>={frames_60} then manager.machine:exit() end
end)
""", encoding="utf-8")
    wav = WORK / "check.wav"
    result = MameRunner(headless=True, seconds_to_run=frames_60 // 60 + 60, extra_args=(
        "-debug", "-oslog", "-debugscript", str(WORK / "debug.txt"),
        "-autoboot_script", str(WORK / "stop.lua"), "-wavwrite", str(wav))).run(WORK / "check.bin")
    text = (result.stdout or "") + (result.stderr or "")
    segments, current = [], {"randoms": [], "services": []}
    for m in re.finditer(r"^R ([0-9A-F]{2})|^VS (\d+) ([0-9A-F]{4}) ([0-9A-F]{2}) ([0-9A-F]{2}) ([0-9A-F]{2}) "
                         r"([0-9A-F]{28}) (\d+)", text, re.M):
        if m[1]:
            current["randoms"].append(int(m[1], 16))
            continue
        work = bytes.fromhex(m[7])                       # R13 .. R0
        entry = {"busy": int(m[3], 16) == a["VS_Busy"], "regs": [work[13 - r] for r in range(14)],
                 "restart": int(m[6], 16) == 0xFF, "cycles": int(m[8])}
        if entry["busy"]:
            current["services"].append(entry)
        else:
            segments.append(current)
            current = {"randoms": [], "services": []}
    mismatches, first, compared, played = 0, None, 0, 0
    for k, seg in enumerate(segments[:len(items) * PASSES]):
        label, data, phrase = items[k % len(items)]
        if SETTINGS or PHRASES:      # the editor's host player: word_track's, with the settings' voice table
            import editor
            want = editor.play({"words": words, "noises": noises, "clock_ep": c["clock_ep"], "clock_scale": c["clock_scale"]},
                               data, alts, iter(seg["randoms"]))
        else:
            want = W.play(data, words, noises, iter(seg["randoms"]), alts)
        got = seg["services"]
        played += 1
        for i in range(max(len(want), len(got))):
            w = want[i] if i < len(want) else None
            g = got[i] if i < len(got) else None
            ok = bool(w and g) and all(w["regs"][r] == g["regs"][r] for r in (0, 1, 2, 3, 6, 8, 9, 11, 12, 13)) \
                and w["regs"][7] & 0x1B == g["regs"][7] & 0x1B and w["shape"] == g["restart"]
            compared += 1
            if not ok:
                mismatches += 1
                first = first or {"phrase": f"{label}: {phrase}", "frame": i, "expected": w and w["regs"],
                                  "mame": g and g["regs"]}
    cycles = sorted(e["cycles"] for seg in segments for e in seg["services"])
    report = {
        "assembler": "AS09 1.42", "rom_bytes": (WORK / "check.bin").stat().st_size,
        "player_bytes": a["VS_Clock_EP"] - a["VS_Busy"],
        "phrases_played": played, "of": len(items) * PASSES, "frames_compared": compared, "mismatches": mismatches,
        "first_mismatch": first,
        "service_cycles": {"mean": round(sum(cycles) / len(cycles), 1) if cycles else None,
                           "p95": cycles[int(len(cycles) * 0.95)] if cycles else None,
                           "max": cycles[-1] if cycles else None},
        "settings": SETTINGS, "phrases": str(PHRASES) if PHRASES else "the Verzerk phrase set",
        "reference": ("vectrex/editor.py play (word_track with the settings' voice table)" if SETTINGS or PHRASES
                      else "VTX tools/vtx_speech/word_track.play") + " on the same bytes and random draws",
        "wav": str(wav.relative_to(HERE)) if wav.exists() else None,
    }
    (WORK / "report.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=1))
    sys.exit(1 if mismatches or played < len(items) * PASSES else 0)


if __name__ == "__main__":
    main()

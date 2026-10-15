"""Check phrases on the emulated cartridge: does the Vectrex player say
exactly what the editor plays?

    python vectrex/mame_check.py phrases.txt [--mame path/to/mame] [--passes 2]

Builds a test cartridge with the bundled AS09 (Windows) that says every
phrase in turn, runs it in MAME with the debugger logging the sound chip's
registers after every frame (and the random bytes the cartridge draws), and
compares each frame with the editor's player (editor.play) for the same
random draws. Needs MAME 0.227 or newer and the Vectrex system ROM
(vectrex.zip) where MAME can find it.

Finding MAME, in order: a location saved earlier (~/.vtx_speech.json, set
with --mame or in the editor), the MAME_PATH environment variable, mame or
mame64 on the PATH, then common install folders.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import export as E  # noqa: E402

SETTINGS_FILE = Path.home() / ".vtx_speech.json"
AS09 = HERE / "as09" / "as09_14.exe"
MIN_VERSION = (0, 227)                      # the Lua API used (manager.machine) and frame hooks
REGS = range(0xC83F, 0xC84D)                # Vec_Music_Work: R13 .. R0
COMMON = [
    r"C:\mame\mame.exe", r"C:\Program Files\MAME\mame.exe", r"C:\Program Files (x86)\MAME\mame.exe",
    "/Applications/mame/mame", "/Applications/MAME.app/Contents/MacOS/mame", "/opt/homebrew/bin/mame",
    "/usr/local/bin/mame", "/usr/games/mame", "/usr/bin/mame",
]


# --- finding MAME --------------------------------------------------------------------
def _settings() -> dict:
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def candidates() -> list[tuple[str, str]]:
    """(path, where it came from) in the order they are tried."""
    out = []
    saved = _settings().get("mame")
    if saved:
        out.append((saved, "saved"))
    if os.environ.get("MAME_PATH"):
        out.append((os.environ["MAME_PATH"], "MAME_PATH"))
    for name in ("mame", "mame64"):
        found = shutil.which(name)
        if found:
            out.append((found, "PATH"))
    out += [(p, "common folder") for p in COMMON if Path(p).exists()]
    return out


def version(path: str) -> tuple[int, ...] | None:
    """MAME's version, (0, 287) for "0.287 (mame0287)", or None if it doesn't run."""
    try:
        r = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.match(r"\s*(\d+)\.(\d+)", r.stdout or "")
    return (int(m[1]), int(m[2])) if m else None


def find() -> dict:
    """{found, path, version, source} or {found: False, problem}."""
    tried = []
    for path, source in candidates():
        v = version(path)
        tried.append(path)
        if v is None:
            continue
        if v < MIN_VERSION:
            return {"found": False, "path": path, "version": ".".join(map(str, v)),
                    "problem": f"MAME {'.'.join(map(str, v))} at {path} is too old: the check needs 0.227 or newer"}
        return {"found": True, "path": path, "version": ".".join(map(str, v)), "source": source}
    return {"found": False, "problem": "MAME not found" + (f" (tried {', '.join(tried)})" if tried else "")
            + ": give its location (mame.exe, or mame on macOS and Linux)"}


def remember(path: str) -> dict:
    """Check ``path`` runs and is new enough, then save it for next time."""
    v = version(path)
    if v is None:
        return {"found": False, "problem": f"{path} does not run as MAME (mame -version gave nothing)"}
    if v < MIN_VERSION:
        return {"found": False, "problem": f"MAME {'.'.join(map(str, v))} is too old: the check needs 0.227 or newer"}
    s = _settings()
    s["mame"] = str(Path(path).resolve())
    SETTINGS_FILE.write_text(json.dumps(s, indent=1) + "\n", encoding="utf-8")
    return {"found": True, "path": s["mame"], "version": ".".join(map(str, v)), "source": "saved"}


# --- the test cartridge -----------------------------------------------------------------
def _cart(labels: list[str]) -> str:
    table = "\n".join(f"        fdb     {label}" for label in labels)
    return f"""; Test cartridge made by vectrex/mame_check.py: says every phrase in turn.
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

        include "vtx_speech.asm"
        include "speech_data.asm"
"""


def _symbol(listing: str, name: str) -> int:
    m = re.search(rf"^\s*{re.escape(name)}\s*:\s*\$([0-9A-Fa-f]{{4}})", listing, re.M)
    if not m:
        raise RuntimeError(f"no symbol {name} in the listing")
    return int(m[1], 16)


def check(source: str, mame: str | None = None, passes: int = 2, work: Path | None = None) -> dict:
    """Build, run and compare. Returns a report: {ok, phrases_played, frames_compared,
    mismatches, first_mismatch, cycles, problems}."""
    import editor                                        # the host player (the same one the editor plays)
    c = E.compile_phrases(source)
    if c["problems"]:
        return {"ok": False, "problems": c["problems"]}
    if not c["phrases"]:
        return {"ok": False, "problems": ["there are no phrases to check"]}
    if not (AS09.exists() and sys.platform == "win32"):
        return {"ok": False, "problems": ["building the test cartridge needs Windows (the bundled AS09 is a Windows program)"]}
    m = {"found": True, "path": mame} if mame else find()
    if not m["found"]:
        return {"ok": False, "problems": [m["problem"]], "mame": m}
    temp = None
    if work is None:
        temp = tempfile.TemporaryDirectory(prefix="vtx-speech-check-")
        work = Path(temp.name)
    try:
        work.mkdir(parents=True, exist_ok=True)
        shutil.copy(HERE / "vtx_speech.asm", work / "vtx_speech.asm")
        (work / "speech_data.asm").write_text(E.to_asm(c, "vectrex/mame_check.py"), encoding="utf-8")
        labels = [p["label"] for p in c["phrases"]]
        (work / "check.asm").write_text(_cart(labels), encoding="ascii")
        subprocess.run([str(AS09), "-w200", "-h0", "-l", "-mctiz", "check.asm"], cwd=work, capture_output=True, text=True)
        listing = (work / "check.lst").read_text(errors="replace") if (work / "check.lst").exists() else ""
        if "No errors in pass 2" not in listing or not (work / "check.bin").exists():
            return {"ok": False, "problems": ["AS09 could not build the test cartridge"]
                    + [l for l in listing.splitlines() if "rror" in l][:6]}
        a = {n: _symbol(listing, n) for n in ("vt_play", "vt_logged", "vtCount", "VS_Busy", "VS_Clock", "VS_Head",
                                             "VS_Random_Got", "VS_RAM")}
        state = a["VS_RAM"] + 20
        nl = chr(92) + "n"
        regs = "".join(f",b@{r:X}" for r in REGS)
        (work / "debug.txt").write_text(
            f'bp ${a["vt_play"]:04X},1,{{ temp1=totalcycles ; g }}\n'
            f'bp ${a["vt_logged"]:04X},1,{{ logerror "VS %d %04X %02X %02X %02X {"%02X" * 14} %d{nl}",'
            f'w@{a["vtCount"]:X},w@{state:X},b@{a["VS_Clock"]:X},b@{a["VS_Head"]:X},b@C80D{regs},totalcycles-temp1 ; g }}\n'
            f'bp ${a["VS_Random_Got"]:04X},1,{{ logerror "R %02X{nl}",a ; g }}\n'
            "go\n", encoding="ascii")
        alts = [s["bytes"] for s in c["seqs"]]
        items = [(p["label"], alts[p["seq"]]) for p in c["phrases"]]
        # How long to run: every phrase (longest choices) plus an idle frame each, twice for 60 Hz.
        rough = sum(len(editor.play(c, data, alts, iter([255] * 256))) + 1 for _, data in items)
        frames_60 = rough * 2 * passes + 900
        (work / "stop.lua").write_text(
            "local n=0\nemu.register_frame_done(function()\n  n=n+1\n"
            f"  if n>={frames_60} then manager.machine:exit() end\nend)\n", encoding="utf-8")
        command = [m["path"], "vectrex", "-cart", str(work / "check.bin"), "-skip_gameinfo",
                   "-video", "none", "-sound", "none", "-nothrottle", "-seconds_to_run", str(frames_60 // 60 + 60),
                   "-debug", "-oslog", "-debugscript", str(work / "debug.txt"), "-autoboot_script", str(work / "stop.lua")]
        roms = Path(m["path"]).parent / "roms"
        if roms.exists():
            command += ["-rompath", str(roms)]
        try:
            run = subprocess.run(command, cwd=work, capture_output=True, text=True, timeout=frames_60 // 60 + 300)
        except subprocess.TimeoutExpired:
            return {"ok": False, "problems": ["MAME did not finish in time"]}
        text = (run.stdout or "") + (run.stderr or "")
        if re.search(r"required files are missing|vectrex\.zip.*NOT FOUND|NOT FOUND.*vectrex", text, re.I):
            return {"ok": False, "problems": [f"MAME is missing the Vectrex system ROM (vectrex.zip): put it in "
                                              f"{roms if roms.exists() else 'a folder on MAME rompath'}"]}
        return _compare(text, a["VS_Busy"], items, c, alts, passes, editor)
    finally:
        if temp:
            temp.cleanup()


def _compare(text: str, busy: int, items: list, c: dict, alts: list, passes: int, editor) -> dict:
    segments, current = [], {"randoms": [], "services": []}
    for m in re.finditer(r"^R ([0-9A-F]{2})|^VS (\d+) ([0-9A-F]{4}) ([0-9A-F]{2}) ([0-9A-F]{2}) ([0-9A-F]{2}) "
                         r"([0-9A-F]{28}) (\d+)", text, re.M):
        if m[1]:
            current["randoms"].append(int(m[1], 16))
            continue
        work = bytes.fromhex(m[7])                       # R13 .. R0
        entry = {"busy": int(m[3], 16) == busy, "regs": [work[13 - r] for r in range(14)],
                 "restart": int(m[6], 16) == 0xFF, "cycles": int(m[8])}
        if entry["busy"]:
            current["services"].append(entry)
        else:                                            # the service that ends a phrase (or an idle one)
            current["end"] = entry
            segments.append(current)
            current = {"randoms": [], "services": []}
    if not segments:
        return {"ok": False, "problems": ["MAME ran but logged nothing: is the debugger available in this MAME build?"],
                "log_tail": text[-1500:]}
    mismatches, first, compared, played = 0, None, 0, 0
    per = {}
    for k, seg in enumerate(segments[:len(items) * passes]):
        label, data = items[k % len(items)]
        want = editor.play(c, data, alts, iter(seg["randoms"]))
        got = seg["services"]
        played += 1
        bad = 0
        for i in range(max(len(want), len(got))):
            w = want[i] if i < len(want) else None
            g = got[i] if i < len(got) else None
            ok = bool(w and g) and all(w["regs"][r] == g["regs"][r] for r in (0, 1, 2, 3, 6, 8, 9, 11, 12, 13)) \
                and w["regs"][7] & 0x1B == g["regs"][7] & 0x1B and w["shape"] == g["restart"]
            compared += 1
            if not ok:
                bad += 1
                first = first or {"phrase": label, "frame": i, "expected": w and w["regs"], "cartridge": g and g["regs"]}
        mismatches += bad
        per.setdefault(label, {"plays": 0, "frames": 0, "mismatches": 0})
        per[label]["plays"] += 1
        per[label]["frames"] += len(want)
        per[label]["mismatches"] += bad
    # After a phrase, A and B must be silent: off in the mixer and at volume 0
    # (a volume left following the envelope would keep buzzing).
    not_silent = [items[k % len(items)][0] for k, seg in enumerate(segments[:len(items) * passes])
                  if seg.get("end") and not (seg["end"]["regs"][7] & 0x1B == 0x1B
                                             and seg["end"]["regs"][8] == 0 and seg["end"]["regs"][9] == 0)]
    cycles = sorted(e["cycles"] for seg in segments for e in seg["services"])
    complete = played >= len(items) * passes
    problems = [] if complete else [f"only {played} of {len(items) * passes} phrase plays were logged"]
    if not_silent:
        problems.append(f"not silent after: {', '.join(sorted(set(not_silent)))} (channel A or B still sounds)")
    return {"ok": mismatches == 0 and complete and not not_silent, "phrases_played": played, "of": len(items) * passes,
            "silent_after_every_phrase": not not_silent,
            "frames_compared": compared, "mismatches": mismatches, "first_mismatch": first, "per_phrase": per,
            "cycles": {"mean": round(sum(cycles) / len(cycles), 1), "max": cycles[-1]} if cycles else None,
            "problems": problems}


def launch(cartridge: Path, mame: str | None = None) -> dict:
    """Open ``cartridge`` in a MAME window with sound, at normal speed, and
    return at once (MAME keeps running): {started, pid, mame} or {problems}."""
    m = {"found": True, "path": mame} if mame else find()
    if not m["found"]:
        return {"started": False, "problems": [m["problem"]], "mame": m}
    if not Path(cartridge).exists():
        return {"started": False, "problems": [f"no cartridge at {cartridge}"]}
    command = [m["path"], "vectrex", "-cart", str(cartridge), "-window", "-skip_gameinfo"]
    roms = Path(m["path"]).parent / "roms"
    if roms.exists():
        command += ["-rompath", str(roms)]
    try:   # MAME writes its cfg/ beside the cartridge, not in the current folder
        process = subprocess.Popen(command, cwd=Path(cartridge).parent,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as error:
        return {"started": False, "problems": [f"could not start MAME: {error}"]}
    return {"started": True, "pid": process.pid, "mame": m["path"]}


def main() -> None:
    parser = argparse.ArgumentParser(description="Check phrases on the emulated cartridge (MAME)")
    parser.add_argument("phrases", help="the phrase file")
    parser.add_argument("--mame", help="MAME's location (remembered for next time)")
    parser.add_argument("--passes", type=int, default=2, help="times through every phrase (random choices differ)")
    args = parser.parse_args()
    if args.mame:
        r = remember(args.mame)
        if not r["found"]:
            sys.exit(r["problem"])
    found = find()
    if not found["found"]:
        sys.exit(found["problem"])
    print(f"MAME {found['version']} at {found['path']} ({found['source']})")
    report = check(Path(args.phrases).read_text(encoding="utf-8"), found["path"], args.passes)
    if report.get("problems"):
        print("\n".join(report["problems"]))
    if "frames_compared" in report:
        print(f"{report['phrases_played']} of {report['of']} phrase plays, {report['frames_compared']} frames compared, "
              f"{report['mismatches']} mismatches" + (f"; cycles a frame mean {report['cycles']['mean']}, max "
                                                      f"{report['cycles']['max']}" if report.get("cycles") else ""))
        if report["first_mismatch"]:
            print("first mismatch:", json.dumps(report["first_mismatch"]))
    print("OK: the cartridge says exactly what the editor plays" if report["ok"] else "NOT OK")
    sys.exit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()

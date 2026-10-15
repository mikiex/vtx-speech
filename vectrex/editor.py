"""VTX Speech editor: a local web page for a Vectrex game's phrases.

    python vectrex/editor.py [phrases.txt] [--port 8768] [--no-browser]

Edit the phrases and words, hear each phrase exactly as the cartridge player
says it, then save the phrase file, export speech_data.asm next to it, or
build a test cartridge with the bundled AS09 (Windows). Standard library
only; the server listens on 127.0.0.1. The phrase file (default phrases.txt
in the current folder, made from the example if it does not exist) is the
only thing it edits; the old file is kept in an .editor_backups folder beside it.

Endpoints (JSON):
- GET  /api/project        {path, source, data path, report}
- POST /api/compile        {source} -> report: phrases, words (as pronounced), sizes, problems
- POST /api/frames         {source, label | word, voice (0..7 or "random")} -> the player's frames
- POST /api/convert        {text, mode, to: "phonemes" | "speakjet"} -> {text}: for switching an entry's mode
- POST /api/save           {source}: write the phrase file
- POST /api/export         {source}: save, then write speech_data.asm beside it
- POST /api/build          {source}: save, export, and assemble a test cartridge with AS09
- GET  /api/mame           where MAME is (vectrex/mame_check.py finds it), or why not
- POST /api/mame           {path}: use (and remember) this MAME
- POST /api/run            {source}: build the test cartridge and open it in a MAME window
- POST /api/check          {source}: say every phrase on the emulated cartridge in MAME and
                           compare every frame with what the editor plays
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import export as E  # noqa: E402
import mame_check  # noqa: E402
from vtxspeech import pronounce as PR, speakjet as SJ, word_track as W  # noqa: E402

STATIC = {
    "/": (HERE / "editor_ui" / "index.html", "text/html; charset=utf-8"),
    "/editor.js": (HERE / "editor_ui" / "editor.js", "text/javascript; charset=utf-8"),
    "/editor.css": (HERE / "editor_ui" / "editor.css", "text/css; charset=utf-8"),
    "/render.js": (ROOT / "js" / "render.js", "text/javascript; charset=utf-8"),
    "/ayumi.js": (ROOT / "vendor" / "ayumi.js", "text/javascript; charset=utf-8"),
}
AS09 = HERE / "as09" / "as09_14.exe"


class Project:
    def __init__(self, path: Path):
        self.path = path
        if not path.exists():
            shutil.copy(HERE / "example" / "phrases.txt", path)

    @property
    def data_path(self) -> Path:
        return self.path.with_name("speech_data.asm")

    def save(self, source: str) -> None:
        if self.path.exists() and self.path.read_text(encoding="utf-8") != source:
            backups = self.path.parent / ".editor_backups"
            backups.mkdir(exist_ok=True)
            shutil.copy(self.path, backups / f"{self.path.stem}_{time.strftime('%Y%m%d_%H%M%S')}{self.path.suffix}")
        self.path.write_text(source, encoding="utf-8", newline="\n")


def word_mode(name: str, say: str) -> str:
    """How a word is written: "speakjet", "phonemes" or "english"."""
    if SJ.is_speakjet(say):
        return "speakjet"
    if say.startswith("/"):
        return "phonemes"
    return "english"


def report(source: str) -> dict:
    """What the page shows: problems, or the phrases, words, settings and sizes."""
    c = E.compile_phrases(source)
    if c["problems"]:
        return {"problems": c["problems"]}
    _, overrides, _, settings = E.parse(source)
    speed = settings.get("speed", 1.0)
    words = []
    for n, data in zip(c["names"], c["words"]):
        w = overrides.get(n, {"say": n, "length": 1.0})
        mode, variants, choice = word_mode(n, w["say"]), 1, 1
        if mode == "speakjet":
            phonemes, how = SJ.to_phonemes(w["say"]), "SpeakJet"
        elif mode == "phonemes":
            phonemes, how = w["say"][1:-1].strip().upper(), "phonemes"
        else:
            _, said = PR.parse_text(w["say"])
            phonemes = " ".join(p for s in said for p in s["phonemes"])
            how = ", ".join(sorted({s["how"] for s in said}))
            if len(said) == 1 and said[0]["how"] == "dictionary":
                variants, choice = said[0]["variants"], said[0]["choice"]
        words.append({"name": n, "say": w["say"], "length": w["length"], "custom": n in overrides,
                      "inline": n.startswith(("\\", "/")), "mode": mode,
                      "phonemes": phonemes, "how": how, "variants": variants, "choice": choice,
                      "frames": len(E.word_states(w["say"], w["length"], speed)), "bytes": len(data)})
    phrases = [{"label": p["label"], "text": p["text"], "bytes": len(c["seqs"][p["seq"]]["bytes"])} for p in c["phrases"]]
    word_bytes = sum(len(w) for w in c["words"])
    seq_bytes = sum(len(s["bytes"]) for s in c["seqs"])
    tables = 16 + 2 * len(c["names"]) + 2 * len(c["noises"])
    return {"problems": [], "warnings": c["warnings"], "phrases": phrases, "words": words, "settings": settings,
            "voices": [round(f, 1) for f in E.voice_pitches(settings)],
            "sizes": {"words": word_bytes, "phrases": seq_bytes, "tables": tables, "total": word_bytes + seq_bytes + tables}}


def play(c: dict, phrase: bytes, alts: list[bytes], draws) -> list[dict]:
    """The cartridge's frames for a phrase: word_track.play, with the voice
    table of the settings (#voices) and, for the picture, which word each
    frame belongs to. ``draws``: the random bytes, in order."""
    words, noises, ep_table = c["words"], [tuple(n) for n in c["noises"]], c["clock_ep"]
    scale = c.get("clock_scale", E.CLOCK_SCALE)      # the player: frames = max(1, (n * S + 64) >> 7)
    seq, clock, data, i, back = [], 0, phrase, 0, None
    while True:
        b = data[i]
        i += 1
        if b == E.END:
            if back is None:
                break
            data, i, back = back[0], back[1], None
        elif b == E.RANDOM_CLOCK:
            clock = next(draws) & 7
        elif b in (E.CHOOSE, 0x8A):
            n = data[i]
            refs = [data[i + 1 + 2 * k] << 8 | data[i + 2 + 2 * k] for k in range(n)]
            ref = refs[(next(draws) * n) >> 8]
            if b == E.CHOOSE:
                back = (data, i + 1 + 2 * n)
            data, i = alts[ref], 0
        elif E.CLOCK <= b < E.CLOCK + 8:
            clock = b - E.CLOCK
        elif b > E.PAUSE:
            seq += [((0, None, 0, 0), clock, None)] * (b - E.PAUSE)
        elif b < 0x80:
            for state, n in W.decode_word(words[b], noises):
                seq += [(state, clock, b)] * max(1, (n * scale[clock] + 64) >> 7)
    out, voiced_before = [], False
    for state, clock, word in seq:
        voiced = state[0] != 0
        kind, _, q1, q2 = state
        targets = [q1 * 16] + ([q2 * 16] if kind in (1, 2) else []) if kind else []
        out.append({"regs": W.registers(state, ep_table[clock]), "shape": voiced and not voiced_before,
                    "clock": clock, "word": word, "targets": targets, "noise": state[1] is not None})
        voiced_before = voiced
    return out


def _fixed_voice(items: list, voice) -> list:
    """The items with every random voice ($88) set to ``voice`` (0..7), or as they are."""
    if voice == "random":
        return items
    return [E.CLOCK + int(voice) if it == E.RANDOM_CLOCK else it for it in items]


def frames(body: dict) -> dict:
    c = E.compile_phrases(body.get("source", ""))
    if c["problems"]:
        return {"problems": c["problems"]}
    voice = body.get("voice", 3)
    seqs = [{"items": _fixed_voice(s["items"], voice)} for s in c["seqs"]]
    as_bytes = lambda items: bytes(b for it in items for b in ([it] if isinstance(it, int) else [it[1] >> 8, it[1] & 0xFF]))  # noqa: E731
    alts = [as_bytes(s["items"]) for s in seqs]
    if body.get("word"):
        if body["word"] not in c["names"]:
            return {"problems": [f'"{body["word"]}" is not a word of the phrases']}
        clock = 3 if voice == "random" else int(voice)
        phrase = bytes([E.CLOCK + clock, c["names"].index(body["word"]), E.END])
    else:
        match = [p for p in c["phrases"] if p["label"] == body.get("label")]
        if not match:
            return {"problems": [f'no phrase "{body.get("label")}"']}
        phrase = alts[match[0]["seq"]]
    draws = iter(random.randrange(256) for _ in range(256))
    return {"frames": play(c, phrase, alts, draws), "names": c["names"]}


def convert(body: dict) -> dict:
    """Convert an entry's text between ways of writing it, for switching its
    mode: {text, mode: "english" | "phonemes" | "speakjet", to: "phonemes" |
    "speakjet"} -> {text}. Phonemes are a group per word ("HH AH0 L OW1 | W
    ER1 L D"); SpeakJet codes come from the phonemes (nearest allophones).
    Nothing converts back to English: the page keeps a phrase's English."""
    text, mode, to = body.get("text", ""), body.get("mode", "english"), body.get("to", "phonemes")
    try:
        if mode == "speakjet":
            phonemes = SJ.to_phonemes(text)
        elif mode == "phonemes":
            phonemes = text
        else:                                      # words as groups split by |, pauses kept
            tokens, _ = PR.parse_text(text)
            parts: list[str] = []
            for t in tokens:
                if t.get("gap"):
                    parts.append("|")
                elif "pause" in t:
                    parts += ["|", f",:{t['pause']}", "|"]
                elif "p" in t:
                    parts.append(t["p"] + ("" if t["stress"] is None else str(t["stress"])))
            phonemes = " ".join(parts)
            while "| |" in phonemes:
                phonemes = phonemes.replace("| |", "|")
            phonemes = phonemes.strip(" |")
        return {"text": SJ.from_phonemes(phonemes) if to == "speakjet" else phonemes}
    except Exception as error:  # noqa: BLE001 - shown on the page
        return {"problems": [str(error)]}


def test_cart(labels: list[str]) -> str:
    names = "\n".join(f"VT_Name_{k}: fcc \"{label.upper().replace('_', ' ')[:24]}\"\n        fcb    $80"
                      for k, label in enumerate(labels))
    table = "\n".join(f"        fdb    {label},VT_Name_{k}" for k, label in enumerate(labels))
    return f"""; Test cartridge made by the VTX Speech editor (vectrex/editor.py).
; Button 1: the next phrase. Button 2: say this one again.
Wait_Recal      equ    $F192
Do_Sound        equ    $F289
Read_Btns       equ    $F1BA
Intensity_a     equ    $F2AB
Reset0Ref       equ    $F354
Print_Str_d     equ    $F37A
Vec_Music_Work  equ    $C83F
VS_RAM          equ    $C880
VS_DUCK         equ    0
VT_Index        equ    $C8A0

        org    0
        fcc    "g GCE 2026"
        fcb    $80
        fdb    $FD0D
        fcb    $F8,$50,$20,-$56
        fcc    "SPEECH TEST"
        fcb    $80
        fcb    0
        ldx    #Vec_Music_Work
        ldb    #14
VT_Clear:
        clr    ,x+
        decb
        bne    VT_Clear
        lda    #$3F
        sta    Vec_Music_Work+6
        jsr    Speech_Init
        clr    VT_Index
VT_Loop:
        jsr    Speech_Wait_Recal
        lda    #$5F
        jsr    Intensity_a
        jsr    Reset0Ref
        ldx    #VT_Table
        ldb    VT_Index
        lslb
        lslb
        abx
        ldu    2,x
        ldd    #$20B0
        jsr    Print_Str_d
        jsr    Reset0Ref
        ldd    #$E0A0
        ldu    #VT_Help
        jsr    Print_Str_d
        jsr    Read_Btns
        bita   #1
        beq    VT_Again
        ldb    VT_Index
        incb
        cmpb   #{len(labels)}
        blo    VT_Set
        clrb
VT_Set:
        stb    VT_Index
        bra    VT_Say
VT_Again:
        bita   #2
        beq    VT_Sound
VT_Say:
        ldx    #VT_Table
        ldb    VT_Index
        lslb
        lslb
        abx
        ldx    ,x
        jsr    Speech_Say
VT_Sound:
        jsr    Speech_Service
        jsr    Do_Sound
        bra    VT_Loop

VT_Help: fcc    "1 NEXT  2 AGAIN"
        fcb    $80
VT_Table:
{table}
{names}

        include "vtx_speech.asm"
        include "speech_data.asm"
"""


class Handler(BaseHTTPRequestHandler):
    project: Project

    def _send(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, value) -> None:
        self._send(200, json.dumps(value).encode(), "application/json")

    def _local(self) -> bool:
        """Only the editor's own page may use the API. The server listens on
        127.0.0.1, but any web page in the browser can send it requests: the
        Host check stops DNS rebinding, the Origin check other sites."""
        port = self.server.server_address[1]
        ours = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host", "") in ours and (origin is None or origin.split("://", 1)[-1] in ours)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/api/") and not self._local():
            self._send(403, b"forbidden", "text/plain")
        elif path in STATIC:
            file, kind = STATIC[path]
            self._send(200, file.read_bytes(), kind)
        elif path == "/api/mame":
            self._json(mame_check.find())
        elif path == "/api/project":
            source = self.project.path.read_text(encoding="utf-8")
            self._json({"path": str(self.project.path), "data": str(self.project.data_path),
                        "source": source, "report": report(source), "as09": AS09.exists() and sys.platform == "win32"})
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        # JSON only: a cross-site form or "simple" fetch can't send it without a CORS preflight, which fails here.
        if not self._local() or self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            self._send(403, b"forbidden", "text/plain")
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        path = self.path.split("?")[0]
        try:
            if path == "/api/compile":
                self._json(report(body.get("source", "")))
            elif path == "/api/frames":
                self._json(frames(body))
            elif path == "/api/convert":
                self._json(convert(body))
            elif path == "/api/mame":
                self._json(mame_check.remember(body.get("path", "").strip().strip('"')))
            elif path == "/api/check":
                self._json(mame_check.check(body.get("source", ""), passes=2,
                                            work=self.project.path.parent / "speech_test" / "check"))
            elif path in ("/api/save", "/api/export", "/api/build"):
                self._json(self.save(body.get("source", ""), path.rsplit("/", 1)[1]))
            elif path == "/api/run":                 # build, then open it in a MAME window
                out = self.save(body.get("source", ""), "build")
                if not out.get("problems") and out.get("built"):
                    out.update(mame_check.launch(Path(out["built"])))
                self._json(out)
            else:
                self._send(404, b"not found", "text/plain")
        except Exception as error:  # noqa: BLE001 - shown on the page
            self._json({"problems": [f"{type(error).__name__}: {error}"]})

    def save(self, source: str, action: str) -> dict:
        c = E.compile_phrases(source)
        self.project.save(source)
        out = {"saved": str(self.project.path), "problems": c["problems"]}
        if action == "save" or c["problems"]:
            return out
        self.project.data_path.write_text(E.to_asm(c, f"vectrex/editor.py, {self.project.path.name}"),
                                          encoding="utf-8", newline="\n")
        out["exported"] = str(self.project.data_path)
        out.update(E.place_player(self.project.data_path.parent))
        if action == "build":
            if not (AS09.exists() and sys.platform == "win32"):
                out["problems"] = ["building needs Windows (the bundled AS09 is a Windows program)"]
                return out
            work = self.project.path.parent / "speech_test"
            work.mkdir(exist_ok=True)
            shutil.copy(HERE / "vtx_speech.asm", work / "vtx_speech.asm")
            shutil.copy(self.project.data_path, work / "speech_data.asm")
            (work / "speech_test.asm").write_text(test_cart([p["label"] for p in c["phrases"]]), encoding="ascii")
            result = subprocess.run([str(AS09), "-w200", "-h0", "-l", "-mctiz", "speech_test.asm"], cwd=work,
                                    capture_output=True, text=True)
            listing = (work / "speech_test.lst").read_text(errors="replace") if (work / "speech_test.lst").exists() else ""
            binary = work / "speech_test.bin"
            if "No errors in pass 2" in listing and binary.exists():
                out["built"] = str(binary)
                out["bytes"] = binary.stat().st_size
            else:
                errors = [l for l in listing.splitlines() if "rror" in l][:8]
                out["problems"] = ["AS09 failed"] + (errors or [(result.stdout + result.stderr)[-500:]])
        return out

    def log_message(self, fmt, *args):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="VTX Speech editor for Vectrex phrases")
    parser.add_argument("phrases", nargs="?", default="phrases.txt", help="the phrase file (made if missing)")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    Handler.project = Project(Path(args.phrases).resolve())
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"VTX Speech editor: {url}  (editing {Handler.project.path}; Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

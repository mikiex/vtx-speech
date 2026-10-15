r"""Phrase list -> speech data for vtx_speech.asm (AS09 source).

    python vectrex/export.py <phrases.txt> [speech_data.asm] [--player]

(--player also puts the player, vtx_speech.asm, beside the data.)

Needs only Python 3.8+ (the voice model is in vectrex/vtxspeech, the CMU
dictionary in vendor/). It writes the same file as vectrex/export.js and the
web page's exporter (test/test_export_python.py checks this).

A phrase file has one phrase per line:

    ; a comment
    Say_Hello = ^c3 hello there
    Say_Taunt = ^c? {get|kill|destroy} {the humanoid|it}
    @vtx      = /V IY1 T IY1 EH1 K S/        a word's own pronunciation
    @shoot    = shoot *1.2                   ... or its length (x1.2)
    @hello    = \HE \EH \LE \OWWW            SpeakJet codes (mnemonics or numbers)
    Say_Hi    = ^c3 \HE \EH \LE \OWWW world  ... also inline: a run of codes is one word

A phrase is words (letters and '), ^c0..^c7 (a voice: pitch and speed),
^c? (a random voice), ,:N (N frames of silence, 1..62) and {a b|c} (one of
the alternatives, chosen at random when the phrase plays).
"""
from __future__ import annotations

import argparse
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vtxspeech import speakjet as SJ, voice as V, word_track as W  # noqa: E402

END, CLOCK, RANDOM_CLOCK, CHOOSE, PAUSE = 0xFF, 0x80, 0x88, 0x89, 0xC0
WORD_LIMIT = 64                  # the player indexes the word table with a signed byte
CLOCK_PITCH = 1220               # voice c: pitch 1220 / (16 - c) Hz, speed x 16 / (16 - c)
REGISTER_NAMES = {"a", "b", "d", "x", "y", "u", "s", "pc", "dp", "cc"}

# Envelope period (R11) and run-length scale 8 * (16 - c) for the voices 0..7.
CLOCK_EP = [V.envelope_period(CLOCK_PITCH / (16 - c)) for c in range(8)]
CLOCK_SCALE = [8 * (16 - c) for c in range(8)]


def voice_pitches(settings: dict) -> list[float]:
    """The 8 voices' pitches (Hz): the arcade's 1220 / (16 - c), or with
    "#voices low high" a geometric run from low (voice 0) to high (voice 7)."""
    if "voices" in settings:
        low, high = settings["voices"]
        return [low * (high / low) ** (c / 7) for c in range(8)]
    return [CLOCK_PITCH / (16 - c) for c in range(8)]


def clock_ep(settings: dict) -> list[int]:
    return [V.envelope_period(f) for f in voice_pitches(settings)]


def clock_scale(settings: dict) -> list[int]:
    """Each voice's run-length scale, 8 * (16 - c): higher voices play faster,
    as on the arcade's chip. "#voicespeed flat": every voice at voice 0's
    speed (128: a run lasts exactly its frames), so changing voice changes
    only the pitch."""
    return [128] * 8 if settings.get("voicespeed") == "flat" else list(CLOCK_SCALE)


def pitch_warnings(names: list[str], overrides: dict) -> list[str]:
    """Per-phoneme @pitch has no place in a word track (only the voice sets
    the pitch), so it is dropped: say so rather than lose it quietly."""
    out = []
    for n in names:
        say = overrides.get(n, {"say": n})["say"]
        if say.startswith("/") and re.search(r"@\d", say):
            out.append(f'word "{n}": @pitch is not kept on the cartridge (only the voice, ^c0..^c7, sets the pitch)')
    return out


def join_groups(items: list) -> list:
    r"""Several tokens that make one word: a run of SpeakJet codes (\he \eh 183
    ...: from a \code, with the numbers after it) or a /phoneme group/ with
    spaces in it (from the token that opens it to the one that closes it)."""
    out: list = []
    for t in items:
        last = out[-1] if out else None
        if isinstance(t, str) and isinstance(last, str) and (
                (last.startswith("\\") and (t.startswith("\\") or t.isdigit()))
                or (last.startswith("/") and not (len(last) > 1 and last.endswith("/")))):
            out[-1] = last + " " + t
        else:
            out.append(t)
    return out


def tokens(text: str) -> list:
    """A phrase's tokens: strings, and for each {a b|c} a list of alternatives."""
    out = []
    for m in re.finditer(r"\{([^{}]*)\}|([^\s{}]+)|([{}])", text):
        if m[3]:
            raise ValueError(f'unmatched "{m[3]}"')
        if m[1] is not None:
            alternatives = [join_groups(a.split()) for a in m[1].split("|")]
            if len(alternatives) < 2 or any(not a for a in alternatives):
                raise ValueError("a {group} needs two or more alternatives, split by |")
            if len(alternatives) > 32:
                raise ValueError("at most 32 alternatives in a {group}")
            out.append(alternatives)
        else:
            out.append(m[2])
    return join_groups(out)


def flat(toks: list) -> list[str]:
    return [t for tok in toks for t in ([tok] if isinstance(tok, str) else [x for a in tok for x in a])]


def is_word(t: str) -> bool:
    """An English word, a run of SpeakJet codes, or a /phoneme group/."""
    return re.fullmatch(r"[a-z']+", t) is not None or t.startswith("\\") or t.startswith("/")


def word_states(say: str, length: float, speed: float = 1.0) -> list:
    """A word's states: English, /phonemes/, or SpeakJet codes. ``speed``
    (the "#speed" setting) divides every length."""
    voice = {"rate": speed}
    if SJ.is_speakjet(say):
        return W.states(voice, "/" + SJ.to_phonemes(say) + "/", length)
    return W.states(voice, say, length)


def parse(source: str) -> tuple[list[dict], dict, list[str], dict]:
    """(phrases [{label, text, line}], word overrides {name: {say, length}},
    problems, settings {speed, voices}).

    Settings lines: "#speed 1.2" (every word 1.2 times as fast; 0.5..2) and
    "#voices 70 160" (voice 0 at 70 Hz up to voice 7 at 160 Hz, 30..600)."""
    phrases, words, problems, settings = [], {}, [], {}
    for i, raw in enumerate(source.splitlines()):
        line = re.sub(r";.*$", "", raw).strip()
        if not line:
            continue
        if line.startswith("#"):
            parts = line[1:].split()
            try:
                values = [float(x) for x in parts[1:]]
            except ValueError:
                values = []
            if parts[:1] == ["speed"] and len(values) == 1 and 0.5 <= values[0] <= 2:
                settings["speed"] = values[0]
            elif parts[:1] == ["voices"] and len(values) == 2 and 30 <= values[0] < values[1] <= 600:
                settings["voices"] = values
            elif parts == ["voicespeed", "flat"]:
                settings["voicespeed"] = "flat"
            elif parts == ["voicespeed", "arcade"]:
                pass
            else:
                problems.append(f"line {i + 1}: write #speed 0.5..2, #voices low high (30..600 Hz, low < high) "
                                "or #voicespeed flat")
            continue
        m = re.match(r"^(@?[A-Za-z_'][\w']*)\s*=\s*(.*)$", line, re.ASCII)
        if not m:
            spaced = re.match(r"^([A-Za-z_][\w ]*?\s[\w ]*?)\s*=", line, re.ASCII)
            if spaced:                                  # "Say Hello = ...": suggest Say_Hello
                problems.append(f'line {i + 1}: a label can\'t have spaces: try "{re.sub(" +", "_", spaced[1].strip())}"')
            else:
                problems.append(f"line {i + 1}: write label = phrase")
            continue
        if m[1].startswith("@"):
            name, say, length = m[1][1:].lower(), m[2].strip(), 1.0
            stretch = re.search(r"\s*\*\s*([\d.]+)\s*$", say)
            if stretch:
                try:
                    length = float(stretch[1])
                except ValueError:
                    length = float("nan")
                say = say[:stretch.start()].strip()
            if not is_word(name):
                problems.append(f"line {i + 1}: a word name is lower-case letters")
            if not 0.25 <= length <= 4:
                problems.append(f"line {i + 1}: a length is 0.25..4")
            words[name] = {"say": say or name, "length": length}
            continue
        if not re.fullmatch(r"[A-Za-z_]\w*", m[1], re.ASCII) or m[1].lower() in REGISTER_NAMES:
            problems.append(f'line {i + 1}: "{m[1]}" is not a usable assembler label')
            continue
        if m[1].startswith(("VS_", "Speech_")):        # the player's and the data's own labels
            problems.append(f'line {i + 1}: "{m[1]}": labels starting VS_ or Speech_ belong to the player')
            continue
        phrases.append({"label": m[1], "text": m[2].lower(), "line": i + 1})
    return phrases, words, problems, settings


def _is_code(t: str, name: str, number: int) -> bool:
    return t.lstrip("\\").upper() == name or (t.startswith("\\") and t[1:] == str(number))


def split_speakjet_pitch(toks: list, pitches: list[float], notes: set) -> list:
    r"""SpeakJet's \PITCH n (n in Hz) becomes the nearest voice: a voice can
    only change between words, so a run of codes is split there, as
    "\he \pitch 120 \eh \le" -> "\he", "^c4", "\eh \le". \SPEED n stays in the
    run, where it is ignored (``notes`` records both, for warnings)."""
    out: list = []
    for t in toks:
        if not isinstance(t, str):
            out.append([split_speakjet_pitch(a, pitches, notes) for a in t])
            continue
        if not t.startswith("\\"):
            out.append(t)
            continue
        parts, run, codes, i = [], [], t.split(), 0
        while i < len(codes):
            c = codes[i]
            if (_is_code(c, "PITCH", 22)) and i + 1 < len(codes) and codes[i + 1].lstrip("\\").isdigit():
                hz = int(codes[i + 1].lstrip("\\"))
                if run:
                    parts.append(run)
                run = []
                if hz > 0:
                    nearest = min(range(8), key=lambda v: abs(math.log(pitches[v] / hz)))
                    parts.append(f"^c{nearest}")
                notes.add("pitch")
                i += 2
                continue
            if _is_code(c, "SPEED", 21):
                notes.add("speed")
            run.append(c)
            i += 1
        if run:
            parts.append(run)
        for part in parts:
            if isinstance(part, str):
                out.append(part)
            else:                                   # a run must start with a \code to read as SpeakJet
                out.append(" ".join(([part[0]] if part[0].startswith("\\") else ["\\" + part[0]]) + part[1:]))
    return out


def compile_phrases(source: str, word_order: list[str] | None = None) -> dict:
    """Everything as bytes, or {"problems": [...]}."""
    phrases, overrides, problems, settings = parse(source)
    parsed, notes, pitches = [], set(), voice_pitches(settings)
    for p in phrases:
        try:
            toks = split_speakjet_pitch(tokens(p["text"]), pitches, notes)
        except ValueError as error:
            problems.append(f"line {p['line']}: {error}")
            continue
        for t in flat(toks):
            if not (is_word(t) or re.fullmatch(r"\^c[0-7?]", t) or re.fullmatch(r",:\d+", t)):
                problems.append(f'line {p["line"]}: cannot read "{t}"')
            elif t.startswith(",:") and not 1 <= int(t[2:]) <= 62:
                problems.append(f"line {p['line']}: a pause is 1..62 frames")
            elif t.startswith("/") and not (len(t) > 2 and t.endswith("/")):
                problems.append(f'line {p["line"]}: a phoneme group "{t}" needs its closing /')
        if not any(is_word(t) for t in flat(toks)):
            problems.append(f"line {p['line']}: says nothing")
        parsed.append({**p, "toks": toks})
    if len({p["label"] for p in phrases}) != len(phrases):
        problems.append("two phrases have the same label")
    names = list(word_order or [])
    for p in parsed:
        for t in flat(p["toks"]):
            if is_word(t) and t not in names:
                names.append(t)
    if len(names) > WORD_LIMIT:
        problems.append(f"{len(names)} different words: at most {WORD_LIMIT}")
    states = {}
    for n in names:
        w = overrides.get(n, {"say": n, "length": 1.0})
        try:
            states[n] = word_states(w["say"], w["length"], settings.get("speed", 1.0))
        except Exception as error:  # noqa: BLE001 - reported like the other problems
            problems.append(f'word "{n}": {error}')
    if problems:
        return {"problems": problems}

    # One noise table for every word: the distinct (period, volume) pairs, sorted.
    noises = sorted({s[1] for n in names for s in states[n] if s[1]})
    words = [W.encode_word(W.runs(states[n]), noises) for n in names]

    # Sequences: each phrase, and each alternative of a {group} (shared by its text).
    seqs, by_key = [], {}

    def add(label: str, items: list) -> int:
        seqs.append({"label": label, "items": items})
        return len(seqs) - 1

    def encode(toks: list) -> list:
        items = []
        for t in toks:
            if not isinstance(t, str):
                items += [CHOOSE, len(t)] + [("ref", alternative(a)) for a in t]
            elif t == "^c?":
                items.append(RANDOM_CLOCK)
            elif t.startswith("^c"):
                items.append(CLOCK + int(t[2]))
            elif t.startswith(",:"):
                items.append(PAUSE + int(t[2:]))
            else:
                items.append(names.index(t))
        return items

    def alternative(toks: list[str]) -> int:
        key = " ".join(toks)
        if key not in by_key:
            by_key[key] = add(f"VS_Alt_{len(by_key)}", encode(toks) + [END])
        return by_key[key]

    out = [{"label": p["label"], "text": p["text"], "seq": add(p["label"], encode(p["toks"]) + [END])}
           for p in parsed]
    for sq in seqs:   # host bytes: a reference is the sequence's index, big-endian
        sq["bytes"] = bytes(b for it in sq["items"] for b in ([it] if isinstance(it, int) else [it[1] >> 8, it[1] & 0xFF]))
    return {"names": names, "noises": noises, "words": words, "seqs": seqs, "phrases": out, "problems": [],
            "settings": settings, "clock_ep": clock_ep(settings), "clock_scale": clock_scale(settings),
            "warnings": pitch_warnings(names, overrides) + speakjet_warnings(notes, overrides, settings)}


def speakjet_warnings(notes: set, overrides: dict, settings: dict) -> list[str]:
    r"""What SpeakJet codes could not keep: \SPEED (no speed per phrase on the
    cartridge), \PITCH inside an @word (a voice changes only between words),
    and \PITCH without #voicespeed flat (a voice also sets the speed)."""
    out = []
    if "speed" in notes or any(SJ.is_speakjet(w["say"]) and re.search(r"\\(speed|21)\b", w["say"], re.I)
                               for w in overrides.values()):
        out.append(r"SpeakJet \SPEED is not kept: the cartridge has no speed per phrase (use #speed)")
    for name, w in overrides.items():
        if SJ.is_speakjet(w["say"]) and re.search(r"\\(pitch|22)\b", w["say"], re.I):
            out.append(f'word "{name}": SpeakJet \\PITCH inside a word is ignored; write the codes in the phrase')
    if "pitch" in notes and settings.get("voicespeed") != "flat":
        out.append(r"SpeakJet \PITCH picks voices, which also change the speed; add #voicespeed flat to keep the timing")
    return out


def _fcb(data) -> list[str]:
    data = list(data)
    return ["        fcb     " + ",".join(f"${b:02X}" for b in data[k:k + 16]) for k in range(0, len(data), 16)]


def _word_labels(names: list[str]) -> list[str]:
    """VS_Word_<word>; VS_Word_sj<k> for the k-th run of SpeakJet codes and
    VS_Word_ph<k> for the k-th /phoneme group/."""
    out, sj, ph = [], 0, 0
    for n in names:
        if n.startswith("\\"):
            out.append(f"VS_Word_sj{sj}")
            sj += 1
        elif n.startswith("/"):
            out.append(f"VS_Word_ph{ph}")
            ph += 1
        else:
            out.append("VS_Word_" + n.replace("'", "_"))
    return out


def _voices_note(c: dict) -> str:
    if "voices" in c["settings"]:
        low, high = c["settings"]["voices"]
        return f"pitch {low:g} to {high:g} Hz, #voices"
    return "pitch 1220 / (16 - c) Hz"


def to_asm(c: dict, note: str = "") -> str:
    """The AS09 source for vectrex/vtx_speech.asm (the same text as js/vectrex_export.js)."""
    labels = _word_labels(c["names"])
    total = sum(len(w) for w in c["words"])
    seq_bytes = sum(1 if isinstance(it, int) else 2 for sq in c["seqs"] for it in sq["items"])
    lines = [
        "; VTX Speech data for vectrex/vtx_speech.asm (AS09).",
        "; Generated by the VTX Speech exporter" + (f": {note}" if note else "") + ". Edit the phrases and export again.",
        f"; {len(c['names'])} words ({total} bytes), {len(c['phrases'])} phrases ({seq_bytes} bytes with alternatives), "
        f"{len(c['noises'])} noises, {16 + 2 * len(c['names']) + 2 * len(c['noises'])} bytes of tables.",
        ";",
        "; Say a phrase with:   ldx #<label>   jsr Speech_Say",
        "",
        f"; Voices 0..7 (^c0..^c7): envelope period ({_voices_note(c)}) and run scale "
        f"{'128, #voicespeed flat' if c['settings'].get('voicespeed') == 'flat' else '8 * (16 - c)'}.",
        "VS_Clock_EP:", *_fcb(c["clock_ep"]),
        "VS_Clock_Scale:", *_fcb(c["clock_scale"]),
        "; Noise sounds: (R6 noise period, channel B volume) pairs.",
        "VS_Noises:", *(_fcb([b for n in c["noises"] for b in n]) if c["noises"] else ["        fcb     0,0"]),
        "; Word table: word number -> its track.",
        "VS_Words:", *[f"        fdb     {label}" for label in labels],
        "",
        "; Word tracks: runs of identical 50 Hz frames (header byte: bit 7 formant bytes follow,",
        "; bit 6 a noise byte follows, bits 5-4 kind, bits 3-0 frames - 1), $FF at the end.",
    ]
    for n, label, data in zip(c["names"], labels, c["words"]):
        lines += [f"{label}:{' ' * max(1, 23 - len(label))}; {n}", *_fcb(data)]
    lines += ["", "; Phrases: word numbers $00-$3F, voice $80-$87, random voice $88, one of n alternatives",
              "; $89 n <addresses>, silence $C1-$FE (1..62 frames), $FF end."]
    texts = {p["seq"]: p["text"] for p in c["phrases"]}
    for k, sq in enumerate(c["seqs"]):
        comment = texts[k] if k in texts else "(an alternative)" if sq["label"].startswith("VS_Alt") else ""
        lines.append(f"{sq['label']}:{' ' * max(1, 23 - len(sq['label']))}; {comment}")
        run: list[int] = []
        for it in sq["items"] + [None]:
            if isinstance(it, int):
                run.append(it)
                continue
            lines += _fcb(run)
            run = []
            if it is not None:
                lines.append(f"        fdb     {c['seqs'][it[1]]['label']}")
    return "\n".join(lines) + "\n"


PLAYER = Path(__file__).resolve().parent / "vtx_speech.asm"


def place_player(folder: Path) -> dict:
    """Put the player (vtx_speech.asm) beside the exported data, so the two
    files sit together: {"player": path, "player_note": what happened}. A
    different vtx_speech.asm already there is kept, not overwritten."""
    target = Path(folder) / "vtx_speech.asm"
    if target.resolve() == PLAYER:
        return {"player": str(target), "player_note": "the player is already here"}
    if target.exists():
        if target.read_bytes() == PLAYER.read_bytes():
            return {"player": str(target), "player_note": "the player beside it is this version"}
        return {"player": str(target), "player_note": "kept your vtx_speech.asm: it differs from this version's player"}
    target.write_bytes(PLAYER.read_bytes())
    return {"player": str(target), "player_note": "copied the player beside it"}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compile a VTX Speech phrase file to speech_data.asm for vtx_speech.asm (AS09).")
    parser.add_argument("phrases", type=Path, help="the phrase file")
    parser.add_argument("output", type=Path, nargs="?", help="the .asm file to write (default: standard output)")
    parser.add_argument("--player", action="store_true",
                        help="also put the player (vtx_speech.asm) beside the output")
    args = parser.parse_args()
    if args.player and args.output is None:
        parser.error("--player needs an output file")
    c = compile_phrases(args.phrases.read_text(encoding="utf-8"))
    if c["problems"]:
        print("\n".join(c["problems"]), file=sys.stderr)
        sys.exit(1)
    for warning in c["warnings"]:
        print(f"warning: {warning}", file=sys.stderr)
    asm = to_asm(c, f"python vectrex/export.py {args.phrases.name}")
    if args.output is None:
        sys.stdout.write(asm)
        return
    args.output.write_text(asm, encoding="utf-8", newline="\n")
    print(f"{args.output}: {len(c['names'])} words ({sum(map(len, c['words']))} bytes), {len(c['phrases'])} phrases")
    if args.player:
        placed = place_player(args.output.resolve().parent)
        print(f"{placed['player']}: {placed['player_note']}")


if __name__ == "__main__":
    main()

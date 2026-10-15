"""VTX Speech lab: the voice model (the host authority for the speech lab).

A voice turns a sequence of vowels into AY register frames, one per 50 Hz
frame (docs/speech/formant_speech.md). The lab page only listens to these
frames through Ayumi; it never decides them.

Voicing. The envelope generator runs as a sawtooth at the voice pitch
(f0 = clock / (256 * EP)). A tone channel set to follow the envelope is struck
once per pitch period and dies away: a crude voiced resonance, which carries
the voice. ``lock``: "nearest" (the default, clearer by ear in Verzerk's
mix) moves each formant to the nearest harmonic of f0, so nearly the whole
sound repeats every pitch period; "off" plays each formant at its own
frequency. Nearest is computed with multiplies and a 64-entry reciprocal
table, exactly as a cartridge would (``locked_period``). The searching locks
("exact", "best") were removed: docs/speech/formant_speech.md.

A voice (all optional, defaults below):

    {"pitch": 110, "vibrato": {"depth": 0.0, "rate": 5.0},
     "shape": 8, "lock": "nearest",
     "channels": [{"role": "F1", "volume": "env"},
                  {"role": "F2", "volume": "env"},
                  {"role": "F3", "volume": 6}],
     "noise": {"period": 0, "channels": []}}

``role``: F1, F2, F3 (a formant), "source" (tone off: the raw envelope
sawtooth, a pure buzz) or "off". ``volume``: 0..15, "env" (follow the
envelope) or "level" (the vowel's own level for that formant, steady).

A sequence: [{"vowel": "oo", "frames": 50, "glide": 10, "pitch": 120}, ...]
(``glide``: frames at the start spent moving from the previous vowel;
``pitch`` overrides the voice's pitch for that vowel, gliding too).
"""
from __future__ import annotations

import math

CLOCK = 1_500_000
FRAME_RATE = 50
MIXER_SILENT = 0x3F

# Peterson & Barney (1952), adult male averages: F1, F2, F3 (Hz) and the
# formant levels (dB relative to the strongest harmonic).
VOWELS = {
    "ee": {"ipa": "i", "word": "heed", "f": (270, 2290, 3010), "db": (-4, -24, -28)},
    "ih": {"ipa": "ɪ", "word": "hid", "f": (390, 1990, 2550), "db": (-3, -23, -27)},
    "eh": {"ipa": "ɛ", "word": "head", "f": (530, 1840, 2480), "db": (-2, -17, -24)},
    "ae": {"ipa": "æ", "word": "had", "f": (660, 1720, 2410), "db": (-1, -12, -22)},
    "ah": {"ipa": "ɑ", "word": "hod", "f": (730, 1090, 2440), "db": (-1, -5, -28)},
    "aw": {"ipa": "ɔ", "word": "hawed", "f": (570, 840, 2410), "db": (0, -7, -34)},
    "uh": {"ipa": "ʊ", "word": "hood", "f": (440, 1020, 2240), "db": (-1, -12, -34)},
    "oo": {"ipa": "u", "word": "who'd", "f": (300, 870, 2240), "db": (-3, -19, -43)},
    "uu": {"ipa": "ʌ", "word": "hud", "f": (640, 1190, 2390), "db": (-1, -10, -27)},
    "er": {"ipa": "ɝ", "word": "heard", "f": (490, 1350, 1690), "db": (-5, -15, -20)},
}

DEFAULT_VOICE = {
    "pitch": 110.0,
    "vibrato": {"depth": 0.0, "rate": 5.0},
    "shape": 8,
    "lock": "nearest",
    "channels": [{"role": "F1", "volume": "env"},
                 {"role": "F2", "volume": "env"},
                 {"role": "F3", "volume": "level"}],
    "noise": {"period": 0, "channels": []},
    "intonation": {"stress": 0.15, "fall": 0.2, "question": 0.35},
    "rate": 1.0,
    "layout": "full",
}
# "full": speech uses all three channels (noise consonants on C). "shared":
# speech uses only A (F1) and B (F2, noise consonants) and leaves channel C
# off, so a game can keep C for its own sound while speaking (Verzerk:
# docs/verzerk/verzerk.md). The voice's channel setup applies to "full".
LAYOUTS = ("full", "shared")
SHARED_CHANNELS = 0b011                         # A and B: the speech's bits in R7 (tone) and R7 >> 3 (noise)
ROLES = ("F1", "F2", "F3", "source", "off")
LOCKS = ("off", "nearest")
SHAPES = (8, 10, 12, 14)            # repeating: \\\\, \/\/, ////, /\/\


def voice_with_defaults(voice: dict | None) -> dict:
    v = {**DEFAULT_VOICE, **(voice or {})}
    v["vibrato"] = {**DEFAULT_VOICE["vibrato"], **v.get("vibrato", {})}
    v["noise"] = {**DEFAULT_VOICE["noise"], **v.get("noise", {})}
    v["intonation"] = {**DEFAULT_VOICE["intonation"], **v.get("intonation", {})}
    return v


def problems(voice: dict, sequence: list) -> list[str]:
    out = []
    v = voice_with_defaults(voice)
    if not 30 <= v["pitch"] <= 1000:
        out.append("pitch must be 30..1000 Hz")
    if v["shape"] not in SHAPES:
        out.append(f"envelope shape must be one of {SHAPES} (repeating shapes)")
    if v["lock"] not in LOCKS:
        out.append(f"lock must be one of {LOCKS}")
    if len(v["channels"]) != 3:
        out.append("three channels")
    for n, ch in enumerate(v["channels"]):
        if ch.get("role") not in ROLES:
            out.append(f"channel {'ABC'[n]}: role must be one of {ROLES}")
        vol = ch.get("volume")
        if vol not in ("env", "level") and not (isinstance(vol, int) and 0 <= vol <= 15):
            out.append(f"channel {'ABC'[n]}: volume must be 0..15, env or level")
    if not 0 <= v["noise"]["period"] <= 31:
        out.append("noise period must be 0..31")
    if v["layout"] not in LAYOUTS:
        out.append(f"layout must be one of {LAYOUTS}")
    if not 0.5 <= v["rate"] <= 2.0:
        out.append("rate (speed) must be 0.5..2 (2 is twice as fast)")
    for key, value in v["intonation"].items():
        if key not in ("stress", "fall", "question") or not 0 <= value <= 1:
            out.append(f"intonation {key} must be 0..1 (a share of the pitch)")
    if not sequence:
        out.append("the sequence is empty")
    for n, item in enumerate(sequence):
        if item.get("vowel") not in VOWELS and item.get("vowel") != "-":
            out.append(f"item {n}: unknown vowel {item.get('vowel')!r} (or - for silence)")
        if not isinstance(item.get("frames"), int) or not 1 <= item["frames"] <= 500:
            out.append(f"item {n}: frames must be 1..500")
    return out


def cycle_clocks(shape: int) -> int:
    """Clocks per envelope cycle for EP = 1: a sawtooth is one 16-step sweep
    of 16 clocks a step (256); a triangle (10, 14) is two sweeps (512)."""
    return 512 if shape in (10, 14) else 256


def envelope_period(f0: float, shape: int = 8) -> int:
    return max(1, min(65535, round(CLOCK / (cycle_clocks(shape) * f0))))


def envelope_pitch(ep: int, shape: int = 8) -> float:
    return CLOCK / (cycle_clocks(shape) * ep)


def tone_period(freq: float) -> int:
    return max(1, min(4095, round(CLOCK / (16 * freq))))


# "nearest" as the cartridge computes it: multiplies and one table, no division.
#   Fq = round(F / 16)                    the formant in 16 Hz units (one byte)
#   n  = (Fq * EP * K + 32768) >> 16      the nearest harmonic, round(F / f0):
#        F / f0 = 16 Fq * 256 EP / clock = Fq EP * 4096 / 1,500,000, and
#        K = round(65536 * 4096 / 1,500,000) = 179 (358 for a triangle,
#        whose cycle is two sweeps); n is clamped to 1..NEAREST_MAX
#   TP = (EP * R[n] + 512) >> 10          round(16 EP / n), R[n] = round(16384 / n)
#        (a triangle: (EP * R[n] + 256) >> 9, round(32 EP / n)); off by one
#        only on rounding ties (51 of 5,859 EP and n pairs, worst 0.54)
# Five MULs per formant (8x8, 16x8, 8x16). Errors against exact division are
# part of the rule: the host plays exactly what the cartridge will.
NEAREST_K = 179
NEAREST_MAX = 63
NEAREST_RECIP = tuple(round(16384 / n) if n else 0 for n in range(NEAREST_MAX + 1))  # 128 bytes as words


def formant_units(freq: float) -> int:
    return max(1, min(255, round(freq / 16)))


def locked_period(freq: float, ep: int, lock: str, shape: int = 8) -> tuple[int, int | None, bool]:
    """(tone period, harmonic number or None, exact) for a formant at ``freq``
    with the envelope at period ``ep``: its own frequency ("off") or the
    nearest harmonic of the pitch by the table rule above ("nearest")."""
    if lock == "off":
        return tone_period(freq), None, False
    triangle = cycle_clocks(shape) == 512
    k = NEAREST_K * (2 if triangle else 1)
    n = max(1, min(NEAREST_MAX, (formant_units(freq) * ep * k + 32768) >> 16))
    tp = (ep * NEAREST_RECIP[n] + 256) >> 9 if triangle else (ep * NEAREST_RECIP[n] + 512) >> 10
    base = cycle_clocks(shape) * ep // 16
    return max(1, min(4095, tp)), n, base % n == 0 and tp * n == base


def _mix(a, b, t):
    return a + (b - a) * t


def frames(voice: dict, sequence: list) -> list[dict]:
    """Register frames for ``sequence`` spoken by ``voice``. Each frame:
    regs R0..R13, ``shape`` (write R13: a voiced sound starts), and what the
    lab shows (vowel, pitch, formant targets, tone frequencies, harmonics)."""
    v = voice_with_defaults(voice)
    out: list[dict] = []
    previous = None                     # (formants, levels, pitch) the glide starts from
    t = 0
    for item in sequence:
        name = item["vowel"]
        if name == "-":
            for _ in range(item["frames"]):
                regs = [0] * 14
                regs[7] = MIXER_SILENT
                out.append({"regs": regs, "shape": False, "vowel": "-"})
                t += 1
            previous = None
            continue
        target = VOWELS[name]
        pitch = item.get("pitch", v["pitch"])
        glide = min(item.get("glide", 0), item["frames"])
        for k in range(item["frames"]):
            a = min(1.0, (k + 1) / glide) if previous and glide else 1.0
            f = [_mix(p, q, a) for p, q in zip(previous[0], target["f"])] if previous else list(target["f"])
            db = [_mix(p, q, a) for p, q in zip(previous[1], target["db"])] if previous else list(target["db"])
            f0 = _mix(previous[2], pitch, a) if previous else pitch
            vib = v["vibrato"]
            f0 *= 1 + vib["depth"] * math.sin(2 * math.pi * vib["rate"] * t / FRAME_RATE)
            out.append(_frame(v, name, f, db, f0))
            t += 1
        previous = (target["f"], target["db"], pitch)
    voiced_before = False
    for frame in out:
        voiced = frame["regs"][7] != MIXER_SILENT
        frame["shape"] = voiced and not voiced_before
        voiced_before = voiced
    return out


def _frame(v: dict, name: str, formants, levels, f0: float) -> dict:
    ep = envelope_period(f0, v["shape"])
    regs = [0] * 14
    mixer = 0x3F                        # bits 0..2 tone off, 3..5 noise off (6, 7: ports, input)
    tones = []
    for ch, setup in enumerate(v["channels"]):
        role, volume = setup["role"], setup["volume"]
        tp, harmonic, exact, freq = 0, None, False, 0.0
        if role in ("F1", "F2", "F3"):
            i = int(role[1]) - 1
            tp, harmonic, exact = locked_period(formants[i], ep, v["lock"], v["shape"])
            freq = CLOCK / (16 * tp)
            mixer &= ~(1 << ch)
            level = max(0, min(15, 15 + round(levels[i] / 3)))
        else:
            level = 15
        if role == "off":
            vol = 0
        elif volume == "env" or role == "source":
            vol = 0x10
        elif volume == "level":
            vol = level
        else:
            vol = volume
        if ch in v["noise"]["channels"]:
            mixer &= ~(8 << ch)
        regs[2 * ch], regs[2 * ch + 1] = tp & 0xFF, tp >> 8
        regs[8 + ch] = vol
        tones.append({"role": role, "period": tp, "freq": round(freq, 1), "harmonic": harmonic, "exact": exact})
    regs[6] = v["noise"]["period"]
    regs[7] = mixer & 0x3F
    regs[11], regs[12] = ep & 0xFF, ep >> 8
    regs[13] = v["shape"]
    return {"regs": regs, "vowel": name, "pitch": round(envelope_pitch(ep, v["shape"]), 2),
            "targets": [round(x) for x in formants], "tones": tones}


# --- words (pronounce.py, phonemes.py) ----------------------------------------

SPEECH_LEVEL = {"F1": 14, "F2": 10, "F3": 6}   # "level" volumes in speech (about the vowels' averages)
STRESS_LENGTH = {1: 1.3, 2: 1.0, 0: 0.75}       # vowel length by stress
PITCH_SMOOTHING = 0.5                           # each frame moves this share of the way to its target


def speak(voice: dict, text: str, mode: str = "text") -> dict:
    """Frames for ``text`` (English, or ARPAbet when ``mode`` is "phonemes";
    see pronounce.py), with the phoneme spans and the words
    as pronounced (for the lab)."""
    from . import pronounce as PR
    from .phonemes import P
    v = voice_with_defaults(voice)
    tokens, words = (PR.parse_phonemes if mode == "phonemes" else PR.parse_text)(text)
    states = _phoneme_states(tokens, P, v["rate"])
    pitches = _intonation(v, states)
    out, spans = [], []
    for t, (state, f0) in enumerate(zip(states, pitches)):
        vib = v["vibrato"]
        f0 *= 1 + vib["depth"] * math.sin(2 * math.pi * vib["rate"] * t / FRAME_RATE)
        out.append(_speech_frame(v, state, f0))
        if state["first"]:
            stress = state.get("stress")
            spans.append({"label": state["label"] + ("" if stress is None else str(stress)), "start": t,
                          "word": state.get("word")})
    voiced_before = False
    for frame in out:
        voiced = any(r & 0x10 for r in frame["regs"][8:11])
        frame["shape"] = voiced and not voiced_before        # restart the envelope at each voice onset
        voiced_before = voiced
    return {"frames": out, "phonemes": spans, "words": words,
            "symbols": [s["label"] for s in spans]}


def _intonation(v: dict, states: list[dict]) -> list[float]:
    """The pitch of every frame: the voice's pitch (or a ^ mark's), falling
    through each phrase by ``fall``; stressed vowels raised by ``stress``
    (half for secondary stress); a question rising by ``question`` from its
    last stressed vowel; @pitch on a phoneme overrides; then smoothed."""
    into = v["intonation"]
    targets = [0.0] * len(states)
    start = 0
    while start < len(states):
        end = start
        while end < len(states) and states[end]["label"] != "pause":
            end += 1
        phrase = range(start, end)
        rise = end < len(states) and states[end].get("rise")
        last_stress = max((i for i in phrase if states[i].get("stress") == 1 and states[i]["first"]),
                          default=None)        # where the last stressed vowel begins
        for k, i in enumerate(phrase):
            s = states[i]
            pos = k / max(1, len(phrase) - 1)
            f0 = (s.get("base") or v["pitch"]) * (1 + into["fall"] / 2 - into["fall"] * pos)
            if s.get("stress") == 1:
                f0 *= 1 + into["stress"]
            elif s.get("stress") == 2:
                f0 *= 1 + into["stress"] / 2
            if rise and last_stress is not None and i >= last_stress:
                f0 *= 1 + into["question"] * (i - last_stress) / max(1, end - 1 - last_stress)
            targets[i] = s["pitch"] if s.get("pitch") else f0
        for i in range(end, len(states)):
            if states[i]["label"] != "pause":
                break
            targets[i] = targets[end - 1] if end > start else v["pitch"]
            end = i + 1
        start = max(end, start + 1)
    out, current = [], None
    for state, target in zip(states, targets):
        if current is None or state["label"] == "pause" or state.get("jump"):
            current = target
        else:
            current += (target - current) * PITCH_SMOOTHING
        out.append(current)
    return out


def _phoneme_states(tokens: list[dict], table: dict, rate: float = 1.0) -> list[dict]:
    """One state per frame: label, formants, voicing ("full", "murmur",
    "low", "bar" or None), noise ((period, volume) or None), and for the
    intonation the stress, an explicit pitch, the pitch base and the word.
    ``rate`` divides every length (sounds, closures, pauses, :frames) except
    the plosive bursts, which keep their one or two frames, and fixed pauses
    (``,:10``); nothing becomes shorter than one frame. A clock mark (``^c5``)
    sets the pitch base and multiplies the rate by 16 / (16 - clock); the
    first frame after it jumps to the new pitch."""
    from .pronounce import CLOCK_PITCH
    speed = rate

    def scaled(n, least=1):
        return max(least, round(n / speed))
    states: list[dict] = []
    last_f = None                       # formants where the last voiced sound ended, or a locus
    base = None                         # a ^ pitch mark in force
    jump = False                        # a clock mark: the next frame takes its pitch at once

    def add(tok, label, f, voice, noise, first):
        nonlocal jump
        states.append({"label": label, "f": f, "voice": voice, "noise": noise, "first": first,
                       "stress": tok.get("stress") if tok else None, "pitch": tok.get("pitch") if tok else None,
                       "base": base, "word": tok.get("word") if tok else None, "jump": jump})
        jump = False

    def next_formants(i):
        for t in tokens[i + 1:]:
            if "p" in t and table[t["p"]].get("f"):
                return table[t["p"]]["f"]
        return (500, 1500, 2500)

    def voiced(tok, target, frames, voice, glide, noise=None, f_end=None):
        nonlocal last_f
        start = last_f or target
        for k in range(frames):
            g = min(1.0, (k + 1) / glide) if glide else 1.0
            f = [_mix(a, b, g) for a, b in zip(start, target)]
            if f_end:                   # a diphthong moves on through its last two thirds
                d = max(0.0, (k - frames / 3) / (frames * 2 / 3))
                f = [_mix(a, b, d) for a, b in zip(f, f_end)]
            add(tok, tok["p"], f, voice, noise, k == 0)
        last_f = tuple(states[-1]["f"])

    for i, tok in enumerate(tokens):
        if tok.get("gap"):
            continue
        if "base" in tok:
            base = tok["base"]
            if base is None:
                speed = rate
            continue
        if "clock" in tok:
            base = CLOCK_PITCH / (16 - tok["clock"])
            speed = rate * 16 / (16 - tok["clock"])
            jump = True
            continue
        if "pause" in tok:
            for k in range(tok["pause"] if tok.get("fixed") else scaled(tok["pause"])):
                add(None, "pause", None, None, None, k == 0)
                states[-1]["rise"] = tok.get("rise", False)
            last_f = None
            continue
        p = table[tok["p"]]
        kind = p["kind"]
        frames = tok.get("frames") or p["frames"]
        if not tok.get("frames") and kind == "vowel" and tok.get("stress") is not None:
            frames = max(3, round(frames * STRESS_LENGTH[tok["stress"]]))
        frames = scaled(frames, 2 if kind == "vowel" else 1)
        if kind in ("vowel", "sonorant"):
            voiced(tok, p["f"], frames, "full", 4 if kind == "vowel" else 2, f_end=p.get("f2"))
        elif kind == "nasal":
            voiced(tok, p["f"], frames, "murmur", 2)
        elif kind == "fricative" and p.get("voiced"):
            voiced(tok, p["f"], frames, "low", 2, noise=(p["noise"], p["level"]))
        elif kind == "fricative":
            for k in range(frames):
                add(tok, tok["p"], None, None, (p["noise"], p["level"]), k == 0)
            if p.get("locus"):          # where the next vowel's formants start (as a plosive's)
                last_f = p["locus"]
        elif kind == "aspirate":
            for k in range(frames):
                add(tok, tok["p"], next_formants(i), None, (p["noise"], p["level"]), k == 0)
            last_f = next_formants(i)
        else:                           # plosive or affricate
            first = True
            for part in ([tok["p"]] if kind == "plosive" else list(p["parts"])):
                q = table[part]
                if q["kind"] == "fricative":
                    for k in range(scaled(max(1, q["frames"] - 2))):
                        add(tok, tok["p"], None, None, (q["noise"], q["level"]), False)
                    continue
                closure = scaled(tok.get("frames") or q["frames"] if kind == "plosive" else q["frames"])
                for k in range(closure):
                    add(tok, tok["p"], (250, 800, 2400) if q.get("voiced") else None,
                        "bar" if q.get("voiced") else None, None, first)
                    first = False
                for k in range(q["burst"]):
                    add(tok, tok["p"], None, None, (q["noise"], q["level"]), False)
                for k in range(scaled(q["aspirate"], 0)):
                    add(tok, tok["p"], None, None, (10, max(0, q["level"] - 4)), False)
                last_f = q["locus"]
    return states


def _speech_frame(v: dict, state: dict, f0: float) -> dict:
    """Registers for one speech state. Voicing "full" uses the voice's
    channel setup; "murmur" (nasals) F1 on the envelope with a weak steady
    F2; "low" (voiced fricatives) and "bar" (voiced closures) F1 alone on the
    envelope. Noise takes channel C, or B in the "shared" layout (which
    never sounds channel C)."""
    f, voice, noise = state["f"], state["voice"], state["noise"]
    shared = v["layout"] == "shared"
    if voice == "full" and shared:
        setups = [{"role": "F1", "volume": "env"}, {"role": "F2", "volume": "env"}, {"role": "off", "volume": 0}]
    elif voice == "full":
        setups = [dict(c) for c in v["channels"]]
    elif voice == "murmur":
        setups = [{"role": "F1", "volume": "env"}, {"role": "F2", "volume": 5}, {"role": "off", "volume": 0}]
    elif voice in ("low", "bar"):
        setups = [{"role": "F1", "volume": "env"}, {"role": "off", "volume": 0}, {"role": "off", "volume": 0}]
    else:
        setups = [{"role": "off", "volume": 0} for _ in range(3)]
    if noise:
        setups[1 if shared else 2] = {"role": "noise", "volume": noise[1]}
    # The voice's own noise (rasp, breath) on its chosen channels while it is voiced.
    rasp = voice == "full" and not noise and not shared and v["noise"]["channels"]
    formants = f or (500, 1500, 2500)
    ep = envelope_period(f0, v["shape"])
    regs = [0] * 14
    mixer = 0x3F
    tones = []
    for ch, setup in enumerate(setups):
        role, volume = setup["role"], setup["volume"]
        tp, harmonic, exact, freq = 0, None, False, 0.0
        if role in ("F1", "F2", "F3"):
            i = int(role[1]) - 1
            tp, harmonic, exact = locked_period(formants[i], ep, v["lock"], v["shape"])
            freq = CLOCK / (16 * tp)
            mixer &= ~(1 << ch)
        if role == "noise" or (rasp and ch in v["noise"]["channels"] and role != "off"):
            mixer &= ~(8 << ch)
        if role == "off":
            vol = 0
        elif volume == "env" or role == "source":
            vol = 0x10
        elif volume == "level":
            vol = SPEECH_LEVEL[role]
        else:
            vol = volume
        regs[2 * ch], regs[2 * ch + 1] = tp & 0xFF, tp >> 8
        regs[8 + ch] = vol
        tones.append({"role": role, "period": tp, "freq": round(freq, 1), "harmonic": harmonic, "exact": exact})
    regs[6] = noise[0] if noise else v["noise"]["period"] if rasp else 0
    regs[7] = mixer & 0x3F
    regs[11], regs[12] = ep & 0xFF, ep >> 8
    regs[13] = v["shape"]
    silent = not voice and not noise
    return {"regs": regs, "vowel": "-" if silent else state["label"],
            "pitch": round(envelope_pitch(ep, v["shape"]), 2),
            "targets": [round(x) for x in f] if f else [], "tones": tones}

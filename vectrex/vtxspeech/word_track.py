"""Word-track speech: the Verzerk cartridge format and its host player.

The voice model (``voice.py``) makes a word's frames at the arcade's clock 0;
this module stores each word as runs of identical *states*, not registers,
and plays phrases from them the way the cartridge does. It is the authority:
the 6809 player (examples/games/verzerk/vtx_speech.vtx) must produce exactly
the frames ``play`` produces, and the lab plays these frames for Verzerk.

A state is what the shared layout (F1 on A, F2 and noise on B, C left to the
game) needs for one frame: the voicing kind, the noise (period, volume) and
the two formants in 16 Hz units (one byte each, as ``voice.locked_period``
uses them). Registers follow from a state and the clock's envelope period
(``registers``), with the "nearest" harmonic lock.

Word data (one byte header per run, then its operands):

    header  bit 7  formant bytes follow (F1, then F2 for "full"/"murmur");
                   clear: the previous run's formants
            bit 6  a noise byte follows (an index into the noise table);
                   clear: no noise
            bits 5-4  kind: 0 silent, 1 full, 2 murmur (nasal), 3 low (F1 only)
            bits 3-0  frames - 1 at clock 0 (runs are split at 15 frames,
                   so $FF never occurs)
    $FF     end of word

Phrase data: $00-$7F a word number, $80-$87 clock 0..7, $88 a random clock
(the arcade's chatter), $89 n a1 .. an: say one of n alternatives at random
(each a 2-byte reference to a sequence ending with $FF, which returns; an
alternative holds no choice itself), $8A n a1 .. an: continue with one of n
phrases at random (an event with several phrases; no return), $C1-$FE a
pause of 1..62 frames, $FF end. A random draw is a byte r from the BIOS
Random; a clock is r & 7, a choice of n is (r * n) >> 8. On the cartridge a
reference is an address; here it is an index into ``alts``.

A clock sets the envelope period (pitch 1220 / (16 - c) Hz, ``CLOCK_EP``) and
the run lengths: a run of n clock-0 frames lasts max(1, (n * S + 128) >> 8)
frames, S = 16 * (16 - c) (``CLOCK_SCALE``): the arcade's chip slows down at
low clocks, every run keeps at least one frame (no plosive burst is lost).
A phrase starts at clock 0 until a clock token says otherwise.

The envelope restarts (R13 written) on a voiced frame after an unvoiced one.
"""
from __future__ import annotations

from . import voice as V
from .phonemes import P
from . import pronounce as PR

KINDS = {None: 0, "full": 1, "murmur": 2, "low": 3, "bar": 3}
CLOCK_PITCH = PR.CLOCK_PITCH
CLOCK_EP = tuple(V.envelope_period(CLOCK_PITCH / (16 - c)) for c in range(8))
CLOCK_SCALE = tuple(16 * (16 - c) for c in range(8))
MAX_RUN = 15
END = 0xFF
CLOCK, RANDOM_CLOCK, CHOOSE, PICK, PAUSE = 0x80, 0x88, 0x89, 0x8A, 0xC0
MIXER_OFF = 0x3F


def states(voice: dict, text: str, length: float = 1.0) -> list[tuple]:
    """A word's frames at clock 0 as states (kind, noise or None, q1, q2):
    formants the kind does not sound are 0, so equal sounds make equal
    states. ``length`` stretches the word (1.0: the voice model's lengths)."""
    v = V.voice_with_defaults(voice)
    tokens, _ = (PR.parse_phonemes(text[1:-1]) if text.startswith("/") else PR.parse_text(text))
    out = []
    for s in V._phoneme_states(tokens, P, v["rate"] / length):
        kind = KINDS[s["voice"]]
        f = s["f"] or (500, 1500, 2500)
        q1 = V.formant_units(f[0]) if kind else 0
        q2 = V.formant_units(f[1]) if kind in (1, 2) else 0
        out.append((kind, tuple(s["noise"]) if s["noise"] else None, q1, q2))
    return out


def runs(word_states: list[tuple]) -> list[tuple]:
    """(state, frames) runs of at most MAX_RUN frames."""
    out: list[list] = []
    for s in word_states:
        if out and out[-1][0] == s and out[-1][1] < MAX_RUN:
            out[-1][1] += 1
        else:
            out.append([s, 1])
    return [(s, n) for s, n in out]


def encode_word(word_runs: list[tuple], noises: list[tuple]) -> bytes:
    out = bytearray()
    q1 = q2 = None                       # the formants the decoder holds
    for (kind, noise, f1, f2), n in word_runs:
        header = (kind << 4) | (n - 1)
        body = bytearray()
        if (kind in (1, 2) and (f1, f2) != (q1, q2)) or (kind == 3 and f1 != q1):
            header |= 0x80
            body.append(f1)
            q1 = f1
            if kind in (1, 2):
                body.append(f2)
                q2 = f2
        if noise:
            header |= 0x40
            body.append(noises.index(noise))
        out.append(header)
        out += body
    out.append(END)
    return bytes(out)


def decode_word(data: bytes, noises: list[tuple], start: int = 0) -> list[tuple]:
    """Runs back from word data (what the cartridge reads)."""
    out, q1, q2, i = [], 0, 0, start
    while data[i] != END:
        h = data[i]
        i += 1
        kind, n = (h >> 4) & 3, (h & 15) + 1
        if h & 0x80:
            q1 = data[i]
            i += 1
            if kind in (1, 2):
                q2 = data[i]
                i += 1
        noise = None
        if h & 0x40:
            noise = noises[data[i]]
            i += 1
        out.append(((kind, noise, q1 if kind else 0, q2 if kind in (1, 2) else 0), n))
    return out


def run_frames(n: int, clock: int) -> int:
    return max(1, (n * CLOCK_SCALE[clock] + 128) >> 8)


def tone(q: int, ep: int) -> int:
    """The "nearest" lock with the formant already in 16 Hz units."""
    n = max(1, min(V.NEAREST_MAX, (q * ep * V.NEAREST_K + 32768) >> 16))
    return max(1, min(4095, (ep * V.NEAREST_RECIP[n] + 512) >> 10))


def registers(state: tuple, ep: int) -> list[int]:
    """R0..R13 for one state (shared layout; C silent: the game's)."""
    kind, noise, q1, q2 = state
    regs = [0] * 14
    mixer = MIXER_OFF
    if kind:
        tp = tone(q1, ep)
        regs[0], regs[1], regs[8] = tp & 0xFF, tp >> 8, 0x10
        mixer &= ~1
    if kind in (1, 2) and not noise:
        tp = tone(q2, ep)
        regs[2], regs[3], regs[9] = tp & 0xFF, tp >> 8, 0x10 if kind == 1 else 5
        mixer &= ~2
    if noise:
        regs[9] = noise[1]
        mixer &= ~0x10
    regs[6] = noise[0] if noise else 0
    regs[7] = mixer
    regs[11], regs[12], regs[13] = ep & 0xFF, ep >> 8, 8
    return regs


def phrase_states(phrase: bytes, words: list[bytes], noises: list[tuple],
                  random_bytes=None, alts: list[bytes] = ()) -> list[tuple]:
    """(state, clock) for every 50 Hz frame of a phrase. ``random_bytes``:
    an iterator of the random bytes the cartridge draws, in order (for $88,
    $89 and $8A); ``alts``: the sequences $89 and $8A refer to."""
    out, clock = [], 0
    data, i, back = phrase, 0, None

    def pick(n):
        return (next(random_bytes) * n) >> 8
    while True:
        b = data[i]
        i += 1
        if b == END:
            if back is None:
                break
            data, i, back = back[0], back[1], None
        elif b == RANDOM_CLOCK:
            clock = next(random_bytes) & 7
        elif b in (CHOOSE, PICK):
            n = data[i]
            refs = [data[i + 1 + 2 * k] << 8 | data[i + 2 + 2 * k] for k in range(n)]
            ref = refs[pick(n)]
            if b == CHOOSE:
                if back is not None:
                    raise ValueError("an alternative holds a choice")
                back = (data, i + 1 + 2 * n)
            data, i = alts[ref], 0
        elif CLOCK <= b < CLOCK + 8:
            clock = b - CLOCK
        elif b > PAUSE:
            out += [((0, None, 0, 0), clock)] * (b - PAUSE)
        elif b < 0x80:
            for state, n in decode_word(words[b], noises):
                out += [(state, clock)] * run_frames(n, clock)
        else:
            raise ValueError(f"bad phrase byte ${b:02X}")
    return out


def play(phrase: bytes, words: list[bytes], noises: list[tuple], random_bytes=None,
         alts: list[bytes] = ()) -> list[dict]:
    """The phrase's register frames: {"regs", "shape" (write R13), "state", "clock"}."""
    out, voiced_before = [], False
    for state, clock in phrase_states(phrase, words, noises, random_bytes, alts):
        regs = registers(state, CLOCK_EP[clock])
        voiced = state[0] != 0
        out.append({"regs": regs, "shape": voiced and not voiced_before, "state": state, "clock": clock})
        voiced_before = voiced
    return out

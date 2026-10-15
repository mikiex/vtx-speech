"""VTX Speech lab: English text and phoneme strings to phoneme tokens.

Text mode. Each word is looked up, in order, in:

1. ``PROJECT_WORDS`` below (names the dictionary does not know, or that the
   project wants said its own way);
2. the CMU Pronouncing Dictionary (vendored: ``vendor/cmudict.dict.gz``,
   about 135,000 words, BSD licence), which gives ARPAbet with stress
   (0 unstressed, 1 primary, 2 secondary);
3. a known word plus a common ending (-s, -es, 's, -ed, -ing, -er, -ers,
   -ly, -ness, -less; also with a dropped final e: "hoping" from "hope");
4. two known words run together ("airlockdoor" = "airlock" + "door");
5. letter-to-sound rules, which only guess and are reported as "guessed" so
   the text can be corrected with /phonemes/.

Numbers are read as words ("10" -> "ten"). Punctuation makes pauses: a
comma, semicolon or colon a short one, a full stop or "!" a long one, and a
"?" also makes the end of the phrase rise. ``,:10`` is a pause of exactly
10 frames (the speed does not change it). ``^150`` sets the voice's pitch
to 150 Hz from there on (``^`` alone goes back to the voice's own pitch and
speed). ``^c5`` sets the arcade Berzerk speech chip's clock 0..7: pitch
1220 / (16 - c) Hz and speed x 16 / (16 - c), both at once, jumping to the
new pitch rather than gliding. ``/HH AH0 L OW1/`` writes phonemes directly
inside text. ``live#2`` takes the dictionary's second pronunciation of a word
that has several ("live": L AY1 V, then L IH1 V; also read, lead, wind,
tear...): the dictionary cannot tell which one a sentence means. A few
common words default to their usual pronunciation, not the dictionary's
first (``PREFERRED``: "live" is "liv"; ``live#1`` is "lyve").

Phoneme mode: ARPAbet symbols with an optional stress digit, length in
frames and pitch: ``HH AH0 L OW1:15@140``; ``|`` between words, ``,`` and
``.`` pause, ``?`` rises; ``,:10``, ``^150`` and ``^c5`` as in text.

A token is a dict: {"p": symbol, "stress": 0/1/2 or None, "frames": int or
None, "pitch": Hz or None, "word": index} for a sound, or a marker:
{"gap": True} between words, {"pause": frames, "rise": bool, "fixed": bool}
for punctuation, {"base": Hz or None} for a pitch mark, {"clock": 0..7}
for a clock mark.
"""
from __future__ import annotations

import functools
import gzip
import re
from pathlib import Path

from .phonemes import P

VENDOR = Path(__file__).resolve().parents[2] / "vendor"     # the repository's vendor/ folder
SHORT_PAUSE, LONG_PAUSE = 8, 14
CLOCK_PITCH = 1220.0            # Hz x (16 - clock): arcade Berzerk's measured monotone

PROJECT_WORDS = {                # the same as js/speech.js
    "vectrex": "V EH1 K T R EH2 K S",
    "vtx": "V IY1 T IY1 EH1 K S",
    "ok": "OW2 K EY1",
    "ay": "EY1 W AY1",           # the chip's name, said as letters
}


# Words whose usual pronunciation is not the dictionary's first: the choice
# used when the text does not say (``live`` is "liv"; ``live#1`` is "lyve").
PREFERRED = {"live": 2, "read": 2, "lead": 2, "wind": 2, "wound": 2}


class SpeechError(ValueError):
    pass


@functools.lru_cache(maxsize=1)
def dictionary() -> dict[str, list[str]]:
    """CMUdict: word -> phonemes of its first pronunciation."""
    out: dict[str, list[str]] = {}
    with gzip.open(VENDOR / "cmudict.dict.gz", "rt", encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            word, *phones = line.split()
            if "(" not in word and word not in out:
                out[word] = phones
    return out


@functools.lru_cache(maxsize=1)
def variants() -> dict[str, list[list[str]]]:
    """CMUdict: word -> all its pronunciations, in the dictionary's order
    (only words that have more than one)."""
    out: dict[str, list[list[str]]] = {}
    with gzip.open(VENDOR / "cmudict.dict.gz", "rt", encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            word, *phones = line.split()
            out.setdefault(word.split("(")[0], []).append(phones)
    return {w: v for w, v in out.items() if len(v) > 1}


def _known(word: str) -> list[str] | None:
    if word in PROJECT_WORDS:
        return PROJECT_WORDS[word].split()
    return dictionary().get(word)


VOICELESS = {"P", "T", "K", "F", "TH"}
SIBILANT = {"S", "Z", "SH", "ZH", "CH", "JH"}


def _plural(phones):
    last = re.sub(r"\d", "", phones[-1])
    if last in SIBILANT:
        return phones + ["IH0", "Z"]
    return phones + (["S"] if last in VOICELESS else ["Z"])


def _past(phones):
    last = re.sub(r"\d", "", phones[-1])
    if last in ("T", "D"):
        return phones + ["IH0", "D"]
    return phones + (["T"] if last in VOICELESS | {"S", "SH", "CH"} else ["D"])


ENDINGS = (                          # (ending, how to add it)
    ("'s", _plural), ("es", _plural), ("s", _plural), ("ed", _past),
    ("ing", lambda p: p + ["IH0", "NG"]), ("ers", lambda p: p + ["ER0", "Z"]),
    ("er", lambda p: p + ["ER0"]), ("ly", lambda p: p + ["L", "IY0"]),
    ("ness", lambda p: p + ["N", "AH0", "S"]), ("less", lambda p: p + ["L", "AH0", "S"]),
)


def _derived(word: str) -> list[str] | None:
    for ending, add in ENDINGS:
        if word.endswith(ending) and len(word) > len(ending) + 2:
            root = word[:-len(ending)]
            for candidate in (root, root + "e", root[:-1] if len(root) > 3 and root[-1] == root[-2] else None):
                if candidate and (phones := _known(candidate)):
                    return add(list(phones))
    for cut in range(len(word) - 3, 2, -1):          # longest first part first
        first, second = _known(word[:cut]), _known(word[cut:])
        if first and second:
            return list(first) + list(second)
    return None


# Letter-to-sound guesses: (spelling, phonemes), longest spellings first;
# "V" in a vowel's phonemes marks where the stress digit goes.
_RULES = sorted([
    ("tion", "SH AH0 N"), ("sion", "ZH AH0 N"), ("ture", "CH ER0"), ("igh", "AY1"), ("tch", "CH"),
    ("sch", "S K"), ("ph", "F"), ("sh", "SH"), ("ch", "CH"), ("th", "TH"), ("ck", "K"), ("ng", "NG"),
    ("qu", "K W"), ("wh", "W"), ("kn", "N"), ("wr", "R"), ("ee", "IY1"), ("ea", "IY1"), ("oo", "UW1"),
    ("ou", "AW1"), ("ow", "OW1"), ("oi", "OY1"), ("oy", "OY1"), ("ai", "EY1"), ("ay", "EY1"),
    ("oa", "OW1"), ("au", "AO1"), ("aw", "AO1"), ("ew", "UW1"), ("ie", "IY1"), ("ey", "IY0"),
    ("a", "AE1"), ("e", "EH1"), ("i", "IH1"), ("o", "AA1"), ("u", "AH1"), ("y", "IY0"),
    ("b", "B"), ("c", "K"), ("d", "D"), ("f", "F"), ("g", "G"), ("h", "HH"), ("j", "JH"), ("k", "K"),
    ("l", "L"), ("m", "M"), ("n", "N"), ("p", "P"), ("q", "K"), ("r", "R"), ("s", "S"), ("t", "T"),
    ("v", "V"), ("w", "W"), ("x", "K S"), ("z", "Z"),
], key=lambda r: -len(r[0]))
_LONG = {"a": "EY1", "e": "IY1", "i": "AY1", "o": "OW1", "u": "UW1"}


def guess(word: str) -> list[str]:
    """Letter-to-sound rules: a rough guess. A vowel, one consonant and a
    final "e" make the vowel long ("vane"); the final "e" is then silent; c
    and g soften before e, i, y. Only the first vowel keeps its stress."""
    out, i, w = [], 0, word.lower()
    while i < len(w):
        if w[i] == "e" and i == len(w) - 1 and i > 1:
            break                                    # silent final e
        if w[i] in _LONG and i + 2 == len(w) - 1 and w[-1] == "e" and w[i + 1] not in "aeiouy":
            out.append(_LONG[w[i]])
            i += 1
            continue
        if w[i] in "cg" and i + 1 < len(w) and w[i + 1] in "eiy":
            out.append("S" if w[i] == "c" else "JH")
            i += 1
            continue
        for spelling, phones in _RULES:
            if w.startswith(spelling, i):
                out += phones.split()
                i += len(spelling)
                break
        else:
            i += 1                                   # not a letter we know
    stressed = False
    for n, ph in enumerate(out):
        if ph[-1].isdigit():
            out[n] = ph[:-1] + ("0" if stressed and ph[-1] == "1" else ph[-1])
            stressed = stressed or ph[-1] == "1"
    return out or ["AH0"]


def pronounce(word: str, choice: int = 1) -> tuple[list[str], str]:
    """(ARPAbet phonemes with stress, how: "project", "dictionary",
    "derived" or "guessed"); ``choice`` picks the dictionary's n-th
    pronunciation of a word that has several (1 is the first)."""
    w = word.lower().strip("'")
    if w in PROJECT_WORDS:
        return PROJECT_WORDS[w].split(), "project"
    if choice > 1 or (choice == 1 and w in PREFERRED):
        options = variants().get(w, [])
        if choice > len(options):
            raise SpeechError(f"{word!r} has {max(1, len(options))} pronunciation(s), not {choice}")
        return list(options[choice - 1]), "dictionary"
    if w in dictionary():
        return list(dictionary()[w]), "dictionary"
    derived = _derived(w)
    if derived:
        return derived, "derived"
    return guess(w), "guessed"


ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen " \
       "sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def number_words(n: int) -> list[str]:
    if n < 20:
        return [ONES[n]]
    if n < 100:
        return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if n < 1000:
        return [ONES[n // 100], "hundred"] + (["and"] + number_words(n % 100) if n % 100 else [])
    if n < 1_000_000:
        return number_words(n // 1000) + ["thousand"] + (number_words(n % 1000) if n % 1000 else [])
    return [d for c in str(n) for d in [ONES[int(c)]]]


def _symbol_token(text: str, word: int | None) -> dict:
    m = re.fullmatch(r"([A-Za-z]+)([012])?(?::(\d+))?(?:@(\d+(?:\.\d+)?))?", text)
    if not m or m.group(1).upper() not in P:
        raise SpeechError(f"unknown phoneme {text!r}; known: {' '.join(sorted(P))} "
                          f"(optionally with stress 0-2, :frames and @pitch, e.g. OW1:15@140)")
    return {"p": m.group(1).upper(), "stress": int(m.group(2)) if m.group(2) else None,
            "frames": int(m.group(3)) if m.group(3) else None,
            "pitch": float(m.group(4)) if m.group(4) else None, "word": word}


def _mark(token: str) -> dict | None:
    if re.fullmatch(r"[,.]:\d+", token):
        return {"pause": int(token[2:]), "rise": False, "fixed": True}
    if re.fullmatch(r"\^c[0-7]", token):
        return {"clock": int(token[2])}
    if token in (",", ";", ":"):
        return {"pause": SHORT_PAUSE, "rise": False}
    if token in (".", "!"):
        return {"pause": LONG_PAUSE, "rise": False}
    if token == "?":
        return {"pause": LONG_PAUSE, "rise": True}
    if token.startswith("^"):
        return {"base": float(token[1:]) if token[1:] else None}
    return None


def _join(tokens: list[dict], more: list[dict]) -> None:
    if tokens and "p" in tokens[-1] and more and "p" in more[0]:
        tokens.append({"gap": True})
    tokens += more


def parse_text(text: str) -> tuple[list[dict], list[dict]]:
    """(tokens, words: [{"word", "phonemes", "how"}]) for English text."""
    tokens: list[dict] = []
    words: list[dict] = []
    for found in re.finditer(r"/[^/]*/|[,.]:\d+|\^c[0-7]|\^\d*(?:\.\d+)?|\d+|[A-Za-z']+(?:#\d+)?|[.,!?;:]", text):
        part, span = found.group(), [found.start(), found.end()]
        mark = _mark(part)
        if mark:
            tokens.append(mark)
            continue
        if part.startswith("/"):
            n = len(words)
            words.append({"word": part, "phonemes": part[1:-1].split(), "how": "phonemes"})
            _join(tokens, [_symbol_token(s, n) for s in part[1:-1].split()])
            continue
        part, _, choice = part.partition("#")
        for w in (number_words(int(part)) if part.isdigit() else [part]):
            chosen = int(choice) if choice else PREFERRED.get(w.lower(), 1)
            phones, how = pronounce(w, chosen)
            n = len(words)
            # "variants" > 1: the lab lets the word cycle through them, rewriting text[span].
            words.append({"word": w, "phonemes": phones, "how": how, "span": span,
                          "variants": 1 if how == "project" else len(variants().get(w.lower().strip("'"), [])) or 1,
                          "choice": chosen, "preferred": PREFERRED.get(w.lower(), 1)})
            _join(tokens, [_symbol_token(s, n) for s in phones])
    if not any("p" in t for t in tokens):
        raise SpeechError("nothing to say")
    return tokens, words


def parse_phonemes(text: str) -> tuple[list[dict], list[dict]]:
    """(tokens, words) for phoneme mode: ARPAbet with stress, :frames and
    @pitch; "|" between words; , . ? pauses; ^Hz pitch marks."""
    tokens: list[dict] = []
    words: list[dict] = []
    current: list[dict] = []

    def end_word():
        nonlocal current
        if current:
            words.append({"word": f"#{len(words) + 1}", "phonemes": [t["p"] + (str(t["stress"]) if t["stress"] is not None else "")
                                                                      for t in current], "how": "phonemes"})
            _join(tokens, current)
            current = []

    for part in re.findall(r"[A-Za-z]+[012]?(?::\d+)?(?:@\d+(?:\.\d+)?)?|[,.]:\d+|\^c[0-7]|\^\d*(?:\.\d+)?|[|.,!?;:]", text):
        if part == "|":
            end_word()
            continue
        mark = _mark(part)
        if mark:
            end_word()
            tokens.append(mark)
            continue
        current.append(_symbol_token(part, len(words)))
    end_word()
    if not any("p" in t for t in tokens):
        raise SpeechError("nothing to say")
    return tokens, words

"""SpeakJet-style input: the chip's allophone codes as VTX Speech phonemes.

Text written for the SpeakJet speech chip (Magnevation; codes from its user
manual, "MSA Sound Allophone Component List") is turned into VTX Speech
phoneme text, which then goes through the usual word-track pipeline:

    \\HE \\EH \\LE \\OWWW            ->  HH EH L OW         ("hello")
    183 131 145 164               ->  the same, as codes

Each SpeakJet allophone becomes the nearest VTX phoneme, or two (the
R-coloured vowels and some diphthongs). Lengths are VTX Speech's own, except:

- \\FAST and \\SLOW play the next sound at 1/2 and 3/2 of its length;
- \\STRESS and \\RELAX make the next vowel stressed (longer) or unstressed;
- \\P0..\\P6 are pauses of 0, 100, 200, 700, 30, 60 and 90 ms, and
  \\DELAY n a pause of n x 10 ms (rounded to 20 ms frames);
- \\PITCH n is handled before this, by the exporters: in a phrase it becomes
  the nearest voice (^c0..^c7), splitting the run of codes there. Here it is
  read and ignored, like \\VOLUME, \\SPEED, \\BEND, \\PORTCTR, \\PORT,
  \\REPEAT, \\CALLPHRASE, \\GOTOPHRASE (each with its value), \\WAIT, \\SOFT
  and \\RESET. The exporters warn about \\SPEED, which the cartridge cannot keep.

The sound effects (codes 200-254) cannot be converted. js/speech.js has the
same table (speakJetToPhonemes); the two must agree.
"""
from __future__ import annotations

import re

from .phonemes import P

# Code -> mnemonic (SpeakJet user manual, allophones 128-199).
ALLOPHONES = {
    128: "IY", 129: "IH", 130: "EY", 131: "EH", 132: "AY", 133: "AX", 134: "UX", 135: "OH", 136: "AW",
    137: "OW", 138: "UH", 139: "UW", 140: "MM", 141: "NE", 142: "NO", 143: "NGE", 144: "NGO", 145: "LE",
    146: "LO", 147: "WW", 148: "RR", 149: "IYRR", 150: "EYRR", 151: "AXRR", 152: "AWRR", 153: "OWRR",
    154: "EYIY", 155: "OHIY", 156: "OWIY", 157: "OHIH", 158: "IYEH", 159: "EHLL", 160: "IYUW", 161: "AXUW",
    162: "IHWW", 163: "AYWW", 164: "OWWW", 165: "JH", 166: "VV", 167: "ZZ", 168: "ZH", 169: "DH", 170: "BE",
    171: "BO", 172: "EB", 173: "OB", 174: "DE", 175: "DO", 176: "ED", 177: "OD", 178: "GE", 179: "GO",
    180: "EG", 181: "OG", 182: "CH", 183: "HE", 184: "HO", 185: "WH", 186: "FF", 187: "SE", 188: "SO",
    189: "SH", 190: "TH", 191: "TT", 192: "TU", 193: "TS", 194: "KE", 195: "KO", 196: "EK", 197: "OK",
    198: "PE", 199: "PO",
}

# Mnemonic -> VTX phonemes (ARPAbet), by the manual's sample words.
SOUNDS = {
    "IY": ["IY"], "IH": ["IH"], "EY": ["EH"], "EH": ["EH"], "AY": ["AE"], "AX": ["AX"], "UX": ["AH"],
    "OH": ["AA"], "AW": ["AO"], "OW": ["OW"], "UH": ["UH"], "UW": ["UW"],
    "MM": ["M"], "NE": ["N"], "NO": ["N"], "NGE": ["NG"], "NGO": ["NG"],
    "LE": ["L"], "LO": ["L"], "WW": ["W"], "RR": ["R"],
    "IYRR": ["IY", "ER"], "EYRR": ["EH", "ER"], "AXRR": ["ER"], "AWRR": ["AA", "ER"], "OWRR": ["AO", "ER"],
    "EYIY": ["EY"], "OHIY": ["AY"], "OWIY": ["OY"], "OHIH": ["AY"], "IYEH": ["Y", "EH"], "EHLL": ["AX", "L"],
    "IYUW": ["Y", "UW"], "AXUW": ["AW"], "IHWW": ["UW"], "AYWW": ["AW"], "OWWW": ["OW"],
    "JH": ["JH"], "VV": ["V"], "ZZ": ["Z"], "ZH": ["ZH"], "DH": ["DH"],
    "BE": ["B"], "BO": ["B"], "EB": ["B"], "OB": ["B"], "DE": ["D"], "DO": ["D"], "ED": ["D"], "OD": ["D"],
    "GE": ["G"], "GO": ["G"], "EG": ["G"], "OG": ["G"],
    "CH": ["CH"], "HE": ["HH"], "HO": ["HH"], "WH": ["HH"], "FF": ["F"], "SE": ["S"], "SO": ["S"],
    "SH": ["SH"], "TH": ["TH"], "TT": ["T"], "TU": ["T"], "TS": ["T", "S"],
    "KE": ["K"], "KO": ["K"], "EK": ["K"], "OK": ["K"], "PE": ["P"], "PO": ["P"],
}
PAUSE_FRAMES = {0: 0, 1: 5, 2: 10, 3: 35, 4: 2, 5: 3, 6: 4}     # 0, 100, 200, 700, 30, 60, 90 ms
CONTROLS = {"FAST": 7, "SLOW": 8, "STRESS": 14, "RELAX": 15, "WAIT": 16, "SOFT": 18, "VOLUME": 20,
            "SPEED": 21, "PITCH": 22, "BEND": 23, "PORTCTR": 24, "PORT": 25, "REPEAT": 26,
            "CALLPHRASE": 28, "GOTOPHRASE": 29, "DELAY": 30, "RESET": 31}
WITH_VALUE = {20, 21, 22, 23, 24, 25, 26, 28, 29, 30}            # the next number is the command's value


# The other way: VTX phonemes -> the nearest SpeakJet allophones, for writing a
# phrase as SpeakJet codes. Consonants with a front and a back form (the
# manual's E and O allophones) take the form for the next vowel.
TO_SPEAKJET = {
    "IY": "IY", "IH": "IH", "EY": "EYIY", "EH": "EH", "AE": "AY", "AA": "OH", "AO": "AW", "OW": "OWWW",
    "UH": "UH", "UW": "UW", "AH": "UX", "AX": "AX", "ER": "AXRR", "AY": "OHIH", "AW": "AYWW", "OY": "OWIY",
    "W": "WW", "Y": "IY", "R": "RR", "M": "MM", "JH": "JH", "V": "VV", "Z": "ZZ", "ZH": "ZH", "DH": "DH",
    "CH": "CH", "F": "FF", "SH": "SH", "TH": "TH", "T": "TT",
    "L": ("LE", "LO"), "N": ("NE", "NO"), "NG": ("NGE", "NGO"), "B": ("BE", "BO"), "D": ("DE", "DO"),
    "G": ("GE", "GO"), "K": ("KE", "KO"), "P": ("PE", "PO"), "S": ("SE", "SO"), "HH": ("HE", "HO"),
}
FRONT = {"IY", "IH", "EY", "EH", "AE", "Y"}
FINAL_STOPS = {"B": ("EB", "OB"), "D": ("ED", "OD"), "G": ("EG", "OG"), "K": ("EK", "OK")}   # after the vowel


def from_phonemes(text: str) -> str:
    """VTX phoneme text ("HH AH0 L OW1 | W ER1 L D", stress, lengths and
    pitches allowed and dropped) -> SpeakJet codes. A consonant with front
    and back forms takes the form for the next vowel in its word; a stop with
    no vowel after it in its word takes the final form (EB/OB, ED/OD, EG/OG,
    EK/OK) for the vowel before it. Pauses (,:N) become the nearest SpeakJet
    pause; | between words is dropped."""
    out = []
    for word in text.split("|"):
        syms = []
        for t in word.split():
            m = re.fullmatch(r",:(\d+)", t)
            if m:
                syms.append(("pause", int(m[1])))
                continue
            m = re.fullmatch(r"([A-Za-z]+)[012]?(?::\d+)?(?:@[\d.]+)?", t)
            if not m or m[1].upper() not in TO_SPEAKJET:
                raise ValueError(f'"{t}" is not a phoneme')
            syms.append(("sound", m[1].upper()))
        vowels = [(i, v) for i, (k, v) in enumerate(syms) if k == "sound" and P[v]["kind"] == "vowel"]
        for i, (kind, value) in enumerate(syms):
            if kind == "pause":                    # the SpeakJet pause nearest in length
                best = min((p for p in PAUSE_FRAMES if PAUSE_FRAMES[p]), key=lambda p: abs(PAUSE_FRAMES[p] - value))
                out.append(f"\\P{best}")
                continue
            after = next((v for j, v in vowels if j > i), None)
            before = next((v for j, v in reversed(vowels) if j < i), None)
            if after is None and value in FINAL_STOPS:
                code = FINAL_STOPS[value][0 if before in FRONT else 1]
            else:
                code = TO_SPEAKJET[value]
                if isinstance(code, tuple):
                    code = code[0] if (after if after is not None else before) in FRONT else code[1]
            out.append("\\" + code)
    return " ".join(out)


def is_speakjet(text: str) -> bool:
    """SpeakJet text has at least one \\code token."""
    return any(t.startswith("\\") for t in text.split())


def _code(token: str) -> int:
    name = token.lstrip("\\").upper()
    if re.fullmatch(r"\d+", name):
        return int(name)
    if re.fullmatch(r"P[0-6]", name):
        return int(name[1])
    if name in CONTROLS:
        return CONTROLS[name]
    effect = re.fullmatch(r"([RABC])([0-9])|M([0-2])", name)      # sound effects R0..C9, M0..M2
    if effect:
        return 252 + int(effect[3]) if effect[3] else 200 + 10 * "RABC".index(effect[1]) + int(effect[2])
    for code, mnemonic in ALLOPHONES.items():
        if mnemonic == name:
            return code
    raise ValueError(f'"{token}" is not a SpeakJet code')


def to_phonemes(text: str) -> str:
    """SpeakJet text -> VTX phoneme text (for the phoneme parser)."""
    out: list[str] = []
    factor, stress = 1.0, None
    tokens = text.split()
    i = 0
    while i < len(tokens):
        code = _code(tokens[i])
        i += 1
        if code in WITH_VALUE:
            if i >= len(tokens) or not re.fullmatch(r"\\?\d+", tokens[i]):
                raise ValueError(f'"{tokens[i - 1]}" needs a value after it')
            value = int(tokens[i].lstrip("\\"))
            i += 1
            if code == 30 and round(value / 2) > 0:          # Delay: n x 10 ms
                out.append(f",:{round(value / 2)}")
            continue
        if code in PAUSE_FRAMES:
            if PAUSE_FRAMES[code]:
                out.append(f",:{PAUSE_FRAMES[code]}")
        elif code == 7:
            factor = 0.5
        elif code == 8:
            factor = 1.5
        elif code == 14:
            stress = 1
        elif code == 15:
            stress = 0
        elif code in ALLOPHONES:
            for sym in SOUNDS[ALLOPHONES[code]]:
                token = sym
                if P[sym]["kind"] == "vowel" and stress is not None:
                    token += str(stress)
                if factor != 1.0:
                    token += f":{max(1, round(P[sym]['frames'] * factor))}"
                out.append(token)
            factor, stress = 1.0, None
        elif 200 <= code <= 254:
            raise ValueError(f"SpeakJet sound effects ({code}) are not supported")
        elif code < 32:
            pass                                              # Wait, Soft, Reset: nothing to say
        else:
            raise ValueError(f'"{tokens[i - 1]}" is not a SpeakJet code')
    if not any(not t.startswith(",") for t in out):
        raise ValueError("the SpeakJet text says nothing")
    return " ".join(out)

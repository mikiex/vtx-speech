"""VTX Speech lab: how each phoneme sounds (a first, hand-made table).

Words become phonemes in pronounce.py.

ARPAbet symbols. Every phoneme becomes frames of a few kinds of sound the AY
can make once per 50 Hz frame (docs/speech/formant_speech.md):

    vowel / sonorant   formant tones voiced by the envelope (the voice)
    nasal              a low voiced murmur (F1) with a weak steady F2
    fricative          the noise generator on channel C (bright "s" =
                       short noise period, darker "sh", quiet "f"); voiced
                       fricatives add the voice underneath
    plosive            a closure (silence, or a quiet voice bar for b d g),
                       a burst of noise, and the next sound's formants
                       sliding in from the consonant's "locus"
    h                  quiet noise while the next vowel's formants start

Formants (Hz) are textbook adult male values (Peterson & Barney for the
vowels); durations are frames (20 ms). This is a starting point to be tuned
by ear and later by spectral analysis.
"""
from __future__ import annotations

# kind, formants (F1, F2, F3), duration in frames, extra fields.
P = {}


def _add(names, kind, f=None, frames=8, **extra):
    for name in names.split():
        P[name] = {"kind": kind, "f": f, "frames": frames, **extra}


# Vowels.
_add("IY", "vowel", (270, 2290, 3010), 9)
_add("IH", "vowel", (390, 1990, 2550), 7)
_add("EH", "vowel", (530, 1840, 2480), 8)
_add("AE", "vowel", (660, 1720, 2410), 10)
_add("AA", "vowel", (730, 1090, 2440), 10)
_add("AO", "vowel", (570, 840, 2410), 10)
_add("UH", "vowel", (440, 1020, 2240), 7)
_add("UW", "vowel", (300, 870, 2240), 9)
_add("AH", "vowel", (640, 1190, 2390), 7)
_add("ER", "vowel", (490, 1350, 1690), 9)
_add("AX", "vowel", (500, 1500, 2500), 4)             # schwa, unstressed
# Diphthongs: from f to f2.
_add("EY", "vowel", (530, 1840, 2480), 12, f2=(300, 2200, 2900))
_add("AY", "vowel", (730, 1090, 2440), 14, f2=(300, 2100, 2900))
_add("OW", "vowel", (570, 840, 2410), 12, f2=(330, 800, 2300))
_add("AW", "vowel", (730, 1090, 2440), 14, f2=(330, 800, 2300))
_add("OY", "vowel", (570, 840, 2410), 14, f2=(300, 2100, 2900))
# Glides and liquids: short voiced sounds that move into the next vowel.
_add("W", "sonorant", (290, 610, 2150), 5)
_add("Y", "sonorant", (260, 2070, 3020), 5)
_add("L", "sonorant", (360, 1050, 2880), 6)
_add("R", "sonorant", (310, 1060, 1380), 6)
# Nasals.
_add("M", "nasal", (250, 1000, 2200), 6)
_add("N", "nasal", (250, 1700, 2600), 6)
_add("NG", "nasal", (250, 2300, 2750), 6)
# Fricatives: noise period (smaller is brighter) and noise volume.
_add("S", "fricative", None, 8, noise=2, level=12)
_add("SH", "fricative", None, 8, noise=5, level=12)
_add("F", "fricative", None, 7, noise=3, level=7)
_add("TH", "fricative", None, 6, noise=3, level=6)
_add("Z", "fricative", (250, 1600, 2500), 7, noise=2, level=10, voiced=True)
_add("ZH", "fricative", (250, 1800, 2500), 7, noise=5, level=10, voiced=True)
_add("V", "fricative", (250, 1100, 2400), 6, noise=3, level=6, voiced=True)
_add("DH", "fricative", (250, 1400, 2500), 5, noise=3, level=5, voiced=True)
_add("HH", "aspirate", None, 4, noise=10, level=8)
# Plosives: closure frames, burst (noise period, volume, frames) and the
# formant locus the next sound slides from.
_add("P", "plosive", None, 4, noise=8, level=11, burst=1, aspirate=2, locus=(250, 800, 2200))
_add("B", "plosive", None, 3, noise=8, level=9, burst=1, aspirate=0, locus=(250, 800, 2200), voiced=True)
_add("T", "plosive", None, 4, noise=2, level=12, burst=1, aspirate=2, locus=(300, 1800, 2700))
_add("D", "plosive", None, 3, noise=2, level=10, burst=1, aspirate=0, locus=(300, 1800, 2700), voiced=True)
_add("K", "plosive", None, 4, noise=5, level=12, burst=2, aspirate=2, locus=(300, 2200, 2600))
_add("G", "plosive", None, 3, noise=5, level=10, burst=1, aspirate=0, locus=(300, 2200, 2600), voiced=True)
# Affricates: a plosive into a fricative.
_add("CH", "affricate", None, 3, parts=("T", "SH"))
_add("JH", "affricate", None, 3, parts=("D", "ZH"))

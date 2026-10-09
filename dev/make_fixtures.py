"""Write test/fixtures/parity.json from the reference voice model.

The reference is the VTX project's Python model (tools/vtx_speech). This
script is only for development: the site never runs Python.

    python dev/make_fixtures.py C:/path/to/VXT_VSCodeProject
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

from tools.vtx_speech import voice as V  # noqa: E402

SCREAM = "AE1:4@300 AA1:8@520 AA1:40@560 AA1:20@500 AA1:15@380 AA0:10@250"
CASES = [
    ({}, "Hello, world.", "text"),
    ({}, "Is the airlock open? Warning, alien on board.", "text"),
    ({}, "Self destruct in 10 minutes!", "text"),
    ({}, "I am the computer, you can not find me.", "text"),
    ({}, "The zorblax hoping airlockdoor jumped quickly.", "text"),
    ({}, "live live#1 read wind; the church judge thought", "text"),
    ({}, "^150 higher ,:10 ^ and back, 2026 years", "text"),
    ({}, "say /HH AH0 L OW1:15@140/ please", "text"),
    ({}, "HH AH0 L OW1:15@140 | W ER1 L D ?", "phonemes"),
    ({"lock": "off"}, "Speech on a sound chip.", "text"),
    ({"layout": "shared"}, "Seven sisters sang softly.", "text"),
    ({"shape": 10, "pitch": 140}, "A triangle envelope voice.", "text"),
    ({"rate": 1.7, "intonation": {"stress": 0.3, "fall": 0.4, "question": 0.6}}, "Fast and excited, is it?", "text"),
    ({"rate": 0.6, "vibrato": {"depth": 0.03, "rate": 6}}, "Slow with vibrato.", "text"),
    ({"pitch": 420, "vibrato": {"depth": 0.05, "rate": 9}, "intonation": {"stress": 0, "fall": 0, "question": 0},
      "channels": [{"role": "F1", "volume": "env"}, {"role": "F2", "volume": "env"}, {"role": "F3", "volume": 10}],
      "noise": {"period": 6, "channels": [2]}}, SCREAM, "phonemes"),
    ({"channels": [{"role": "F1", "volume": "env"}, {"role": "source", "volume": "env"}, {"role": "F2", "volume": 9}]},
     "Thank you very much.", "text"),
]

out = []
for voice, text, mode in CASES:
    r = V.speak(voice, text, mode)
    out.append({"voice": voice, "text": text, "mode": mode,
                "regs": [f["regs"] for f in r["frames"]],
                "shape": [f["shape"] for f in r["frames"]],
                "phonemes": [[p["label"], p["start"]] for p in r["phonemes"]],
                "words": [[w["word"], " ".join(w["phonemes"]), w["how"]] for w in r["words"]]})
path = HERE / "test" / "fixtures" / "parity.json"
path.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"{len(out)} cases, {sum(len(c['regs']) for c in out)} frames -> {path}")

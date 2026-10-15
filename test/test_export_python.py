"""The Python and JavaScript exporters write the same speech_data.asm.

    python test/test_export_python.py

Compares vectrex/export.py with vectrex/export.js on the example's phrases
and on the Verzerk phrase set (test/fixtures/vectrex_export.json), apart
from the header line that names the tool. Needs Node.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vectrex"))
import export  # noqa: E402


def without_tool_line(text: str) -> list[str]:
    return [line for k, line in enumerate(text.splitlines()) if k != 1]


class ExportersAgree(unittest.TestCase):
    def compare(self, source: str) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            phrases = Path(tmp) / "phrases.txt"
            phrases.write_text(source, encoding="utf-8")
            js_out, py_out = Path(tmp) / "js.asm", Path(tmp) / "py.asm"
            subprocess.run(["node", str(ROOT / "vectrex" / "export.js"), str(phrases), str(js_out)],
                           check=True, capture_output=True)
            subprocess.run([sys.executable, str(ROOT / "vectrex" / "export.py"), str(phrases), str(py_out)],
                           check=True, capture_output=True)
            self.assertEqual(without_tool_line(py_out.read_text(encoding="utf-8")),
                             without_tool_line(js_out.read_text(encoding="utf-8")))

    def test_example(self):
        self.compare((ROOT / "vectrex" / "example" / "phrases.txt").read_text(encoding="utf-8"))

    def test_verzerk_phrase_set(self):
        fixture = json.loads((ROOT / "test" / "fixtures" / "vectrex_export.json").read_text(encoding="utf-8"))
        self.compare(fixture["source"])

    def test_speakjet_input(self):
        self.compare(r"""
@hello  = \HE \EH \LE \OWWW
@robot  = 148 137 \BO \OH \TT
@live   = live#2
Say_A   = ^c3 hello robot
Say_B   = ^c5 \FAST \IYRR \P2 \STRESS \EH \PITCH 88 \DELAY 25 \SE world
Say_C   = ^c? {\KE \OHIY \TT|hello} live and live
""")
        c = export.compile_phrases(r"Bad = \HE \XX" + "\nFx = \\R0 hello")
        self.assertIn('word "\\he \\xx": "\\xx" is not a SpeakJet code', c["problems"])
        self.assertIn('word "\\r0": SpeakJet sound effects (200) are not supported', c["problems"])

    def test_settings_and_inline_phonemes(self):
        source = r"""
#speed 1.3
#voices 70 160
@vtx   = /V IY1 T IY1 EH1 K S/
Say_A  = ^c2 hello /W ER1 L D/ vtx
Say_B  = ^c? {/HH AY1/|hello there} ,:5 /G UH1 D B AY1/
"""
        self.compare(source)
        c = export.compile_phrases(source)
        self.assertEqual(c["settings"], {"speed": 1.3, "voices": [70.0, 160.0]})
        self.assertEqual(c["clock_ep"][0], round(1500000 / (256 * 70)))
        self.assertIn("/w er1 l d/", c["names"])
        bad = export.compile_phrases("#speed 9\nSay = /HH AH0\n")["problems"]
        self.assertIn("line 1: write #speed 0.5..2, #voices low high (30..600 Hz, low < high) or #voicespeed flat", bad)
        self.assertIn('line 2: a phoneme group "/hh ah0" needs its closing /', bad)

    def test_shall_we_play_example(self):
        source = (ROOT / "vectrex" / "example" / "shall_we_play.txt").read_text(encoding="utf-8")
        self.compare(source)
        c = export.compile_phrases(source)
        self.assertEqual(c["clock_scale"], [128] * 8)
        self.assertEqual(c["warnings"], [])
        warned = export.compile_phrases("Say_A = ^c3 /HH AH0 L OW1@140/")["warnings"]
        self.assertEqual(warned, ['word "/hh ah0 l ow1@140/": @pitch is not kept on the cartridge (only the voice, ^c0..^c7, sets the pitch)'])

    def test_speakjet_pitch_becomes_voices(self):
        source = r"""
#voicespeed flat
@robot = \RR \PITCH 90 \OW
Say_A  = \HE \PITCH 120 \EH \LE \PITCH 70 \OWWW world
Say_B  = ^c3 {\PITCH 140 \KE \OHIY \TT|hello} \SPEED 90 \IY 22 88
"""
        self.compare(source)
        c = export.compile_phrases(source)
        items = {s["label"]: s["items"] for s in c["seqs"]}
        self.assertEqual(items["Say_A"][1], export.CLOCK + 6)          # 120 Hz: voice 6 (122 Hz)
        self.assertEqual(items["Say_A"][3], export.CLOCK + 0)          # 70 Hz: voice 0 (76 Hz)
        self.assertEqual(items["VS_Alt_0"][0], export.CLOCK + 7)       # 140 Hz: voice 7 (136 Hz)
        self.assertEqual(c["warnings"], [
            r"SpeakJet \SPEED is not kept: the cartridge has no speed per phrase (use #speed)",
            'word "robot": SpeakJet \\PITCH inside a word is ignored; write the codes in the phrase'])
        flat = export.compile_phrases("Say = \\HE \\PITCH 120 \\EH")["warnings"]
        self.assertEqual(flat, [r"SpeakJet \PITCH picks voices, which also change the speed; add #voicespeed flat to keep the timing"])

    def test_problems_are_reported(self):
        c = export.compile_phrases("Bad = ,:99 hello\nb = hello\nNothing = ^c3")
        self.assertIn("line 1: a pause is 1..62 frames", c["problems"])
        self.assertIn('line 2: "b" is not a usable assembler label', c["problems"])
        self.assertIn("line 3: says nothing", c["problems"])
        spaced = export.compile_phrases("Say Hello there = hello")["problems"]
        self.assertEqual(spaced, ["line 1: a label can't have spaces: try \"Say_Hello_there\""])
        reserved = export.compile_phrases("VS_Words = hello\nSpeech_Init = hi\n")["problems"]
        self.assertEqual(reserved, ['line 1: "VS_Words": labels starting VS_ or Speech_ belong to the player',
                                    'line 2: "Speech_Init": labels starting VS_ or Speech_ belong to the player'])


if __name__ == "__main__":
    unittest.main()

"""Write test/fixtures/vectrex_export.json from the VTX project's exporter.

The reference is tools/vtx_speech/verzerk_speech.py (compile_project) on the
Verzerk speech project: its words, noise table and phrase bytes. The site's
exporter (js/vectrex_export.js) must produce the same bytes from the same
phrases (test/vectrex_export.test.js).

    python dev/make_export_fixture.py C:/path/to/VXT_VSCodeProject
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

from tools.vtx_speech import verzerk_speech as VS  # noqa: E402

project = VS.load()
c = VS.compile_project(project)
lines = ["; The Verzerk speech project, as a phrase list"]
for name, w in project["words"].items():
    lines.append(f"@{name} = {w['say']} *{w.get('length', 1.0)}")
labels = []
for p in VS.phrases(project):
    label = f"P_{p['event']}_{p['index']}"
    labels.append(label)
    lines.append(f"{label} = {p['text']}")
# The reference's sequences in order: its phrases and their shared alternatives
# (the event sets that follow them are Verzerk's own and not compared).
count = max(p["seq"] for p in c["phrases"]) + 1
out = {
    "source": "\n".join(lines) + "\n",
    "word_order": c["names"],
    "noises": [list(n) for n in c["noises"]],
    "words": [w.hex() for w in c["words"]],
    "seqs": [{"label": s["label"], "bytes": s["bytes"].hex()} for s in c["seqs"][:count]],
}
path = HERE / "test" / "fixtures" / "vectrex_export.json"
path.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")
print(f"{len(c['names'])} words, {count} sequences -> {path}")

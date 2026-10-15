"""The editor's server: every endpoint, on a scratch phrase file.

    python test/test_editor.py
"""
import json
import os
import shutil
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vectrex"))
import editor  # noqa: E402

WORK = ROOT / "build" / "test_editor"


class EditorServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if WORK.exists():
            shutil.rmtree(WORK)
        WORK.mkdir(parents=True)
        editor.Handler.project = editor.Project(WORK / "phrases.txt")      # made from the example
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), editor.Handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def call(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data is not None else {}
        with urllib.request.urlopen(urllib.request.Request(self.url + path, data=data, headers=headers)) as r:
            return json.loads(r.read())

    def test_pages_are_served(self):
        for path in ("/", "/editor.js", "/editor.css", "/render.js", "/ayumi.js"):
            with urllib.request.urlopen(self.url + path) as r:
                self.assertEqual(r.status, 200, path)

    def test_project_and_listening(self):
        p = self.call("/api/project")
        self.assertIn("Say_Game", p["source"])
        self.assertEqual([x["label"] for x in p["report"]["phrases"]], ["Say_Game", "Say_Hello", "Say_Alert", "Say_Taunt"])
        f = self.call("/api/frames", {"source": p["source"], "label": "Say_Taunt", "voice": "random"})
        self.assertGreater(len(f["frames"]), 20)
        self.assertEqual(len(f["frames"][0]["regs"]), 14)
        f = self.call("/api/frames", {"source": p["source"], "word": "alert", "voice": 2})
        self.assertTrue(all(x["clock"] == 2 for x in f["frames"]))

    def test_pronunciations_and_speakjet(self):
        source = "@live = live#1\nSay_Live = live \\HE \\EH \\LE \\OWWW zorblax\n"
        r = self.call("/api/compile", {"source": source})
        words = {w["name"]: w for w in r["words"]}
        self.assertEqual((words["live"]["phonemes"], words["live"]["choice"], words["live"]["variants"]), ("L AY1 V", 1, 2))
        self.assertEqual((words["\\he \\eh \\le \\owww"]["how"], words["\\he \\eh \\le \\owww"]["phonemes"]), ("SpeakJet", "HH EH L OW"))
        self.assertEqual(words["zorblax"]["how"], "guessed")

    def test_other_sites_are_refused(self):
        before = (WORK / "phrases.txt").read_text(encoding="utf-8")
        attempts = [
            ({"Content-Type": "text/plain"}, "a simple cross-site POST"),
            ({"Content-Type": "application/json", "Origin": "https://evil.example"}, "another site's page"),
            ({"Content-Type": "application/json", "Host": "evil.example"}, "a rebound host name"),
        ]
        for headers, what in attempts:
            req = urllib.request.Request(self.url + "/api/save", data=json.dumps({"source": "Say_X = gotcha"}).encode(),
                                         headers=headers)
            with self.assertRaises(urllib.error.HTTPError, msg=what) as caught:
                urllib.request.urlopen(req)
            self.assertEqual(caught.exception.code, 403, what)
        self.assertEqual((WORK / "phrases.txt").read_text(encoding="utf-8"), before)

    def test_problems(self):
        r = self.call("/api/compile", {"source": "Bad = ,:99 hello"})
        self.assertEqual(r["problems"], ["line 1: a pause is 1..62 frames"])

    def test_save_export_build(self):
        source = (WORK / "phrases.txt").read_text(encoding="utf-8") + "Say_More = ^c4 one more\n"
        r = self.call("/api/export", {"source": source})
        self.assertEqual(r["problems"], [])
        self.assertIn("Say_More:", (WORK / "speech_data.asm").read_text(encoding="utf-8"))
        self.assertTrue(list((WORK / ".editor_backups").glob("phrases_*.txt")), "the old file is backed up")
        if sys.platform == "win32":
            r = self.call("/api/build", {"source": source})
            self.assertEqual(r["problems"], [])
            self.assertGreater(r["bytes"], 1500)


class RunInMame(unittest.TestCase):
    """/api/run builds the test cartridge and opens it in MAME (stubbed: no window)."""

    def test_run_builds_and_launches(self):
        if sys.platform != "win32":
            self.skipTest("building needs Windows")
        import mame_check
        launched = []
        real = mame_check.launch
        mame_check.launch = lambda cart, mame=None: launched.append(Path(cart)) or {"started": True, "pid": 1, "mame": "stub"}
        (WORK / "run").mkdir(parents=True, exist_ok=True)
        before = editor.Handler.project
        editor.Handler.project = editor.Project(WORK / "run" / "phrases.txt")
        server = ThreadingHTTPServer(("127.0.0.1", 0), editor.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}"
            source = (WORK / "run" / "phrases.txt").read_text(encoding="utf-8")
            req = urllib.request.Request(url + "/api/run", data=json.dumps({"source": source}).encode(),
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req) as r:
                out = json.loads(r.read())
        finally:
            server.shutdown()
            server.server_close()
            mame_check.launch = real
            editor.Handler.project = before
        self.assertTrue(out["started"])
        self.assertEqual(len(launched), 1)
        self.assertEqual(launched[0].name, "speech_test.bin")
        self.assertTrue(launched[0].exists())


class FindingMame(unittest.TestCase):
    """mame_check's search order and remembering, with a scratch settings file."""

    def setUp(self):
        import mame_check
        self.mc = mame_check
        self.known = mame_check.find()                 # this machine's MAME, if any
        self.saved_file, self.saved_env = mame_check.SETTINGS_FILE, dict(os.environ)
        mame_check.SETTINGS_FILE = WORK / "settings.json"
        if mame_check.SETTINGS_FILE.exists():
            mame_check.SETTINGS_FILE.unlink()
        os.environ.pop("MAME_PATH", None)
        os.environ["PATH"] = ""
        self.saved_common, mame_check.COMMON = mame_check.COMMON, []

    def tearDown(self):
        self.mc.SETTINGS_FILE, self.mc.COMMON = self.saved_file, self.saved_common
        os.environ.clear()
        os.environ.update(self.saved_env)

    def test_not_found_asks(self):
        found = self.mc.find()
        self.assertFalse(found["found"])
        self.assertIn("MAME not found", found["problem"])

    def test_a_bad_path_is_refused(self):
        r = self.mc.remember(str(WORK / "no_such_mame.exe"))
        self.assertFalse(r["found"])
        self.assertFalse(self.mc.SETTINGS_FILE.exists())

    def test_remembered_and_env(self):
        if not self.known["found"]:
            self.skipTest("MAME is not known on this machine")
        os.environ["MAME_PATH"] = self.known["path"]
        self.assertEqual(self.mc.find()["source"], "MAME_PATH")
        del os.environ["MAME_PATH"]
        r = self.mc.remember(self.known["path"])
        self.assertTrue(r["found"])
        self.assertEqual(json.loads(self.mc.SETTINGS_FILE.read_text())["mame"], str(Path(self.known["path"]).resolve()))
        self.assertEqual(self.mc.find()["source"], "saved")


if __name__ == "__main__":
    unittest.main()

"""Smoke test of the example cartridge in MAME: it boots, shows its text,
and button 1 starts a phrase that plays to the end.

    python dev/example_smoke.py C:/path/to/VXT_VSCodeProject [cartridge.asm]

(default: vectrex/example/example.asm; the editor's test cartridge works too)

Builds vectrex/example/example.asm with AS09, runs it in MAME, presses
button 1 once, and records a snapshot and the sound under
build/example_smoke/.
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
VTX = Path(sys.argv[1]).resolve()
for d in (VTX, VTX / "src"):
    sys.path.insert(0, str(d))
from src.emulator import MameRunner  # noqa: E402

OUT = HERE / "build" / "example_smoke"
SOURCE = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else HERE / "vectrex" / "example" / "example.asm"


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    work = OUT / "src"
    shutil.copytree(SOURCE.parent, work)
    for where in (OUT, work):          # example.asm includes ../vtx_speech.asm, a test cartridge vtx_speech.asm
        shutil.copy(HERE / "vectrex" / "vtx_speech.asm", where / "vtx_speech.asm")
    shutil.copy(VTX / "as09_14.exe", work / "as09_14.exe")
    subprocess.run([str(work / "as09_14.exe"), "-w200", "-h0", "-l", "-mctiz", SOURCE.name], cwd=work,
                   capture_output=True, text=True)
    lst = (work / SOURCE.with_suffix(".lst").name).read_text(errors="replace")
    if "No errors in pass 2" not in lst:
        raise SystemExit("AS09 failed")
    sym = lambda n: int(re.search(rf"^\s*{n}\s*:\s*\$([0-9A-Fa-f]{{4}})", lst, re.M)[1], 16)  # noqa: E731
    state, done = sym("VS_RAM") + 20, sym("VS_Done")
    script = OUT / "smoke.lua"
    script.write_text(f"""local mem = manager.machine.devices[":maincpu"].spaces["program"]
local button, start, said, spoke = nil, nil, false, 0
local function now() return manager.machine.time:as_double() end
emu.register_frame_done(function()
  if button == nil then
    for tag, port in pairs(manager.machine.ioport.ports) do for f, fld in pairs(port.fields) do
      if tag == ":BUTTONS" and f == "P1 Button 1" then button = fld end end end
  end
  local t = now()
  local s = mem:read_u16(0x{state:04X})
  if start == nil and s == 0x{done:04X} then start = t print(string.format("RUNNING %.2f", t)) end
  if start then
    local dt = t - start
    if dt >= 1.0 and dt < 1.1 then manager.machine.video:snapshot() end
    if button then button:set_value((dt >= 1.5 and dt < 1.7) and 1 or 0) end
    if dt >= 1.5 and s ~= 0x{done:04X} then spoke = spoke + 1 end
    if dt >= 1.5 and spoke > 0 and s == 0x{done:04X} and not said then
      said = true print(string.format("SPOKE %d frames, silent again at %.2f", spoke, dt)) end
    if dt >= 6 then manager.machine:exit() end
  end
end)
""", encoding="utf-8")
    result = MameRunner(headless=False, seconds_to_run=30, extra_args=(
        "-autoboot_script", str(script.resolve()), "-snapshot_directory", str(OUT.resolve()),
        "-snapsize", "750x938", "-video", "none", "-nothrottle", "-wavwrite", str(OUT / "example.wav"),
        "-oslog")).run(work / SOURCE.with_suffix(".bin").name)
    text = (result.stdout or "") + (result.stderr or "")
    lines = [l for l in text.splitlines() if l.startswith(("RUNNING", "SPOKE"))]
    print("\n".join(lines) or text[-2000:])
    print("snapshots:", [p.relative_to(HERE).as_posix() for p in OUT.rglob("*.png")])
    sys.exit(0 if any(l.startswith("SPOKE") for l in lines) else 1)


if __name__ == "__main__":
    main()

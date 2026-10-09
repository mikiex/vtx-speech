// AY-family machines and a rough per-frame cost model for the speech player.
//
// Only the Vectrex figure is measured (the VTX player in the MAME emulator:
// mean 641, max 1,103 cycles). The Vectrex coefficients are fitted to it: on
// similar phrases (two formants, noise on B) the model gives 578 / 1,080.
// The fixed cost includes what that player also does (real-time catch-up,
// phrase decoding, sharing the chip with game sound). The other machines
// are estimates from instruction timings for the same steps, with the fixed
// part scaled from the Vectrex fit. None of them has been built.
//   cost per frame = base + lock * formants locked + write * registers written
(function (root) {
  "use strict";
  const MACHINES = [
    {
      id: "vectrex", name: "Vectrex", chip: "AY-3-8912", clock: 1500000, ym: false,
      cpu: "6809, 1.5 MHz", unit: "cycles", frame: 30000, frameNote: "1.5 MHz / 50 Hz",
      base: 330, lock: 130, write: 35, samples: 0.32,
      measured: { mean: 641, p95: 814, max: 1103 },
      access: "The AY sits behind the VIA's port A; writing one register through the BIOS costs about 35–45 cycles.",
      notes: "Hardware MUL (11 cycles) makes the lock cheap. Measured: the VTX cartridge player (F1 and F2, noise on B), MAME.",
    },
    {
      id: "spectrum", name: "ZX Spectrum 128", chip: "AY-3-8912", clock: 1773400, ym: false,
      cpu: "Z80, 3.55 MHz", unit: "T-states", frame: 70908, frameNote: "128K frame",
      base: 720, lock: 320, write: 55, samples: 0.25,
      access: "OUT to $FFFD selects a register, OUT to $BFFD writes it: about 40 T-states plus fetching the value.",
      notes: "No multiply instruction; a 512-byte quarter-squares table keeps each 8x8 multiply near 70 T-states. Run it from the 50 Hz interrupt.",
    },
    {
      id: "cpc", name: "Amstrad CPC", chip: "AY-3-8912", clock: 1000000, ym: false,
      cpu: "Z80, 4 MHz (stretched to 1 µs steps)", unit: "µs (NOPs)", frame: 19968, frameNote: "312 lines × 64 µs",
      base: 220, lock: 95, write: 28, samples: 0.32,
      access: "The AY is reached through the 8255 PPI: select and write take several OUTs each, the slowest register access of the four.",
      notes: "The 1 MHz AY clock gives coarser pitch steps (about 2.8% near 110 Hz against 1.9% on the Vectrex). Use one of the six 300 Hz interrupts.",
    },
    {
      id: "msx", name: "MSX", chip: "AY-3-8910 (PSG)", clock: 1789773, ym: false,
      cpu: "Z80, 3.58 MHz", unit: "T-states", frame: 71364, frameNote: "50 Hz machine (60 Hz: 59,736)",
      base: 790, lock: 350, write: 50, samples: 0.25,
      access: "OUT ($A0) selects, OUT ($A1) writes; MSX adds a wait state to every instruction fetch.",
      notes: "Japanese and American machines run at 60 Hz: retime the frames (or skip one update in six) so speech keeps its speed.",
    },
    {
      id: "st", name: "Atari ST", chip: "YM2149", clock: 2000000, ym: true,
      cpu: "68000, 8 MHz", unit: "cycles", frame: 160256, frameNote: "PAL frame",
      base: 550, lock: 300, write: 36, samples: 0.15,
      access: "Write the register number to $FF8800 and the value to $FF8802; MOVEP can send two at once.",
      notes: "The YM2149's envelope has 32 steps instead of 16 and a different volume curve: a smoother buzz. MULU is slow (up to 70 cycles) but the frame is large. (The 8-bit Ataris have POKEY, not an AY.)",
    },
  ];

  // Cost of one frame: {formants locked, registers written} -> units.
  function frameCost(m, locks, writes, lockOff) {
    return m.base + (lockOff ? m.lock * 0.15 : m.lock) * locks + m.write * writes;
  }

  // Mean and maximum over a phrase's frames (silent frames included).
  function phraseCost(m, result, writes, lockOff) {
    let sum = 0, max = 0;
    result.frames.forEach((fr, i) => {
      const locks = fr.tones.filter((t) => /^F[123]$/.test(t.role)).length;
      const c = frameCost(m, locks, writes[i], lockOff);
      sum += c;
      max = Math.max(max, c);
    });
    const mean = result.frames.length ? sum / result.frames.length : 0;
    return { mean, max, meanShare: mean / m.frame, maxShare: max / m.frame };
  }

  const api = { MACHINES, frameCost, phraseCost };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Machines = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

// Register frames -> sound (through Ayumi) and measurements of that sound.
// Works in the browser (window.Render) and in Node (module.exports).
(function (root) {
  "use strict";
  const FRAME_RATE = 50;
  const GAIN = 0.66;            // three loud channels sum to about 1.5 in Ayumi

  // frames: [{regs: R0..R13, shape: write R13}], chip: {clock, ym}.
  function render(frames, rate, chip, Ayumi) {
    const ay = new Ayumi();
    ay.configure(!!chip.ym, chip.clock, rate);
    for (let i = 0; i < 3; i++) ay.setPan(i, 0.5, false);
    const edge = (n) => Math.round(n * rate / FRAME_RATE);
    const out = new Float32Array(edge(frames.length));
    let k = 0;
    frames.forEach((frame, n) => {
      const r = frame.regs;
      for (let i = 0; i < 3; i++) {
        ay.setTone(i, r[2 * i] | ((r[2 * i + 1] & 0x0f) << 8));
        ay.setMixer(i, (r[7] >> i) & 1, (r[7] >> (i + 3)) & 1, (r[8 + i] >> 4) & 1);
        ay.setVolume(i, r[8 + i] & 0x0f);
      }
      ay.setNoise(r[6]);
      ay.setEnvelope(r[11] | (r[12] << 8));
      if (frame.shape) ay.setEnvelopeShape(r[13]);    // writing R13 restarts the envelope
      for (let s = edge(n); s < edge(n + 1); s++) {
        ay.process();
        ay.removeDC();
        out[k++] = Math.max(-1, Math.min(1, ay.left * GAIN));
      }
    });
    return out;
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const h = i + k + len / 2;
          const vr = re[h] * cr - im[h] * ci, vi = re[h] * ci + im[h] * cr;
          re[h] = re[i + k] - vr; im[h] = im[i + k] - vi;
          re[i + k] += vr; im[i + k] += vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }

  const hann = (size) => Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));

  // Average power spectrum of samples[from, to) (Hann windows, half overlap).
  function spectrum(samples, rate, from, to, size = 8192) {
    const power = new Float64Array(size / 2), w = hann(size);
    let count = 0;
    for (let s = Math.max(0, from); s + size <= Math.min(to, samples.length); s += size / 2, count++) {
      const re = new Float64Array(size), im = new Float64Array(size);
      for (let i = 0; i < size; i++) re[i] = samples[s + i] * w[i];
      fft(re, im);
      for (let i = 0; i < size / 2; i++) power[i] += re[i] * re[i] + im[i] * im[i];
    }
    if (count) for (let i = 0; i < power.length; i++) power[i] /= count;
    return { power, hz: rate / size, count };
  }

  // Share of the 60 Hz..5 kHz energy within 6 Hz of a harmonic of f0:
  // near 1 for a periodic (buzzing) sound.
  function harmonicity(spec, f0) {
    let on = 0, all = 0;
    for (let i = 1; i < spec.power.length; i++) {
      const f = i * spec.hz;
      if (f < 60 || f > 5000) continue;
      all += spec.power[i];
      const h = f / f0;
      if (Math.abs(h - Math.round(h)) * f0 < 6) on += spec.power[i];
    }
    return all ? on / all : 0;
  }

  // One column per 50 Hz frame: dB power in `bins` bands up to maxHz.
  function spectrogram(samples, rate, frames, maxHz = 4000, size = 1024) {
    const hop = rate / FRAME_RATE, w = hann(size), cols = [];
    const top = Math.min(size / 2, Math.ceil(maxHz / (rate / size)));
    for (let f = 0; f < frames; f++) {
      const centre = Math.round((f + 0.5) * hop), re = new Float64Array(size), im = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        const s = centre - size / 2 + i;
        re[i] = s >= 0 && s < samples.length ? samples[s] * w[i] : 0;
      }
      fft(re, im);
      const col = new Float32Array(top);
      for (let i = 0; i < top; i++) col[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-9);
      cols.push(col);
    }
    return { cols, hzPerBin: rate / size };
  }

  // 16-bit mono WAV.
  function wav(samples, rate) {
    const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * 32767), true));
    return buf;
  }

  const api = { FRAME_RATE, render, fft, spectrum, harmonicity, spectrogram, wav };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Render = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

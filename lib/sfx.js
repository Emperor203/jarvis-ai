// Встроенный звуковой движок (Web Audio API) для всех игр и сайтов Jarvis (без внешних аудиофайлов)
export const SFX_SCRIPT = `<script>
(function() {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('jarvis_muted') === '1'; } catch (e) {}

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function unlock() {
    ensureCtx();
  }
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });

  function tone(freq, dur = 0.1, type = 'sine', vol = 0.18, endFreq = null, delay = 0) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    try {
      const t = c.currentTime + delay;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq !== null) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
      }
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.linearRampToValueAtTime(vol, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    } catch (e) {}
  }

  function noise(dur = 0.18, vol = 0.22, delay = 0) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    try {
      const t = c.currentTime + delay;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource();
      src.buffer = buf;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(900, t);
      filter.frequency.exponentialRampToValueAtTime(120, t + dur);
      const gain = c.createGain();
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(c.destination);
      src.start(t);
    } catch (e) {}
  }

  const SFX = {
    get muted() { return muted; },
    setMuted(v) {
      muted = Boolean(v);
      try { localStorage.setItem('jarvis_muted', muted ? '1' : '0'); } catch (e) {}
      return muted;
    },
    toggle() {
      return this.setMuted(!muted);
    },
    tone,
    click() { tone(680, 0.045, 'triangle', 0.12, 340); },
    type() { tone(1100, 0.022, 'square', 0.05, 500); },
    move() { tone(320, 0.055, 'sine', 0.09, 240); },
    jump() { tone(220, 0.14, 'triangle', 0.16, 580); },
    shoot() { tone(880, 0.11, 'sawtooth', 0.11, 180); },
    coin() {
      tone(988, 0.08, 'square', 0.11);
      tone(1319, 0.16, 'square', 0.11, null, 0.075);
    },
    point() { this.coin(); },
    hit() {
      noise(0.16, 0.22);
      tone(140, 0.18, 'sawtooth', 0.18, 45);
    },
    boom() {
      noise(0.32, 0.28);
      tone(110, 0.35, 'sawtooth', 0.22, 30);
    },
    win() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone(f, 0.16, 'triangle', 0.15, null, i * 0.09);
      });
    },
    gameover() {
      [392, 349.23, 311.13, 261.63].forEach((f, i) => {
        tone(f, 0.18, 'sawtooth', 0.12, f * 0.92, i * 0.14);
      });
    }
  };

  window.SFX = SFX;
  window.JarvisSFX = SFX;
})();
</script>`;

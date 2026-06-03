/* ── DISC WARS AUDIO ENGINE — 140 BPM hard techno ── */

const Audio = (() => {
  let ctx = null;
  let master, sfxBus;
  let musicRunning = false;
  let nextBar = 0, barNum = 0;
  let isFinal = false;
  let chantTimer = null;

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.72; master.connect(ctx.destination);
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9;  sfxBus.connect(master);
  }

  // ── Low-level helpers ─────────────────────────────────────────────────

  function noise(s) {
    const n = Math.ceil(ctx.sampleRate * s);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function osc(type, freq, amp, dest, t, dur, atk) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    const a = atk || 0.005;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.01);
  }

  function noiseHit(amp, dest, t, dur, lpFreq) {
    const src = ctx.createBufferSource();
    src.buffer = noise(Math.max(dur, 0.01));
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    if (lpFreq) {
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lpFreq;
      src.connect(f); f.connect(g);
    } else { src.connect(g); }
    g.connect(dest); src.start(t); src.stop(t + dur + 0.01);
  }

  function hpf(freq, dest) {
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = freq;
    f.connect(dest); return f;
  }

  // ── Music engine (140 BPM hard techno, B minor) ───────────────────────

  const BPM = 140;
  const B   = 60 / BPM;   // one beat
  const S   = B / 4;      // one 16th note

  function kick(t) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(master);
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(0.001, t + 0.55);
    g.gain.setValueAtTime(isFinal ? 6 : 5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    o.start(t); o.stop(t + 0.56);
  }

  function clap(t) {
    for (let i = 0; i < 3; i++) {
      const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise(0.13);
      bp.type = 'bandpass'; bp.frequency.value = 1800 + i * 300; bp.Q.value = 0.5;
      s.connect(bp); bp.connect(g); g.connect(master);
      g.gain.setValueAtTime(0.65 - i * 0.15, t + i * 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.012 + 0.13);
      s.start(t + i * 0.012); s.stop(t + i * 0.012 + 0.14);
    }
  }

  function hat(t, v) {
    const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise(0.035); hp.type = 'highpass'; hp.frequency.value = 11000;
    s.connect(hp); hp.connect(g); g.connect(master);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    s.start(t); s.stop(t + 0.04);
  }

  function openHat(t) {
    const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise(0.22); hp.type = 'highpass'; hp.frequency.value = 8500;
    s.connect(hp); hp.connect(g); g.connect(master);
    g.gain.setValueAtTime(0.38, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    s.start(t); s.stop(t + 0.22);
  }

  function bass(t, freq, dur) {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = freq;
    f.type = 'lowpass'; f.Q.value = 12;
    f.frequency.setValueAtTime(2000, t);
    f.frequency.exponentialRampToValueAtTime(150, t + dur * 0.55);
    o.connect(f); f.connect(g); g.connect(master);
    g.gain.setValueAtTime(isFinal ? 2.0 : 1.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t); o.stop(t + dur + 0.01);
  }

  function stab(t, freqs) {
    freqs.forEach(freq => {
      const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = freq;
      f.type = 'lowpass'; f.frequency.value = 2800; f.Q.value = 3;
      o.connect(f); f.connect(g); g.connect(master);
      g.gain.setValueAtTime(0.11, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + B * 0.35);
      o.start(t); o.stop(t + B * 0.36);
    });
  }

  function lead(t, freq, dur) {
    [0, 3].forEach(detune => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = freq * (1 + detune * 0.001);
      o.connect(g); g.connect(master);
      g.gain.setValueAtTime(isFinal ? 0.1 : 0.065, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur + 0.01);
    });
  }

  // Final battle extra layer — high screeching lead
  function finalLead(t, freq, dur) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = freq * 2;
    o.connect(g); g.connect(master);
    g.gain.setValueAtTime(0.07, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t); o.stop(t + dur + 0.01);
  }

  const LEAD_NOTES = [
    493.88, 587.33, 659.26, 739.99, 659.26, 587.33, 493.88, 440.00,
    493.88, 659.26, 739.99, 880.00, 739.99, 659.26, 587.33, 493.88,
  ];

  function scheduleBar(t, n) {
    // Kick on every beat
    for (let i = 0; i < 4; i++) kick(t + i * B);

    // Clap on 2 and 4
    clap(t + B); clap(t + 3 * B);

    // Hi-hats
    for (let i = 0; i < 16; i++) {
      if (i === 6 || i === 14) openHat(t + i * S);
      else hat(t + i * S, i % 4 === 0 ? 0.55 : i % 2 === 0 ? 0.3 : 0.14);
    }

    // Driving bass in B minor
    [
      [0,    61.74, 0.20], [0.5,  61.74, 0.13], [0.75, 73.42, 0.13],
      [1,    61.74, 0.20], [1.5,  92.50, 0.25],
      [2,    82.41, 0.20], [2.5,  73.42, 0.13], [2.75, 61.74, 0.13],
      [3,    61.74, 0.20], [3.5,  92.50, 0.13], [3.75, 82.41, 0.13],
    ].forEach(([dt, f, d]) => bass(t + dt * B, f, d * B));

    // Stab chords on odd bars
    if (n % 2 === 1) {
      stab(t + 1.5 * B, [246.94, 293.66, 369.99]);
      stab(t + 3.5 * B, [246.94, 293.66, 369.99]);
    }

    // Synth lead melody
    for (let i = 0; i < 16; i++) lead(t + i * S, LEAD_NOTES[i], S * 0.6);

    // Final battle: extra high lead layer
    if (isFinal) {
      for (let i = 0; i < 16; i++) finalLead(t + i * S, LEAD_NOTES[i], S * 0.5);
    }
  }

  function pump() {
    if (!musicRunning) return;
    while (nextBar < ctx.currentTime + 0.8) {
      scheduleBar(nextBar, barNum++);
      nextBar += B * 4;
    }
    setTimeout(pump, 200);
  }

  function startMusic() {
    ensure();
    if (musicRunning) return;
    musicRunning = true; isFinal = false; barNum = 0;
    nextBar = ctx.currentTime + 0.05;
    pump();
  }

  function stopMusic() {
    musicRunning = false;
  }

  function setFinal(on) {
    isFinal = on;
  }

  // ── Crowd ─────────────────────────────────────────────────────────────

  function crowdRumble(amp, dur) {
    ensure();
    const buf = ctx.createBuffer(2, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let v = 0;
      for (let i = 0; i < d.length; i++) { v = v * 0.997 + (Math.random() * 2 - 1) * 0.003; d[i] = v; }
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bpf = ctx.createBiquadFilter(); bpf.type = 'bandpass'; bpf.frequency.value = 750; bpf.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = amp;
    src.connect(bpf); bpf.connect(g); g.connect(sfxBus);
    src.start(); src.stop(ctx.currentTime + dur);
  }

  function crowdChant() {
    ensure();
    crowdRumble(0.3, 4);
    const t = ctx.currentTime;
    [[820, 0.08], [1200, 0.045], [2500, 0.02]].forEach(([f, a]) => {
      osc('sine', f * (0.97 + Math.random() * 0.06), a, sfxBus, t, 0.3);
    });
    const t2 = t + 0.44;
    [[600, 0.10], [1000, 0.06], [2000, 0.025]].forEach(([f, a]) => {
      osc('sine', f * (0.97 + Math.random() * 0.06), a, sfxBus, t2, 0.7);
    });
    crowdRumble(0.5, 0.6);
    if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance('DISC WARS!');
      u.rate = 0.8; u.pitch = 0.7; u.volume = 0.22; speechSynthesis.speak(u);
    }
  }

  function crowdExcited() {
    ensure();
    crowdRumble(0.6, 2.5);
    const t = ctx.currentTime;
    for (let i = 0; i < 16; i++) osc('sine', 260 + i * 50 + Math.random() * 40, 0.05, sfxBus, t + i * 0.05, 0.18);
    for (let i = 0; i < 5; i++) osc('sine', 2200 + Math.random() * 600, 0.14, sfxBus, t + Math.random() * 0.4, 0.3);
    if (window.speechSynthesis) {
      const lines = ['YEAH!', 'DEREZ!', 'END OF LINE!', "HE'S DOWN!", 'FIGHT!'];
      const u = new SpeechSynthesisUtterance(lines[Math.floor(Math.random() * lines.length)]);
      u.rate = 1.15; u.pitch = 1.2; u.volume = 0.3; speechSynthesis.speak(u);
    }
  }

  function startChanting() {
    ensure(); crowdChant();
    chantTimer = setInterval(() => {
      if (Math.random() < 0.45) crowdChant(); else crowdRumble(0.12, 1.2);
    }, 6500 + Math.random() * 4000);
  }
  function stopChanting() { clearInterval(chantTimer); chantTimer = null; }

  // ── SFX ───────────────────────────────────────────────────────────────

  function throwDisc() {
    ensure(); const t = ctx.currentTime;
    osc('sine', 800, 0.3, sfxBus, t, 0.06);
    osc('sine', 400, 0.4, sfxBus, t + 0.03, 0.15);
    noiseHit(0.12, sfxBus, t, 0.07, 5000);
  }

  function discCatch() {
    ensure(); const t = ctx.currentTime;
    osc('sine', 950,  0.3,  sfxBus, t,        0.04);
    osc('sine', 1200, 0.2,  sfxBus, t + 0.03, 0.05);
    osc('sine', 1500, 0.14, sfxBus, t + 0.06, 0.07);
  }

  function derezz() {
    ensure(); const t = ctx.currentTime;
    for (let i = 0; i < 10; i++) {
      osc('sine', 850 * Math.pow(0.7, i), 0.22, sfxBus, t + i * 0.04, 0.07);
      noiseHit(0.2, sfxBus, t + i * 0.04, 0.05, 4000);
    }
    osc('sine', 80, 0.6, sfxBus, t + 0.05, 0.6);
  }

  function dodgeSfx() {
    ensure(); const t = ctx.currentTime;
    osc('sine', 1300, 0.2,  sfxBus, t,        0.04);
    osc('sine', 900,  0.14, sfxBus, t + 0.03, 0.05);
  }

  // ── Public API ────────────────────────────────────────────────────────
  return {
    init()          { ensure(); },
    startMusic()    { startMusic(); },
    stopMusic()     { stopMusic(); },
    finalMode(on)   { setFinal(on); },
    startChanting() { ensure(); startChanting(); },
    stopChanting()  { stopChanting(); },
    crowdChant()    { ensure(); crowdChant(); },
    crowdExcited()  { ensure(); crowdExcited(); },
    throwDisc()     { throwDisc(); },
    discCatch()     { discCatch(); },
    discBounce()    {},
    derezz()        { derezz(); },
    dodge()         { dodgeSfx(); },
  };
})();

/* ── DISC WARS AUDIO ENGINE ──────────────────────────────────────────── */
/* Synthesized TRON-style score + procedural crowd chants via Web Audio   */

const Audio = (() => {
  let ctx = null;
  let masterGain, musicGain, sfxGain;
  let musicNodes = [];
  let drumLoop  = null;
  let arpeLoop  = null;
  let bassLoop  = null;
  let padLoop   = null;

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = ctx.createGain(); masterGain.gain.value = 0.7; masterGain.connect(ctx.destination);
    musicGain  = ctx.createGain(); musicGain.gain.value  = 0.45; musicGain.connect(masterGain);
    sfxGain    = ctx.createGain(); sfxGain.gain.value    = 0.9;  sfxGain.connect(masterGain);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  function osc(type, freq, gainVal, dest, start, dur) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type      = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gainVal, start + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(dest);
    o.start(start); o.stop(start + dur + 0.05);
    return o;
  }

  function noise(gainVal, dest, start, dur) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gainVal, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(g); g.connect(dest);
    src.start(start); src.stop(start + dur + 0.02);
  }

  function lpf(freq) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = freq;
    f.connect(sfxGain); return f;
  }

  function reverb(wet) {
    // Simple convolution reverb via delay network
    const d1 = ctx.createDelay(0.5); d1.delayTime.value = 0.13;
    const d2 = ctx.createDelay(0.5); d2.delayTime.value = 0.21;
    const fb1 = ctx.createGain(); fb1.gain.value = wet;
    const fb2 = ctx.createGain(); fb2.gain.value = wet * 0.7;
    d1.connect(fb1); fb1.connect(d1); d1.connect(sfxGain);
    d2.connect(fb2); fb2.connect(d2); d2.connect(sfxGain);
    return { in1: d1, in2: d2 };
  }

  // ── MUSIC ────────────────────────────────────────────────────────────
  // Inspired by "Disc Wars" / Daft Punk TRON Legacy OST
  // Key: D minor  BPM: 140

  const BPM    = 140;
  const BEAT   = 60 / BPM;          // seconds per beat
  const BAR    = BEAT * 4;

  // Notes in Hz – D minor scale
  const NOTE = {
    D2: 73.4, A2: 110,  C3: 130.8, D3: 146.8, F3: 174.6,
    G3: 196,  A3: 220,  C4: 261.6, D4: 293.7, F4: 349.2,
    G4: 392,  A4: 440,  C5: 523.3, D5: 587.3,
  };

  // 8-step arpeggio pattern (indexes into arp notes)
  const ARP_NOTES  = [NOTE.D3, NOTE.F3, NOTE.A3, NOTE.C4, NOTE.D4, NOTE.A3, NOTE.F3, NOTE.C4];
  const BASS_NOTES = [NOTE.D2, NOTE.D2, NOTE.A2, NOTE.A2, NOTE.C3, NOTE.C3, NOTE.A2, NOTE.D2];

  let musicScheduled = false;
  let musicStartTime = 0;
  let finalMode = false;

  function scheduleBar(barIndex) {
    const t0 = musicStartTime + barIndex * BAR;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 6;
    comp.connect(musicGain);

    const rev = ctx.createConvolver();
    // simple impulse
    const irLen  = ctx.sampleRate * 1.5;
    const irBuf  = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = irBuf.getChannelData(ch);
      for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2);
    }
    rev.buffer = irBuf;
    const revGain = ctx.createGain(); revGain.gain.value = 0.18;
    rev.connect(revGain); revGain.connect(musicGain);

    // Bass line
    for (let s = 0; s < 8; s++) {
      const t = t0 + s * BEAT * 0.5;
      osc('sawtooth', BASS_NOTES[s], 0.35, comp, t, BEAT * 0.48);
      // sub
      osc('sine', BASS_NOTES[s] * 0.5, 0.5, comp, t, BEAT * 0.48);
    }

    // Arpeggio (16th notes)
    for (let s = 0; s < 16; s++) {
      const t    = t0 + s * BEAT * 0.25;
      const note = ARP_NOTES[s % 8];
      osc('square', note, finalMode ? 0.14 : 0.10, rev, t, BEAT * 0.22);
      osc('sawtooth', note * 2, finalMode ? 0.06 : 0.04, comp, t, BEAT * 0.10);
    }

    // Pad (whole note)
    const chordFreqs = [NOTE.D3, NOTE.F3, NOTE.A3, NOTE.C4];
    chordFreqs.forEach(f => {
      osc('sine', f, 0.06, revGain, t0, BAR * 0.98);
      osc('triangle', f * 1.005, 0.04, revGain, t0, BAR * 0.98);
    });

    // Kick
    [0, 2].forEach(b => {
      const t = t0 + b * BEAT;
      const k = ctx.createOscillator();
      const kg = ctx.createGain();
      k.frequency.setValueAtTime(150, t);
      k.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      kg.gain.setValueAtTime(finalMode ? 1.2 : 0.9, t);
      kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      k.connect(kg); kg.connect(comp);
      k.start(t); k.stop(t + 0.3);
    });

    // Snare (beats 1 and 3 in half-bar)
    [1, 3].forEach(b => {
      const t = t0 + b * BEAT;
      noise(finalMode ? 0.35 : 0.28, comp, t, 0.14);
      osc('triangle', 220, 0.2, comp, t, 0.14);
    });

    // Hi-hats (8th notes)
    for (let h = 0; h < 8; h++) {
      noise(0.06, comp, t0 + h * BEAT * 0.5, 0.04);
    }

    // Open hat on off-beats
    [1, 3, 5, 7].forEach(h => {
      noise(0.09, comp, t0 + h * BEAT * 0.5, 0.09);
    });
  }

  function startMusicLoop() {
    if (musicScheduled) return;
    musicScheduled = true;
    musicStartTime = ctx.currentTime + 0.1;
    let bar = 0;
    const LOOKAHEAD = 2; // bars

    function schedule() {
      const now = ctx.currentTime;
      while (musicStartTime + bar * BAR < now + LOOKAHEAD * BAR) {
        scheduleBar(bar);
        bar++;
      }
    }
    schedule();
    const id = setInterval(schedule, 500);
    musicNodes.push({ stop: () => clearInterval(id) });
  }

  function stopMusic() {
    musicNodes.forEach(n => n.stop && n.stop());
    musicNodes = [];
    musicScheduled = false;
    finalMode = false;
  }

  function setFinalMode(on) {
    finalMode = on;
    if (on && musicGain) {
      musicGain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.5);
    }
  }

  // ── SFX ──────────────────────────────────────────────────────────────

  function throwDisc() {
    const f = lpf(4000);
    const t = ctx.currentTime;
    osc('sawtooth', 880, 0.3, f, t, 0.06);
    osc('sine', 440, 0.4, f, t + 0.03, 0.15);
    noise(0.1, f, t, 0.08);
  }

  function discBounce() {
    const t = ctx.currentTime;
    osc('sine', 660, 0.35, sfxGain, t, 0.07);
    osc('square', 330, 0.15, sfxGain, t + 0.01, 0.05);
  }

  function discCatch() {
    const t = ctx.currentTime;
    osc('sine', 880, 0.3, sfxGain, t, 0.04);
    osc('sine', 1100, 0.2, sfxGain, t + 0.03, 0.06);
    osc('sine', 1320, 0.15, sfxGain, t + 0.06, 0.08);
  }

  function derezz() {
    const t = ctx.currentTime;
    const f = lpf(3000);
    // descending crash
    for (let i = 0; i < 8; i++) {
      const tt = t + i * 0.045;
      osc('sawtooth', 800 * Math.pow(0.75, i), 0.25, f, tt, 0.08);
      noise(0.2, f, tt, 0.06);
    }
    osc('sine', 120, 0.6, sfxGain, t + 0.1, 0.4);
  }

  function dodge() {
    const t = ctx.currentTime;
    osc('sine', 1200, 0.2, sfxGain, t, 0.04);
    osc('sine', 900,  0.15, sfxGain, t + 0.03, 0.06);
    noise(0.08, sfxGain, t, 0.05);
  }

  // ── CROWD ─────────────────────────────────────────────────────────────
  // Synthesize "DISC WARS!" crowd chant using Web Speech API layered
  // with generated crowd noise

  function crowdNoise(duration, gainVal) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let state = 0;
    for (let i = 0; i < d.length; i++) {
      state = state * 0.998 + (Math.random() * 2 - 1) * 0.002;
      d[i] = state;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass'; bpf.frequency.value = 800; bpf.Q.value = 0.5;
    const g = ctx.createGain(); g.gain.value = gainVal;
    src.connect(bpf); bpf.connect(g); g.connect(sfxGain);
    src.start(); src.stop(ctx.currentTime + duration);
  }

  function crowdChant() {
    // Layer crowd background noise
    crowdNoise(4, 0.3);

    // Synthesized crowd voice using oscillators (vowel formants)
    // "DISC" — short burst — then "WARS" — longer
    const t = ctx.currentTime;
    // "DISC" formants: ~800Hz F1, ~1200Hz F2
    [800, 1200, 2400].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = f * (0.95 + Math.random() * 0.1);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.07 - i * 0.015, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + 0.4);
    });
    // "WARS" formants: ~600Hz F1, ~1000Hz F2, longer
    const t2 = t + 0.45;
    [600, 1000, 2000].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = f * (0.95 + Math.random() * 0.1);
      g.gain.setValueAtTime(0, t2);
      g.gain.linearRampToValueAtTime(0.10 - i * 0.02, t2 + 0.06);
      g.gain.setValueAtTime(0.10 - i * 0.02, t2 + 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.7);
      o.connect(g); g.connect(sfxGain);
      o.start(t2); o.stop(t2 + 0.8);
    });
    // "!" — crowd up-swell
    const t3 = t2 + 0.7;
    crowdNoise(0.5, 0.5);

    // Also use speech synthesis for clarity (layered quietly)
    if (window.speechSynthesis) {
      const utter = new SpeechSynthesisUtterance('DISC WARS!');
      utter.rate   = 0.9;
      utter.pitch  = 0.8;
      utter.volume = 0.25;
      window.speechSynthesis.speak(utter);
    }
  }

  function crowdExcited() {
    crowdNoise(2.5, 0.55);
    // Rising cheer
    const t = ctx.currentTime;
    for (let i = 0; i < 12; i++) {
      const tt   = t + i * 0.07;
      const freq = 300 + i * 40 + Math.random() * 60;
      osc('sawtooth', freq, 0.06, sfxGain, tt, 0.2);
    }
    // Whistles
    for (let i = 0; i < 5; i++) {
      const tt = t + Math.random() * 0.5;
      osc('sine', 2400 + Math.random() * 400, 0.12, sfxGain, tt, 0.3 + Math.random() * 0.3);
    }
    if (window.speechSynthesis) {
      const r = ['YEAH!', 'DEREZ!', 'WHOA!', 'HE\'S DOWN!', 'FINISH HIM!'];
      const utter = new SpeechSynthesisUtterance(r[Math.floor(Math.random() * r.length)]);
      utter.rate = 1.1; utter.pitch = 1.2; utter.volume = 0.3;
      window.speechSynthesis.speak(utter);
    }
  }

  function crowdTense() {
    crowdNoise(1, 0.15);
  }

  // Periodic crowd chants during gameplay
  let chantInterval = null;
  function startChanting() {
    if (chantInterval) return;
    crowdChant();
    chantInterval = setInterval(() => {
      if (Math.random() < 0.4) crowdChant();
      else crowdTense();
    }, 6000 + Math.random() * 4000);
  }
  function stopChanting() {
    clearInterval(chantInterval);
    chantInterval = null;
  }

  // ── Public API ────────────────────────────────────────────────────────
  return {
    init() { ensure(); },
    startMusic() { ensure(); startMusicLoop(); },
    stopMusic()  { stopMusic(); },
    finalMode(on) { ensure(); setFinalMode(on); },
    startChanting() { ensure(); startChanting(); },
    stopChanting()  { stopChanting(); },
    crowdChant()    { ensure(); crowdChant(); },
    crowdExcited()  { ensure(); crowdExcited(); },
    throwDisc()     { ensure(); throwDisc(); },
    discBounce()    { ensure(); discBounce(); },
    discCatch()     { ensure(); discCatch(); },
    derezz()        { ensure(); derezz(); },
    dodge()         { ensure(); dodge(); },
  };
})();

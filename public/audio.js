/* ── DISC WARS AUDIO ENGINE — Techno-Pop / Daft Punk TRON style ──────── */

const Audio = (() => {
  let ctx = null;
  let master, musicBus, sfxBus;
  let schedulerTimer = null;
  let nextBarTime   = 0;
  let barIndex      = 0;
  let isFinal       = false;
  let chantTimer    = null;

  // ── init ──────────────────────────────────────────────────────────────
  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    master   = ctx.createGain(); master.gain.value   = 0.72; master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.5;  musicBus.connect(master);
    sfxBus   = ctx.createGain(); sfxBus.gain.value   = 0.9;  sfxBus.connect(master);
  }

  // ── low-level helpers ─────────────────────────────────────────────────
  function note(type, freq, amp, dest, t, dur, attack) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    const atk = attack || 0.005;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.01);
  }

  function noiseHit(amp, dest, t, dur) {
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d   = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(g); g.connect(dest);
    src.start(t); src.stop(t + dur + 0.01);
  }

  function makeCompressor(dest) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -14; c.ratio.value = 5; c.attack.value = 0.003; c.release.value = 0.15;
    c.connect(dest);
    return c;
  }

  function makeLPF(freq, dest) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = 1.2;
    f.connect(dest);
    return f;
  }

  function makeHPF(freq, dest) {
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = freq;
    f.connect(dest);
    return f;
  }

  // Plate-style reverb via feedback delay network
  function makeReverb(wetGain) {
    const times  = [0.031, 0.053, 0.077, 0.099];
    const merger = ctx.createGain(); merger.gain.value = wetGain; merger.connect(musicBus);
    times.forEach(t => {
      const d = ctx.createDelay(0.5); d.delayTime.value = t;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      d.connect(fb); fb.connect(d); d.connect(merger);
      merger._ins = merger._ins || [];
      merger._ins.push(d);
    });
    return merger;
  }

  // ── Musical constants ─────────────────────────────────────────────────
  const BPM   = 128;
  const BEAT  = 60 / BPM;
  const BAR   = BEAT * 4;
  const STEP  = BEAT / 4;   // 16th note

  // A minor / A dorian — bright, driving, pop-friendly
  const A2=110, E3=164.8, A3=220, B3=246.9, C4=261.6, D4=293.7,
        E4=329.6, F4=349.2, G4=392, A4=440, B4=493.9, C5=523.3,
        D5=587.3, E5=659.3;

  // 16-step bass pattern (indexes into bassNotes, 0=rest)
  const BASS_SEQ  = [A2, 0,A2,0,  E3,0,A2,0,  A2,0,D4/2,0,  E3,0,E3,A2];
  // 16-step arp pattern
  const ARP_SEQ   = [A3,0,E4,0, C4,0,E4,0, A3,0,D4,0, B3,E4,A4,0];
  // lead melody (plays every 2 bars, 16 steps)
  const LEAD_SEQ  = [E4,0,E4,D4, C4,0,A3,0, B3,0,B3,A3, G4,0,E4,0];

  let rev = null;

  function scheduleBar(t, bar) {
    if (!rev) rev = makeReverb(0.22);
    const comp  = makeCompressor(musicBus);
    const bassLPF = makeLPF(isFinal ? 1800 : 1200, comp);
    const arpLPF  = makeLPF(isFinal ? 7000 : 5000, rev._ins ? rev._ins[0] : musicBus);

    const beatVol = isFinal ? 1.1 : 0.85;

    // ── Kick (4-on-the-floor) ──────────────────────────────────────────
    for (let b = 0; b < 4; b++) {
      const kt = t + b * BEAT;
      const ko = ctx.createOscillator();
      const kg = ctx.createGain();
      ko.frequency.setValueAtTime(160, kt);
      ko.frequency.exponentialRampToValueAtTime(40, kt + 0.1);
      kg.gain.setValueAtTime(beatVol * 1.1, kt);
      kg.gain.exponentialRampToValueAtTime(0.0001, kt + 0.35);
      ko.connect(kg); kg.connect(comp);
      ko.start(kt); ko.stop(kt + 0.4);
    }

    // ── Snare (2 + 4) ─────────────────────────────────────────────────
    [1, 3].forEach(b => {
      const st = t + b * BEAT;
      noiseHit(beatVol * 0.35, comp, st, 0.12);
      note('triangle', 200, beatVol * 0.25, comp, st, 0.1);
    });

    // ── Hi-hats ───────────────────────────────────────────────────────
    for (let s = 0; s < 16; s++) {
      const ht = t + s * STEP;
      const isOpen = (s % 4 === 2);
      noiseHit(isOpen ? 0.12 : 0.06, makeHPF(8000, comp), ht, isOpen ? 0.08 : 0.025);
    }

    // ── Clap (on 2+4, layered with snare) ────────────────────────────
    [1, 3].forEach(b => {
      const ct = t + b * BEAT + 0.008;
      noiseHit(beatVol * 0.18, makeLPF(6000, comp), ct, 0.07);
    });

    // ── Synth bass ────────────────────────────────────────────────────
    for (let s = 0; s < 16; s++) {
      const freq = BASS_SEQ[s];
      if (!freq) continue;
      const bt = t + s * STEP;
      // sawtooth + sub sine
      note('sawtooth', freq,      0.38, bassLPF, bt, STEP * 0.75, 0.008);
      note('sine',     freq * 0.5, 0.5, comp,    bt, STEP * 0.85, 0.005);
    }

    // ── Arp synth ─────────────────────────────────────────────────────
    for (let s = 0; s < 16; s++) {
      const freq = ARP_SEQ[s];
      if (!freq) continue;
      const at = t + s * STEP;
      note('square', freq,  isFinal ? 0.12 : 0.08, arpLPF,  at, STEP * 0.6, 0.003);
      note('sawtooth',freq, isFinal ? 0.06 : 0.04, arpLPF,  at, STEP * 0.4, 0.003);
    }

    // ── Lead melody (every 2 bars) ────────────────────────────────────
    if (bar % 2 === 0) {
      for (let s = 0; s < 16; s++) {
        const freq = LEAD_SEQ[s];
        if (!freq) continue;
        const lt = t + s * STEP;
        note('sawtooth', freq, isFinal ? 0.18 : 0.13, rev._ins ? rev._ins[1] : musicBus, lt, STEP * 0.85, 0.01);
      }
    }

    // ── Chord stab (every 4 bars) ─────────────────────────────────────
    if (bar % 4 === 0) {
      const chord = [A3, C4, E4, G4];
      const stab  = t + 3 * BEAT + 3 * STEP;
      chord.forEach(f => {
        note('sawtooth', f, 0.09, rev._ins ? rev._ins[2] : musicBus, stab, STEP * 0.5, 0.005);
      });
    }

    // ── Side-chain pumping effect on pad ─────────────────────────────
    const pad = ctx.createOscillator();
    const padG = ctx.createGain();
    pad.type = 'sine'; pad.frequency.value = A2;
    padG.gain.setValueAtTime(0.04, t);
    for (let b = 0; b < 4; b++) {
      padG.gain.setValueAtTime(0, t + b * BEAT);
      padG.gain.linearRampToValueAtTime(0.04, t + b * BEAT + BEAT * 0.4);
    }
    pad.connect(padG); padG.connect(musicBus);
    pad.start(t); pad.stop(t + BAR);
  }

  // ── Scheduler ────────────────────────────────────────────────────────
  function schedule() {
    const LOOKAHEAD = 0.1;   // s ahead to schedule
    const INTERVAL  = 50;    // ms between scheduler runs

    if (!ctx) return;
    while (nextBarTime < ctx.currentTime + LOOKAHEAD + BAR) {
      scheduleBar(nextBarTime, barIndex);
      nextBarTime += BAR;
      barIndex++;
    }
  }

  function startMusic() {
    ensure();
    if (schedulerTimer) return;
    nextBarTime = ctx.currentTime + 0.05;
    barIndex    = 0;
    isFinal     = false;
    schedule();
    schedulerTimer = setInterval(schedule, 50);
  }

  function stopMusic() {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    barIndex = 0;
    rev = null;
  }

  function setFinal(on) {
    isFinal = on;
    if (on && musicBus) {
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(0.65, ctx.currentTime + 0.5);
    }
  }

  // ── Crowd ─────────────────────────────────────────────────────────────
  function crowdNoise(amp, dur) {
    ensure();
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let v = 0;
      for (let i = 0; i < len; i++) { v = v * 0.997 + (Math.random() * 2 - 1) * 0.003; d[i] = v; }
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bpf = ctx.createBiquadFilter(); bpf.type='bandpass'; bpf.frequency.value=900; bpf.Q.value=0.8;
    const g   = ctx.createGain(); g.gain.value = amp;
    src.connect(bpf); bpf.connect(g); g.connect(sfxBus);
    src.start(); src.stop(ctx.currentTime + dur);
  }

  function crowdChant() {
    ensure();
    crowdNoise(0.28, 3.5);
    const t = ctx.currentTime;
    // synthesized crowd-voice vowel formants for "DISC"
    [[820,0.07],[1200,0.04],[2500,0.02]].forEach(([f,a])=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type='sawtooth'; o.frequency.value=f*(0.97+Math.random()*0.06);
      g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(a,t+0.04);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.32);
      o.connect(g); g.connect(sfxBus); o.start(t); o.stop(t+0.35);
    });
    // "WARS"
    const t2=t+0.42;
    [[600,0.09],[1000,0.055],[2000,0.025]].forEach(([f,a])=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.type='sawtooth'; o.frequency.value=f*(0.97+Math.random()*0.06);
      g.gain.setValueAtTime(0,t2); g.gain.linearRampToValueAtTime(a,t2+0.06);
      g.gain.setValueAtTime(a,t2+0.38); g.gain.exponentialRampToValueAtTime(0.0001,t2+0.75);
      o.connect(g); g.connect(sfxBus); o.start(t2); o.stop(t2+0.8);
    });
    // "!"  swell
    crowdNoise(0.45, 0.5);
    if (window.speechSynthesis) {
      const u=new SpeechSynthesisUtterance('DISC WARS!');
      u.rate=0.85; u.pitch=0.75; u.volume=0.22; speechSynthesis.speak(u);
    }
  }

  function crowdExcited() {
    ensure();
    crowdNoise(0.55, 2.5);
    const t=ctx.currentTime;
    for(let i=0;i<14;i++){
      const tt=t+i*0.06, f=280+i*45+Math.random()*50;
      note('sawtooth',f,0.055,sfxBus,tt,0.18);
    }
    for(let i=0;i<4;i++){
      const tt=t+Math.random()*0.5;
      note('sine',2300+Math.random()*500,0.13,sfxBus,tt,0.3+Math.random()*0.3);
    }
    if(window.speechSynthesis){
      const lines=['YEAH!','DEREZ!','WHOA!','HE\'S DOWN!','END OF LINE!'];
      const u=new SpeechSynthesisUtterance(lines[Math.floor(Math.random()*lines.length)]);
      u.rate=1.1; u.pitch=1.2; u.volume=0.28; speechSynthesis.speak(u);
    }
  }

  function startChanting() {
    ensure();
    crowdChant();
    chantTimer = setInterval(()=>{
      if(Math.random()<0.45) crowdChant(); else crowdNoise(0.1,1);
    }, 7000+Math.random()*4000);
  }
  function stopChanting() { clearInterval(chantTimer); chantTimer=null; }

  // ── SFX ──────────────────────────────────────────────────────────────
  function throwDisc() {
    ensure();
    const t=ctx.currentTime;
    note('sawtooth',900,0.28,sfxBus,t,0.06);
    note('sine',    450,0.38,sfxBus,t+0.03,0.14);
    noiseHit(0.1,sfxBus,t,0.07);
  }

  function discCatch() {
    ensure();
    const t=ctx.currentTime;
    note('sine',1000,0.28,sfxBus,t,0.04);
    note('sine',1260,0.20,sfxBus,t+0.03,0.05);
    note('sine',1580,0.14,sfxBus,t+0.06,0.07);
  }

  function derezz() {
    ensure();
    const t=ctx.currentTime;
    for(let i=0;i<10;i++){
      const tt=t+i*0.04;
      note('sawtooth',900*Math.pow(0.72,i),0.22,sfxBus,tt,0.07);
      noiseHit(0.18,sfxBus,tt,0.05);
    }
    note('sine',100,0.55,sfxBus,t+0.08,0.5);
  }

  function dodgeSfx() {
    ensure();
    const t=ctx.currentTime;
    note('sine',1400,0.18,sfxBus,t,0.04);
    note('sine',1000,0.13,sfxBus,t+0.03,0.05);
    noiseHit(0.07,sfxBus,t,0.04);
  }

  // ── public API ────────────────────────────────────────────────────────
  return {
    init()           { ensure(); },
    startMusic()     { ensure(); startMusic(); },
    stopMusic()      { stopMusic(); },
    finalMode(on)    { ensure(); setFinal(on); },
    startChanting()  { ensure(); startChanting(); },
    stopChanting()   { stopChanting(); },
    crowdChant()     { crowdChant(); },
    crowdExcited()   { crowdExcited(); },
    throwDisc()      { throwDisc(); },
    discCatch()      { discCatch(); },
    discBounce()     {},
    derezz()         { derezz(); },
    dodge()          { dodgeSfx(); },
  };
})();

/* ── DISC WARS AUDIO ENGINE — "End of Line" style (Daft Punk / TRON) ── */
/*  Dark, mechanical, heavy electronic — C minor, 126 BPM               */

const Audio = (() => {
  let ctx = null;
  let master, musicBus, sfxBus;
  let schedulerTimer = null;
  let nextBarTime = 0;
  let barIndex    = 0;
  let isFinal     = false;
  let chantTimer  = null;

  function ensure() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master   = ctx.createGain(); master.gain.value   = 0.75; master.connect(ctx.destination);
    musicBus = ctx.createGain(); musicBus.gain.value = 0.48; musicBus.connect(master);
    sfxBus   = ctx.createGain(); sfxBus.gain.value   = 0.88; sfxBus.connect(master);
  }

  // ── low-level synth helpers ───────────────────────────────────────────

  function osc(type, freq, amp, dest, t, dur, atk) {
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type=type; o.frequency.setValueAtTime(freq, t);
    const a=atk||0.005;
    g.gain.setValueAtTime(0,t);
    g.gain.linearRampToValueAtTime(amp, t+a);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t+dur+0.01);
  }

  function oscSlide(type, f0, f1, amp, dest, t, dur) {
    const o=ctx.createOscillator(), g=ctx.createGain();
    o.type=type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t+dur*0.3);
    g.gain.setValueAtTime(amp,t);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t+dur+0.01);
  }

  function noiseHit(amp, dest, t, dur, lpFreq) {
    const len=Math.ceil(ctx.sampleRate*Math.max(dur,0.01));
    const buf=ctx.createBuffer(1,len,ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i]=Math.random()*2-1;
    const src=ctx.createBufferSource(); src.buffer=buf;
    const g=ctx.createGain();
    g.gain.setValueAtTime(amp,t); g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    if (lpFreq) {
      const f=ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value=lpFreq;
      src.connect(f); f.connect(g);
    } else { src.connect(g); }
    g.connect(dest); src.start(t); src.stop(t+dur+0.01);
  }

  function distort(dest) {
    const w=ctx.createWaveShaper();
    const n=256, curve=new Float32Array(n);
    const k=80;
    for(let i=0;i<n;i++){
      const x=i*2/n-1;
      curve[i]=x*(k+1)/(1+k*Math.abs(x))*0.7;
    }
    w.curve=curve; w.connect(dest); return w;
  }

  function compressor(dest) {
    const c=ctx.createDynamicsCompressor();
    c.threshold.value=-16; c.ratio.value=6;
    c.attack.value=0.003; c.release.value=0.12;
    c.connect(dest); return c;
  }

  function lpf(freq, dest) {
    const f=ctx.createBiquadFilter(); f.type='lowpass'; f.frequency.value=freq; f.Q.value=2;
    f.connect(dest); return f;
  }

  function hpf(freq, dest) {
    const f=ctx.createBiquadFilter(); f.type='highpass'; f.frequency.value=freq;
    f.connect(dest); return f;
  }

  // ── Musical constants ─────────────────────────────────────────────────
  // "End of Line" feel: C minor, 126 BPM, heavy and dark
  const BPM  = 126;
  const BEAT = 60 / BPM;
  const BAR  = BEAT * 4;
  const S16  = BEAT / 4;   // 16th note

  // C minor notes
  const C2=65.4, G2=98, C3=130.8, Eb3=155.6, F3=174.6, G3=196,
        Ab3=207.7, Bb3=233.1, C4=261.6, Eb4=311.1, F4=349.2,
        G4=392, Ab4=415.3, Bb4=466.2, C5=523.3;

  // "End of Line" main bass riff — heavy, repetitive, mechanical
  // 16 steps (16th notes per bar)
  const BASS = [
    C2,  0,   C2,  0,   G2,  0,   C2,  C2,
    Eb3/2, 0, F3/2,0,   G2,  0,   G2,  C2,
  ];

  // Inner synth riff (the signature descending-then-rising hook)
  const HOOK = [
    C4, 0,  C4, Bb3, Ab3, 0,  G3, 0,
    Ab3,0,  Bb3,0,   C4, 0,   G3, 0,
  ];

  // Chord stabs (tense, minor)
  const STABS = [ // bar positions where stabs hit
    [0, [C3,Eb3,G3]],
    [2, [G2,Bb3,Eb4]],
  ];

  // ── Reverb ────────────────────────────────────────────────────────────
  let _rev = null;
  function getRev() {
    if (_rev) return _rev;
    const irLen=ctx.sampleRate*1.2;
    const irBuf=ctx.createBuffer(2,irLen,ctx.sampleRate);
    for(let ch=0;ch<2;ch++){
      const d=irBuf.getChannelData(ch);
      for(let i=0;i<irLen;i++) d[i]=(Math.random()*2-1)*Math.pow(1-i/irLen,3.5);
    }
    const c=ctx.createConvolver(); c.buffer=irBuf;
    const g=ctx.createGain(); g.gain.value=0.14; g.connect(musicBus);
    c.connect(g); _rev={input:c}; return _rev;
  }

  // ── Schedule one bar ──────────────────────────────────────────────────
  function scheduleBar(t, bar) {
    const rev=getRev();
    const comp=compressor(musicBus);
    const bassChain=lpf(isFinal?900:650, distort(comp));
    const leadChain=lpf(isFinal?4000:3000, comp);
    const vol = isFinal ? 1.2 : 1.0;

    // ── 4-on-the-floor kick (heavy, sub-heavy) ────────────────────────
    for(let b=0;b<4;b++){
      const kt=t+b*BEAT;
      oscSlide('sine', 120, 38, vol*1.2, comp, kt, 0.38);
      // click transient
      noiseHit(vol*0.18, comp, kt, 0.02, 3000);
    }

    // ── Punchy snare + noise (on 2 & 4) ──────────────────────────────
    [1,3].forEach(b=>{
      const st=t+b*BEAT;
      noiseHit(vol*0.42, comp, st, 0.16, 8000);
      osc('triangle', 190, vol*0.28, comp, st, 0.12, 0.003);
      // rim shot click
      noiseHit(vol*0.18, hpf(5000, comp), st+0.002, 0.04);
    });

    // ── Hi-hats — tight and mechanical ───────────────────────────────
    for(let s=0;s<16;s++){
      const ht=t+s*S16;
      const isOpen=(s===2||s===6||s===10||s===14);
      const amp=isOpen?vol*0.15:vol*0.07;
      noiseHit(amp, hpf(9000,comp), ht, isOpen?0.06:0.022);
    }

    // ── Ghost snare (light hits between main snares) ──────────────────
    [0.5,1.5,2.5,3.5].forEach(b=>{
      noiseHit(vol*0.06, hpf(6000,comp), t+b*BEAT+S16, 0.03);
    });

    // ── Heavy synth bass (distorted sawtooth) ────────────────────────
    for(let s=0;s<16;s++){
      const freq=BASS[s]; if(!freq) continue;
      const bt=t+s*S16;
      osc('sawtooth', freq,     vol*0.55, bassChain, bt, S16*0.72, 0.006);
      osc('sine',     freq*0.5, vol*0.65, comp,      bt, S16*0.85, 0.004); // sub
      // slight detune for fatness
      osc('sawtooth', freq*1.007, vol*0.18, bassChain, bt, S16*0.65, 0.008);
    }

    // ── "End of Line" hook riff ───────────────────────────────────────
    for(let s=0;s<16;s++){
      const freq=HOOK[s]; if(!freq) continue;
      const ht=t+s*S16;
      osc('sawtooth', freq,     vol*(isFinal?0.16:0.11), leadChain,   ht, S16*0.65, 0.005);
      osc('sawtooth', freq*0.5, vol*(isFinal?0.07:0.04), rev.input,   ht, S16*0.8,  0.008);
    }

    // ── Chord stabs (dark minor) ──────────────────────────────────────
    STABS.forEach(([beat, notes])=>{
      const st=t+beat*BEAT;
      notes.forEach(f=>{
        osc('sawtooth', f, vol*0.12, rev.input, st, BEAT*0.18, 0.01);
        osc('sawtooth', f, vol*0.05, comp,      st, BEAT*0.10, 0.005);
      });
    });

    // ── Dark pad (whole bar, slowly modulated) ────────────────────────
    const padFreqs=[C2*2, Eb3, G3];
    padFreqs.forEach(f=>{
      const padO=ctx.createOscillator(), padG=ctx.createGain();
      padO.type='sine'; padO.frequency.value=f;
      // side-chain pumping: duck on every kick
      padG.gain.setValueAtTime(vol*0.035, t);
      for(let b=0;b<4;b++){
        padG.gain.setValueAtTime(0, t+b*BEAT);
        padG.gain.linearRampToValueAtTime(vol*0.035, t+b*BEAT+BEAT*0.35);
      }
      padO.connect(padG); padG.connect(rev.input);
      padO.start(t); padO.stop(t+BAR+0.01);
    });

    // ── "Final battle" extra layer: distorted lead ────────────────────
    if (isFinal && bar%2===0) {
      const fHook=[C5,0,Bb4,Ab4, G4,0,Ab4,0, Bb4,0,C5,0, G4,0,0,0];
      for(let s=0;s<16;s++){
        const freq=fHook[s]; if(!freq) continue;
        osc('sawtooth',freq,0.22,distort(comp),t+s*S16,S16*0.6,0.005);
      }
    }
  }

  // ── Scheduler loop ────────────────────────────────────────────────────
  function schedule() {
    if (!ctx) return;
    while (nextBarTime < ctx.currentTime + BAR*1.5) {
      scheduleBar(nextBarTime, barIndex);
      nextBarTime+=BAR; barIndex++;
    }
  }

  function startMusic() {
    ensure();
    if (schedulerTimer) return;
    _rev=null; barIndex=0; isFinal=false;
    nextBarTime=ctx.currentTime+0.06;
    schedule();
    schedulerTimer=setInterval(schedule, 80);
  }

  function stopMusic() {
    clearInterval(schedulerTimer); schedulerTimer=null;
    barIndex=0; _rev=null;
  }

  function setFinal(on) {
    isFinal=on;
    if (on&&musicBus) {
      musicBus.gain.cancelScheduledValues(ctx.currentTime);
      musicBus.gain.linearRampToValueAtTime(0.62, ctx.currentTime+0.4);
    }
  }

  // ── Crowd ─────────────────────────────────────────────────────────────
  function crowdRumble(amp, dur) {
    ensure();
    const len=Math.ceil(ctx.sampleRate*dur);
    const buf=ctx.createBuffer(2,len,ctx.sampleRate);
    for(let ch=0;ch<2;ch++){
      const d=buf.getChannelData(ch); let v=0;
      for(let i=0;i<len;i++){v=v*0.997+(Math.random()*2-1)*0.003; d[i]=v;}
    }
    const src=ctx.createBufferSource(); src.buffer=buf;
    const bpf=ctx.createBiquadFilter(); bpf.type='bandpass'; bpf.frequency.value=750; bpf.Q.value=0.6;
    const g=ctx.createGain(); g.gain.value=amp;
    src.connect(bpf); bpf.connect(g); g.connect(sfxBus);
    src.start(); src.stop(ctx.currentTime+dur);
  }

  function crowdChant() {
    ensure();
    crowdRumble(0.3, 4);
    const t=ctx.currentTime;
    // "DISC" formants
    [[820,0.08],[1200,0.045],[2500,0.02]].forEach(([f,a])=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sawtooth'; o.frequency.value=f*(0.97+Math.random()*0.06);
      g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(a,t+0.04);
      g.gain.exponentialRampToValueAtTime(0.0001,t+0.3);
      o.connect(g); g.connect(sfxBus); o.start(t); o.stop(t+0.35);
    });
    // "WARS" formants
    const t2=t+0.44;
    [[600,0.10],[1000,0.06],[2000,0.025]].forEach(([f,a])=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.type='sawtooth'; o.frequency.value=f*(0.97+Math.random()*0.06);
      g.gain.setValueAtTime(0,t2); g.gain.linearRampToValueAtTime(a,t2+0.06);
      g.gain.setValueAtTime(a,t2+0.35); g.gain.exponentialRampToValueAtTime(0.0001,t2+0.75);
      o.connect(g); g.connect(sfxBus); o.start(t2); o.stop(t2+0.8);
    });
    crowdRumble(0.5, 0.6);
    if(window.speechSynthesis){
      const u=new SpeechSynthesisUtterance('DISC WARS!');
      u.rate=0.8; u.pitch=0.7; u.volume=0.22; speechSynthesis.speak(u);
    }
  }

  function crowdExcited() {
    ensure();
    crowdRumble(0.6, 2.5);
    const t=ctx.currentTime;
    for(let i=0;i<16;i++){
      const tt=t+i*0.05, f=260+i*50+Math.random()*40;
      osc('sawtooth',f,0.05,sfxBus,tt,0.18);
    }
    for(let i=0;i<5;i++) osc('sine',2200+Math.random()*600,0.14,sfxBus,t+Math.random()*0.4,0.3+Math.random()*0.2);
    if(window.speechSynthesis){
      const lines=['YEAH!','DEREZ!','END OF LINE!','HE\'S DOWN!','FIGHT!'];
      const u=new SpeechSynthesisUtterance(lines[Math.floor(Math.random()*lines.length)]);
      u.rate=1.15; u.pitch=1.2; u.volume=0.3; speechSynthesis.speak(u);
    }
  }

  function startChanting() {
    ensure(); crowdChant();
    chantTimer=setInterval(()=>{
      if(Math.random()<0.45) crowdChant(); else crowdRumble(0.12,1.2);
    }, 6500+Math.random()*4000);
  }
  function stopChanting(){ clearInterval(chantTimer); chantTimer=null; }

  // ── SFX ──────────────────────────────────────────────────────────────
  function throwDisc() {
    ensure(); const t=ctx.currentTime;
    osc('sawtooth',800,0.3,sfxBus,t,0.06);
    osc('sine',400,0.4,sfxBus,t+0.03,0.15);
    noiseHit(0.12,sfxBus,t,0.07,5000);
  }

  function discCatch() {
    ensure(); const t=ctx.currentTime;
    osc('sine',950,0.3,sfxBus,t,0.04);
    osc('sine',1200,0.2,sfxBus,t+0.03,0.05);
    osc('sine',1500,0.14,sfxBus,t+0.06,0.07);
  }

  function derezz() {
    ensure(); const t=ctx.currentTime;
    for(let i=0;i<10;i++){
      const tt=t+i*0.04;
      osc('sawtooth',850*Math.pow(0.7,i),0.22,sfxBus,tt,0.07);
      noiseHit(0.2,sfxBus,tt,0.05,4000);
    }
    osc('sine',80,0.6,sfxBus,t+0.05,0.6);
  }

  function dodgeSfx() {
    ensure(); const t=ctx.currentTime;
    osc('sine',1300,0.2,sfxBus,t,0.04);
    osc('sine',900,0.14,sfxBus,t+0.03,0.05);
  }

  // ── Public API ────────────────────────────────────────────────────────
  return {
    init()          { ensure(); },
    startMusic()    { ensure(); startMusic(); },
    stopMusic()     { stopMusic(); },
    finalMode(on)   { ensure(); setFinal(on); },
    startChanting() { ensure(); startChanting(); },
    stopChanting()  { stopChanting(); },
    crowdChant()    { crowdChant(); },
    crowdExcited()  { crowdExcited(); },
    throwDisc()     { throwDisc(); },
    discCatch()     { discCatch(); },
    discBounce()    {},
    derezz()        { derezz(); },
    dodge()         { dodgeSfx(); },
  };
})();

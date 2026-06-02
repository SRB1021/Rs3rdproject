/* ── DISC WARS – CLIENT ──────────────────────────────────────────────── */

const socket = io();

let myId       = null;
let myRoomCode = null;
let hostId     = null;
let gameState  = 'title';
let arena      = { width: 960, height: 640 };
let players    = {};
let bodies     = [];
let keys       = {};
let mouseWorld = { x: 0, y: 0 };

const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

// ── screens ────────────────────────────────────────────────────────────
function showTitle()  { document.getElementById('titleScreen').style.display='flex'; document.getElementById('arenaWrap').style.display='none'; }
function showArena()  { document.getElementById('titleScreen').style.display='none'; document.getElementById('arenaWrap').style.display='block'; }

function setLobbyMode(on) {
  document.getElementById('lobbyOverlay').style.display = on ? 'flex' : 'none';
  document.getElementById('hud').style.display          = on ? 'none' : 'block';
}

// ── input ──────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if (keys[k]) return;
  keys[k] = true;
  if (k === 'd' && (gameState === 'playing' || gameState === 'finalBattle')) {
    socket.emit('dodge');
    Audio.dodge();
  }
  sendInput();
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; sendInput(); });

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouseWorld.x = (e.clientX - r.left) * (canvas.width  / r.width);
  mouseWorld.y = (e.clientY - r.top)  * (canvas.height / r.height);
});

canvas.addEventListener('click', () => {
  if (gameState !== 'playing' && gameState !== 'finalBattle') return;
  const me = players[myId];
  if (!me || !me.alive || !me.hasDisc) return;
  socket.emit('throwDisc', { tx: mouseWorld.x, ty: mouseWorld.y });
  Audio.throwDisc();
});

function sendInput() {
  let vx = 0, vy = 0;
  if (keys['w'] || keys['arrowup'])    vy -= 1;
  if (keys['s'] || keys['arrowdown'])  vy += 1;
  if (keys['a'] || keys['arrowleft'])  vx -= 1;
  if (keys['arrowright']) vx += 1;
  if (keys['q']) vx -= 1;
  if (keys['e']) vx += 1;
  socket.emit('input', { vx, vy });
}

// ── title screen buttons ───────────────────────────────────────────────
const nameInput   = document.getElementById('nameInput');
const createBtn   = document.getElementById('createBtn');
const joinBtnOpen = document.getElementById('joinBtnOpen');
const joinRow     = document.getElementById('joinRow');
const codeInput   = document.getElementById('codeInput');
const joinBtn     = document.getElementById('joinBtn');
const joinError   = document.getElementById('joinError');

createBtn.addEventListener('click', () => { Audio.init(); socket.emit('createRoom', { name: nameInput.value.trim() }); });
joinBtnOpen.addEventListener('click', () => {
  joinRow.style.display = joinRow.style.display === 'none' ? 'block' : 'none';
  joinError.style.display = 'none';
  if (joinRow.style.display !== 'none') codeInput.focus();
});
joinBtn.addEventListener('click', doJoin);
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });

function doJoin() { Audio.init(); joinError.style.display='none'; socket.emit('joinRoom',{code:codeInput.value.trim(),name:nameInput.value.trim()}); }

// ── lobby overlay buttons ──────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click',   () => socket.emit('startGame'));
document.getElementById('addBotBtn').addEventListener('click',  () => socket.emit('addBot'));
document.getElementById('removeBotBtn').addEventListener('click',()=> socket.emit('removeBot'));
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(myRoomCode).catch(()=>{});
  const b = document.getElementById('copyCodeBtn');
  b.textContent='✓'; setTimeout(()=>b.textContent='⧉',1500);
});
document.getElementById('leaveBtn').addEventListener('click', doLeave);
document.getElementById('leaveGameBtn').addEventListener('click', doLeave);
document.getElementById('playAgainBtn').addEventListener('click', () => {
  document.getElementById('gameOverScreen').style.display='none';
  socket.emit('startGame');
});

function doLeave() {
  socket.emit('leaveRoom');
  myRoomCode=null; hostId=null; players={}; bodies=[];
  document.getElementById('gameOverScreen').style.display='none';
  gameState='title'; showTitle();
}

function updateLobbyOverlay() {
  document.getElementById('roomCodeDisplay').textContent = myRoomCode;
  const isHost = socket.id === hostId;
  document.getElementById('startBtn').style.display  = isHost ? 'block' : 'none';
  document.getElementById('waitMsg').style.display   = isHost ? 'none'  : 'block';
  document.getElementById('botRow').style.display    = isHost ? 'flex'  : 'none';

  const list = document.getElementById('playerListLobby');
  list.innerHTML = '';
  Object.values(players).forEach(p => {
    const el = document.createElement('div');
    el.className = 'pl-item';
    const crown = p.id===hostId ? ' 👑' : '';
    const me    = p.id===myId   ? ' (you)' : '';
    const bot   = p.isBot       ? ' 🤖' : '';
    el.innerHTML = `<span class="pl-dot" style="background:${p.color};box-shadow:0 0 6px ${p.color}"></span>
                    <span style="color:${p.color}">${p.name}${bot}${crown}${me}</span>`;
    list.appendChild(el);
  });
}

// ── socket: room events ────────────────────────────────────────────────
socket.on('roomCreated', ({ code, playerId, players: ps, state, arena: a, hostId: h }) => {
  myId=playerId; myRoomCode=code; hostId=h; gameState=state;
  arena=a; players={}; bodies=[];
  ps.forEach(p => players[p.id]=p);
  showArena(); resizeCanvas(); setLobbyMode(true); updateLobbyOverlay(); loop();
});

socket.on('roomJoined', ({ code, playerId, players: ps, state, arena: a, hostId: h, bodies: b }) => {
  myId=playerId; myRoomCode=code; hostId=h; gameState=state;
  arena=a; players={}; bodies=b||[];
  ps.forEach(p => players[p.id]=p);
  showArena(); resizeCanvas(); setLobbyMode(true); updateLobbyOverlay(); loop();
});

socket.on('joinError',   ({ message }) => { joinError.textContent=message; joinError.style.display='block'; });
socket.on('playerJoined',({ player })  => { players[player.id]=player; updateLobbyOverlay(); });
socket.on('playerLeft',  ({ id })      => { delete players[id]; if (gameState==='lobby'||gameState==='gameOver') updateLobbyOverlay(); });
socket.on('playerUpdate',({ id, name })=> { if(players[id]){players[id].name=name;} updateLobbyOverlay(); });
socket.on('hostChanged', ({ hostId:h })=> { hostId=h; updateLobbyOverlay(); });

// ── socket: game events ────────────────────────────────────────────────
socket.on('gameStart', ({ arena: a }) => {
  arena=a; gameState='playing';
  document.getElementById('gameOverScreen').style.display='none';
  setLobbyMode(false); resizeCanvas();
  Audio.startMusic(); Audio.startChanting();
});

socket.on('finalBattle', ({ arena: a }) => {
  arena=a; gameState='finalBattle';
  resizeCanvas(); showFinalBanner();
  Audio.finalMode(true); Audio.crowdExcited();
});

socket.on('gameState', ({ players: ps, bodies: b, arena: a, state }) => {
  arena=a; bodies=b||[];
  ps.forEach(p => { if(players[p.id]) Object.assign(players[p.id],p); else players[p.id]=p; });
  if (gameState==='playing'||gameState==='finalBattle') updateHUD();
});

socket.on('playerEliminated', ({ id, killerName }) => {
  Audio.derezz(); Audio.crowdExcited();
  if (players[id]) { players[id]._derezzTime=Date.now(); players[id].alive=false; }
  addKillFeed(killerName, players[id]?.name||'???');
});

socket.on('discCaught', ({ playerId }) => { if(playerId===myId) Audio.discCatch(); });

socket.on('gameOver', ({ winnerId, winnerName }) => {
  gameState='gameOver';
  Audio.stopMusic(); Audio.stopChanting();
  // switch back to lobby overlay so players can move around
  setLobbyMode(true); updateLobbyOverlay();
  showGameOver(winnerName, winnerId===myId);
});

// ── resize ─────────────────────────────────────────────────────────────
function resizeCanvas() {
  const scale = Math.min(window.innerWidth/arena.width, window.innerHeight/arena.height, 1);
  canvas.width=arena.width; canvas.height=arena.height;
  canvas.style.width =`${arena.width *scale}px`;
  canvas.style.height=`${arena.height*scale}px`;
}
window.addEventListener('resize', () => { if(gameState!=='title') resizeCanvas(); });

function showFinalBanner() {
  const b=document.getElementById('finalBanner');
  b.style.display='flex'; setTimeout(()=>b.style.display='none',3200);
}

function showGameOver(winnerName, isMe) {
  const s=document.getElementById('gameOverScreen');
  document.getElementById('goWinner').textContent = isMe ? 'YOU WIN, PROGRAM.' : `${winnerName} WINS`;
  document.getElementById('playAgainBtn').style.display = socket.id===hostId ? 'block' : 'none';
  s.style.display='flex';
}

function addKillFeed(killer, victim) {
  const feed=document.getElementById('killFeed');
  const el=document.createElement('div');
  el.className='kill-entry';
  el.innerHTML=`<span style="color:#ff6600">${killer}</span> derezzed <span style="color:#aaa">${victim}</span>`;
  feed.appendChild(el);
  setTimeout(()=>el.remove(),3600);
}

function updateHUD() {
  const hud=document.getElementById('hudPlayers');
  hud.innerHTML='';
  Object.values(players).sort((a,b)=>b.score-a.score).forEach(p=>{
    const el=document.createElement('div');
    el.className='hud-player'+(p.alive?'':' hud-dead');
    el.style.color=p.color; el.style.borderColor=p.color;
    el.innerHTML=`<span class="hud-name">${p.name}${p.id===myId?' ◀':''}${p.isBot?' 🤖':''}</span>
                  <span class="hud-disc">${p.alive?(p.hasDisc?'◈ DISC READY':(p.dodging?'⚡ DODGING':'◌ disc away')):'✕ DEREZZED'}</span>`;
    hud.appendChild(el);
  });
  const alive=Object.values(players).filter(p=>p.alive).length;
  document.getElementById('hudCenter').textContent = gameState==='finalBattle'
    ? '⚡ FINAL BATTLE'
    : `${alive} PROGRAM${alive!==1?'S':''} REMAIN`;
}

// ── render ─────────────────────────────────────────────────────────────
const WALL=24, P_R=18, D_R=11;

function glow(color,blur){ ctx.shadowColor=color; ctx.shadowBlur=blur; }
function noGlow()         { ctx.shadowBlur=0; }

function drawArena() {
  ctx.fillStyle='#020b14'; ctx.fillRect(0,0,arena.width,arena.height);

  // grid
  ctx.strokeStyle='#0a2030'; ctx.lineWidth=1;
  for(let x=WALL;x<=arena.width-WALL;x+=40){ ctx.beginPath(); ctx.moveTo(x,WALL); ctx.lineTo(x,arena.height-WALL); ctx.stroke(); }
  for(let y=WALL;y<=arena.height-WALL;y+=40){ ctx.beginPath(); ctx.moveTo(WALL,y); ctx.lineTo(arena.width-WALL,y); ctx.stroke(); }

  // wall
  const wc = gameState==='finalBattle'?'#ff6600':'#00f7ff';
  ctx.strokeStyle=wc; ctx.lineWidth=3; glow(wc,18);
  ctx.strokeRect(WALL,WALL,arena.width-WALL*2,arena.height-WALL*2);
  [[WALL,WALL],[arena.width-WALL,WALL],[WALL,arena.height-WALL],[arena.width-WALL,arena.height-WALL]].forEach(([cx,cy])=>{
    ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2); ctx.fillStyle=wc; glow(wc,20); ctx.fill();
  });
  noGlow();

  // lobby "WAITING" pulse
  if (gameState==='lobby') {
    ctx.fillStyle='rgba(0,247,255,0.04)';
    ctx.font='bold 22px "Courier New"'; ctx.textAlign='center';
    ctx.fillText('MOVE FREELY — GAME STARTS SOON', arena.width/2, arena.height/2);
  }

  // room code watermark
  ctx.fillStyle='rgba(0,247,255,0.06)'; ctx.font='13px "Courier New"'; ctx.textAlign='right';
  ctx.fillText(myRoomCode||'', arena.width-WALL-6, arena.height-WALL-6);
}

// Scatter fragment positions per body (stable per body)
const bodyFragCache = {};
function getFrags(body) {
  if (!bodyFragCache[body.id]) {
    const frags = [];
    for(let i=0;i<14;i++) {
      const a=Math.random()*Math.PI*2, r=8+Math.random()*32;
      frags.push({dx:Math.cos(a)*r, dy:Math.sin(a)*r, size:3+Math.random()*6, angle:Math.random()*Math.PI*2});
    }
    bodyFragCache[body.id]=frags;
  }
  return bodyFragCache[body.id];
}

function drawBodies() {
  for (const body of bodies) {
    const frags = getFrags(body);
    ctx.globalAlpha = 0.55;
    frags.forEach(f => {
      glow(body.color, 6);
      ctx.fillStyle = body.color;
      ctx.save();
      ctx.translate(body.x+f.dx, body.y+f.dy);
      ctx.rotate(f.angle);
      ctx.fillRect(-f.size/2, -f.size/2, f.size, f.size);
      ctx.restore();
    });
    // name tag over body
    ctx.globalAlpha=0.3; ctx.fillStyle=body.color;
    ctx.font='9px "Courier New"'; ctx.textAlign='center';
    glow(body.color,4);
    ctx.fillText('✕ '+body.name, body.x, body.y-30);
    ctx.globalAlpha=1; noGlow();
  }
  ctx.globalAlpha=1; noGlow();
}

function drawPlayer(p) {
  if (!p.alive) return;
  const {x,y,color:c}=p;

  if (p.dodging) {
    glow(c,40); ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.arc(x,y,P_R+8,0,Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
  }

  glow(c,22); ctx.fillStyle=c; ctx.beginPath(); ctx.arc(x,y,P_R,0,Math.PI*2); ctx.fill();
  noGlow(); ctx.fillStyle='#020b14'; ctx.beginPath(); ctx.arc(x,y,P_R*0.55,0,Math.PI*2); ctx.fill();

  // facing dot
  glow(c,10); ctx.strokeStyle=c; ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(x+p.facing.x*P_R*0.55, y+p.facing.y*P_R*0.55);
  ctx.lineTo(x+p.facing.x*(P_R+6),  y+p.facing.y*(P_R+6));
  ctx.stroke(); noGlow();

  // "you" ring
  if (p.id===myId) {
    ctx.strokeStyle='#fff'; ctx.lineWidth=1; ctx.globalAlpha=0.4;
    ctx.beginPath(); ctx.arc(x,y,P_R+5,0,Math.PI*2); ctx.stroke(); ctx.globalAlpha=1;
  }

  // bot icon
  const label = p.isBot ? '🤖 '+p.name : p.name;
  ctx.fillStyle=c; ctx.font='10px "Courier New"'; ctx.textAlign='center';
  glow(c,6); ctx.fillText(label,x,y-P_R-6); noGlow();
}

function drawDisc(disc) {
  if(!disc) return;
  const{x,y,ownerColor,returning,vx,vy}=disc;
  const speed=Math.sqrt(vx*vx+vy*vy)||1, nx=vx/speed, ny=vy/speed;
  glow(ownerColor,returning?10:20);
  for(let i=1;i<=5;i++){
    ctx.globalAlpha=0.25-i*0.04; ctx.fillStyle=ownerColor;
    ctx.beginPath(); ctx.arc(x-nx*i*5,y-ny*i*5,D_R*(1-i*0.12),0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha=1;
  const col=returning?'#fff':ownerColor;
  glow(col,returning?30:22); ctx.fillStyle=col; ctx.beginPath(); ctx.arc(x,y,D_R,0,Math.PI*2); ctx.fill();
  noGlow(); ctx.fillStyle='#020b14'; ctx.beginPath(); ctx.arc(x,y,D_R*0.38,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle=col; ctx.lineWidth=1.5; glow(col,8); ctx.globalAlpha=0.7;
  ctx.beginPath(); ctx.arc(x,y,D_R*0.72,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha=1; noGlow();
}

function drawDerezz(p) {
  if(p.alive||!p._derezzTime) return;
  const elapsed=(Date.now()-p._derezzTime)/1000;
  if(elapsed>1.5) return;
  ctx.globalAlpha=Math.max(0,1-elapsed*0.7);
  for(let i=0;i<8;i++){
    const angle=(i/8)*Math.PI*2+elapsed*2, dist=elapsed*70+10, size=Math.max(1,7-elapsed*4);
    glow(p.color,10); ctx.fillStyle=p.color;
    ctx.fillRect(p.x+Math.cos(angle)*dist-size/2, p.y+Math.sin(angle)*dist-size/2, size, size);
  }
  ctx.globalAlpha=1; noGlow();
}

function render() {
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawArena();
  drawBodies();
  const all=Object.values(players);
  all.forEach(p=>{ if(p.disc) drawDisc(p.disc); });
  all.forEach(p=>{ drawDerezz(p); drawPlayer(p); });

  // aim line
  const me=players[myId];
  if(me&&me.alive&&me.hasDisc&&(gameState==='playing'||gameState==='finalBattle')){
    const dx=mouseWorld.x-me.x, dy=mouseWorld.y-me.y, l=Math.sqrt(dx*dx+dy*dy)||1;
    ctx.strokeStyle=me.color; ctx.lineWidth=1; ctx.setLineDash([4,8]);
    ctx.globalAlpha=0.45; glow(me.color,6);
    ctx.beginPath();
    ctx.moveTo(me.x+(dx/l)*(P_R+2), me.y+(dy/l)*(P_R+2));
    ctx.lineTo(me.x+(dx/l)*60,       me.y+(dy/l)*60);
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha=1; noGlow();
  }
}

let loopRunning=false;
function loop(){
  if(loopRunning) return; loopRunning=true;
  function frame(){ render(); if(gameState!=='title') requestAnimationFrame(frame); else loopRunning=false; }
  requestAnimationFrame(frame);
}

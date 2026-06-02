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
let localTileMap = null;
let discRotAngle = 0;
let gravity = { x: 0, y: 0 };
let gravityAnnounceTick = 0;

const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

// ── hex math (client mirror) ───────────────────────────────────────────
const sqrt3 = Math.sqrt(3);
const HEX_SIZE = 26;

function hexToWorld(q, r, size) {
  return { x: size*(sqrt3*q + sqrt3/2*r), y: size*(3/2*r) };
}
function worldToHexFrac(x, y, size) {
  return { q:(sqrt3/3*x - 1/3*y)/size, r:(2/3*y)/size };
}
function hexRound(fq, fr) {
  const fs=-fq-fr;
  let rq=Math.round(fq),rr=Math.round(fr),rs=Math.round(fs);
  const dq=Math.abs(rq-fq),dr=Math.abs(rr-fr),ds=Math.abs(rs-fs);
  if(dq>dr&&dq>ds) rq=-rr-rs;
  else if(dr>ds) rr=-rq-rs;
  return {q:rq,r:rr};
}
function buildLocalTileMap(a) {
  const cx=a.width/2, cy=a.height/2;
  const R=Math.min(a.width,a.height)*0.44;
  const size=HEX_SIZE;
  const tiles={};
  const range=Math.ceil(R/size)+2;
  for(let q=-range;q<=range;q++){
    for(let r=-range;r<=range;r++){
      const {x:lx,y:ly}=hexToWorld(q,r,size);
      const d=Math.sqrt(lx*lx+ly*ly);
      if(d+size*0.6<=R) tiles[`${q},${r}`]={q,r,x:cx+lx,y:cy+ly,state:0};
    }
  }
  return {tiles,cx,cy,R,size};
}

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
  if (e.key === 'Shift') {
    if (gameState === 'playing' || gameState === 'finalBattle') {
      socket.emit('blockStart');
    }
  }
  sendInput();
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (e.key === 'Shift') {
    socket.emit('blockEnd');
  }
  sendInput();
});

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
  localTileMap=null;
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
  localTileMap = buildLocalTileMap(a);
  document.getElementById('gameOverScreen').style.display='none';
  setLobbyMode(false); resizeCanvas();
  Audio.startMusic(); Audio.startChanting();
});

socket.on('finalBattle', ({ arena: a }) => {
  arena=a; gameState='finalBattle';
  localTileMap = buildLocalTileMap(a);
  resizeCanvas(); showFinalBanner();
  Audio.finalMode(true); Audio.crowdExcited();
});

socket.on('gameState', ({ players: ps, bodies: b, arena: a, state, changedTiles, gravity: g }) => {
  arena=a; bodies=b||[];
  if (g) gravity=g;
  ps.forEach(p => { if(players[p.id]) Object.assign(players[p.id],p); else players[p.id]=p; });
  if (localTileMap && changedTiles) {
    for (const ct of changedTiles) {
      if (localTileMap.tiles[ct.id]) localTileMap.tiles[ct.id].state = ct.state;
    }
  }
  if (gameState==='playing'||gameState==='finalBattle') updateHUD();
});

socket.on('gravityShift', ({ angle, strength }) => {
  gravity.x = Math.cos(angle) * strength;
  gravity.y = Math.sin(angle) * strength;
  gravityAnnounceTick = Date.now();
  Audio.derezz && Audio.dodge && Audio.dodge();
});

socket.on('playerEliminated', ({ id, killerName }) => {
  Audio.derezz(); Audio.crowdExcited();
  if (players[id]) { players[id]._derezzTime=Date.now(); players[id].alive=false; }
  const victimName = players[id]?.name||'???';
  addKillFeed(killerName||'VOID', victimName);
});

socket.on('discCaught', ({ playerId }) => { if(playerId===myId) Audio.discCatch(); });

socket.on('gameOver', ({ winnerId, winnerName }) => {
  gameState='gameOver';
  Audio.stopMusic(); Audio.stopChanting();
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
    let status = p.alive
      ? (p.hasDisc ? '◈ DISC READY' : (p.dodging ? '⚡ DODGING' : (p.blocking ? '🛡 BLOCKING' : '◌ disc away')))
      : '✕ DEREZZED';
    el.innerHTML=`<span class="hud-name">${p.name}${p.id===myId?' ◀':''}${p.isBot?' 🤖':''}</span>
                  <span class="hud-disc">${status}</span>`;
    hud.appendChild(el);
  });
  const alive=Object.values(players).filter(p=>p.alive).length;
  document.getElementById('hudCenter').textContent = gameState==='finalBattle'
    ? '⚡ FINAL BATTLE'
    : `${alive} PROGRAM${alive!==1?'S':''} REMAIN`;
}

// ── render helpers ─────────────────────────────────────────────────────
const P_R=18, D_R=11;

function glow(color,blur){ ctx.shadowColor=color; ctx.shadowBlur=blur; }
function noGlow()         { ctx.shadowBlur=0; }

// ── draw hex tiles ─────────────────────────────────────────────────────
function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i=0;i<6;i++) {
    const angle = Math.PI/180*(60*i - 30); // pointy-top
    pts.push({x: cx+size*Math.cos(angle), y: cy+size*Math.sin(angle)});
  }
  return pts;
}

function drawHexTile(t, now) {
  const pts = hexCorners(t.x, t.y, HEX_SIZE-1);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for(let i=1;i<6;i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();

  if (t.state === 0) {
    ctx.fillStyle = 'rgba(0,15,30,0.85)';
    ctx.fill();
    glow('#00f7ff', 4);
    ctx.strokeStyle = 'rgba(0,200,255,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    noGlow();
  } else if (t.state === 1) {
    // cracking — flash orange
    const flash = 0.5+0.5*Math.sin(now*0.02);
    ctx.fillStyle = `rgba(${Math.floor(180+75*flash)},${Math.floor(60+30*flash)},0,0.9)`;
    ctx.fill();
    glow('#ff8800', 12);
    ctx.strokeStyle = '#ffaa00';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    noGlow();
  } else if (t.state === 2) {
    // destroyed — void
    ctx.fillStyle = 'rgba(0,0,0,0.97)';
    ctx.fill();
    glow('#001040', 8);
    ctx.strokeStyle = 'rgba(30,0,80,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    noGlow();
  }
}

function drawHexTiles() {
  if (!localTileMap) return;
  const now = Date.now();
  for (const t of Object.values(localTileMap.tiles)) {
    drawHexTile(t, now);
  }
}

// ── draw arena ─────────────────────────────────────────────────────────
function drawArena() {
  // black void outside circle
  ctx.fillStyle='#000'; ctx.fillRect(0,0,arena.width,arena.height);

  const tm = localTileMap;
  if (!tm) {
    // fallback if no tilemap yet
    ctx.fillStyle='#020b14';
    ctx.beginPath(); ctx.arc(arena.width/2,arena.height/2,Math.min(arena.width,arena.height)*0.44,0,Math.PI*2); ctx.fill();
    return;
  }

  // clip to circle for floor
  ctx.save();
  ctx.beginPath(); ctx.arc(tm.cx, tm.cy, tm.R, 0, Math.PI*2); ctx.clip();

  // draw hex tile floor
  drawHexTiles();

  ctx.restore();

  // outer ring wall
  const wc = gameState==='finalBattle'?'#ff6600':'#00f7ff';
  ctx.strokeStyle=wc; ctx.lineWidth=4;
  glow(wc, 24);
  ctx.beginPath(); ctx.arc(tm.cx, tm.cy, tm.R, 0, Math.PI*2); ctx.stroke();
  noGlow();

  // secondary inner ring
  ctx.strokeStyle = gameState==='finalBattle'?'rgba(255,102,0,0.3)':'rgba(0,200,255,0.2)';
  ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(tm.cx, tm.cy, tm.R-6, 0, Math.PI*2); ctx.stroke();

  // lobby text
  if (gameState==='lobby') {
    ctx.fillStyle='rgba(0,247,255,0.07)';
    ctx.font='bold 20px "Courier New"'; ctx.textAlign='center';
    ctx.fillText('MOVE FREELY — GAME STARTS SOON', arena.width/2, arena.height/2);
  }

  // room code watermark
  ctx.fillStyle='rgba(0,247,255,0.06)'; ctx.font='13px "Courier New"'; ctx.textAlign='right';
  ctx.fillText(myRoomCode||'', arena.width-30, arena.height-14);
}

// ── draw bodies ─────────────────────────────────────────────────────────
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
    ctx.globalAlpha=0.3; ctx.fillStyle=body.color;
    ctx.font='9px "Courier New"'; ctx.textAlign='center';
    glow(body.color,4);
    ctx.fillText('✕ '+body.name, body.x, body.y-30);
    ctx.globalAlpha=1; noGlow();
  }
  ctx.globalAlpha=1; noGlow();
}

// ── draw full TRON program body ────────────────────────────────────────
function drawProgram(ctx2, dc, hasDisc, isBlocking, isDodging, isMe, walkPhase) {
  const S = '#010c18'; // suit base dark

  // ── BOOTS ───────────────────────────────────────────────────────────
  ctx2.fillStyle = S;
  ctx2.fillRect(-8, 20+walkPhase, 7, 6);   // left boot
  ctx2.fillRect(1,  20-walkPhase, 7, 6);   // right boot
  ctx2.fillStyle = dc; ctx2.globalAlpha=0.55;
  ctx2.fillRect(-7, 20+walkPhase, 5, 2);
  ctx2.fillRect(2,  20-walkPhase, 5, 2);
  ctx2.globalAlpha=1;

  // ── LEGS ────────────────────────────────────────────────────────────
  ctx2.fillStyle = S;
  ctx2.fillRect(-7, 7+walkPhase,  5, 14);  // left
  ctx2.fillRect(2,  7-walkPhase,  5, 14);  // right
  glow(dc, 6);
  ctx2.fillStyle=dc; ctx2.globalAlpha=0.75;
  ctx2.fillRect(-6, 11+walkPhase, 3, 2);
  ctx2.fillRect(-6, 16+walkPhase, 3, 2);
  ctx2.fillRect(3,  11-walkPhase, 3, 2);
  ctx2.fillRect(3,  16-walkPhase, 3, 2);
  ctx2.globalAlpha=1; noGlow();

  // ── TORSO ───────────────────────────────────────────────────────────
  ctx2.fillStyle = S;
  ctx2.fillRect(-9, -10, 18, 18);

  glow(dc, 10);
  ctx2.strokeStyle=dc; ctx2.lineWidth=1.5;
  ctx2.beginPath(); ctx2.moveTo(-8,-4); ctx2.lineTo(8,-4); ctx2.stroke();  // chest
  ctx2.beginPath(); ctx2.moveTo(-8, 1); ctx2.lineTo(8, 1); ctx2.stroke();  // mid
  ctx2.beginPath(); ctx2.moveTo(-8, 6); ctx2.lineTo(8, 6); ctx2.stroke();  // lower
  ctx2.lineWidth=1;
  ctx2.beginPath(); ctx2.moveTo(0,-10); ctx2.lineTo(0,8);  ctx2.stroke();  // spine

  // chest reactor glow
  ctx2.fillStyle=dc; ctx2.globalAlpha=0.65;
  ctx2.beginPath(); ctx2.arc(0,-1,3.5,0,Math.PI*2); ctx2.fill();
  ctx2.globalAlpha=1; noGlow();

  // ── SHOULDERS ───────────────────────────────────────────────────────
  ctx2.fillStyle=S;
  ctx2.fillRect(-18,-12, 10, 5);  // left
  ctx2.fillRect(8,  -12, 10, 5);  // right
  glow(dc,7); ctx2.fillStyle=dc; ctx2.globalAlpha=0.65;
  ctx2.fillRect(-17,-12, 8, 2);
  ctx2.fillRect(9,  -12, 8, 2);
  ctx2.globalAlpha=1; noGlow();

  // ── ARMS ────────────────────────────────────────────────────────────
  ctx2.fillStyle=S;
  ctx2.fillRect(-18,-7, 7, 14);  // left arm
  ctx2.fillRect(11, -7, 7, 14);  // right arm
  ctx2.fillStyle=dc; ctx2.globalAlpha=0.55;
  ctx2.fillRect(-17,-2,4,2); ctx2.fillRect(-17,4,4,2);  // left stripes
  ctx2.fillRect(13, -2,4,2); ctx2.fillRect(13, 4,4,2);  // right stripes
  ctx2.globalAlpha=1;
  // gauntlets
  ctx2.fillStyle=S; ctx2.fillRect(-19,5,8,5); ctx2.fillRect(11,5,8,5);
  ctx2.fillStyle=dc; ctx2.globalAlpha=0.6;
  ctx2.fillRect(-18,5,6,2); ctx2.fillRect(12,5,6,2);
  ctx2.globalAlpha=1;

  // ── NECK ────────────────────────────────────────────────────────────
  ctx2.fillStyle=S; ctx2.fillRect(-3,-16,6,7);

  // ── HELMET ──────────────────────────────────────────────────────────
  noGlow();
  ctx2.fillStyle=S;
  ctx2.beginPath(); ctx2.ellipse(0,-24,11,13,0,0,Math.PI*2); ctx2.fill();

  glow(dc,20);
  ctx2.strokeStyle=dc; ctx2.lineWidth=2;
  ctx2.beginPath(); ctx2.ellipse(0,-24,10,12,0,0,Math.PI*2); ctx2.stroke();

  // visor bar
  ctx2.fillStyle=dc; ctx2.globalAlpha=0.75;
  ctx2.beginPath(); ctx2.ellipse(0,-24,6,3,0,0,Math.PI*2); ctx2.fill();
  ctx2.globalAlpha=1;

  // helmet band lines
  ctx2.strokeStyle=dc; ctx2.lineWidth=1; ctx2.globalAlpha=0.4;
  ctx2.beginPath(); ctx2.ellipse(0,-22,7,5,0,0,Math.PI*2); ctx2.stroke();
  ctx2.globalAlpha=1; noGlow();

  // ── DISC (on arm when held) ─────────────────────────────────────────
  if (hasDisc) {
    const dr=9;
    glow(dc,14);
    ctx2.strokeStyle=dc; ctx2.lineWidth=2.5;
    ctx2.beginPath(); ctx2.arc(15,-3,dr,0,Math.PI*2); ctx2.stroke();
    noGlow();
    ctx2.fillStyle='#020b14';
    ctx2.beginPath(); ctx2.arc(15,-3,dr-3,0,Math.PI*2); ctx2.fill();
    ctx2.strokeStyle=dc; ctx2.lineWidth=1; ctx2.globalAlpha=0.45;
    ctx2.beginPath(); ctx2.arc(15,-3,dr-1,0,Math.PI*2); ctx2.stroke();
    ctx2.globalAlpha=1;
  }

  // ── DODGE aura ──────────────────────────────────────────────────────
  if (isDodging) {
    glow(dc,28); ctx2.strokeStyle='#fff'; ctx2.lineWidth=2; ctx2.setLineDash([3,5]);
    ctx2.beginPath(); ctx2.ellipse(0,5,20,33,0,0,Math.PI*2); ctx2.stroke();
    ctx2.setLineDash([]); noGlow();
  }

  // ── "You" ring ───────────────────────────────────────────────────────
  if (isMe) {
    const pulse=0.3+0.2*Math.sin(Date.now()*0.005);
    ctx2.strokeStyle='#fff'; ctx2.lineWidth=1.5; ctx2.globalAlpha=pulse;
    ctx2.beginPath(); ctx2.ellipse(0,5,22,35,0,0,Math.PI*2); ctx2.stroke();
    ctx2.globalAlpha=1;
  }
}

function drawPlayer(p) {
  if (!p.alive) return;
  const {x,y}=p;
  const isFalling = p.fallTimer && p.fallTimer > 0;
  const flashRed  = isFalling && Math.floor(Date.now()/80)%2===0;
  const dc = flashRed ? '#ff4444' : p.color;
  const isMoving = Math.abs(p.inputVx||0)+Math.abs(p.inputVy||0) > 0.15;
  const walkPhase = isMoving ? Math.sin(Date.now()*0.013)*4 : 0;
  const angle = Math.atan2(p.facing.y, p.facing.x) + Math.PI/2;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  drawProgram(ctx, dc, p.hasDisc, p.blocking, p.dodging, p.id===myId, walkPhase);
  ctx.restore();

  // ── blocking disc shield (world space, in front) ────────────────────
  if (p.blocking) {
    const sx=x+p.facing.x*30, sy=y+p.facing.y*30;
    glow(dc,35); ctx.strokeStyle=dc; ctx.lineWidth=4;
    ctx.beginPath(); ctx.arc(sx,sy,18,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(sx,sy,11,0,Math.PI*2); ctx.stroke();
    noGlow();
  }

  // ── name label (always upright) ─────────────────────────────────────
  const label = p.isBot ? '🤖 '+p.name : p.name;
  ctx.fillStyle=dc; ctx.font='bold 10px "Courier New"'; ctx.textAlign='center';
  glow(dc,6); ctx.fillText(label,x,y-44); noGlow();
}

// ── draw disc ─────────────────────────────────────────────────────────
function drawDisc(disc) {
  if(!disc) return;
  const{x,y,ownerColor,returning,vx,vy}=disc;
  const speed=Math.sqrt(vx*vx+vy*vy)||1;
  const nx=vx/speed, ny=vy/speed;
  const col=returning?'#ffffff':ownerColor;

  // motion trail
  for(let i=1;i<=5;i++){
    ctx.globalAlpha=0.22-i*0.04; ctx.fillStyle=ownerColor;
    glow(ownerColor, 4);
    ctx.beginPath(); ctx.arc(x-nx*i*5,y-ny*i*5,D_R*(1-i*0.12),0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha=1; noGlow();

  // outer glowing ring
  glow(col, returning?35:22);
  ctx.strokeStyle=col; ctx.lineWidth=3;
  ctx.beginPath(); ctx.arc(x,y,D_R,0,Math.PI*2); ctx.stroke();

  // inner ring (rotates)
  ctx.strokeStyle=returning?'rgba(255,255,255,0.6)':ownerColor;
  ctx.lineWidth=1.5;
  ctx.save();
  ctx.translate(x,y);
  ctx.rotate(discRotAngle);
  ctx.beginPath(); ctx.arc(0,0,D_R*0.65,0,Math.PI*2); ctx.stroke();
  // tick marks
  for(let i=0;i<4;i++){
    const a=i*Math.PI/2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*D_R*0.48, Math.sin(a)*D_R*0.48);
    ctx.lineTo(Math.cos(a)*D_R*0.65, Math.sin(a)*D_R*0.65);
    ctx.stroke();
  }
  ctx.restore();

  // dark center
  noGlow();
  ctx.fillStyle='#000810';
  ctx.beginPath(); ctx.arc(x,y,D_R*0.38,0,Math.PI*2); ctx.fill();
  noGlow();
}

// ── draw derezz ─────────────────────────────────────────────────────────
function drawDerezz(p) {
  if(p.alive||!p._derezzTime) return;
  const elapsed=(Date.now()-p._derezzTime)/1000;
  if(elapsed>2.0) return;
  ctx.globalAlpha=Math.max(0,1-elapsed*0.55);
  for(let i=0;i<12;i++){
    const angle=(i/12)*Math.PI*2+elapsed*1.5, d=elapsed*90+10, size=Math.max(1,8-elapsed*4);
    glow(p.color,12); ctx.fillStyle=p.color;
    ctx.save();
    ctx.translate(p.x+Math.cos(angle)*d, p.y+Math.sin(angle)*d);
    ctx.rotate(elapsed*3+i);
    ctx.fillRect(-size/2,-size/2,size,size);
    ctx.restore();
  }
  ctx.globalAlpha=1; noGlow();
}

// ── render ─────────────────────────────────────────────────────────────
function render() {
  discRotAngle += 0.052; // ~3 deg per frame at 60fps

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

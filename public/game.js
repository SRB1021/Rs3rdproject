/* ── DISC WARS – CLIENT ──────────────────────────────────────────────── */

const socket = io();

// ── State ─────────────────────────────────────────────────────────────
let myId      = null;
let gameState = 'lobby';
let arena     = { width: 960, height: 640 };
let players   = {};   // id → player
let prevState = null; // for interpolation
let keys      = {};
let mouseWorld = { x: 0, y: 0 };

let canvasOffsetX = 0;
let canvasOffsetY = 0;

// ── Canvas / HUD ───────────────────────────────────────────────────────
const canvas  = document.getElementById('gameCanvas');
const ctx     = canvas.getContext('2d');

// ── Input ──────────────────────────────────────────────────────────────
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

window.addEventListener('keyup', e => {
  keys[e.key.toLowerCase()] = false;
  sendInput();
});

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  mouseWorld.x = e.clientX - r.left - canvasOffsetX;
  mouseWorld.y = e.clientY - r.top  - canvasOffsetY;
});

canvas.addEventListener('click', e => {
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
  // d key is DODGE only – not movement, to avoid conflict
  if (keys['arrowright']) vx += 1;
  // allow q/e as strafing alternatives
  if (keys['q']) vx -= 1;
  if (keys['e']) vx += 1;

  socket.emit('input', { vx, vy });
}

// ── Socket events ──────────────────────────────────────────────────────
socket.on('joined', ({ playerId, players: ps, state, arena: a }) => {
  myId = playerId;
  gameState = state;
  arena = a;
  players = {};
  ps.forEach(p => players[p.id] = p);
  updateLobbyUI();
  updateStartButton();
});

socket.on('playerJoined', ({ player }) => {
  players[player.id] = player;
  updateLobbyUI();
  updateStartButton();
});

socket.on('playerLeft', ({ id }) => {
  delete players[id];
  updateLobbyUI();
});

socket.on('playerUpdate', ({ id, name }) => {
  if (players[id]) players[id].name = name;
  updateLobbyUI();
});

socket.on('gameStart', ({ arena: a }) => {
  arena = a;
  gameState = 'playing';
  showGame();
  Audio.startMusic();
  Audio.startChanting();
  loop();
});

socket.on('finalBattle', ({ arena: a }) => {
  arena = a;
  gameState = 'finalBattle';
  resizeCanvas();
  showFinalBanner();
  Audio.finalMode(true);
  Audio.crowdExcited();
});

socket.on('gameState', (data) => {
  prevState = JSON.parse(JSON.stringify(players));
  data.players.forEach(p => {
    players[p.id] = p;
  });
  updateHUD();
});

socket.on('playerEliminated', ({ id, killerId, killerName }) => {
  Audio.derezz();
  Audio.crowdExcited();
  addKillFeed(killerName, players[id]?.name || '???');
  if (players[id]) players[id].alive = false;
});

socket.on('discThrown', ({ playerId }) => {
  // already played locally if it's us
});

socket.on('discCaught', ({ playerId }) => {
  if (playerId === myId) Audio.discCatch();
});

socket.on('gameOver', ({ winnerId, winnerName }) => {
  gameState = 'gameOver';
  Audio.stopMusic();
  Audio.stopChanting();
  showGameOver(winnerName, winnerId === myId);
});

// ── Lobby UI ───────────────────────────────────────────────────────────
const nameInput  = document.getElementById('nameInput');
const startBtn   = document.getElementById('startBtn');
const waitMsg    = document.getElementById('waitMsg');
const playerList = document.getElementById('playerList');

nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim();
  if (name) socket.emit('setName', name);
});
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const name = nameInput.value.trim();
    if (name) socket.emit('setName', name);
    nameInput.blur();
  }
});

startBtn.addEventListener('click', () => {
  Audio.init();
  socket.emit('startGame');
});

document.getElementById('playAgainBtn').addEventListener('click', () => {
  document.getElementById('gameOverScreen').style.display = 'none';
  gameState = 'lobby';
  document.getElementById('gameWrap').style.display = 'none';
  document.getElementById('lobby').style.display    = 'flex';
  socket.emit('startGame');
});

function updateLobbyUI() {
  playerList.innerHTML = '';
  Object.values(players).forEach(p => {
    const el = document.createElement('div');
    el.className = 'pl-item';
    el.innerHTML = `<span class="pl-dot" style="background:${p.color};box-shadow:0 0 6px ${p.color}"></span>
                    <span style="color:${p.color}">${p.name}${p.id === myId ? ' (you)' : ''}</span>`;
    playerList.appendChild(el);
  });
}

function updateStartButton() {
  const count = Object.keys(players).length;
  const isFirst = Object.keys(players)[0] === myId;
  if (isFirst) {
    startBtn.style.display = 'block';
    waitMsg.style.display  = 'none';
    startBtn.textContent   = count >= 2 ? `START GAME (${count} players)` : 'START SOLO (test)';
  } else {
    startBtn.style.display = 'none';
    waitMsg.style.display  = 'block';
  }
}

// ── Game display ───────────────────────────────────────────────────────
function showGame() {
  document.getElementById('lobby').style.display    = 'none';
  document.getElementById('gameWrap').style.display = 'block';
  resizeCanvas();
}

function resizeCanvas() {
  const vw = window.innerWidth, vh = window.innerHeight;
  const scaleX = vw / arena.width;
  const scaleY = vh / arena.height;
  const scale  = Math.min(scaleX, scaleY, 1);

  canvas.width  = arena.width;
  canvas.height = arena.height;
  canvas.style.width  = `${arena.width  * scale}px`;
  canvas.style.height = `${arena.height * scale}px`;

  // Recalculate mouse offset
  const r = canvas.getBoundingClientRect();
  canvasOffsetX = 0;
  canvasOffsetY = 0;
}

window.addEventListener('resize', () => { if (gameState !== 'lobby') resizeCanvas(); });

// ── Final battle banner ────────────────────────────────────────────────
function showFinalBanner() {
  const banner = document.getElementById('finalBanner');
  banner.style.display = 'flex';
  setTimeout(() => { banner.style.display = 'none'; }, 3200);
}

// ── Game over screen ───────────────────────────────────────────────────
function showGameOver(winnerName, isMe) {
  const screen = document.getElementById('gameOverScreen');
  const winner = document.getElementById('goWinner');
  winner.textContent = isMe ? 'YOU WIN, PROGRAM.' : `${winnerName} WINS`;
  screen.style.display = 'flex';
}

// ── Kill feed ──────────────────────────────────────────────────────────
function addKillFeed(killer, victim) {
  const feed = document.getElementById('killFeed');
  const el   = document.createElement('div');
  el.className = 'kill-entry';
  el.innerHTML = `<span style="color:#ff6600">${killer}</span> derezzed <span style="color:#aaa">${victim}</span>`;
  feed.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ── HUD ────────────────────────────────────────────────────────────────
function updateHUD() {
  const hud = document.getElementById('hudPlayers');
  hud.innerHTML = '';
  Object.values(players).sort((a, b) => b.score - a.score).forEach(p => {
    const el = document.createElement('div');
    el.className = 'hud-player' + (p.alive ? '' : ' hud-dead');
    el.style.color = p.color;
    el.style.borderColor = p.color;

    const dodgePct = p.alive ? Math.max(0, 1 - p.dodgeCooldown / 2.2) * 100 : 0;
    el.innerHTML = `
      <span class="hud-name">${p.name}${p.id === myId ? ' ◀' : ''}</span>
      <span class="hud-disc">${p.alive ? (p.hasDisc ? '◈ DISC READY' : (p.dodging ? '⚡ DODGING' : '◌ disc away')) : '✕ DEREZZED'}</span>
    `;
    hud.appendChild(el);
  });

  const center = document.getElementById('hudCenter');
  const alive  = Object.values(players).filter(p => p.alive).length;
  center.textContent = gameState === 'finalBattle'
    ? '⚡ FINAL BATTLE'
    : `${alive} PROGRAM${alive !== 1 ? 'S' : ''} REMAIN`;
}

// ── RENDER ─────────────────────────────────────────────────────────────
const WALL = 24;
const P_R  = 18;
const D_R  = 11;

function glow(color, blur) {
  ctx.shadowColor = color;
  ctx.shadowBlur  = blur;
}
function noGlow() {
  ctx.shadowBlur = 0;
}

function drawArena() {
  // Background
  ctx.fillStyle = '#020b14';
  ctx.fillRect(0, 0, arena.width, arena.height);

  // Grid
  ctx.strokeStyle = '#0a2030';
  ctx.lineWidth   = 1;
  const gs = 40;
  for (let x = WALL; x <= arena.width - WALL; x += gs) {
    ctx.beginPath(); ctx.moveTo(x, WALL); ctx.lineTo(x, arena.height - WALL); ctx.stroke();
  }
  for (let y = WALL; y <= arena.height - WALL; y += gs) {
    ctx.beginPath(); ctx.moveTo(WALL, y); ctx.lineTo(arena.width - WALL, y); ctx.stroke();
  }

  // Walls
  const wallColor = gameState === 'finalBattle' ? '#ff6600' : '#00f7ff';
  ctx.strokeStyle = wallColor;
  ctx.lineWidth   = 3;
  glow(wallColor, 18);
  ctx.strokeRect(WALL, WALL, arena.width - WALL * 2, arena.height - WALL * 2);

  // Corner markers
  const corners = [[WALL, WALL], [arena.width - WALL, WALL],
                   [WALL, arena.height - WALL], [arena.width - WALL, arena.height - WALL]];
  corners.forEach(([cx, cy]) => {
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = wallColor;
    glow(wallColor, 20);
    ctx.fill();
  });
  noGlow();
}

function drawPlayer(p) {
  if (!p.alive) {
    // Derezz fragments
    return;
  }

  const x = p.x, y = p.y;
  const c = p.color;

  // Dodge flash
  if (p.dodging) {
    glow(c, 40);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(x, y, P_R + 8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Body
  glow(c, 22);
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.arc(x, y, P_R, 0, Math.PI * 2);
  ctx.fill();

  // Inner dark
  noGlow();
  ctx.fillStyle = '#020b14';
  ctx.beginPath();
  ctx.arc(x, y, P_R * 0.55, 0, Math.PI * 2);
  ctx.fill();

  // Facing direction indicator
  glow(c, 10);
  ctx.strokeStyle = c;
  ctx.lineWidth   = 2;
  ctx.beginPath();
  ctx.moveTo(x + p.facing.x * P_R * 0.55, y + p.facing.y * P_R * 0.55);
  ctx.lineTo(x + p.facing.x * (P_R + 6),  y + p.facing.y * (P_R + 6));
  ctx.stroke();
  noGlow();

  // Is-me marker
  if (p.id === myId) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 1;
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.arc(x, y, P_R + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Name tag
  ctx.fillStyle   = c;
  ctx.font        = '10px "Courier New"';
  ctx.textAlign   = 'center';
  ctx.shadowColor = c;
  ctx.shadowBlur  = 6;
  ctx.fillText(p.name, x, y - P_R - 6);
  noGlow();
}

function drawDisc(disc, ownerAlive) {
  if (!disc) return;
  const { x, y, ownerColor, returning } = disc;

  // Trail
  glow(ownerColor, returning ? 10 : 20);
  const trailLen = 5;
  const speed    = Math.sqrt(disc.vx * disc.vx + disc.vy * disc.vy) || 1;
  const nx       = disc.vx / speed, ny = disc.vy / speed;
  for (let i = 1; i <= trailLen; i++) {
    ctx.globalAlpha = 0.25 - i * 0.04;
    ctx.fillStyle   = ownerColor;
    ctx.beginPath();
    ctx.arc(x - nx * i * 5, y - ny * i * 5, D_R * (1 - i * 0.12), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Disc body
  const col = returning ? '#ffffff' : ownerColor;
  glow(col, returning ? 30 : 22);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x, y, D_R, 0, Math.PI * 2);
  ctx.fill();

  // Center hole
  noGlow();
  ctx.fillStyle = '#020b14';
  ctx.beginPath();
  ctx.arc(x, y, D_R * 0.38, 0, Math.PI * 2);
  ctx.fill();

  // Spin ring
  ctx.strokeStyle = col;
  ctx.lineWidth   = 1.5;
  glow(col, 8);
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.arc(x, y, D_R * 0.72, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  noGlow();
}

function drawDerezz(p) {
  if (p.alive) return;
  // Scattered cubes around last position
  if (!p._derezzTime) p._derezzTime = Date.now();
  const elapsed = (Date.now() - p._derezzTime) / 1000;
  if (elapsed > 2) return;
  const alpha = Math.max(0, 1 - elapsed * 0.5);
  ctx.globalAlpha = alpha;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 + elapsed * 2;
    const dist  = elapsed * 60 + 10;
    const fx    = p.x + Math.cos(angle) * dist;
    const fy    = p.y + Math.sin(angle) * dist;
    const size  = Math.max(1, 6 - elapsed * 3);
    glow(p.color, 10);
    ctx.fillStyle = p.color;
    ctx.fillRect(fx - size / 2, fy - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
  noGlow();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawArena();

  const allPlayers = Object.values(players);

  // Discs
  allPlayers.forEach(p => {
    if (p.disc) drawDisc(p.disc, p.alive);
  });

  // Players
  allPlayers.forEach(p => {
    drawDerezz(p);
    drawPlayer(p);
  });

  // Aim line for local player
  const me = players[myId];
  if (me && me.alive && me.hasDisc && (gameState === 'playing' || gameState === 'finalBattle')) {
    const dx = mouseWorld.x - me.x;
    const dy = mouseWorld.y - me.y;
    const l  = Math.sqrt(dx * dx + dy * dy) || 1;
    const endX = me.x + (dx / l) * 60;
    const endY = me.y + (dy / l) * 60;

    ctx.strokeStyle = me.color;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 8]);
    ctx.globalAlpha = 0.45;
    glow(me.color, 6);
    ctx.beginPath();
    ctx.moveTo(me.x + (dx / l) * (P_R + 2), me.y + (dy / l) * (P_R + 2));
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    noGlow();
  }
}

// ── Game loop ──────────────────────────────────────────────────────────
let loopRunning = false;
function loop() {
  if (loopRunning) return;
  loopRunning = true;
  function frame() {
    render();
    if (gameState !== 'lobby') requestAnimationFrame(frame);
    else loopRunning = false;
  }
  requestAnimationFrame(frame);
}

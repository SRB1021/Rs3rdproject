const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE = 60;

const STANDARD_ARENA = { width: 960, height: 640 };
const FINAL_ARENA   = { width: 1280, height: 860 };
const WALL          = 24;
const P_RADIUS      = 18;
const D_RADIUS      = 11;
const P_SPEED       = 230;       // px/s
const DISC_SPEED    = 500;       // px/s
const DISC_RETURN_SPEED = 620;
const DODGE_SPEED   = 680;
const DODGE_DUR     = 0.26;      // s
const DODGE_CD      = 0;         // no cooldown
const BOUNCE_MAX    = 6;
const RETURN_AFTER  = 2.8;       // s

const COLORS = ['#00f7ff', '#ff6600', '#00ff88', '#ff00ff', '#ffee00', '#ff3355'];

let rooms = {};

function createRoom(id) {
  return { id, players: {}, state: 'lobby', arena: { ...STANDARD_ARENA }, winner: null };
}

function createPlayer(id, colorIdx) {
  return {
    id, name: `Program-${colorIdx + 1}`,
    color: COLORS[colorIdx % COLORS.length],
    x: 0, y: 0, inputVx: 0, inputVy: 0,
    alive: true, hasDisc: true, disc: null,
    dodging: false, dodgeTimer: 0, dodgeCooldown: 0,
    dodgeVx: 0, dodgeVy: 0,
    facing: { x: 1, y: 0 },
    score: 0,
  };
}

function spawnPositions(n, arena) {
  const pad = 90;
  const all = [
    { x: pad,               y: pad },
    { x: arena.width - pad, y: arena.height - pad },
    { x: arena.width - pad, y: pad },
    { x: pad,               y: arena.height - pad },
    { x: arena.width / 2,   y: pad },
    { x: arena.width / 2,   y: arena.height - pad },
  ];
  return all.slice(0, n);
}

function startGame(room) {
  room.state  = 'playing';
  room.arena  = { ...STANDARD_ARENA };
  room.winner = null;

  const list = Object.values(room.players);
  const pos  = spawnPositions(list.length, room.arena);
  list.forEach((p, i) => {
    Object.assign(p, {
      alive: true, hasDisc: true, disc: null,
      dodging: false, dodgeTimer: 0, dodgeCooldown: 0,
      x: pos[i].x, y: pos[i].y, inputVx: 0, inputVy: 0,
    });
  });

  io.to(room.id).emit('gameStart', { arena: room.arena });
}

function makeDisc(player, tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  const l  = Math.sqrt(dx * dx + dy * dy) || 1;
  return {
    x: player.x, y: player.y,
    vx: (dx / l) * DISC_SPEED, vy: (dy / l) * DISC_SPEED,
    ownerId: player.id, ownerColor: player.color,
    bounces: 0, returning: false, timer: 0, active: true,
  };
}

function checkWin(room) {
  const alive = Object.values(room.players).filter(p => p.alive);

  if (alive.length === 1) {
    alive[0].score++;
    room.winner = alive[0].id;
    room.state  = 'gameOver';
    io.to(room.id).emit('gameOver', { winnerId: alive[0].id, winnerName: alive[0].name });
    return;
  }

  if (alive.length === 2 && room.state === 'playing') {
    room.state = 'finalBattle';
    room.arena = { ...FINAL_ARENA };
    const pos  = spawnPositions(2, room.arena);
    alive.forEach((p, i) => {
      p.x = pos[i].x; p.y = pos[i].y;
      p.hasDisc = true; p.disc = null;
    });
    io.to(room.id).emit('finalBattle', { arena: room.arena });
  }
}

function tick(room, dt) {
  if (room.state !== 'playing' && room.state !== 'finalBattle') return;

  const a    = room.arena;
  const minX = WALL + P_RADIUS, maxX = a.width  - WALL - P_RADIUS;
  const minY = WALL + P_RADIUS, maxY = a.height - WALL - P_RADIUS;

  const alive = Object.values(room.players).filter(p => p.alive);

  for (const p of alive) {
    // Movement
    if (p.dodging) {
      p.dodgeTimer -= dt;
      p.x += p.dodgeVx * dt;
      p.y += p.dodgeVy * dt;
      if (p.dodgeTimer <= 0) { p.dodging = false; p.dodgeTimer = 0; }
    } else {
      p.x += p.inputVx * P_SPEED * dt;
      p.y += p.inputVy * P_SPEED * dt;
    }
    if (p.dodgeCooldown > 0) p.dodgeCooldown -= dt;

    const mx = p.inputVx, my = p.inputVy;
    if (mx !== 0 || my !== 0) {
      const l = Math.sqrt(mx * mx + my * my);
      p.facing.x = mx / l; p.facing.y = my / l;
    }

    p.x = Math.max(minX, Math.min(maxX, p.x));
    p.y = Math.max(minY, Math.min(maxY, p.y));

    // Disc physics
    const d = p.disc;
    if (!d || !d.active) continue;

    d.timer += dt;
    if (!d.returning && (d.timer > RETURN_AFTER || d.bounces >= BOUNCE_MAX)) {
      d.returning = true;
    }

    if (d.returning) {
      const rx = p.x - d.x, ry = p.y - d.y;
      const rl = Math.sqrt(rx * rx + ry * ry) || 1;
      d.vx = (rx / rl) * DISC_RETURN_SPEED;
      d.vy = (ry / rl) * DISC_RETURN_SPEED;
    }

    d.x += d.vx * dt;
    d.y += d.vy * dt;

    // Wall bounces (only while not returning)
    if (!d.returning) {
      const dMinX = WALL + D_RADIUS, dMaxX = a.width  - WALL - D_RADIUS;
      const dMinY = WALL + D_RADIUS, dMaxY = a.height - WALL - D_RADIUS;
      if (d.x <= dMinX || d.x >= dMaxX) {
        d.vx *= -1;
        d.x = Math.max(dMinX, Math.min(dMaxX, d.x));
        d.bounces++;
      }
      if (d.y <= dMinY || d.y >= dMaxY) {
        d.vy *= -1;
        d.y = Math.max(dMinY, Math.min(dMaxY, d.y));
        d.bounces++;
      }
    }

    // Owner catch
    if (d.returning) {
      const cx = p.x - d.x, cy = p.y - d.y;
      if (Math.sqrt(cx * cx + cy * cy) < P_RADIUS + D_RADIUS + 12) {
        p.hasDisc = true;
        p.disc    = null;
        io.to(room.id).emit('discCaught', { playerId: p.id });
        continue;
      }
    }

    // Hit other players
    for (const other of alive) {
      if (other.id === p.id || !other.alive) continue;
      const hx = other.x - d.x, hy = other.y - d.y;
      if (Math.sqrt(hx * hx + hy * hy) < P_RADIUS + D_RADIUS) {
        if (!other.dodging) {
          other.alive = false;
          p.score++;
          p.hasDisc = true;
          p.disc    = null;
          io.to(room.id).emit('playerEliminated', { id: other.id, killerId: p.id, killerName: p.name });
          checkWin(room);
          break;
        }
        // Dodged — disc bounces back
        d.vx *= -1; d.vy *= -1; d.returning = true;
      }
    }
  }
}

// Main loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt  = Math.min((now - last) / 1000, 0.05);
  last = now;

  for (const room of Object.values(rooms)) {
    tick(room, dt);
    if (room.state === 'playing' || room.state === 'finalBattle') {
      io.to(room.id).emit('gameState', {
        players: Object.values(room.players).map(p => ({
          id: p.id, name: p.name, color: p.color,
          x: p.x, y: p.y, alive: p.alive, hasDisc: p.hasDisc,
          dodging: p.dodging, dodgeCooldown: p.dodgeCooldown,
          score: p.score, facing: p.facing,
          disc: p.disc ? {
            x: p.disc.x, y: p.disc.y,
            vx: p.disc.vx, vy: p.disc.vy,
            returning: p.disc.returning,
            ownerColor: p.disc.ownerColor,
          } : null,
        })),
        arena: room.arena,
        state: room.state,
      });
    }
  }
}, 1000 / TICK_RATE);

// Socket handlers
io.on('connection', (socket) => {
  const roomId = 'main';
  if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
  const room = rooms[roomId];

  socket.join(roomId);
  socket.roomId = roomId;

  const idx    = Object.keys(room.players).length;
  const player = createPlayer(socket.id, idx);
  room.players[socket.id] = player;

  socket.emit('joined', {
    playerId: socket.id,
    player,
    players: Object.values(room.players),
    state: room.state,
    arena: room.arena,
  });
  socket.to(roomId).emit('playerJoined', { player });

  socket.on('setName', (name) => {
    const p = room.players[socket.id];
    if (p) {
      p.name = String(name).slice(0, 18) || p.name;
      io.to(roomId).emit('playerUpdate', { id: socket.id, name: p.name });
    }
  });

  socket.on('startGame', () => {
    if (room.state === 'lobby' || room.state === 'gameOver') {
      startGame(room);
    }
  });

  socket.on('input', ({ vx, vy }) => {
    const p = room.players[socket.id];
    if (!p || !p.alive) return;
    if (room.state !== 'playing' && room.state !== 'finalBattle') return;
    const l = Math.sqrt(vx * vx + vy * vy);
    p.inputVx = l > 1 ? vx / l : vx;
    p.inputVy = l > 1 ? vy / l : vy;
  });

  socket.on('throwDisc', ({ tx, ty }) => {
    const p = room.players[socket.id];
    if (!p || !p.alive || !p.hasDisc) return;
    if (room.state !== 'playing' && room.state !== 'finalBattle') return;
    p.hasDisc = false;
    p.disc    = makeDisc(p, tx, ty);
    io.to(roomId).emit('discThrown', { playerId: p.id });
  });

  socket.on('dodge', () => {
    const p = room.players[socket.id];
    if (!p || !p.alive || p.dodging || p.dodgeCooldown > 0) return;
    if (room.state !== 'playing' && room.state !== 'finalBattle') return;
    const dx = p.inputVx || p.facing.x;
    const dy = p.inputVy || p.facing.y;
    const l  = Math.sqrt(dx * dx + dy * dy) || 1;
    p.dodging     = true;
    p.dodgeTimer  = DODGE_DUR;
    p.dodgeCooldown = DODGE_CD;
    p.dodgeVx     = (dx / l) * DODGE_SPEED;
    p.dodgeVy     = (dy / l) * DODGE_SPEED;
  });

  socket.on('disconnect', () => {
    delete room.players[socket.id];
    io.to(roomId).emit('playerLeft', { id: socket.id });
    if (room.state === 'playing' || room.state === 'finalBattle') checkWin(room);
    if (Object.keys(room.players).length === 0) delete rooms[roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Disc Wars running on http://localhost:${PORT}`));

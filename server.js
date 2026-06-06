const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE    = 60;
const STD_ARENA    = { width: 1440, height: 1000 };
const FINAL_ARENA  = { width: 1800, height: 1300 };
const P_R          = 18;
const D_R          = 11;
const P_SPEED      = 230;
const DISC_SPEED   = 500;
const DISC_RET     = 620;
const DODGE_SPEED  = 680;
const DODGE_DUR    = 0.26;
const BOUNCE_MAX   = 6;
const RETURN_AFTER = 2.8;
const CRACK_TIME   = 1.5;
const FALL_WARN    = 0.3;
const HEX_SIZE     = 26;

const COLORS = ['#00f7ff','#ff6600','#00ff88','#ff00ff','#ffee00','#ff3355','#ff88ff','#00ffcc','#ffaa00','#3399ff','#ff2222','#aaff00'];
const BOT_NAMES = ['SARK','CLU','RINZLER','JARVIS','DYSON','ABRAXAS','CROM','BIT','RAM','YORI','DUMONT','TESLER'];
const MAX_PLAYERS = 12;

const rooms      = {};
const socketRoom = {};
let   botCounter = 0;

// ── hex math ───────────────────────────────────────────────────────────
const sqrt3 = Math.sqrt(3);
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

function buildTileMap(arena) {
  const cx=arena.width/2, cy=arena.height/2;
  const R=Math.min(arena.width,arena.height)*0.44;
  const size=HEX_SIZE;
  const tiles={};
  const range=Math.ceil(R/size)+2;
  for(let q=-range;q<=range;q++){
    for(let r=-range;r<=range;r++){
      const {x:lx,y:ly}=hexToWorld(q,r,size);
      const d=Math.sqrt(lx*lx+ly*ly);
      if(d+size*0.6<=R) tiles[`${q},${r}`]={q,r,x:cx+lx,y:cy+ly,state:0,timer:0};
    }
  }
  return {tiles,cx,cy,R,size};
}

function crackTilesAtPos(tileMap, wx, wy) {
  const {tiles,cx,cy,size}=tileMap;
  const lx=wx-cx, ly=wy-cy;
  const frac=worldToHexFrac(lx,ly,size);
  const center=hexRound(frac.q,frac.r);
  const neighbors=[{q:0,r:0},{q:1,r:0},{q:-1,r:0},{q:0,r:1},{q:0,r:-1},{q:1,r:-1},{q:-1,r:1}];
  for(const n of neighbors){
    const key=`${center.q+n.q},${center.r+n.r}`;
    const t=tiles[key];
    if(t&&t.state===0){t.state=1;t.timer=CRACK_TIME;}
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function genCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({length:4},()=>ch[Math.floor(Math.random()*ch.length)]).join(''); } while (rooms[c]);
  return c;
}

const POD_COUNT = 6;

function spawnPosCircular(n, arena) {
  const cx=arena.width/2, cy=arena.height/2;
  const R=Math.min(arena.width,arena.height)*0.44;
  // Place players at pod positions — 6 pods, 2 slots each, offset slightly
  const positions=[];
  for(let i=0;i<n;i++){
    const pod = Math.floor(i / 2);              // which pod (0-5)
    const slot = i % 2;                         // which slot in pod (0 or 1)
    const podAngle = (pod / POD_COUNT) * Math.PI * 2 - Math.PI / 2;
    const podR = R * 0.58;
    const slotOffset = slot === 0 ? -18 : 18;   // side-by-side within pod
    const perpAngle = podAngle + Math.PI / 2;
    positions.push({
      x: cx + Math.cos(podAngle)*podR + Math.cos(perpAngle)*slotOffset,
      y: cy + Math.sin(podAngle)*podR + Math.sin(perpAngle)*slotOffset,
    });
  }
  return positions;
}

function makePlayer(id, idx, isBot) {
  return {
    id, name: isBot ? BOT_NAMES[botCounter++ % BOT_NAMES.length] : `Program-${idx+1}`,
    color: COLORS[idx % COLORS.length],
    x:0, y:0, inputVx:0, inputVy:0,
    alive:true, hasDisc:true, disc:null,
    dodging:false, dodgeTimer:0, dodgeCooldown:0,
    dodgeVx:0, dodgeVy:0,
    facing:{x:1,y:0},
    score:0,
    isBot: !!isBot,
    blocking:false, botBlockTimer:0,
    fallTimer:0, falling:false,
    botState:'wander', botTimer:1+Math.random(), botTarget:null, botStrafeSign:1,
  };
}

function makeRoom(code, hostId) {
  return { code, hostId, players:{}, state:'lobby', arena:{...STD_ARENA}, bodies:[], winner:null, tileMap:null,
    gravity:{ x:0, y:0 }, gravityAngle:0, gravityTimer:0, gravityStrength:0,
  };
}

function resetPlayer(p, pos) {
  p.x=pos.x; p.y=pos.y; p.inputVx=0; p.inputVy=0;
  p.alive=true; p.hasDisc=true; p.disc=null;
  p.dodging=false; p.dodgeTimer=0; p.dodgeCooldown=0;
  p.blocking=false; p.botBlockTimer=0; p.fallTimer=0; p.falling=false;
  if (p.isBot) {
    p.botState='approach'; p.botTimer=0.8+Math.random()*0.6;
    p.botTarget=null; p.botStrafeSign=Math.random()<0.5?1:-1;
  }
}

function startGame(room) {
  room.state  = 'playing';
  room.arena  = {...STD_ARENA, radius: Math.min(STD_ARENA.width, STD_ARENA.height)*0.48};
  room.bodies = [];
  room.winner = null;
  room.tileMap = buildTileMap(room.arena);
  const list = Object.values(room.players);
  const pos  = spawnPosCircular(list.length, room.arena);
  list.forEach((p,i) => resetPlayer(p, pos[i]));
  io.to(room.code).emit('gameStart', { arena: room.arena });
}

function makeDisc(p, tx, ty) {
  const dx=tx-p.x, dy=ty-p.y, l=Math.sqrt(dx*dx+dy*dy)||1;
  return {
    x:p.x, y:p.y,
    vx:(dx/l)*DISC_SPEED, vy:(dy/l)*DISC_SPEED,
    ownerId:p.id, ownerColor:p.color,
    bounces:0, returning:false, timer:0, active:true,
  };
}

function dist2(ax,ay,bx,by) { return (ax-bx)**2+(ay-by)**2; }
function dist(ax,ay,bx,by)  { return Math.sqrt(dist2(ax,ay,bx,by)); }

// ── Bot AI ────────────────────────────────────────────────────────────

function isTileSafe(tileMap, wx, wy) {
  if (!tileMap) return true;
  const lx=wx-tileMap.cx, ly=wy-tileMap.cy;
  const frac=worldToHexFrac(lx,ly,tileMap.size);
  const h=hexRound(frac.q,frac.r);
  const tile=tileMap.tiles[`${h.q},${h.r}`];
  // safe if tile exists and not destroyed
  return tile && tile.state < 2;
}

function safeMove(bot, vx, vy, tileMap) {
  // Check if moving in this direction leads to a bad tile
  if (!tileMap) { bot.inputVx=vx; bot.inputVy=vy; return; }
  const testX = bot.x + vx*P_SPEED*0.25;
  const testY = bot.y + vy*P_SPEED*0.25;
  if (isTileSafe(tileMap, testX, testY)) {
    bot.inputVx=vx; bot.inputVy=vy;
  } else {
    // try perpendicular
    bot.inputVx=-vy; bot.inputVy=vx;
  }
}

function tickBot(bot, room, dt) {
  if (!bot.alive) return;
  const inGame = room.state==='playing' || room.state==='finalBattle';
  const tm = room.tileMap;
  bot.botTimer -= dt;

  // ── tick block timer (replaces unreliable setTimeout) ─────────────
  if (bot.botBlockTimer > 0) {
    bot.botBlockTimer -= dt;
    if (bot.botBlockTimer <= 0) { bot.blocking=false; bot.botBlockTimer=0; }
  }

  // ── detect incoming disc ──────────────────────────────────────────
  let danger = null, dangerDist = Infinity;
  for (const p of Object.values(room.players)) {
    if (!p.disc || p.id===bot.id) continue;
    const d2 = dist2(bot.x,bot.y,p.disc.x,p.disc.y);
    if (d2 < 140*140 && d2 < dangerDist) {
      const dd=p.disc;
      // dot product: is disc heading toward bot?
      if ((bot.x-dd.x)*dd.vx+(bot.y-dd.y)*dd.vy > 0) { danger=dd; dangerDist=d2; }
    }
  }

  if (danger && !bot.dodging && !bot.blocking && inGame && Math.random() < 0.55) {
    if (Math.random() < 0.18) {
      // BLOCK: stand ground and raise disc
      bot.blocking=true;
      bot.botBlockTimer=0.7+Math.random()*0.5;
      bot.inputVx=0; bot.inputVy=0;
      // face the disc
      const dx=danger.x-bot.x, dy=danger.y-bot.y, l=Math.sqrt(dx*dx+dy*dy)||1;
      bot.facing.x=dx/l; bot.facing.y=dy/l;
    } else {
      // DODGE: roll perpendicular
      const spd=Math.sqrt(danger.vx**2+danger.vy**2)||1;
      const sign=Math.random()<0.5?1:-1;
      bot.dodging=true; bot.dodgeTimer=DODGE_DUR;
      bot.dodgeVx=(danger.vy/spd)*DODGE_SPEED*sign;
      bot.dodgeVy=(-danger.vx/spd)*DODGE_SPEED*sign;
      bot.botTimer=0.4;
    }
    return;
  }

  if (bot.dodging) return; // movement handled by main tick
  if (bot.blocking) { bot.inputVx=0; bot.inputVy=0; return; }

  // ── lobby wander ──────────────────────────────────────────────────
  if (!inGame) {
    if (bot.botTimer <= 0 || !bot.botTarget) {
      const cx=room.arena.width/2, cy=room.arena.height/2;
      const R=(tm?tm.R:Math.min(room.arena.width,room.arena.height)*0.44)*0.55;
      const angle=Math.random()*Math.PI*2;
      bot.botTarget={x:cx+Math.cos(angle)*R*0.6*(0.5+Math.random()*0.5), y:cy+Math.sin(angle)*R*0.6*(0.5+Math.random()*0.5)};
      bot.botTimer=1.2+Math.random()*1.0;
    }
    const dx=bot.botTarget.x-bot.x, dy=bot.botTarget.y-bot.y;
    const l=Math.sqrt(dx*dx+dy*dy)||1;
    if (l<24) { bot.inputVx=0; bot.inputVy=0; bot.botTarget=null; }
    else safeMove(bot, dx/l, dy/l, tm);
    const mx=bot.inputVx,my=bot.inputVy;
    if(mx||my){const l2=Math.sqrt(mx*mx+my*my);bot.facing.x=mx/l2;bot.facing.y=my/l2;}
    return;
  }

  // ── in-game AI ────────────────────────────────────────────────────
  const others = Object.values(room.players).filter(p=>p.id!==bot.id&&p.alive);
  if (!others.length) { bot.inputVx=0; bot.inputVy=0; return; }

  // find nearest living enemy
  let nearest=null, nearestDist=Infinity;
  for (const p of others) {
    const d=dist2(bot.x,bot.y,p.x,p.y);
    if (d<nearestDist) { nearestDist=d; nearest=p; }
  }

  const eDist=Math.sqrt(nearestDist);
  const edx=nearest.x-bot.x, edy=nearest.y-bot.y;
  const el=eDist||1;

  if (bot.hasDisc) {
    // APPROACH then THROW
    const throwRange = 210;
    const readyToThrow = eDist < throwRange && bot.botTimer <= 0;

    if (readyToThrow) {
      // imprecise aim — bots lead target poorly and add random spread
      const leadTime = eDist / DISC_SPEED * 0.5;
      const spread = (Math.random() - 0.5) * 80;
      const tx=nearest.x + nearest.inputVx*P_SPEED*leadTime + spread;
      const ty=nearest.y + nearest.inputVy*P_SPEED*leadTime + spread;
      bot.hasDisc=false;
      bot.disc=makeDisc(bot,tx,ty);
      bot.botTimer=1.6+Math.random()*1.2;
      io.to(room.code).emit('discThrown',{playerId:bot.id});
      bot.inputVx=0; bot.inputVy=0;
    } else if (eDist > throwRange) {
      // approach enemy
      safeMove(bot, edx/el, edy/el, tm);
    } else {
      // in range but cooling down — strafe to be unpredictable
      if (bot.botTimer <= 0) { bot.botStrafeSign*=-1; bot.botTimer=0.5+Math.random()*0.5; }
      safeMove(bot, (-edy/el)*bot.botStrafeSign, (edx/el)*bot.botStrafeSign, tm);
    }
  } else {
    if (bot.disc && bot.disc.returning) {
      // move to intercept returning disc
      const rx=bot.disc.x-bot.x, ry=bot.disc.y-bot.y, rl=Math.sqrt(rx*rx+ry*ry)||1;
      safeMove(bot, rx/rl, ry/rl, tm);
    } else if (bot.disc) {
      // disc in flight — circle the enemy while waiting
      if (bot.botTimer<=0) { bot.botStrafeSign*=-1; bot.botTimer=0.6+Math.random()*0.6; }
      const preferred = eDist > 180
        ? { vx: edx/el, vy: edy/el }  // close in
        : { vx: (-edy/el)*bot.botStrafeSign, vy: (edx/el)*bot.botStrafeSign }; // strafe
      safeMove(bot, preferred.vx, preferred.vy, tm);
    } else {
      // disc gone (impossible normally, but recover)
      bot.hasDisc=true;
    }
  }

  // Bots move at 70% of player speed
  bot.inputVx *= 0.70;
  bot.inputVy *= 0.70;

  const mx=bot.inputVx, my=bot.inputVy;
  if(mx||my){const l=Math.sqrt(mx*mx+my*my);bot.facing.x=mx/l;bot.facing.y=my/l;}
}

// ── check win ─────────────────────────────────────────────────────────

function checkWin(room) {
  const alive = Object.values(room.players).filter(p=>p.alive);
  if (alive.length===1) {
    alive[0].score++;
    room.winner=alive[0].id; room.state='gameOver';
    io.to(room.code).emit('gameOver',{winnerId:alive[0].id,winnerName:alive[0].name});
    return;
  }
  if (alive.length===2 && room.state==='playing') {
    room.state='finalBattle'; room.arena={...FINAL_ARENA, radius: Math.min(FINAL_ARENA.width, FINAL_ARENA.height)*0.48};
    room.tileMap=buildTileMap(room.arena);
    const pos=spawnPosCircular(2,room.arena);
    alive.forEach((p,i)=>{ p.x=pos[i].x; p.y=pos[i].y; p.hasDisc=true; p.disc=null; });
    io.to(room.code).emit('finalBattle',{arena:room.arena});
  }
}

function eliminatePlayer(room, other, killer) {
  other.alive=false;
  if(killer){ killer.score++; killer.hasDisc=true; killer.disc=null; }
  room.bodies.push({id:other.id,x:other.x,y:other.y,color:other.color,name:other.name,angle:Math.atan2(other.facing.y,other.facing.x)});
  io.to(room.code).emit('playerEliminated',{id:other.id,killerId:killer?killer.id:null,killerName:killer?killer.name:'VOID'});
  checkWin(room);
}

// ── main tick ─────────────────────────────────────────────────────────

function tick(room, dt) {
  const inGame  = room.state==='playing'||room.state==='finalBattle';
  const inLobby = room.state==='lobby'||room.state==='gameOver';
  if (!inGame && !inLobby) return;

  const a=room.arena;
  const tm=room.tileMap;
  const cx=tm?tm.cx:a.width/2, cy=tm?tm.cy:a.height/2;
  const R=tm?tm.R:Math.min(a.width,a.height)*0.44;

  // ── gravity shift (in-game only) ────────────────────────────────────
  const GRAVITY_STRENGTH_MAX = 90;  // px/s²
  const GRAVITY_SHIFT_INTERVAL = 20; // seconds between shifts
  if (inGame) {
    room.gravityTimer += dt;
    if (room.gravityTimer >= GRAVITY_SHIFT_INTERVAL) {
      room.gravityTimer = 0;
      room.gravityAngle += Math.PI * (0.4 + Math.random() * 0.7);
      room.gravityStrength = 30 + Math.random() * 60;
      room.gravity.x = Math.cos(room.gravityAngle) * room.gravityStrength;
      room.gravity.y = Math.sin(room.gravityAngle) * room.gravityStrength;
      io.to(room.code).emit('gravityShift', { angle: room.gravityAngle, strength: room.gravityStrength });
    }
  }

  // tick bots
  for (const p of Object.values(room.players)) {
    if (p.isBot) tickBot(p, room, dt);
  }

  // tick tile cracks
  if (inGame && tm) {
    for (const t of Object.values(tm.tiles)) {
      if (t.state===1) {
        t.timer-=dt;
        if (t.timer<=0) { t.state=2; t.timer=0; }
      }
    }
  }

  for (const p of Object.values(room.players)) {
    if (!p.alive && !inLobby) continue;

    // fall detection
    if (inGame && p.alive && tm) {
      const lx=p.x-tm.cx, ly=p.y-tm.cy;
      const frac=worldToHexFrac(lx,ly,tm.size);
      const h=hexRound(frac.q,frac.r);
      const tile=tm.tiles[`${h.q},${h.r}`];
      if (!tile || tile.state===2) {
        p.fallTimer+=dt;
        if (p.fallTimer>=FALL_WARN) {
          eliminatePlayer(room, p, null);
          continue;
        }
      } else {
        p.fallTimer=0;
      }
    }

    const speed = p.blocking ? P_SPEED*0.5 : P_SPEED;

    if (p.dodging && inGame) {
      p.dodgeTimer-=dt; p.x+=p.dodgeVx*dt; p.y+=p.dodgeVy*dt;
      if (p.dodgeTimer<=0) { p.dodging=false; p.dodgeTimer=0; }
    } else {
      p.x+=p.inputVx*speed*dt; p.y+=p.inputVy*speed*dt;
    }
    const mx=p.inputVx,my=p.inputVy;
    if (mx||my) { const l=Math.sqrt(mx*mx+my*my); p.facing.x=mx/l; p.facing.y=my/l; }

    // circular boundary
    const pdx=p.x-cx, pdy=p.y-cy;
    const pdist=Math.sqrt(pdx*pdx+pdy*pdy);
    const maxR=R-P_R-2;
    if (pdist>maxR && pdist>0) {
      p.x=cx+(pdx/pdist)*maxR;
      p.y=cy+(pdy/pdist)*maxR;
    }

    if (!inGame||!p.disc?.active) continue;
    const d=p.disc;
    d.timer+=dt;
    if (!d.returning&&(d.timer>RETURN_AFTER||d.bounces>=BOUNCE_MAX)) d.returning=true;

    if (d.returning) {
      const rx=p.x-d.x,ry=p.y-d.y,rl=Math.sqrt(rx*rx+ry*ry)||1;
      d.vx=(rx/rl)*DISC_RET; d.vy=(ry/rl)*DISC_RET;
    } else {
      // apply gravity drift to in-flight disc (not when homing back)
      d.vx += room.gravity.x * dt;
      d.vy += room.gravity.y * dt;
    }
    d.x+=d.vx*dt; d.y+=d.vy*dt;

    // circular wall bounce
    if (!d.returning && tm) {
      const ddx=d.x-tm.cx, ddy=d.y-tm.cy;
      const ddist=Math.sqrt(ddx*ddx+ddy*ddy);
      if (ddist+D_R>=tm.R) {
        const nx=ddx/ddist, ny=ddy/ddist;
        const dot=d.vx*nx+d.vy*ny;
        if (dot>0) { d.vx-=2*dot*nx; d.vy-=2*dot*ny; d.bounces++; }
        const inside=tm.R-D_R-1;
        d.x=tm.cx+nx*inside; d.y=tm.cy+ny*inside;
      }
      // crack tiles under disc
      crackTilesAtPos(tm, d.x, d.y);
    }

    if (d.returning) {
      const rcx=p.x-d.x,rcy=p.y-d.y;
      if (Math.sqrt(rcx*rcx+rcy*rcy)<P_R+D_R+12) {
        p.hasDisc=true; p.disc=null;
        io.to(room.code).emit('discCaught',{playerId:p.id});
        continue;
      }
    }

    for (const other of Object.values(room.players)) {
      if (other.id===p.id||!other.alive) continue;
      const hx=other.x-d.x,hy=other.y-d.y;
      if (Math.sqrt(hx*hx+hy*hy)<P_R+D_R) {
        if (other.blocking) {
          // reflect disc back toward thrower
          const bx=p.x-d.x, by=p.y-d.y, bl=Math.sqrt(bx*bx+by*by)||1;
          d.vx=(bx/bl)*DISC_SPEED; d.vy=(by/bl)*DISC_SPEED;
          d.returning=false; d.bounces=0; d.timer=0;
          d.ownerId=other.id; d.ownerColor=other.color;
          p.hasDisc=false;
        } else if (!other.dodging) {
          eliminatePlayer(room, other, p);
          break;
        }
      }
    }
  }
}

// ── broadcast loop ────────────────────────────────────────────────────
let last=Date.now();
setInterval(()=>{
  const now=Date.now(), dt=Math.min((now-last)/1000,0.05); last=now;
  for (const room of Object.values(rooms)) {
    tick(room,dt);
    const changedTiles = room.tileMap
      ? Object.values(room.tileMap.tiles).filter(t=>t.state>0).map(t=>({id:`${t.q},${t.r}`,state:t.state}))
      : [];
    io.to(room.code).emit('gameState',{
      players: Object.values(room.players).map(p=>({
        id:p.id,name:p.name,color:p.color,isBot:p.isBot,
        x:p.x,y:p.y,alive:p.alive,hasDisc:p.hasDisc,
        dodging:p.dodging,blocking:p.blocking,fallTimer:p.fallTimer,
        score:p.score,facing:p.facing,
        disc:p.disc?{x:p.disc.x,y:p.disc.y,vx:p.disc.vx,vy:p.disc.vy,returning:p.disc.returning,ownerColor:p.disc.ownerColor}:null,
      })),
      bodies: room.bodies,
      arena:  room.arena,
      state:  room.state,
      changedTiles,
      gravity: room.gravity,
    });
  }
},1000/TICK_RATE);

// ── socket events ─────────────────────────────────────────────────────
function leaveRoom(socket) {
  const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
  const room=rooms[code];
  delete room.players[socket.id]; delete socketRoom[socket.id];
  socket.leave(code);
  if (room.hostId===socket.id) {
    const rem=Object.keys(room.players).filter(id=>!rooms[code]?.players[id]?.isBot);
    if (rem.length) { room.hostId=rem[0]; io.to(code).emit('hostChanged',{hostId:room.hostId}); }
    else { delete rooms[code]; return; }
  }
  io.to(code).emit('playerLeft',{id:socket.id});
  if ((room.state==='playing'||room.state==='finalBattle') &&
      Object.values(room.players).filter(p=>p.alive).length<=1) checkWin(room);
}

io.on('connection', socket=>{

  socket.on('createRoom',({name})=>{
    const code=genCode(), room=makeRoom(code,socket.id);
    rooms[code]=room;
    const p=makePlayer(socket.id,0,false);
    p.name=String(name||p.name).slice(0,18);
    const pos=spawnPosCircular(1,room.arena); p.x=pos[0].x; p.y=pos[0].y;
    room.players[socket.id]=p; socketRoom[socket.id]=code;
    socket.join(code);
    socket.emit('roomCreated',{code,playerId:socket.id,player:p,players:Object.values(room.players),state:room.state,arena:room.arena,hostId:socket.id});
  });

  socket.on('joinRoom',({code,name})=>{
    const upper=String(code).toUpperCase().trim(), room=rooms[upper];
    if (!room) { socket.emit('joinError',{message:'Room not found.'}); return; }
    if (Object.keys(room.players).length>=MAX_PLAYERS) { socket.emit('joinError',{message:`Room is full (${MAX_PLAYERS} max).`}); return; }
    const idx=Object.keys(room.players).length;
    const p=makePlayer(socket.id,idx,false);
    p.name=String(name||p.name).slice(0,18);
    const pos=spawnPosCircular(idx+1,room.arena); p.x=pos[idx].x; p.y=pos[idx].y;
    room.players[socket.id]=p; socketRoom[socket.id]=upper;
    socket.join(upper);
    socket.emit('roomJoined',{code:upper,playerId:socket.id,player:p,players:Object.values(room.players),state:room.state,arena:room.arena,hostId:room.hostId,bodies:room.bodies});
    socket.to(upper).emit('playerJoined',{player:p});
  });

  socket.on('setName',name=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const p=rooms[code].players[socket.id]; if (!p) return;
    p.name=String(name).slice(0,18)||p.name;
    io.to(code).emit('playerUpdate',{id:socket.id,name:p.name});
  });

  socket.on('addBot',()=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const room=rooms[code];
    if (room.hostId!==socket.id) return;
    if (room.state!=='lobby'&&room.state!=='gameOver') return;
    if (Object.keys(room.players).length>=MAX_PLAYERS) return;
    const idx=Object.keys(room.players).length;
    const botId=`bot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const bot=makePlayer(botId,idx,true);
    const pos=spawnPosCircular(idx+1,room.arena); bot.x=pos[idx].x; bot.y=pos[idx].y;
    room.players[botId]=bot;
    io.to(code).emit('playerJoined',{player:bot});
  });

  socket.on('removeBot',()=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const room=rooms[code];
    if (room.hostId!==socket.id) return;
    const bots=Object.values(room.players).filter(p=>p.isBot);
    if (!bots.length) return;
    const bot=bots[bots.length-1];
    delete room.players[bot.id];
    io.to(code).emit('playerLeft',{id:bot.id});
  });

  socket.on('startGame',()=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const room=rooms[code];
    if (room.hostId!==socket.id) return;
    if (room.state==='lobby'||room.state==='gameOver') startGame(room);
  });

  socket.on('input',({vx,vy})=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const p=rooms[code].players[socket.id]; if (!p||p.isBot) return;
    if (!p.alive&&rooms[code].state!=='lobby'&&rooms[code].state!=='gameOver') return;
    const l=Math.sqrt(vx*vx+vy*vy);
    p.inputVx=l>1?vx/l:vx; p.inputVy=l>1?vy/l:vy;
  });

  socket.on('throwDisc',({tx,ty})=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const room=rooms[code], p=room.players[socket.id];
    if (!p||!p.alive||!p.hasDisc||p.isBot) return;
    if (room.state!=='playing'&&room.state!=='finalBattle') return;
    p.hasDisc=false; p.disc=makeDisc(p,tx,ty);
    io.to(code).emit('discThrown',{playerId:p.id});
  });

  socket.on('dodge',()=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const room=rooms[code], p=room.players[socket.id];
    if (!p||!p.alive||p.dodging||p.isBot) return;
    if (room.state!=='playing'&&room.state!=='finalBattle') return;
    const dx=p.inputVx||p.facing.x, dy=p.inputVy||p.facing.y;
    const l=Math.sqrt(dx*dx+dy*dy)||1;
    p.dodging=true; p.dodgeTimer=DODGE_DUR; p.dodgeCooldown=0;
    p.dodgeVx=(dx/l)*DODGE_SPEED; p.dodgeVy=(dy/l)*DODGE_SPEED;
  });

  socket.on('blockStart',()=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const p=rooms[code].players[socket.id]; if (!p||!p.alive||p.isBot) return;
    p.blocking=true;
  });

  socket.on('blockEnd',()=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const p=rooms[code].players[socket.id]; if (!p) return;
    p.blocking=false;
  });

  socket.on('setFacing',({fx,fy})=>{
    const code=socketRoom[socket.id]; if (!code||!rooms[code]) return;
    const p=rooms[code].players[socket.id]; if (!p||p.isBot) return;
    const l=Math.sqrt(fx*fx+fy*fy)||1;
    p.facing.x=fx/l; p.facing.y=fy/l;
  });

  socket.on('leaveRoom',()=>leaveRoom(socket));
  socket.on('disconnect',()=>leaveRoom(socket));
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Disc Wars running on http://localhost:${PORT}`));

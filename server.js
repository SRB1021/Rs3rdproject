const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const TICK_RATE    = 60;
const STD_ARENA    = { width: 960, height: 640 };
const FINAL_ARENA  = { width: 1280, height: 860 };
const WALL         = 24;
const P_R          = 18;
const D_R          = 11;
const P_SPEED      = 230;
const DISC_SPEED   = 500;
const DISC_RET     = 620;
const DODGE_SPEED  = 680;
const DODGE_DUR    = 0.26;
const BOUNCE_MAX   = 6;
const RETURN_AFTER = 2.8;
const MAX_BOTS     = 5;

const COLORS = ['#00f7ff','#ff6600','#00ff88','#ff00ff','#ffee00','#ff3355'];
const BOT_NAMES = ['SARK','CLU','RINZLER','JARVIS','DYSON','ABRAXAS'];

const rooms      = {};
const socketRoom = {};
let   botCounter = 0;

// ── helpers ───────────────────────────────────────────────────────────

function genCode() {
  const ch = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({length:4},()=>ch[Math.floor(Math.random()*ch.length)]).join(''); } while (rooms[c]);
  return c;
}

function spawnPos(n, arena) {
  const pad = 90;
  return [
    {x:pad,             y:pad},
    {x:arena.width-pad, y:arena.height-pad},
    {x:arena.width-pad, y:pad},
    {x:pad,             y:arena.height-pad},
    {x:arena.width/2,   y:pad},
    {x:arena.width/2,   y:arena.height-pad},
  ].slice(0, n);
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
    // bot brain state
    botState:'wander', botTimer:0, botTarget:null,
  };
}

function makeRoom(code, hostId) {
  return { code, hostId, players:{}, state:'lobby', arena:{...STD_ARENA}, bodies:[], winner:null };
}

function resetPlayer(p, pos) {
  p.x=pos.x; p.y=pos.y; p.inputVx=0; p.inputVy=0;
  p.alive=true; p.hasDisc=true; p.disc=null;
  p.dodging=false; p.dodgeTimer=0; p.dodgeCooldown=0;
}

function startGame(room) {
  room.state  = 'playing';
  room.arena  = {...STD_ARENA};
  room.bodies = [];
  room.winner = null;
  const list = Object.values(room.players);
  const pos  = spawnPos(list.length, room.arena);
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

function tickBot(bot, room, dt) {
  if (!bot.alive) return;
  const a     = room.arena;
  const inGame = room.state==='playing' || room.state==='finalBattle';
  const others = Object.values(room.players).filter(p=>p.id!==bot.id && p.alive);

  bot.botTimer -= dt;

  // --- detect incoming disc ---
  let dangerDisc = null, dangerDist = Infinity;
  for (const p of Object.values(room.players)) {
    if (!p.disc || p.id===bot.id) continue;
    const d2 = dist2(bot.x,bot.y,p.disc.x,p.disc.y);
    if (d2 < 120**2 && d2 < dangerDist) {
      // check if disc is heading toward bot
      const dd = p.disc;
      const tx = bot.x-dd.x, ty = bot.y-dd.y;
      const dot = tx*dd.vx + ty*dd.vy;
      if (dot > 0) { dangerDisc=dd; dangerDist=d2; }
    }
  }

  if (dangerDisc && !bot.dodging && inGame) {
    // dodge perpendicular to disc direction
    const speed = Math.sqrt(dangerDisc.vx**2+dangerDisc.vy**2)||1;
    // pick perpendicular that moves away
    bot.dodging    = true;
    bot.dodgeTimer = DODGE_DUR;
    bot.dodgeVx    = (dangerDisc.vy/speed) * DODGE_SPEED * (Math.random()<0.5?1:-1);
    bot.dodgeVy    = (-dangerDisc.vx/speed) * DODGE_SPEED * (Math.random()<0.5?1:-1);
    bot.botState   = 'dodge';
    bot.botTimer   = 0.3;
    return;
  }

  if (bot.dodging) return;

  // wander when not in game
  if (!inGame) {
    if (bot.botTimer <= 0) {
      const cx = a.width/2, cy = a.height/2;
      const angle = Math.random()*Math.PI*2;
      const r = 80 + Math.random()*180;
      bot.botTarget = { x: cx+Math.cos(angle)*r, y: cy+Math.sin(angle)*r };
      bot.botTimer  = 1.5 + Math.random();
    }
    if (bot.botTarget) {
      const dx=bot.botTarget.x-bot.x, dy=bot.botTarget.y-bot.y;
      const l=Math.sqrt(dx*dx+dy*dy)||1;
      if (l < 20) { bot.inputVx=0; bot.inputVy=0; bot.botTarget=null; }
      else { bot.inputVx=dx/l; bot.inputVy=dy/l; }
    }
    return;
  }

  // --- in game ---
  // find nearest enemy
  let nearest=null, nearestDist=Infinity;
  for (const p of others) {
    const d=dist2(bot.x,bot.y,p.x,p.y);
    if (d<nearestDist) { nearestDist=d; nearest=p; }
  }

  if (!nearest) { bot.inputVx=0; bot.inputVy=0; return; }

  if (bot.hasDisc) {
    const d = Math.sqrt(nearestDist);
    if (d < 350 || bot.botTimer <= 0) {
      // throw at where they're heading (simple lead)
      const lead = 0.25;
      const tx = nearest.x + nearest.inputVx*P_SPEED*lead;
      const ty = nearest.y + nearest.inputVy*P_SPEED*lead;
      bot.hasDisc = false;
      bot.disc    = makeDisc(bot, tx, ty);
      bot.botTimer = 0.8 + Math.random()*0.6;
      io.to(room.code).emit('discThrown',{playerId:bot.id});
    } else {
      // approach
      const dx=nearest.x-bot.x, dy=nearest.y-bot.y, l=Math.sqrt(dx*dx+dy*dy)||1;
      bot.inputVx=dx/l; bot.inputVy=dy/l;
    }
  } else {
    // disc is out — strafe and wait for return
    if (bot.disc && bot.disc.returning) {
      // move toward returning disc
      const dx=bot.disc.x-bot.x, dy=bot.disc.y-bot.y, l=Math.sqrt(dx*dx+dy*dy)||1;
      bot.inputVx=dx/l*0.4; bot.inputVy=dy/l*0.4;
    } else {
      // strafe perpendicular to nearest enemy
      const dx=nearest.x-bot.x, dy=nearest.y-bot.y, l=Math.sqrt(dx*dx+dy*dy)||1;
      if (bot.botTimer<=0) { bot._strafeSign=(bot._strafeSign||1)*-1; bot.botTimer=0.7+Math.random()*0.5; }
      bot.inputVx= (-dy/l)*bot._strafeSign;
      bot.inputVy=  (dx/l)*bot._strafeSign;
    }
  }

  // update facing
  const mx=bot.inputVx, my=bot.inputVy;
  if (mx||my) { const l=Math.sqrt(mx*mx+my*my); bot.facing.x=mx/l; bot.facing.y=my/l; }
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
    room.state='finalBattle'; room.arena={...FINAL_ARENA};
    const pos=spawnPos(2,room.arena);
    alive.forEach((p,i)=>{ p.x=pos[i].x; p.y=pos[i].y; p.hasDisc=true; p.disc=null; });
    io.to(room.code).emit('finalBattle',{arena:room.arena});
  }
}

// ── main tick ─────────────────────────────────────────────────────────

function tick(room, dt) {
  const inGame  = room.state==='playing'||room.state==='finalBattle';
  const inLobby = room.state==='lobby'||room.state==='gameOver';
  if (!inGame && !inLobby) return;

  const a=room.arena;
  const minX=WALL+P_R, maxX=a.width-WALL-P_R;
  const minY=WALL+P_R, maxY=a.height-WALL-P_R;

  // tick bots
  for (const p of Object.values(room.players)) {
    if (p.isBot) tickBot(p, room, dt);
  }

  for (const p of Object.values(room.players)) {
    if (!p.alive && !inLobby) continue;

    if (p.dodging && inGame) {
      p.dodgeTimer-=dt; p.x+=p.dodgeVx*dt; p.y+=p.dodgeVy*dt;
      if (p.dodgeTimer<=0) { p.dodging=false; p.dodgeTimer=0; }
    } else {
      p.x+=p.inputVx*P_SPEED*dt; p.y+=p.inputVy*P_SPEED*dt;
    }
    const mx=p.inputVx,my=p.inputVy;
    if (mx||my) { const l=Math.sqrt(mx*mx+my*my); p.facing.x=mx/l; p.facing.y=my/l; }
    p.x=Math.max(minX,Math.min(maxX,p.x));
    p.y=Math.max(minY,Math.min(maxY,p.y));

    if (!inGame||!p.disc?.active) continue;
    const d=p.disc;
    d.timer+=dt;
    if (!d.returning&&(d.timer>RETURN_AFTER||d.bounces>=BOUNCE_MAX)) d.returning=true;

    if (d.returning) {
      const rx=p.x-d.x,ry=p.y-d.y,rl=Math.sqrt(rx*rx+ry*ry)||1;
      d.vx=(rx/rl)*DISC_RET; d.vy=(ry/rl)*DISC_RET;
    }
    d.x+=d.vx*dt; d.y+=d.vy*dt;

    if (!d.returning) {
      const dx1=WALL+D_R,dx2=a.width-WALL-D_R,dy1=WALL+D_R,dy2=a.height-WALL-D_R;
      if (d.x<=dx1||d.x>=dx2) { d.vx*=-1; d.x=Math.max(dx1,Math.min(dx2,d.x)); d.bounces++; }
      if (d.y<=dy1||d.y>=dy2) { d.vy*=-1; d.y=Math.max(dy1,Math.min(dy2,d.y)); d.bounces++; }
    }

    if (d.returning) {
      const cx=p.x-d.x,cy=p.y-d.y;
      if (Math.sqrt(cx*cx+cy*cy)<P_R+D_R+12) {
        p.hasDisc=true; p.disc=null;
        io.to(room.code).emit('discCaught',{playerId:p.id});
        continue;
      }
    }

    for (const other of Object.values(room.players)) {
      if (other.id===p.id||!other.alive) continue;
      const hx=other.x-d.x,hy=other.y-d.y;
      if (Math.sqrt(hx*hx+hy*hy)<P_R+D_R) {
        if (!other.dodging) {
          other.alive=false; p.score++; p.hasDisc=true; p.disc=null;
          room.bodies.push({id:other.id,x:other.x,y:other.y,color:other.color,name:other.name,angle:Math.random()*Math.PI*2});
          io.to(room.code).emit('playerEliminated',{id:other.id,killerId:p.id,killerName:p.name});
          checkWin(room);
          break;
        }
        d.vx*=-1; d.vy*=-1; d.returning=true;
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
    io.to(room.code).emit('gameState',{
      players: Object.values(room.players).map(p=>({
        id:p.id,name:p.name,color:p.color,isBot:p.isBot,
        x:p.x,y:p.y,alive:p.alive,hasDisc:p.hasDisc,
        dodging:p.dodging,score:p.score,facing:p.facing,
        disc:p.disc?{x:p.disc.x,y:p.disc.y,vx:p.disc.vx,vy:p.disc.vy,returning:p.disc.returning,ownerColor:p.disc.ownerColor}:null,
      })),
      bodies: room.bodies,
      arena:  room.arena,
      state:  room.state,
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
    const pos=spawnPos(1,room.arena); p.x=pos[0].x; p.y=pos[0].y;
    room.players[socket.id]=p; socketRoom[socket.id]=code;
    socket.join(code);
    socket.emit('roomCreated',{code,playerId:socket.id,player:p,players:Object.values(room.players),state:room.state,arena:room.arena,hostId:socket.id});
  });

  socket.on('joinRoom',({code,name})=>{
    const upper=String(code).toUpperCase().trim(), room=rooms[upper];
    if (!room) { socket.emit('joinError',{message:'Room not found.'}); return; }
    if (Object.keys(room.players).length>=6) { socket.emit('joinError',{message:'Room is full (6 max).'}); return; }
    const idx=Object.keys(room.players).length;
    const p=makePlayer(socket.id,idx,false);
    p.name=String(name||p.name).slice(0,18);
    const pos=spawnPos(idx+1,room.arena); p.x=pos[idx].x; p.y=pos[idx].y;
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
    if (Object.keys(room.players).length>=6) return;
    const idx=Object.keys(room.players).length;
    const botId=`bot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const bot=makePlayer(botId,idx,true);
    const pos=spawnPos(idx+1,room.arena); bot.x=pos[idx].x; bot.y=pos[idx].y;
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

  socket.on('leaveRoom',()=>leaveRoom(socket));
  socket.on('disconnect',()=>leaveRoom(socket));
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Disc Wars running on http://localhost:${PORT}`));

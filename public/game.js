/* DISC WARS — 3-D First-Person Client (Three.js r128) */
'use strict';

const socket = io();

// ── DOM refs ──────────────────────────────────────────────────────────────
const titleScreen     = document.getElementById('titleScreen');
const arenaWrap       = document.getElementById('arenaWrap');
const lobbyOverlay    = document.getElementById('lobbyOverlay');
const hud             = document.getElementById('hud');
const hudPlayers      = document.getElementById('hudPlayers');
const hudCenter       = document.getElementById('hudCenter');
const finalBanner     = document.getElementById('finalBanner');
const gameOverScreen  = document.getElementById('gameOverScreen');
const killFeedEl      = document.getElementById('killFeed');
const crosshairEl     = document.getElementById('crosshair');
const lockMsgEl       = document.getElementById('lockMsg');
const gravIndicatorEl = document.getElementById('gravIndicator');

// ── State ─────────────────────────────────────────────────────────────────
let myId = null, myRoomCode = null, hostId = null;
let gamePhase = 'title';
let players = {}, bodies = [];
let arenaInfo = { width: 1440, height: 1000, radius: 480 };
let gravity = { x: 0, y: 0 };

// ── Three.js objects ──────────────────────────────────────────────────────
let renderer, scene, camera, animId;
const playerMeshes = {};   // id → THREE.Group
const discMeshes   = {};   // ownerId → THREE.Group
const tileMeshes   = {};   // 'q,r' → THREE.Mesh
const tileData     = new Map(); // 'q,r' → {q,r,wx,wz,state}
let rimMesh = null, wallMesh = null, floorMesh = null;

// ── Camera / pointer lock ─────────────────────────────────────────────────
let yaw = 0, pitch = 0;
let pointerLocked = false;
let myFacingX = 0, myFacingZ = 1;
const EYE_H     = 30;
const DISC_FLY_H = 20;

// ── Input ─────────────────────────────────────────────────────────────────
const keys = {};

// ── Hex constants (must match server) ────────────────────────────────────
const HEX_SIZE = 26;
const SQ3 = Math.sqrt(3);

// ── Hex math ──────────────────────────────────────────────────────────────
function hexToWorld3(q, r) {
  return {
    x: HEX_SIZE * SQ3 * (q + r * 0.5),
    z: HEX_SIZE * 1.5 * r
  };
}

// ── Init Three.js ─────────────────────────────────────────────────────────
function initThree() {
  const canvas = document.getElementById('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000408);
  scene.fog = new THREE.FogExp2(0x000510, 0.00055);

  camera = new THREE.PerspectiveCamera(72, 1, 0.5, 3000);
  camera.rotation.order = 'YXZ';

  // Ambient + directional
  scene.add(new THREE.AmbientLight(0x001830, 2.5));
  const dir = new THREE.DirectionalLight(0x002244, 1.2);
  dir.position.set(0, 300, 0);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 1;
  dir.shadow.camera.far = 800;
  dir.shadow.camera.left = dir.shadow.camera.bottom = -600;
  dir.shadow.camera.right = dir.shadow.camera.top = 600;
  scene.add(dir);

  // Ceiling grid gives the TRON city feel
  const ceilGeo = new THREE.PlaneGeometry(6000, 6000, 40, 40);
  const ceilMat = new THREE.MeshBasicMaterial({
    color: 0x002244, wireframe: true, transparent: true, opacity: 0.07
  });
  const ceil = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 280;
  scene.add(ceil);

  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);
  setupPointerLock(canvas);
  setupInput();
}

function resizeRenderer() {
  const w = arenaWrap.clientWidth  || window.innerWidth;
  const h = arenaWrap.clientHeight || window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Arena geometry ─────────────────────────────────────────────────────────
function buildArena(radius) {
  [rimMesh, wallMesh, floorMesh].forEach(m => { if (m) scene.remove(m); });

  // Void underfloor
  const vGeo = new THREE.CircleGeometry(radius + 80, 64);
  const vMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  floorMesh = new THREE.Mesh(vGeo, vMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -5;
  scene.add(floorMesh);

  // Tall glowing cylinder wall (inside surface)
  const wGeo = new THREE.CylinderGeometry(radius, radius, 200, 72, 1, true);
  const wMat = new THREE.MeshBasicMaterial({
    color: 0x00f7ff, side: THREE.BackSide, transparent: true, opacity: 0.07
  });
  wallMesh = new THREE.Mesh(wGeo, wMat);
  wallMesh.position.y = 90;
  scene.add(wallMesh);

  // Glowing floor ring
  const rGeo = new THREE.TorusGeometry(radius, 2, 8, 128);
  const rMat = new THREE.MeshBasicMaterial({ color: 0x00f7ff });
  rimMesh = new THREE.Mesh(rGeo, rMat);
  rimMesh.rotation.x = Math.PI / 2;
  rimMesh.position.y = 0.5;
  scene.add(rimMesh);

  // Central glow
  const cLight = new THREE.PointLight(0x0088cc, 1.2, radius * 2.5);
  cLight.position.set(0, 60, 0);
  scene.add(cLight);
  const fLight = new THREE.PointLight(0x003355, 3.5, radius * 1.8);
  fLight.position.set(0, 8, 0);
  scene.add(fLight);
}

// ── Tile map ───────────────────────────────────────────────────────────────
function buildTileMap(arena) {
  // Remove old tiles
  tileData.forEach((_, key) => removeTileMesh(key));
  tileData.clear();

  const R = arena.radius || 480;
  const range = Math.ceil(R / (HEX_SIZE * SQ3)) + 2;
  for (let q = -range; q <= range; q++) {
    for (let r = -range; r <= range; r++) {
      const { x: wx, z: wz } = hexToWorld3(q, r);
      const dist = Math.sqrt(wx * wx + wz * wz);
      if (dist > R - HEX_SIZE * 0.5) continue;
      const key = `${q},${r}`;
      tileData.set(key, { q, r, wx, wz, state: 0 });
      spawnTileMesh(key, wx, wz, 0);
    }
  }
}

function spawnTileMesh(key, wx, wz, state) {
  removeTileMesh(key);
  if (state === 2) return;

  const geo = new THREE.CylinderGeometry(HEX_SIZE * 0.94, HEX_SIZE * 0.94, 4, 6);
  let color, emissive, emissiveIntensity;
  if (state === 0) {
    color = 0x001a22; emissive = 0x003344; emissiveIntensity = 0.18;
  } else {
    color = 0x2a0a00; emissive = 0x883300; emissiveIntensity = 0.7;
  }
  const mat = new THREE.MeshStandardMaterial({
    color, emissive, emissiveIntensity, roughness: 0.35, metalness: 0.7
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.y = Math.PI / 6;
  mesh.position.set(wx, -2.5, wz);
  mesh.receiveShadow = true;
  mesh.userData.state = state;
  scene.add(mesh);
  tileMeshes[key] = mesh;
}

function removeTileMesh(key) {
  const m = tileMeshes[key];
  if (!m) return;
  scene.remove(m);
  m.geometry.dispose();
  m.material.dispose();
  delete tileMeshes[key];
}

// ── Player meshes ──────────────────────────────────────────────────────────
function makePlayerGroup(color) {
  const group = new THREE.Group();
  const col = new THREE.Color(color);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x060606, emissive: col, emissiveIntensity: 0.08,
    roughness: 0.25, metalness: 0.9
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 1.2,
    roughness: 0.1, metalness: 0.6
  });

  // Legs
  for (const ox of [-4.5, 4.5]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 16, 8), bodyMat);
    leg.position.set(ox, 8, 0);
    group.add(leg);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1, 10, 1.5), glowMat);
    stripe.position.set(ox, 8, 3.5);
    group.add(stripe);
  }

  // Torso
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(6.5, 5.5, 18, 8), bodyMat);
  torso.position.set(0, 25, 0);
  group.add(torso);

  // Chest glow lines
  const chest = new THREE.Mesh(new THREE.BoxGeometry(8, 2, 1), glowMat);
  chest.position.set(0, 27, 6.5);
  group.add(chest);
  const mid = new THREE.Mesh(new THREE.BoxGeometry(5, 1, 1), glowMat);
  mid.position.set(0, 23, 6.5);
  group.add(mid);

  // Chest reactor sphere
  const reactorGeo = new THREE.SphereGeometry(2, 8, 8);
  const reactor = new THREE.Mesh(reactorGeo, glowMat);
  reactor.position.set(0, 25, 6.8);
  group.add(reactor);
  const rLight = new THREE.PointLight(col, 0.5, 50);
  rLight.position.set(0, 25, 8);
  group.add(rLight);

  // Arms
  for (const [ox, rz] of [[-9, 0.2], [9, -0.2]]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 15, 8), bodyMat);
    arm.position.set(ox, 23, 0);
    arm.rotation.z = rz;
    group.add(arm);
    const astripe = new THREE.Mesh(new THREE.BoxGeometry(1, 10, 1.2), glowMat);
    astripe.position.set(ox * 1.1, 23, 2.5);
    group.add(astripe);
  }

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), bodyMat);
  head.position.set(0, 41, 0);
  head.scale.set(0.9, 0.82, 1.05);
  group.add(head);

  // Visor
  const visor = new THREE.Mesh(new THREE.BoxGeometry(10, 3.5, 2), glowMat);
  visor.position.set(0, 41.5, 7);
  group.add(visor);

  // Helmet band
  const band = new THREE.Mesh(new THREE.TorusGeometry(7, 0.8, 6, 20), glowMat);
  band.position.set(0, 44, 0);
  band.rotation.x = Math.PI / 2;
  group.add(band);

  group.userData.col = col;
  return group;
}

function getOrMakePlayerMesh(id, color, isMe) {
  if (playerMeshes[id]) return playerMeshes[id];
  const g = makePlayerGroup(color);
  if (isMe) g.visible = false; // first-person: don't render own body
  scene.add(g);
  playerMeshes[id] = g;
  return g;
}

function removePlayerMesh(id) {
  const g = playerMeshes[id];
  if (!g) return;
  scene.remove(g);
  delete playerMeshes[id];
}

// ── Disc meshes ────────────────────────────────────────────────────────────
function getOrMakeDiscMesh(ownerId, color) {
  if (discMeshes[ownerId]) return discMeshes[ownerId];

  const group = new THREE.Group();
  const col = new THREE.Color(color || 0x00f7ff);

  const geo = new THREE.CylinderGeometry(11, 11, 3, 24);
  const mat = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 1.0,
    roughness: 0.1, metalness: 0.7, transparent: true, opacity: 0.9
  });
  group.add(new THREE.Mesh(geo, mat));

  const ringGeo = new THREE.TorusGeometry(11, 1.8, 8, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: col });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  const dLight = new THREE.PointLight(col, 1.2, 80);
  group.add(dLight);

  scene.add(group);
  discMeshes[ownerId] = group;
  return group;
}

function removeDiscMesh(ownerId) {
  const g = discMeshes[ownerId];
  if (!g) return;
  scene.remove(g);
  delete discMeshes[ownerId];
}

// ── Dead body on floor ─────────────────────────────────────────────────────
function spawnBodyMesh(body) {
  const col = new THREE.Color(body.color || '#444444');
  // Flat silhouette
  const geo = new THREE.CylinderGeometry(10, 10, 1.5, 8);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: col, emissiveIntensity: 0.12
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(body.x, 0.8, body.y);
  m.receiveShadow = true;
  scene.add(m);
}

// ── Pointer lock ───────────────────────────────────────────────────────────
function setupPointerLock(canvas) {
  canvas.addEventListener('click', () => {
    if (gamePhase === 'playing' || gamePhase === 'finalBattle') {
      if (!pointerLocked) {
        canvas.requestPointerLock();
      } else {
        doThrowDisc();
      }
    }
  });

  document.addEventListener('pointerlockchange', () => {
    pointerLocked = document.pointerLockElement === canvas;
    crosshairEl.style.display = pointerLocked ? 'block' : 'none';
    lockMsgEl.style.display   = (!pointerLocked && (gamePhase === 'playing' || gamePhase === 'finalBattle')) ? 'block' : 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!pointerLocked) return;
    const sens = 0.0017;
    yaw   -= e.movementX * sens;
    pitch -= e.movementY * sens;
    pitch = Math.max(-0.55, Math.min(0.55, pitch));
    myFacingX = Math.sin(yaw);
    myFacingZ = Math.cos(yaw);
    socket.emit('setFacing', { fx: myFacingX, fy: myFacingZ });
  });
}

function doThrowDisc() {
  const me = players[myId];
  if (!me || !me.alive || !me.hasDisc) return;
  const tx = me.x + myFacingX * 2000;
  const ty = me.y + myFacingZ * 2000;
  socket.emit('throwDisc', { tx, ty });
  Audio.throwDisc();
}

// ── Input ──────────────────────────────────────────────────────────────────
function setupInput() {
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (keys[k]) return;
    keys[k] = true;
    if (k === 'd' && (gamePhase === 'playing' || gamePhase === 'finalBattle')) {
      socket.emit('dodge'); Audio.dodge();
    }
    if (e.key === 'Shift' && (gamePhase === 'playing' || gamePhase === 'finalBattle')) {
      socket.emit('blockStart');
    }
    if (k === 'escape' && pointerLocked) {
      document.exitPointerLock();
    }
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === 'Shift') socket.emit('blockEnd');
  });
}

let _lastInputVx = 0, _lastInputVy = 0;
function sendInput() {
  if (!myId) return;
  if (gamePhase !== 'playing' && gamePhase !== 'finalBattle' && gamePhase !== 'lobby') return;

  // Strafe axes (facing is Z-forward, X-right in Three.js→server coords)
  const fwX = myFacingX, fwZ = myFacingZ;
  const stX = myFacingZ,  stZ = -myFacingX; // perpendicular right

  let vx = 0, vy = 0;
  if (keys['w'])                   { vx += fwX; vy += fwZ; }
  if (keys['s'])                   { vx -= fwX; vy -= fwZ; }
  if (keys['q'] || keys['a'])      { vx -= stX; vy -= stZ; }
  if (keys['e'])                   { vx += stX; vy += stZ; }

  const l = Math.sqrt(vx * vx + vy * vy);
  if (l > 0) { vx /= l; vy /= l; }

  if (vx !== _lastInputVx || vy !== _lastInputVy) {
    _lastInputVx = vx; _lastInputVy = vy;
    socket.emit('input', { vx, vy });
  }
}

// ── Update camera each frame ───────────────────────────────────────────────
function updateCamera() {
  const me = players[myId];
  if (!me) return;
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  camera.position.set(me.x, EYE_H, me.y);
}

// ── Update 3D scene from server state ────────────────────────────────────
let _discRotAngle = 0;
function updateScene() {
  _discRotAngle += 0.06;

  const seenPlayers = new Set();
  const seenDiscs   = new Set();

  Object.values(players).forEach(p => {
    seenPlayers.add(p.id);
    const group = getOrMakePlayerMesh(p.id, p.color, p.id === myId);
    if (p.id === myId) {
      group.position.set(p.x, 0, p.y);
      return;
    }
    group.visible = !!p.alive;
    if (!p.alive) return;
    group.position.set(p.x, 0, p.y);
    group.rotation.y = Math.atan2(p.facing.x, p.facing.y);

    // Disc held on right arm
    if (p.hasDisc) {
      seenDiscs.add(p.id);
      const dm = getOrMakeDiscMesh(p.id, p.color);
      const angle = Math.atan2(p.facing.x, p.facing.y);
      dm.position.set(
        p.x + Math.cos(angle) * 10,
        22,
        p.y - Math.sin(angle) * 10
      );
      dm.rotation.y = _discRotAngle;
    }

    // Disc in flight
    if (p.disc) {
      seenDiscs.add(p.id);
      const dm = getOrMakeDiscMesh(p.id, p.color);
      dm.position.set(p.disc.x, DISC_FLY_H, p.disc.y);
      dm.rotation.y = _discRotAngle;
    }
  });

  // My own disc
  const me = players[myId];
  if (me) {
    if (me.hasDisc) {
      seenDiscs.add(myId);
      const dm = getOrMakeDiscMesh(myId, me.color);
      // Show disc just below camera (arm view)
      const camRight = Math.cos(yaw);
      dm.position.set(me.x + camRight * 14, EYE_H - 10, me.y - Math.sin(yaw) * 14);
      dm.rotation.y = _discRotAngle;
    }
    if (me.disc) {
      seenDiscs.add(myId);
      const dm = getOrMakeDiscMesh(myId, me.color);
      dm.position.set(me.disc.x, DISC_FLY_H, me.disc.y);
      dm.rotation.y = _discRotAngle;
    }
  }

  // Remove stale meshes
  Object.keys(playerMeshes).forEach(id => {
    if (!seenPlayers.has(id)) removePlayerMesh(id);
  });
  Object.keys(discMeshes).forEach(id => {
    if (!seenDiscs.has(id)) removeDiscMesh(id);
  });
}

// ── Tile flicker animation ────────────────────────────────────────────────
let _lastTileAnim = 0;
function animateTiles(ts) {
  if (ts - _lastTileAnim < 80) return;
  _lastTileAnim = ts;
  tileData.forEach((t, key) => {
    const mesh = tileMeshes[key];
    if (!mesh || t.state !== 1) return;
    mesh.material.emissiveIntensity = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(ts * 0.012));
  });
}

// ── Render loop ────────────────────────────────────────────────────────────
let _lastTs = 0;
function gameLoop(ts) {
  animId = requestAnimationFrame(gameLoop);
  _lastTs = ts;
  sendInput();
  updateCamera();
  updateScene();
  animateTiles(ts);
  renderer.render(scene, camera);
}

function startLoop() {
  if (animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(gameLoop);
}

// ── Lobby UI ───────────────────────────────────────────────────────────────
function updateLobbyOverlay() {
  document.getElementById('roomCodeDisplay').textContent = myRoomCode;
  const isHost = myId === hostId;
  document.getElementById('startBtn').style.display  = isHost ? 'block' : 'none';
  document.getElementById('waitMsg').style.display   = isHost ? 'none'  : 'block';
  document.getElementById('botRow').style.display    = isHost ? 'flex'  : 'none';
  const list = document.getElementById('playerListLobby');
  list.innerHTML = '';
  Object.values(players).forEach(p => {
    const el = document.createElement('div');
    el.className = 'pl-item';
    const crown = p.id === hostId ? ' 👑' : '';
    const me    = p.id === myId   ? ' (you)' : '';
    const bot   = p.isBot         ? ' [CPU]' : '';
    el.innerHTML = `<span class="pl-dot" style="background:${p.color};box-shadow:0 0 6px ${p.color}"></span>
                    <span style="color:${p.color}">${p.name}${bot}${crown}${me}</span>`;
    list.appendChild(el);
  });
}

function updateHUD() {
  hudPlayers.innerHTML = '';
  Object.values(players).sort((a, b) => b.score - a.score).forEach(p => {
    const el = document.createElement('div');
    el.className = 'hud-player' + (p.alive ? '' : ' hud-dead');
    el.style.color = el.style.borderColor = p.color;
    const status = p.alive
      ? (p.hasDisc ? '◈ DISC READY' : (p.dodging ? '⚡ DODGE' : (p.blocking ? '🛡 BLOCK' : '◌ disc away')))
      : '✕ DEREZZED';
    el.innerHTML = `<span class="hud-name">${p.name}${p.id === myId ? ' ◀' : ''}${p.isBot ? ' 🤖' : ''}</span>
                    <span class="hud-disc">${status}</span>`;
    hudPlayers.appendChild(el);
  });
  const alive = Object.values(players).filter(p => p.alive).length;
  hudCenter.textContent = gamePhase === 'finalBattle'
    ? '⚡ FINAL BATTLE'
    : `${alive} PROGRAM${alive !== 1 ? 'S' : ''} REMAIN`;
}

function addKillFeed(killer, victim) {
  const el = document.createElement('div');
  el.className = 'kill-entry';
  el.innerHTML = `<span style="color:#ff6600">${killer}</span> derezzed <span style="color:#aaa">${victim}</span>`;
  killFeedEl.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ── Show/hide scenes ───────────────────────────────────────────────────────
function showTitle() {
  titleScreen.style.display   = 'flex';
  arenaWrap.style.display     = 'none';
}

function showArena() {
  titleScreen.style.display   = 'none';
  arenaWrap.style.display     = 'block';
  lobbyOverlay.style.display  = 'flex';
  hud.style.display           = 'none';
  gameOverScreen.style.display = 'none';

  if (!renderer) {
    initThree();
    startLoop();
  }
  resizeRenderer();
}

function enterGame(arena) {
  arenaInfo = arena;
  gamePhase = 'playing';
  lobbyOverlay.style.display   = 'none';
  gameOverScreen.style.display = 'none';
  hud.style.display = 'block';
  lockMsgEl.style.display = 'block';
  buildArena(arena.radius);
  buildTileMap(arena);
  // Request pointer lock on next click handled in click listener
}

function doLeave() {
  socket.emit('leaveRoom');
  myRoomCode = null; hostId = null; players = {}; bodies = [];
  gamePhase = 'title';
  tileData.clear();
  Object.keys(tileMeshes).forEach(k => removeTileMesh(k));
  Object.keys(playerMeshes).forEach(id => removePlayerMesh(id));
  Object.keys(discMeshes).forEach(id => removeDiscMesh(id));
  if (pointerLocked) document.exitPointerLock();
  crosshairEl.style.display = 'none';
  lockMsgEl.style.display   = 'none';
  gameOverScreen.style.display = 'none';
  Audio.stopMusic(); Audio.stopChanting();
  showTitle();
}

// ── Socket events ──────────────────────────────────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', ({ code, playerId, players: ps, arena: a, hostId: h }) => {
  myId = playerId; myRoomCode = code; hostId = h;
  arenaInfo = a; players = {};
  ps.forEach(p => players[p.id] = p);
  gamePhase = 'lobby';
  showArena();
  buildArena(a.radius);
  buildTileMap(a);
  updateLobbyOverlay();
  Audio.startChanting();
});

socket.on('roomJoined', ({ code, playerId, players: ps, arena: a, hostId: h, bodies: b }) => {
  myId = playerId; myRoomCode = code; hostId = h;
  arenaInfo = a; players = {}; bodies = b || [];
  ps.forEach(p => players[p.id] = p);
  gamePhase = 'lobby';
  showArena();
  buildArena(a.radius);
  buildTileMap(a);
  bodies.forEach(body => spawnBodyMesh(body));
  updateLobbyOverlay();
  Audio.startChanting();
});

socket.on('joinError', ({ message }) => {
  const el = document.getElementById('joinError');
  el.textContent = message; el.style.display = 'block';
});

socket.on('playerJoined',  ({ player }) => { players[player.id] = player; updateLobbyOverlay(); });
socket.on('playerLeft',    ({ id })     => { delete players[id]; if (gamePhase === 'lobby' || gamePhase === 'gameOver') updateLobbyOverlay(); });
socket.on('playerUpdate',  ({ id, name }) => { if (players[id]) { players[id].name = name; } updateLobbyOverlay(); });
socket.on('hostChanged',   ({ hostId: h }) => { hostId = h; updateLobbyOverlay(); });

socket.on('gameStart', ({ arena: a }) => {
  Audio.stopChanting(); Audio.startMusic();
  enterGame(a);
  // Auto-lock pointer
  renderer.domElement.requestPointerLock();
});

socket.on('finalBattle', ({ arena: a }) => {
  gamePhase = 'finalBattle';
  buildArena(a.radius);
  buildTileMap(a);
  finalBanner.style.display = 'flex';
  setTimeout(() => { finalBanner.style.display = 'none'; }, 3200);
  Audio.finalMode(true); Audio.crowdExcited();
});

socket.on('gameState', ({ players: ps, bodies: b, arena: a, state, changedTiles, gravity: g }) => {
  if (a) arenaInfo = a;
  if (b) bodies = b;
  if (g) gravity = g;
  if (ps) ps.forEach(p => {
    if (players[p.id]) Object.assign(players[p.id], p);
    else players[p.id] = p;
  });

  if (changedTiles && changedTiles.length) {
    changedTiles.forEach(({ id, state: ts }) => {
      const t = tileData.get(id);
      if (!t) return;
      const prev = t.state;
      t.state = ts;
      if (prev !== ts) spawnTileMesh(id, t.wx, t.wz, ts);
    });
  }

  if (gamePhase === 'playing' || gamePhase === 'finalBattle') updateHUD();
});

socket.on('gravityShift', ({ angle, strength }) => {
  gravity.x = Math.cos(angle) * strength;
  gravity.y = Math.sin(angle) * strength;
  Audio.dodge();
  gravIndicatorEl.classList.add('visible');
  setTimeout(() => gravIndicatorEl.classList.remove('visible'), 3000);
});

socket.on('playerEliminated', ({ id, killerName }) => {
  Audio.derezz(); Audio.crowdExcited();
  const p = players[id];
  if (p) {
    p.alive = false;
    spawnBodyMesh({
      x: p.x, y: p.y,
      color: p.color,
    });
  }
  addKillFeed(killerName || 'VOID', p?.name || id);
  if (id === myId && pointerLocked) document.exitPointerLock();
});

socket.on('discThrown', ({ playerId }) => {
  if (playerId !== myId) Audio.throwDisc();
});

socket.on('discCaught', ({ playerId }) => {
  if (playerId === myId) Audio.discCatch();
});

socket.on('gameOver', ({ winnerId, winnerName }) => {
  gamePhase = 'gameOver';
  Audio.stopMusic(); Audio.stopChanting();
  if (pointerLocked) document.exitPointerLock();
  crosshairEl.style.display = 'none';
  lockMsgEl.style.display   = 'none';
  document.getElementById('goWinner').textContent = winnerId === myId ? 'YOU WIN, PROGRAM.' : `${winnerName} WINS`;
  document.getElementById('playAgainBtn').style.display = myId === hostId ? 'block' : 'none';
  gameOverScreen.style.display = 'flex';
  lobbyOverlay.style.display   = 'none';
  hud.style.display            = 'none';
});

// ── Button wiring ──────────────────────────────────────────────────────────
document.getElementById('createBtn').addEventListener('click', () => {
  Audio.init();
  socket.emit('createRoom', { name: document.getElementById('nameInput').value.trim() || 'Program-1' });
});
document.getElementById('joinBtnOpen').addEventListener('click', () => {
  const jr = document.getElementById('joinRow');
  jr.style.display = jr.style.display === 'none' ? 'block' : 'none';
  document.getElementById('joinError').style.display = 'none';
  if (jr.style.display !== 'none') document.getElementById('codeInput').focus();
});
document.getElementById('joinBtn').addEventListener('click', doJoin);
document.getElementById('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
document.getElementById('codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

function doJoin() {
  Audio.init();
  document.getElementById('joinError').style.display = 'none';
  socket.emit('joinRoom', {
    code: document.getElementById('codeInput').value.trim(),
    name: document.getElementById('nameInput').value.trim() || 'Program-1'
  });
}

document.getElementById('startBtn').addEventListener('click', () => socket.emit('startGame'));
document.getElementById('addBotBtn').addEventListener('click', () => socket.emit('addBot'));
document.getElementById('removeBotBtn').addEventListener('click', () => socket.emit('removeBot'));
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard?.writeText(myRoomCode).catch(() => {});
  const b = document.getElementById('copyCodeBtn');
  b.textContent = '✓'; setTimeout(() => b.textContent = '⧉', 1500);
});
document.getElementById('leaveBtn').addEventListener('click', doLeave);
document.getElementById('leaveGameBtn').addEventListener('click', doLeave);
document.getElementById('playAgainBtn').addEventListener('click', () => {
  gameOverScreen.style.display = 'none';
  gamePhase = 'lobby';
  lobbyOverlay.style.display = 'flex';
  hud.style.display = 'none';
  Object.keys(tileMeshes).forEach(k => removeTileMesh(k));
  tileData.clear();
  socket.emit('startGame');
});

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
const playerMeshes = {};
const discMeshes   = {};
const tileMeshes   = {};
const tileData     = new Map();
let rimMesh = null, wallMesh = null, floorMesh = null;

// ── Camera / pointer lock ─────────────────────────────────────────────────
let yaw = 0, pitch = 0;
let pointerLocked = false;
let myFacingX = 0, myFacingZ = 1; // Three.js axes: facing +Z = server +Y

const EYE_H      = 30;
const DISC_FLY_H = 20;

// ── Input ─────────────────────────────────────────────────────────────────
const keys = {};

// ── Hex constants (must match server) ────────────────────────────────────
const HEX_SIZE = 26;
const SQ3 = Math.sqrt(3);

// ── Coordinate helpers ────────────────────────────────────────────────────
// Server uses (0,0)=top-left of arena; Three.js tiles are centered at origin.
// Subtract arena center before placing anything in 3D space.
function toScene(sx, sy) {
  return {
    x: sx - arenaInfo.width  / 2,
    z: sy - arenaInfo.height / 2
  };
}

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
  scene.fog = new THREE.FogExp2(0x000510, 0.00045);

  camera = new THREE.PerspectiveCamera(72, 1, 0.5, 3000);
  camera.rotation.order = 'YXZ';

  // Ambient + directional shadow light
  scene.add(new THREE.AmbientLight(0x001830, 2.5));
  const dir = new THREE.DirectionalLight(0x002244, 1.2);
  dir.position.set(0, 300, 0);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 1; dir.shadow.camera.far = 900;
  dir.shadow.camera.left = dir.shadow.camera.bottom = -700;
  dir.shadow.camera.right = dir.shadow.camera.top = 700;
  scene.add(dir);

  // Ceiling grid — TRON city feel
  const ceilGeo = new THREE.PlaneGeometry(6000, 6000, 40, 40);
  const ceilMat = new THREE.MeshBasicMaterial({
    color: 0x002244, wireframe: true, transparent: true, opacity: 0.07
  });
  const ceil = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 300;
  scene.add(ceil);

  // Initial resize — must use window dimensions since arenaWrap may have 0 size yet
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);
  setupPointerLock(canvas);
  setupInput();
}

function resizeRenderer() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Arena geometry ─────────────────────────────────────────────────────────
let _domeLightObjs = []; // tracked so we can remove on arena rebuild

function buildArena(radius) {
  [rimMesh, wallMesh, floorMesh].forEach(m => { if (m) scene.remove(m); });
  _domeLightObjs.forEach(o => scene.remove(o));
  _domeLightObjs = [];

  // Black void below tiles
  const vGeo = new THREE.CircleGeometry(radius + 80, 64);
  const vMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  floorMesh = new THREE.Mesh(vGeo, vMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -6;
  scene.add(floorMesh);

  // Tall glowing inner cylinder wall
  const wGeo = new THREE.CylinderGeometry(radius, radius, 220, 72, 1, true);
  const wMat = new THREE.MeshBasicMaterial({
    color: 0x00f7ff, side: THREE.BackSide, transparent: true, opacity: 0.07
  });
  wallMesh = new THREE.Mesh(wGeo, wMat);
  wallMesh.position.y = 100;
  scene.add(wallMesh);

  // Glowing floor rim
  const rGeo = new THREE.TorusGeometry(radius, 2.5, 8, 128);
  const rMat = new THREE.MeshBasicMaterial({ color: 0x00f7ff });
  rimMesh = new THREE.Mesh(rGeo, rMat);
  rimMesh.rotation.x = Math.PI / 2;
  rimMesh.position.y = 0.5;
  scene.add(rimMesh);

  // Soft fill lighting from floor level
  const cL = new THREE.PointLight(0x0088cc, 1.0, radius * 3);
  cL.position.set(0, 80, 0);
  scene.add(cL);
  const fL = new THREE.PointLight(0x003355, 3, radius * 1.5);
  fL.position.set(0, 10, 0);
  scene.add(fL);

  buildDomeLights(radius);
}

function buildDomeLights(radius) {
  const DOME_H    = 280;           // height of the light ring
  const LIGHT_R   = radius * 0.58; // radius of the spotlight circle
  const N         = 8;             // number of spotlights

  // ── Structural ring that holds the lights ─────────────────────────────
  const ringGeo = new THREE.TorusGeometry(LIGHT_R, 4, 8, 80);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x0a1a22, emissive: 0x001133, emissiveIntensity: 0.4,
    metalness: 0.95, roughness: 0.15
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = DOME_H;
  scene.add(ring);
  _domeLightObjs.push(ring);

  // Inner accent ring (smaller, brighter)
  const innerRingGeo = new THREE.TorusGeometry(radius * 0.18, 2.5, 8, 48);
  const innerRingMat = new THREE.MeshBasicMaterial({ color: 0xaaddff });
  const innerRing = new THREE.Mesh(innerRingGeo, innerRingMat);
  innerRing.rotation.x = Math.PI / 2;
  innerRing.position.y = DOME_H + 8;
  scene.add(innerRing);
  _domeLightObjs.push(innerRing);
  // Glow from center ring
  const centerLight = new THREE.PointLight(0x88bbff, 1.2, 300);
  centerLight.position.set(0, DOME_H, 0);
  scene.add(centerLight);
  _domeLightObjs.push(centerLight);

  // Radial struts connecting outer ring to center
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const strutGeo = new THREE.CylinderGeometry(0.8, 0.8, LIGHT_R - radius * 0.18, 4);
    const strutMat = new THREE.MeshStandardMaterial({
      color: 0x0a1a22, metalness: 0.9, roughness: 0.2
    });
    const strut = new THREE.Mesh(strutGeo, strutMat);
    strut.rotation.z = Math.PI / 2;
    // Position at midpoint between center ring and outer ring, rotated
    const midR = (LIGHT_R + radius * 0.18) / 2;
    strut.position.set(Math.cos(a) * midR, DOME_H, Math.sin(a) * midR);
    strut.rotation.z = Math.PI / 2;
    strut.rotation.y = -a;
    scene.add(strut);
    _domeLightObjs.push(strut);
  }

  // ── 8 spotlight fixtures ───────────────────────────────────────────────
  const SPOT_ANGLE = Math.PI / 7.5;
  const BEAM_H     = DOME_H;
  const BEAM_R     = BEAM_H * Math.tan(SPOT_ANGLE) * 1.1;

  for (let i = 0; i < N; i++) {
    const a  = (i / N) * Math.PI * 2;
    const lx = Math.cos(a) * LIGHT_R;
    const lz = Math.sin(a) * LIGHT_R;

    // ── SpotLight ──────────────────────────────────────────────────────
    const spot = new THREE.SpotLight(0xccddff, 2.5, DOME_H + 30, SPOT_ANGLE, 0.28, 1.4);
    spot.position.set(lx, DOME_H, lz);
    // Aim slightly toward arena center so beams converge
    spot.target.position.set(lx * 0.35, 0, lz * 0.35);
    scene.add(spot);
    scene.add(spot.target);
    _domeLightObjs.push(spot, spot.target);

    // ── Visible beam cone ──────────────────────────────────────────────
    // Apex at lamp, base at floor — ConeGeometry apex is at +y end
    const beamGeo = new THREE.ConeGeometry(BEAM_R, BEAM_H, 20, 1, true);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0x88bbff,
      transparent: true,
      opacity: 0.032,
      side: THREE.FrontSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    // Mesh center is at mid-height; apex (+y) ends at DOME_H
    beam.position.set(lx, DOME_H / 2, lz);
    scene.add(beam);
    _domeLightObjs.push(beam);

    // Second beam pass at lower opacity for extra glow depth
    const beam2 = new THREE.Mesh(
      new THREE.ConeGeometry(BEAM_R * 0.55, BEAM_H, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.018,
        side: THREE.FrontSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      })
    );
    beam2.position.set(lx, DOME_H / 2, lz);
    scene.add(beam2);
    _domeLightObjs.push(beam2);

    // ── Lamp housing ───────────────────────────────────────────────────
    const housingGeo = new THREE.CylinderGeometry(5, 8, 12, 10);
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x0d1f2a, emissive: 0x001122, emissiveIntensity: 0.2,
      metalness: 0.95, roughness: 0.1
    });
    const housing = new THREE.Mesh(housingGeo, housingMat);
    housing.position.set(lx, DOME_H + 6, lz);
    scene.add(housing);
    _domeLightObjs.push(housing);

    // Lens disc (glowing face of the lamp)
    const lensGeo = new THREE.CircleGeometry(6.5, 16);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xddeeff });
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.rotation.x = Math.PI / 2; // face downward
    lens.position.set(lx, DOME_H - 0.5, lz);
    scene.add(lens);
    _domeLightObjs.push(lens);

    // Lens glow halo
    const haloGeo = new THREE.CircleGeometry(10, 16);
    const haloMat = new THREE.MeshBasicMaterial({
      color: 0x88bbff, transparent: true, opacity: 0.25,
      depthWrite: false, blending: THREE.AdditiveBlending
    });
    const halo = new THREE.Mesh(haloGeo, haloMat);
    halo.rotation.x = Math.PI / 2;
    halo.position.set(lx, DOME_H - 1, lz);
    scene.add(halo);
    _domeLightObjs.push(halo);

    // Bright point at each lamp for local bloom
    const lampPt = new THREE.PointLight(0xbbddff, 0.8, 60);
    lampPt.position.set(lx, DOME_H - 5, lz);
    scene.add(lampPt);
    _domeLightObjs.push(lampPt);
  }

  // ── Floor pool circles (lit zones where beams hit) ───────────────────
  for (let i = 0; i < N; i++) {
    const a   = (i / N) * Math.PI * 2;
    const px  = Math.cos(a) * LIGHT_R * 0.35;
    const pz  = Math.sin(a) * LIGHT_R * 0.35;
    const poolGeo = new THREE.CircleGeometry(BEAM_R * 0.7, 32);
    const poolMat = new THREE.MeshBasicMaterial({
      color: 0x224466,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(px, 0.05, pz);
    scene.add(pool);
    _domeLightObjs.push(pool);
  }
}

// ── Tile map ───────────────────────────────────────────────────────────────
function buildTileMap(arena) {
  tileData.forEach((_, key) => removeTileMesh(key));
  tileData.clear();

  const R = arena.radius || 480;
  const range = Math.ceil(R / (HEX_SIZE * SQ3)) + 2;
  for (let q = -range; q <= range; q++) {
    for (let r = -range; r <= range; r++) {
      const { x: wx, z: wz } = hexToWorld3(q, r);
      if (Math.sqrt(wx * wx + wz * wz) > R - HEX_SIZE * 0.5) continue;
      const key = `${q},${r}`;
      tileData.set(key, { q, r, wx, wz, state: 0 });
      spawnTileMesh(key, wx, wz, 0);
    }
  }
}

function spawnTileMesh(key, wx, wz, state) {
  removeTileMesh(key);
  if (state === 2) return;

  const geo = new THREE.CylinderGeometry(HEX_SIZE * 0.93, HEX_SIZE * 0.93, 4, 6);
  const isIntact = state === 0;
  const mat = new THREE.MeshStandardMaterial({
    color:             isIntact ? 0x001a22 : 0x2a0a00,
    emissive:          isIntact ? 0x003344 : 0x883300,
    emissiveIntensity: isIntact ? 0.18     : 0.7,
    roughness: 0.35, metalness: 0.7
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
    color: 0x060606, emissive: col, emissiveIntensity: 0.07,
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

  // Chest lines
  const chest = new THREE.Mesh(new THREE.BoxGeometry(8, 2, 1), glowMat);
  chest.position.set(0, 27, 6.5);
  group.add(chest);
  const mid = new THREE.Mesh(new THREE.BoxGeometry(5, 1, 1), glowMat);
  mid.position.set(0, 23, 6.5);
  group.add(mid);

  // Chest reactor
  const reactor = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), glowMat);
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
    const stripe2 = new THREE.Mesh(new THREE.BoxGeometry(1, 10, 1.2), glowMat);
    stripe2.position.set(ox > 0 ? ox + 1 : ox - 1, 23, 2.5);
    group.add(stripe2);
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

  return group;
}

function getOrMakePlayerMesh(id, color, isMe) {
  if (playerMeshes[id]) return playerMeshes[id];
  const g = makePlayerGroup(color);
  if (isMe) g.visible = false;
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
  const col = new THREE.Color(color || '#00f7ff');

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(11, 11, 3, 24),
    new THREE.MeshStandardMaterial({
      color: col, emissive: col, emissiveIntensity: 1.0,
      roughness: 0.1, metalness: 0.7, transparent: true, opacity: 0.9
    })
  );
  group.add(mesh);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(11, 1.8, 8, 32),
    new THREE.MeshBasicMaterial({ color: col })
  );
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

// ── Dead body silhouette ───────────────────────────────────────────────────
function spawnBodyMesh(body) {
  const col = new THREE.Color(body.color || '#444444');
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(10, 10, 1.5, 8),
    new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: col, emissiveIntensity: 0.12
    })
  );
  const s = toScene(body.x, body.y);
  m.position.set(s.x, 0.8, s.z);
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
    pitch  = Math.max(-0.55, Math.min(0.55, pitch));
    myFacingX = Math.sin(yaw);
    myFacingZ = Math.cos(yaw);
    socket.emit('setFacing', { fx: myFacingX, fy: myFacingZ });
  });
}

function doThrowDisc() {
  const me = players[myId];
  if (!me || !me.alive || !me.hasDisc) return;
  // Target in server world coords (not 3D scene coords)
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
    if (k === 'escape' && pointerLocked) document.exitPointerLock();
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === 'Shift') socket.emit('blockEnd');
  });
}

let _lastVx = 0, _lastVy = 0;
function sendInput() {
  if (!myId) return;
  if (gamePhase !== 'playing' && gamePhase !== 'finalBattle') return;

  // Forward (server +Y = Three.js +Z) and strafe (server +X = Three.js +X)
  const fwX = myFacingX, fwZ = myFacingZ;
  const stX =  myFacingZ, stZ = -myFacingX; // 90° left of forward

  let vx = 0, vy = 0;
  if (keys['w'])              { vx += fwX; vy += fwZ; }
  if (keys['s'])              { vx -= fwX; vy -= fwZ; }
  if (keys['q'] || keys['a']) { vx -= stX; vy -= stZ; }
  if (keys['e'])              { vx += stX; vy += stZ; }

  const l = Math.sqrt(vx * vx + vy * vy);
  if (l > 0) { vx /= l; vy /= l; }

  if (vx !== _lastVx || vy !== _lastVy) {
    _lastVx = vx; _lastVy = vy;
    socket.emit('input', { vx, vy });
  }
}

// ── Update camera ──────────────────────────────────────────────────────────
function updateCamera() {
  const me = players[myId];
  if (!me) return;
  camera.rotation.y = yaw;
  camera.rotation.x = pitch;
  const s = toScene(me.x, me.y);
  camera.position.set(s.x, EYE_H, s.z);
}

// ── Update scene from server state ────────────────────────────────────────
let _discRot = 0;
function updateScene() {
  _discRot += 0.06;
  const seenDiscs = new Set();

  Object.values(players).forEach(p => {
    const group = getOrMakePlayerMesh(p.id, p.color, p.id === myId);

    if (p.id === myId) {
      // Own body hidden in first-person; still placed for shadow
      const s = toScene(p.x, p.y);
      group.position.set(s.x, 0, s.z);

      // Show held disc at arm level
      if (p.hasDisc) {
        seenDiscs.add(p.id);
        const dm = getOrMakeDiscMesh(p.id, p.color);
        dm.position.set(s.x + Math.cos(yaw) * 14, EYE_H - 10, s.z - Math.sin(yaw) * 14);
        dm.rotation.y = _discRot;
      }
      // Disc in flight
      if (p.disc) {
        seenDiscs.add(p.id);
        const ds = toScene(p.disc.x, p.disc.y);
        const dm = getOrMakeDiscMesh(p.id, p.color);
        dm.position.set(ds.x, DISC_FLY_H, ds.z);
        dm.rotation.y = _discRot;
      }
      return;
    }

    group.visible = !!p.alive;
    if (!p.alive) return;

    const s = toScene(p.x, p.y);
    group.position.set(s.x, 0, s.z);
    group.rotation.y = Math.atan2(p.facing.x, p.facing.y);

    if (p.hasDisc) {
      seenDiscs.add(p.id);
      const angle = Math.atan2(p.facing.x, p.facing.y);
      const dm = getOrMakeDiscMesh(p.id, p.color);
      dm.position.set(s.x + Math.cos(angle) * 10, 22, s.z - Math.sin(angle) * 10);
      dm.rotation.y = _discRot;
    } else if (p.disc) {
      seenDiscs.add(p.id);
      const ds = toScene(p.disc.x, p.disc.y);
      const dm = getOrMakeDiscMesh(p.id, p.color);
      dm.position.set(ds.x, DISC_FLY_H, ds.z);
      dm.rotation.y = _discRot;
    }
  });

  // Remove stale player/disc meshes
  Object.keys(playerMeshes).forEach(id => { if (!players[id]) removePlayerMesh(id); });
  Object.keys(discMeshes).forEach(id => { if (!seenDiscs.has(id)) removeDiscMesh(id); });
}

// ── Tile cracking animation ────────────────────────────────────────────────
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
function gameLoop(ts) {
  animId = requestAnimationFrame(gameLoop);
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

// ── Show/hide screens ──────────────────────────────────────────────────────
function showTitle() {
  titleScreen.style.display  = 'flex';
  arenaWrap.style.display    = 'none';
}

function showArena() {
  titleScreen.style.display  = 'none';
  arenaWrap.style.display    = 'block';
  lobbyOverlay.style.display = 'flex';
  hud.style.display          = 'none';
  gameOverScreen.style.display = 'none';

  if (!renderer) {
    initThree();
    startLoop();
  }
  // Resize after layout settles
  setTimeout(resizeRenderer, 50);
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
}

function doLeave() {
  socket.emit('leaveRoom');
  myRoomCode = null; hostId = null; players = {}; bodies = [];
  gamePhase = 'title';
  tileData.forEach((_, k) => removeTileMesh(k));
  tileData.clear();
  Object.keys(playerMeshes).forEach(removePlayerMesh);
  Object.keys(discMeshes).forEach(removeDiscMesh);
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
  bodies.forEach(spawnBodyMesh);
  updateLobbyOverlay();
  Audio.startChanting();
});

socket.on('joinError', ({ message }) => {
  const el = document.getElementById('joinError');
  el.textContent = message; el.style.display = 'block';
});

socket.on('playerJoined',  ({ player })      => { players[player.id] = player; updateLobbyOverlay(); });
socket.on('playerLeft',    ({ id })          => { delete players[id]; if (gamePhase === 'lobby') updateLobbyOverlay(); });
socket.on('playerUpdate',  ({ id, name })    => { if (players[id]) players[id].name = name; updateLobbyOverlay(); });
socket.on('hostChanged',   ({ hostId: h })   => { hostId = h; updateLobbyOverlay(); });

socket.on('gameStart', ({ arena: a }) => {
  Audio.stopChanting(); Audio.startMusic();
  enterGame(a);
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
      if (!t || t.state === ts) return;
      t.state = ts;
      spawnTileMesh(id, t.wx, t.wz, ts);
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
    spawnBodyMesh({ x: p.x, y: p.y, color: p.color });
  }
  addKillFeed(killerName || 'VOID', p?.name || id);
  if (id === myId && pointerLocked) document.exitPointerLock();
});

socket.on('discThrown', ({ playerId }) => { if (playerId !== myId) Audio.throwDisc(); });
socket.on('discCaught', ({ playerId }) => { if (playerId === myId) Audio.discCatch(); });

socket.on('gameOver', ({ winnerId, winnerName }) => {
  gamePhase = 'gameOver';
  Audio.stopMusic(); Audio.stopChanting();
  if (pointerLocked) document.exitPointerLock();
  crosshairEl.style.display = 'none';
  lockMsgEl.style.display   = 'none';
  document.getElementById('goWinner').textContent = winnerId === myId
    ? 'YOU WIN, PROGRAM.' : `${winnerName} WINS`;
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
document.getElementById('codeInput').addEventListener('input',   e => { e.target.value = e.target.value.toUpperCase(); });

function doJoin() {
  Audio.init();
  document.getElementById('joinError').style.display = 'none';
  socket.emit('joinRoom', {
    code: document.getElementById('codeInput').value.trim(),
    name: document.getElementById('nameInput').value.trim() || 'Program-1'
  });
}

document.getElementById('startBtn').addEventListener('click',    () => socket.emit('startGame'));
document.getElementById('addBotBtn').addEventListener('click',   () => socket.emit('addBot'));
document.getElementById('removeBotBtn').addEventListener('click',() => socket.emit('removeBot'));
document.getElementById('copyCodeBtn').addEventListener('click', () => {
  navigator.clipboard?.writeText(myRoomCode).catch(() => {});
  const b = document.getElementById('copyCodeBtn');
  b.textContent = '✓'; setTimeout(() => b.textContent = '⧉', 1500);
});
document.getElementById('leaveBtn').addEventListener('click',     doLeave);
document.getElementById('leaveGameBtn').addEventListener('click', doLeave);
document.getElementById('playAgainBtn').addEventListener('click', () => {
  gameOverScreen.style.display = 'none';
  gamePhase = 'lobby';
  lobbyOverlay.style.display = 'flex';
  hud.style.display = 'none';
  tileData.forEach((_, k) => removeTileMesh(k));
  tileData.clear();
  socket.emit('startGame');
});

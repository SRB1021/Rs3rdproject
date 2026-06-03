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
let renderer, scene, camera, animId, composer;
const playerMeshes = {};
const discMeshes   = {};
const tileMeshes   = {};
const tileData     = new Map();
let rimMesh = null, wallMesh = null, floorMesh = null;

// ── Camera / pointer lock ─────────────────────────────────────────────────
// yaw=0 → camera looks along Three.js -Z → server facing (0,-1)
// initialise to Math.PI so player starts looking toward +Y (into arena)
let yaw = Math.PI, pitch = 0;
let pointerLocked = false;
// myFacingX/Z are server-coordinate facing (x and y respectively)
// Camera look dir in Three.js = (-sin(yaw), 0, -cos(yaw))
// → server facing.x = -sin(yaw), server facing.y = -cos(yaw)
let myFacingX = -Math.sin(Math.PI);   // 0
let myFacingZ = -Math.cos(Math.PI);   // 1  (server +Y)

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.00028);

  camera = new THREE.PerspectiveCamera(72, 1, 0.5, 3000);
  camera.rotation.order = 'YXZ';

  // Minimal ambient — scene should be mostly dark, lit by arena fixtures
  scene.add(new THREE.AmbientLight(0x050d1a, 2.0));

  // Overhead fill — subtle, so shadows are visible
  const dir = new THREE.DirectionalLight(0x6688aa, 0.6);
  dir.position.set(0, 500, 0);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 1; dir.shadow.camera.far = 1400;
  dir.shadow.camera.left = dir.shadow.camera.bottom = -600;
  dir.shadow.camera.right = dir.shadow.camera.top = 600;
  dir.shadow.bias = -0.001;
  scene.add(dir);

  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);
  setupPointerLock(canvas);
  setupInput();
  setupBloom();
}

function setupBloom() {
  const { EffectComposer, RenderPass, UnrealBloomPass } = window.PP;
  const w = window.innerWidth, h = window.innerHeight;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    1.4,   // strength
    0.55,  // radius
    0.18   // threshold — only bright emissive surfaces bloom
  );
  composer.addPass(bloom);
}

function resizeRenderer() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  if (composer) composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ── Shared geometries (created once, reused) ──────────────────────────────
let _hexGeo = null;
function getHexGeo() {
  if (!_hexGeo) _hexGeo = new THREE.CylinderGeometry(HEX_SIZE * 0.93, HEX_SIZE * 0.93, 4, 6);
  return _hexGeo;
}
const _matIntact = new THREE.MeshStandardMaterial({
  color: 0x003344, emissive: 0x00ccee, emissiveIntensity: 0.55,
  roughness: 0.35, metalness: 0.85
});
const _matCracking = new THREE.MeshStandardMaterial({
  color: 0x331100, emissive: 0xff5500, emissiveIntensity: 0.85,
  roughness: 0.4, metalness: 0.6
});

// ── Arena geometry ─────────────────────────────────────────────────────────
let _arenaObjs = [];

function buildArena(r) {
  _arenaObjs.forEach(o => scene.remove(o));
  _arenaObjs = [];
  [rimMesh, wallMesh, floorMesh].forEach(m => { if (m) scene.remove(m); });

  r = r || 480;

  // ── Combat platform floor (elevated disc) ─────────────────────────────────
  floorMesh = new THREE.Mesh(
    new THREE.CircleGeometry(r + 20, 64),
    new THREE.MeshStandardMaterial({
      color: 0x000810, roughness: 0.06, metalness: 0.98
    })
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -5.1;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // ── Arena inner wall (combat ring) ───────────────────────────────────────
  wallMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, 180, 80, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x000d1a, roughness: 0.5, metalness: 0.7, side: THREE.BackSide
    })
  );
  wallMesh.position.y = 85;
  scene.add(wallMesh);

  // Neon floor rim (bright cyan edge of combat platform)
  rimMesh = new THREE.Mesh(
    new THREE.TorusGeometry(r, 4, 8, 120),
    new THREE.MeshStandardMaterial({
      color: 0x00f7ff, emissive: 0x00f7ff, emissiveIntensity: 3.5,
      roughness: 0.0, metalness: 0.0
    })
  );
  rimMesh.rotation.x = Math.PI / 2;
  rimMesh.position.y = 1;
  scene.add(rimMesh);

  // Horizontal wall strip lights — 4 bands at different heights
  [30, 65, 105, 155].forEach((hy, idx) => {
    const stripMat = new THREE.MeshStandardMaterial({
      color: idx === 3 ? 0xffffff : 0x00ccff,
      emissive: idx === 3 ? 0xaaccff : 0x0088cc,
      emissiveIntensity: idx === 3 ? 1.2 : 0.6,
      roughness: 0.1, metalness: 0.0
    });
    const strip = new THREE.Mesh(
      new THREE.CylinderGeometry(r - 1, r - 1, idx === 3 ? 6 : 2, 80, 1, true),
      stripMat
    );
    strip.position.y = hy;
    scene.add(strip);
    _arenaObjs.push(strip);
  });

  // ── Outer structure wall (enclosing the whole venue) ──────────────────────
  const OUTER_R  = r * 2.1;
  const VENUE_H  = 420;

  const outerWall = new THREE.Mesh(
    new THREE.CylinderGeometry(OUTER_R, OUTER_R, VENUE_H, 80, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x010810, roughness: 0.8, metalness: 0.3, side: THREE.BackSide
    })
  );
  outerWall.position.y = VENUE_H / 2 - 80;
  scene.add(outerWall);
  _arenaObjs.push(outerWall);

  // Outer wall horizontal accent strips
  [40, 100, 180, 260].forEach(hy => {
    const s = new THREE.Mesh(
      new THREE.CylinderGeometry(OUTER_R - 1, OUTER_R - 1, 1.5, 80, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x003355, transparent: true, opacity: 0.9 })
    );
    s.position.y = hy - 80;
    scene.add(s);
    _arenaObjs.push(s);
  });

  // ── Tiered spectator stands ───────────────────────────────────────────────
  const TIERS = [
    { r0: r + 20,  r1: r + 90,  y: -20,  h: 60  },
    { r0: r + 80,  r1: r + 180, y: 20,   h: 100 },
    { r0: r + 170, r1: r + 320, y: 90,   h: 180 },
    { r0: r + 300, r1: OUTER_R, y: 200,  h: 140 },
  ];
  const standMat = new THREE.MeshStandardMaterial({
    color: 0x000a14, roughness: 0.9, metalness: 0.2
  });
  TIERS.forEach(({ r0, r1, y, h }) => {
    const geo = new THREE.CylinderGeometry(r1, r1, h, 64, 1, true);
    const m   = new THREE.Mesh(geo, standMat);
    m.position.y = y;
    scene.add(m);
    _arenaObjs.push(m);

    // tier floor ring (top face of stands)
    const tierFloor = new THREE.Mesh(
      new THREE.RingGeometry(r0, r1, 64),
      new THREE.MeshStandardMaterial({ color: 0x00060f, roughness: 0.95, metalness: 0.1 })
    );
    tierFloor.rotation.x = -Math.PI / 2;
    tierFloor.position.y = y + h / 2;
    scene.add(tierFloor);
    _arenaObjs.push(tierFloor);
  });

  // ── Crowd particle field (thousands of spectator lights) ──────────────────
  const CROWD_COUNT = 3200;
  const positions   = new Float32Array(CROWD_COUNT * 3);
  const colors      = new Float32Array(CROWD_COUNT * 3);
  let ci = 0;
  for (let i = 0; i < CROWD_COUNT; i++) {
    const angle  = Math.random() * Math.PI * 2;
    const tier   = TIERS[Math.floor(Math.random() * TIERS.length)];
    const cr     = tier.r0 + Math.random() * (tier.r1 - tier.r0);
    const cy2    = tier.y + tier.h / 2 + Math.random() * 30;
    positions[ci]     = Math.cos(angle) * cr;
    positions[ci + 1] = cy2;
    positions[ci + 2] = Math.sin(angle) * cr;
    // Mostly white/blue crowd lights, occasional warm
    const warm = Math.random() < 0.08;
    colors[ci]     = warm ? 1.0 : 0.7 + Math.random() * 0.3;
    colors[ci + 1] = warm ? 0.6 : 0.85 + Math.random() * 0.15;
    colors[ci + 2] = warm ? 0.2 : 1.0;
    ci += 3;
  }
  const crowdGeo = new THREE.BufferGeometry();
  crowdGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  crowdGeo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
  const crowd = new THREE.Points(
    crowdGeo,
    new THREE.PointsMaterial({ size: 2.8, vertexColors: true, sizeAttenuation: true })
  );
  scene.add(crowd);
  _arenaObjs.push(crowd);

  // ── Venue ceiling ─────────────────────────────────────────────────────────
  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(OUTER_R, 80),
    new THREE.MeshStandardMaterial({ color: 0x000810, roughness: 0.9, metalness: 0.5 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = VENUE_H - 80;
  scene.add(ceiling);
  _arenaObjs.push(ceiling);

  // ── THE BIG RING — iconic TRON disc wars ring at apex ────────────────────
  const BIG_RING_R = r * 1.35;
  const BIG_RING_Y = 200;

  // Outer dark structural torus
  const bigRingOuter = new THREE.Mesh(
    new THREE.TorusGeometry(BIG_RING_R, 18, 16, 120),
    new THREE.MeshStandardMaterial({
      color: 0x001428, roughness: 0.4, metalness: 0.95
    })
  );
  bigRingOuter.rotation.x = Math.PI / 2;
  bigRingOuter.position.y = BIG_RING_Y;
  scene.add(bigRingOuter);
  _arenaObjs.push(bigRingOuter);

  // Bright inner emission face — the glowing white ring in the movie
  const bigRingGlow = new THREE.Mesh(
    new THREE.TorusGeometry(BIG_RING_R, 8, 12, 120),
    new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xddeeff, emissiveIntensity: 4.0,
      roughness: 0.0, metalness: 0.0
    })
  );
  bigRingGlow.rotation.x = Math.PI / 2;
  bigRingGlow.position.y = BIG_RING_Y;
  scene.add(bigRingGlow);
  _arenaObjs.push(bigRingGlow);

  // Secondary inner ring slightly smaller
  const bigRingInner = new THREE.Mesh(
    new THREE.TorusGeometry(BIG_RING_R * 0.86, 4, 8, 100),
    new THREE.MeshStandardMaterial({
      color: 0x88bbff, emissive: 0x6699ff, emissiveIntensity: 2.5,
      roughness: 0.0, metalness: 0.0
    })
  );
  bigRingInner.rotation.x = Math.PI / 2;
  bigRingInner.position.y = BIG_RING_Y - 2;
  scene.add(bigRingInner);
  _arenaObjs.push(bigRingInner);

  // Point light riding the big ring — gives it that "halo" lit-from-above feel
  const ringLight = new THREE.PointLight(0xaaccff, 3.0, r * 3);
  ringLight.position.set(0, BIG_RING_Y, 0);
  scene.add(ringLight);
  _arenaObjs.push(ringLight);

  // ── Overhead combat spotlights (4, crisscrossing over platform) ──────────
  const SPOT_H = BIG_RING_Y - 10;
  for (let i = 0; i < 4; i++) {
    const sa = (i / 4) * Math.PI * 2;
    const sx = Math.cos(sa) * r * 0.55;
    const sz = Math.sin(sa) * r * 0.55;
    const spot = new THREE.SpotLight(0xcce0ff, 2.5, SPOT_H * 2.2, Math.PI / 10, 0.35, 1.2);
    spot.position.set(sx, SPOT_H, sz);
    spot.target.position.set(-sx * 0.3, 0, -sz * 0.3);
    spot.castShadow = (i === 0);
    if (i === 0) { spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.001; }
    scene.add(spot); scene.add(spot.target);
    _arenaObjs.push(spot); _arenaObjs.push(spot.target);
  }

  // Soft fill from below rim (makes floor reflect)
  const floorFill = new THREE.PointLight(0x003355, 1.5, r * 1.8);
  floorFill.position.set(0, 20, 0);
  scene.add(floorFill);
  _arenaObjs.push(floorFill);
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
  const mesh = new THREE.Mesh(getHexGeo(), state === 0 ? _matIntact : _matCracking);
  mesh.rotation.y = Math.PI / 6;
  mesh.position.set(wx, -2.5, wz);
  mesh.userData.state = state;
  mesh.receiveShadow = true;
  scene.add(mesh);
  tileMeshes[key] = mesh;
}

function removeTileMesh(key) {
  const m = tileMeshes[key];
  if (!m) return;
  scene.remove(m);
  delete tileMeshes[key];
}

// ── Player meshes ──────────────────────────────────────────────────────────
function makePlayerGroup(color) {
  const group = new THREE.Group();
  const col = new THREE.Color(color);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x030609, roughness: 0.18, metalness: 0.97
  });
  const armorMat = new THREE.MeshStandardMaterial({
    color: 0x060d15, roughness: 0.12, metalness: 0.99
  });
  const glowMat = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 2.8,
    roughness: 0.0, metalness: 0.0
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xddf4ff, emissiveIntensity: 3.5,
    roughness: 0.0, metalness: 0.0, transparent: true, opacity: 0.85
  });

  function add(mesh, x, y, z) { mesh.position.set(x, y, z); group.add(mesh); return mesh; }
  function box(w, h, d, mat)  { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
  function cyl(rt, rb, h, s, mat) { return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s), mat); }

  // ── BOOTS ────────────────────────────────────────────────────────────────
  for (const ox of [-5, 5]) {
    add(box(7, 5, 8, armorMat),     ox, -13, 0.5);   // boot block
    add(box(7.5, 1, 9, glowMat),    ox, -10.5, 0.5); // ankle glow line
  }

  // ── LOWER LEGS ───────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-5,-1],[5,1]]) {
    add(box(6, 11, 6, bodyMat),       ox, -4.5, 0);   // shin
    add(box(7, 2.5, 7, armorMat),     ox,  1.5, 0);   // knee armor
    add(box(7.5, 1, 7.5, glowMat),    ox,  2.8, 0);   // knee glow cap
    add(box(1, 9, 1, glowMat),        ox+sx*2.2, -4, 3.2); // shin stripe
  }

  // ── UPPER LEGS ───────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-5,-1],[5,1]]) {
    add(box(7, 13, 7, bodyMat),      ox, 10.5, 0);    // thigh
    add(box(7.5, 1, 7.5, glowMat),   ox, 17.2, 0);   // hip glow line
    add(box(1, 11, 1, glowMat),      ox+sx*2.2, 10.5, 3.5); // thigh stripe
  }

  // ── WAIST / PELVIS ───────────────────────────────────────────────────────
  add(box(15, 4, 8, armorMat),  0, 18.5, 0);
  add(box(15, 1, 8.5, glowMat), 0, 20.8, 0);   // waist top glow
  add(box(15, 1, 8.5, glowMat), 0, 16.5, 0);   // waist bottom glow

  // ── TORSO ────────────────────────────────────────────────────────────────
  add(box(15, 16, 8, bodyMat),   0, 29, 0);    // main torso
  add(box(11, 12, 2, armorMat),  0, 29, 4.5);  // chest plate

  // Vertical center spine on chest
  add(box(1.2, 16, 1, glowMat),  0, 29, 5.6);
  // Horizontal chest lines
  add(box(13, 1.2, 1, glowMat),  0, 33, 5.6);
  add(box(11, 1.2, 1, glowMat),  0, 29, 5.6);
  add(box(9,  1.2, 1, glowMat),  0, 25, 5.6);

  // Identity core circle on chest
  const coreDisc = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.8, 20), glowMat);
  coreDisc.rotation.x = Math.PI / 2;
  add(coreDisc, 0, 29, 6.1);
  const coreRing = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.5, 8, 24), glowMat);
  add(coreRing, 0, 29, 5.8);

  // Back spine glow line
  add(box(1.2, 16, 1, glowMat),  0, 29, -4.6);

  // ── SHOULDERS ────────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-10,-1],[10,1]]) {
    add(box(6, 5, 9, armorMat),    ox, 35, 0);        // shoulder pad
    add(box(6.5, 1, 9.5, glowMat), ox, 37.8, 0);      // shoulder top glow
    add(box(6.5, 1, 9.5, glowMat), ox, 32.5, 0);      // shoulder bottom glow
  }

  // ── ARMS ─────────────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-10,-1],[10,1]]) {
    add(box(5.5, 12, 5.5, bodyMat),   ox, 26, 0);     // upper arm
    add(box(6, 2.5, 6.5, armorMat),   ox, 20, 0);     // elbow armor
    add(box(6.5, 1, 7, glowMat),      ox, 21.5, 0);   // elbow top glow
    add(box(6.5, 1, 7, glowMat),      ox, 18.5, 0);   // elbow bottom glow
    add(box(5, 10, 5, bodyMat),        ox, 13, 0);    // forearm
    add(box(5.5, 1, 5.5, glowMat),    ox, 8.5, 0);   // wrist glow
    // Arm circuit stripe
    add(box(1, 10, 1, glowMat),  ox+sx*1.8, 26, 3);
    add(box(1, 8, 1, glowMat),   ox+sx*1.8, 13, 2.8);
  }

  // ── NECK ─────────────────────────────────────────────────────────────────
  add(cyl(3, 3.5, 5, 8, bodyMat), 0, 39.5, 0);

  // ── HELMET ───────────────────────────────────────────────────────────────
  const helmetBase = new THREE.Mesh(new THREE.SphereGeometry(7.5, 20, 14), armorMat);
  helmetBase.scale.set(0.94, 0.9, 1.0);
  add(helmetBase, 0, 48, 0);

  // Visor — bright glowing horizontal slit
  const visorMesh = box(13, 3.5, 2.5, visorMat);
  add(visorMesh, 0, 48.2, 7.5);

  // Visor bright core
  const visorCore = box(9, 2, 1, new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 5.0,
    roughness: 0, metalness: 0
  }));
  add(visorCore, 0, 48.2, 8.8);

  // Helmet top glow stripe
  add(box(1.5, 7, 1.5, glowMat), 0, 53.5, 5.5);
  // Helmet side glow lines
  for (const ox of [-6.5, 6.5]) add(box(1, 10, 1, glowMat), ox, 48.5, 3);

  // ── IDENTITY DISC (on back, the signature TRON disc) ─────────────────────
  const discBody = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 2.5, 28), armorMat);
  discBody.rotation.x = Math.PI / 2;
  add(discBody, 0, 29, -8.5);

  const discGlow = new THREE.Mesh(new THREE.TorusGeometry(8.5, 1.2, 8, 36), glowMat);
  add(discGlow, 0, 29, -8.5);

  const discCenter = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.8, 16), glowMat);
  discCenter.rotation.x = Math.PI / 2;
  add(discCenter, 0, 29, -10);

  const discInnerRing = new THREE.Mesh(new THREE.TorusGeometry(5.5, 0.6, 6, 28), glowMat);
  add(discInnerRing, 0, 29, -10);

  return group;
}

function getOrMakePlayerMesh(id, color, isMe) {
  if (playerMeshes[id]) return playerMeshes[id];
  const g = makePlayerGroup(color);
  if (isMe) g.visible = false;
  g.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
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
      color: col, emissive: col, emissiveIntensity: 1.4,
      roughness: 0.05, metalness: 0.9, transparent: true, opacity: 0.92
    })
  );
  group.add(mesh);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(11, 1.8, 8, 32),
    new THREE.MeshBasicMaterial({ color: col })
  );
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

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
    new THREE.MeshBasicMaterial({ color: col })
  );
  const s = toScene(body.x, body.y);
  m.position.set(s.x, 0.8, s.z);
  
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
    // Camera looks along (-sin(yaw), 0, -cos(yaw)) in Three.js
    // = server facing (-sin(yaw), -cos(yaw))
    myFacingX = -Math.sin(yaw);
    myFacingZ = -Math.cos(yaw);
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
    const inGame = gamePhase === 'playing' || gamePhase === 'finalBattle';
    if ((k === ' ' || k === 'f') && inGame) { socket.emit('dodge'); Audio.dodge(); }
    if (e.key === 'Shift' && inGame)         { socket.emit('blockStart'); }
    if (k === 'escape' && pointerLocked)     { document.exitPointerLock(); }
  });
  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
    if (e.key === 'Shift') socket.emit('blockEnd');
  });
}

function sendInput() {
  if (!myId) return;
  if (gamePhase !== 'playing' && gamePhase !== 'finalBattle') return;

  const fwX = myFacingX,  fwZ = myFacingZ;
  const stX = -myFacingZ, stZ = myFacingX;

  let vx = 0, vy = 0;
  if (keys['w'] || keys['arrowup'])                 { vx += fwX; vy += fwZ; }
  if (keys['s'] || keys['arrowdown'])               { vx -= fwX; vy -= fwZ; }
  if (keys['a'] || keys['arrowleft']  || keys['q']) { vx -= stX; vy -= stZ; }
  if (keys['d'] || keys['arrowright'] || keys['e']) { vx += stX; vy += stZ; }

  const l = Math.sqrt(vx * vx + vy * vy);
  if (l > 0) { vx /= l; vy /= l; }

  socket.emit('input', { vx, vy });
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
        // right = (cos(yaw), -sin(yaw)) in Three.js xz plane
      dm.position.set(s.x + Math.cos(yaw) * 12, EYE_H - 12, s.z - Math.sin(yaw) * 12);
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

  // Remove stale player meshes; hide discs rather than delete them
  Object.keys(playerMeshes).forEach(id => { if (!players[id]) removePlayerMesh(id); });
  Object.keys(discMeshes).forEach(id => {
    if (!seenDiscs.has(id)) discMeshes[id].visible = false;
  });
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
  if (composer) composer.render(); else renderer.render(scene, camera);
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

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
let _bigRings = [];   // tracked for slow rotation

// ── Effects systems ───────────────────────────────────────────────────────
const discTrails  = {};   // ownerId → { pts, positions, head }
const activeExplosions = [];
let   _shakeAmp = 0;
const TRAIL_LEN = 28;

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
  const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(isMobile ? Math.min(window.devicePixelRatio, 1.5) : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputEncoding = THREE.sRGBEncoding;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000005, 0.00018);

  camera = new THREE.PerspectiveCamera(68, 1, 0.5, 4000);
  camera.rotation.order = 'YXZ';

  // HDR environment map — real reflections on all metallic surfaces
  const { RoomEnvironment } = window.PP;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  scene.add(new THREE.AmbientLight(0x0d2035, 0.9));

  const dir = new THREE.DirectionalLight(0x6688bb, 0.65);
  dir.position.set(80, 500, 120);
  dir.castShadow = true;
  dir.shadow.mapSize.set(4096, 4096);
  dir.shadow.camera.near = 1; dir.shadow.camera.far = 1800;
  dir.shadow.camera.left = dir.shadow.camera.bottom = -800;
  dir.shadow.camera.right = dir.shadow.camera.top = 800;
  dir.shadow.bias = -0.0005;
  dir.shadow.radius = 2;
  scene.add(dir);

  // Subtle counter-fill from below
  const fill = new THREE.DirectionalLight(0x002244, 0.25);
  fill.position.set(-60, -80, -100);
  scene.add(fill);

  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);
  setupPointerLock(canvas);
  setupInput();
  setupMobileControls();
  setupPostProcessing();
}

// Chromatic aberration — colour fringing like a real camera lens
const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse:  { value: null },
    amount:    { value: 0.0028 },
    angle:     { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float angle;
    varying vec2 vUv;
    void main() {
      vec2 offset = amount * vec2(cos(angle), sin(angle));
      vec4 cr = texture2D(tDiffuse, vUv + offset);
      vec4 cg = texture2D(tDiffuse, vUv);
      vec4 cb = texture2D(tDiffuse, vUv - offset);
      gl_FragColor = vec4(cr.r, cg.g, cb.b, cg.a);
    }
  `
};

function setupPostProcessing() {
  const {
    EffectComposer, RenderPass, UnrealBloomPass,
    SSAOPass, SMAAPass, FilmPass, BokehPass, ShaderPass, VignetteShader
  } = window.PP;
  const w = window.innerWidth, h = window.innerHeight;
  const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  composer = new EffectComposer(renderer);

  // 1. Scene render
  composer.addPass(new RenderPass(scene, camera));

  if (!isMobile) {
    // 2. SSAO — ambient occlusion (desktop only, too heavy on mobile)
    const ssao = new SSAOPass(scene, camera, w, h);
    ssao.kernelRadius = 28; ssao.minDistance = 0.001; ssao.maxDistance = 0.055;
    composer.addPass(ssao);
  }

  // 3. HDR bloom — neon glow halos
  const bloomStrength = isMobile ? 0.9 : 0.75;
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), bloomStrength, 0.5, 0.28));

  if (!isMobile) {
    // 4. Depth of field (desktop only)
    composer.addPass(new BokehPass(scene, camera, {
      focus: 180.0, aperture: 0.00004, maxblur: 0.006, width: w, height: h
    }));
    // 5. Chromatic aberration
    composer.addPass(new ShaderPass(ChromaticAberrationShader));
    // 6. SMAA
    composer.addPass(new SMAAPass(w, h));
  }

  // 7. Film grain
  composer.addPass(new FilmPass(isMobile ? 0.15 : 0.22, 0.0, 648, false));

  // 8. Vignette
  const vignette = new ShaderPass(VignetteShader);
  vignette.uniforms['offset'].value = isMobile ? 0.75 : 0.80;
  vignette.uniforms['darkness'].value = isMobile ? 1.6 : 1.8;
  composer.addPass(vignette);
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
  color: 0x001520, emissive: 0x00ccee, emissiveIntensity: 0.6,
  roughness: 0.2, metalness: 0.9, envMapIntensity: 1.8
});
const _matCracking = new THREE.MeshStandardMaterial({
  color: 0x2a0800, emissive: 0xff4400, emissiveIntensity: 1.0,
  roughness: 0.3, metalness: 0.7, envMapIntensity: 1.0
});

// ── Arena geometry ─────────────────────────────────────────────────────────
let _arenaObjs = [];
let _smokeParts = null, _smokeVels = null;

function buildArena(r) {
  _arenaObjs.forEach(o => scene.remove(o));
  _arenaObjs = [];
  _smokeParts = null;
  _bigRings = [];
  [rimMesh, wallMesh, floorMesh].forEach(m => { if (m) scene.remove(m); });

  r = r || 480;
  const _mob = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  // ── Combat platform floor (mirror-dark disc) ──────────────────────────────
  floorMesh = new THREE.Mesh(
    new THREE.CircleGeometry(r + 22, 80),
    new THREE.MeshStandardMaterial({
      color: 0x000204, roughness: 0.02, metalness: 1.0, envMapIntensity: 3.0
    })
  );
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = -5.1;
  floorMesh.receiveShadow = true;
  scene.add(floorMesh);

  // Platform underside — glowing cyan slab edge visible from sides
  const undersideRing = new THREE.Mesh(
    new THREE.CylinderGeometry(r + 22, r + 22, 8, 80, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x003344, emissive: 0x00ccff, emissiveIntensity: 1.5,
      roughness: 0.1, metalness: 0.0, side: THREE.BackSide
    })
  );
  undersideRing.position.y = -9;
  scene.add(undersideRing);
  _arenaObjs.push(undersideRing);

  // ── Arena inner wall (combat ring) — nearly invisible in darkness ─────────
  wallMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, 220, 80, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x000608, roughness: 0.7, metalness: 0.5, side: THREE.BackSide
    })
  );
  wallMesh.position.y = 100;
  scene.add(wallMesh);

  // Neon floor rim (bright cyan edge)
  rimMesh = new THREE.Mesh(
    new THREE.TorusGeometry(r + 2, 5, 8, 120),
    new THREE.MeshStandardMaterial({
      color: 0x00f7ff, emissive: 0x00f7ff, emissiveIntensity: 4.0,
      roughness: 0.0, metalness: 0.0
    })
  );
  rimMesh.rotation.x = Math.PI / 2;
  rimMesh.position.y = 1;
  scene.add(rimMesh);

  // Second rim band (inner, narrower)
  const rimInner = new THREE.Mesh(
    new THREE.TorusGeometry(r - 18, 2, 6, 100),
    new THREE.MeshStandardMaterial({
      color: 0x00ccff, emissive: 0x00ccff, emissiveIntensity: 2.5,
      roughness: 0.0, metalness: 0.0
    })
  );
  rimInner.rotation.x = Math.PI / 2;
  rimInner.position.y = 0.5;
  scene.add(rimInner);
  _arenaObjs.push(rimInner);

  // ── Outer structure wall (venue boundary) ─────────────────────────────────
  const OUTER_R = r * 2.2;
  const VENUE_H = 500;

  const outerWall = new THREE.Mesh(
    new THREE.CylinderGeometry(OUTER_R, OUTER_R, VENUE_H, 80, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x000408, roughness: 0.95, metalness: 0.3, side: THREE.BackSide
    })
  );
  outerWall.position.y = VENUE_H / 2 - 100;
  scene.add(outerWall);
  _arenaObjs.push(outerWall);

  // Subtle circuit-line accents on outer wall
  [60, 150, 250].forEach(hy => {
    const s = new THREE.Mesh(
      new THREE.CylinderGeometry(OUTER_R - 1, OUTER_R - 1, 1, 80, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x002244, transparent: true, opacity: 0.7 })
    );
    s.position.y = hy - 100;
    scene.add(s); _arenaObjs.push(s);
  });

  // ── Tiered spectator stands ────────────────────────────────────────────────
  const TIERS = [
    { r0: r + 22,  r1: r + 120, y: -30,  h: 80  },
    { r0: r + 110, r1: r + 250, y: 30,   h: 140 },
    { r0: r + 240, r1: r + 420, y: 110,  h: 200 },
    { r0: r + 410, r1: OUTER_R, y: 220,  h: 160 },
  ];
  const standMat = new THREE.MeshStandardMaterial({ color: 0x000408, roughness: 0.95, metalness: 0.15 });
  TIERS.forEach(({ r0, r1, y, h }) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r1, h, 64, 1, true), standMat);
    m.position.y = y;
    scene.add(m); _arenaObjs.push(m);
    const tf = new THREE.Mesh(
      new THREE.RingGeometry(r0, r1, 64),
      new THREE.MeshStandardMaterial({ color: 0x000305, roughness: 0.98, metalness: 0.05 })
    );
    tf.rotation.x = -Math.PI / 2;
    tf.position.y = y + h / 2;
    scene.add(tf); _arenaObjs.push(tf);
  });

  // ── Crowd particle field ───────────────────────────────────────────────────
  const CROWD = _mob ? 2000 : 5000;
  const cpos = new Float32Array(CROWD * 3), ccol = new Float32Array(CROWD * 3);
  for (let i = 0, ci = 0; i < CROWD; i++, ci += 3) {
    const a = Math.random() * Math.PI * 2;
    const t = TIERS[Math.floor(Math.random() * TIERS.length)];
    const cr = t.r0 + Math.random() * (t.r1 - t.r0);
    const cy = t.y + t.h / 2 + Math.random() * 50;
    cpos[ci] = Math.cos(a) * cr; cpos[ci+1] = cy; cpos[ci+2] = Math.sin(a) * cr;
    const warm = Math.random() < 0.10;
    const bright = 0.75 + Math.random() * 0.25;
    ccol[ci]   = warm ? 1.0 : bright * 0.7;
    ccol[ci+1] = warm ? 0.55 : bright * 0.88;
    ccol[ci+2] = warm ? 0.1  : bright;
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
  cg.setAttribute('color',    new THREE.BufferAttribute(ccol, 3));
  // Larger size so crowd is actually visible from combat platform
  const crowd = new THREE.Points(cg, new THREE.PointsMaterial({ size: 4.5, vertexColors: true, sizeAttenuation: true }));
  scene.add(crowd); _arenaObjs.push(crowd);

  // Crowd silhouette rows — dark humanoid blocks packed into stands
  const SILO_MAT = new THREE.MeshBasicMaterial({ color: 0x001a2a });
  const SILO_GEO = new THREE.BoxGeometry(6, 14, 4);
  const SILO_ROWS = _mob ? 40 : 120;
  for (let i = 0; i < SILO_ROWS; i++) {
    const a = Math.random() * Math.PI * 2;
    const t = TIERS[1 + Math.floor(Math.random() * (TIERS.length - 1))];
    const cr = t.r0 + Math.random() * (t.r1 - t.r0);
    const cy = t.y + t.h / 2 + 8;
    const silo = new THREE.Mesh(SILO_GEO, SILO_MAT);
    silo.position.set(Math.cos(a) * cr, cy, Math.sin(a) * cr);
    silo.rotation.y = a;
    scene.add(silo); _arenaObjs.push(silo);
  }

  // Crowd ambient glow — warm wash from stands area
  const crowdGlow1 = new THREE.PointLight(0x1133aa, 0.7, r * 2.5);
  crowdGlow1.position.set(r * 1.3, 120, 0);
  scene.add(crowdGlow1); _arenaObjs.push(crowdGlow1);
  const crowdGlow2 = new THREE.PointLight(0x1133aa, 0.7, r * 2.5);
  crowdGlow2.position.set(-r * 1.3, 120, 0);
  scene.add(crowdGlow2); _arenaObjs.push(crowdGlow2);

  // ── Venue ceiling ──────────────────────────────────────────────────────────
  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(OUTER_R, 80),
    new THREE.MeshStandardMaterial({ color: 0x000508, roughness: 0.95, metalness: 0.4 })
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = VENUE_H - 100;
  scene.add(ceiling); _arenaObjs.push(ceiling);

  // ── THE BIG RING — iconic TRON scoreboard ring ────────────────────────────
  const BIG_RING_R = r * 1.38;
  const BIG_RING_Y = 210;

  // Structural dark torus
  const bigRingOuter = new THREE.Mesh(
    new THREE.TorusGeometry(BIG_RING_R, 22, 20, 120),
    new THREE.MeshStandardMaterial({ color: 0x000e1c, roughness: 0.3, metalness: 0.98 })
  );
  bigRingOuter.rotation.x = Math.PI / 2;
  bigRingOuter.position.y = BIG_RING_Y;
  scene.add(bigRingOuter); _arenaObjs.push(bigRingOuter);

  // Glowing inner face
  const bigRingGlow = new THREE.Mesh(
    new THREE.TorusGeometry(BIG_RING_R, 9, 14, 120),
    new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xd0eeff, emissiveIntensity: 2.5,
      roughness: 0.0, metalness: 0.0
    })
  );
  bigRingGlow.rotation.x = Math.PI / 2;
  bigRingGlow.position.y = BIG_RING_Y;
  scene.add(bigRingGlow); _arenaObjs.push(bigRingGlow);
  _bigRings.push(bigRingOuter, bigRingGlow);

  // Inner accent ring
  const bigRingInner = new THREE.Mesh(
    new THREE.TorusGeometry(BIG_RING_R * 0.84, 3.5, 8, 100),
    new THREE.MeshStandardMaterial({ color: 0x88bbff, emissive: 0x4488ff, emissiveIntensity: 1.2, roughness: 0, metalness: 0 })
  );
  bigRingInner.rotation.x = Math.PI / 2;
  bigRingInner.position.y = BIG_RING_Y - 3;
  scene.add(bigRingInner); _arenaObjs.push(bigRingInner);

  // Scoreboard panels hanging from ring (8 evenly spaced flat panels)
  for (let i = 0; i < 8; i++) {
    const pa = (i / 8) * Math.PI * 2;
    const px = Math.cos(pa) * BIG_RING_R;
    const pz = Math.sin(pa) * BIG_RING_R;
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(60, 18, 3),
      new THREE.MeshStandardMaterial({
        color: 0x001122, emissive: 0x003366, emissiveIntensity: 0.8,
        roughness: 0.5, metalness: 0.6
      })
    );
    panel.position.set(px, BIG_RING_Y - 30, pz);
    panel.rotation.y = pa + Math.PI / 2;
    scene.add(panel); _arenaObjs.push(panel);
    // Panel border glow
    const border = new THREE.Mesh(
      new THREE.BoxGeometry(62, 20, 1),
      new THREE.MeshStandardMaterial({ color: 0x00aaff, emissive: 0x0066cc, emissiveIntensity: 1.0, roughness: 0, metalness: 0 })
    );
    border.position.copy(panel.position);
    border.rotation.copy(panel.rotation);
    border.position.y -= 0.5;
    scene.add(border); _arenaObjs.push(border);
  }

  // Ring halo light
  const ringLight = new THREE.PointLight(0x88aadd, 0.9, r * 3.5);
  ringLight.position.set(0, BIG_RING_Y, 0);
  scene.add(ringLight); _arenaObjs.push(ringLight);

  // ── Overhead spotlights + god rays ────────────────────────────────────────
  const SPOT_H = BIG_RING_Y - 15;
  const godRayMat = new THREE.MeshBasicMaterial({
    color: 0x6699cc, transparent: true, opacity: 0.04,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
  });

  for (let i = 0; i < 4; i++) {
    const sa = (i / 4) * Math.PI * 2;
    const sx = Math.cos(sa) * r * 0.5, sz = Math.sin(sa) * r * 0.5;
    const spot = new THREE.SpotLight(0xbbddff, 0.8, SPOT_H * 2.5, Math.PI / 11, 0.4, 1.4);
    spot.position.set(sx, SPOT_H, sz);
    spot.target.position.set(-sx * 0.2, 0, -sz * 0.2);
    spot.castShadow = (i === 0);
    if (i === 0) { spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.001; }
    scene.add(spot); scene.add(spot.target);
    _arenaObjs.push(spot); _arenaObjs.push(spot.target);

    const rayH = SPOT_H;
    const rayR = rayH * Math.tan(Math.PI / 11) * 0.9;
    const ray = new THREE.Mesh(new THREE.ConeGeometry(rayR, rayH, 10, 1, true), godRayMat);
    ray.position.set(sx * 0.8, SPOT_H / 2, sz * 0.8);
    scene.add(ray); _arenaObjs.push(ray);
  }

  // ── Arena pods — large floating rectangular panels around combat ring ────────
  // Matches the TRON disc wars arena: dark box pods with glowing cyan edges
  const POD_COUNT = 6;
  const POD_W = r * 0.55, POD_H = r * 0.45, POD_D = 28;
  const POD_R  = r * 1.08;   // radius from center
  const POD_Y  = 60;          // mid-height

  const podBodyMat = new THREE.MeshStandardMaterial({
    color: 0x000d1a, roughness: 0.25, metalness: 0.95, envMapIntensity: 1.5
  });
  const podEdgeMat = new THREE.MeshStandardMaterial({
    color: 0x00ccff, emissive: 0x00aaff, emissiveIntensity: 2.2,
    roughness: 0.0, metalness: 0.0
  });
  const podFaceMat = new THREE.MeshStandardMaterial({
    color: 0x001a2e, emissive: 0x003355, emissiveIntensity: 0.6,
    roughness: 0.4, metalness: 0.7, envMapIntensity: 1.0
  });

  for (let i = 0; i < POD_COUNT; i++) {
    const pa = (i / POD_COUNT) * Math.PI * 2;
    const px = Math.cos(pa) * POD_R;
    const pz = Math.sin(pa) * POD_R;

    const podGroup = new THREE.Group();
    podGroup.position.set(px, POD_Y, pz);
    podGroup.rotation.y = pa + Math.PI / 2;

    // Main body block
    const body = new THREE.Mesh(new THREE.BoxGeometry(POD_W, POD_H, POD_D), podBodyMat);
    podGroup.add(body);

    // Front face panel (slightly inset)
    const face = new THREE.Mesh(new THREE.BoxGeometry(POD_W * 0.88, POD_H * 0.84, 2), podFaceMat);
    face.position.z = POD_D / 2 + 0.5;
    podGroup.add(face);

    // Glowing edge strips — top, bottom, left, right
    const eT = new THREE.Mesh(new THREE.BoxGeometry(POD_W + 4, 3, POD_D + 4), podEdgeMat);
    eT.position.y =  POD_H / 2 + 1; podGroup.add(eT);
    const eB = new THREE.Mesh(new THREE.BoxGeometry(POD_W + 4, 3, POD_D + 4), podEdgeMat);
    eB.position.y = -POD_H / 2 - 1; podGroup.add(eB);
    const eL = new THREE.Mesh(new THREE.BoxGeometry(3, POD_H + 4, POD_D + 4), podEdgeMat);
    eL.position.x = -POD_W / 2 - 1; podGroup.add(eL);
    const eR = new THREE.Mesh(new THREE.BoxGeometry(3, POD_H + 4, POD_D + 4), podEdgeMat);
    eR.position.x =  POD_W / 2 + 1; podGroup.add(eR);

    // Corner accent lines on front face
    const cornerMat = new THREE.MeshBasicMaterial({ color: 0x00eeff });
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx2, sy]) => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(POD_W * 0.12, 2, 2), cornerMat);
      c.position.set(sx2 * POD_W * 0.38, sy * POD_H * 0.42, POD_D / 2 + 1.5);
      podGroup.add(c);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(2, POD_H * 0.12, 2), cornerMat);
      c2.position.set(sx2 * POD_W * 0.44, sy * POD_H * 0.38, POD_D / 2 + 1.5);
      podGroup.add(c2);
    });

    // Inner horizontal data lines on face
    for (let li = 0; li < 4; li++) {
      const ly = -POD_H * 0.28 + li * (POD_H * 0.18);
      const line = new THREE.Mesh(
        new THREE.BoxGeometry(POD_W * 0.7, 1.2, 1),
        new THREE.MeshBasicMaterial({ color: li === 1 ? 0x00ffff : 0x005577 })
      );
      line.position.set(0, ly, POD_D / 2 + 1.5);
      podGroup.add(line);
    }

    // Pod glow light (illuminates the floor around the pod)
    const podLight = new THREE.PointLight(0x0088cc, 0.5, r * 0.7);
    podLight.position.set(0, -20, 0);
    podGroup.add(podLight);

    scene.add(podGroup);
    _arenaObjs.push(podGroup);
  }

  // ── Connecting support struts between pods and outer ring ─────────────────
  for (let i = 0; i < POD_COUNT; i++) {
    const pa = (i / POD_COUNT) * Math.PI * 2;
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x000a18, roughness: 0.5, metalness: 0.9 });
    // Vertical pillar down from pod bottom
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(6, POD_Y, 6), strutMat);
    pillar.position.set(Math.cos(pa) * POD_R, POD_Y / 2 - POD_H / 2, Math.sin(pa) * POD_R);
    scene.add(pillar); _arenaObjs.push(pillar);
  }

  // ── Sub-platform cyan under-glow ──────────────────────────────────────────
  const floorFill = new THREE.PointLight(0x00aaff, 1.8, r * 2.2);
  floorFill.position.set(0, -30, 0);
  scene.add(floorFill); _arenaObjs.push(floorFill);

  const platformGlow = new THREE.PointLight(0x00ddff, 1.4, r * 1.6);
  platformGlow.position.set(0, 15, 0);
  scene.add(platformGlow); _arenaObjs.push(platformGlow);

  // Fill lights at pod level so players are clearly visible
  for (let i = 0; i < 3; i++) {
    const fa = (i / 3) * Math.PI * 2;
    const fill = new THREE.PointLight(0x4488bb, 0.6, r * 1.8);
    fill.position.set(Math.cos(fa) * r * 0.5, 40, Math.sin(fa) * r * 0.5);
    scene.add(fill); _arenaObjs.push(fill);
  }

  // ── VOLUMETRIC SMOKE CLOUD particles around platform ─────────────────────
  const SMOKE_COUNT = _mob ? 500 : 1200;
  const smokePos = new Float32Array(SMOKE_COUNT * 3);
  const smokeAlpha = new Float32Array(SMOKE_COUNT);
  _smokeVels = new Float32Array(SMOKE_COUNT * 3);

  for (let i = 0, ci = 0; i < SMOKE_COUNT; i++, ci += 3) {
    const a = Math.random() * Math.PI * 2;
    const radSpread = r * 0.55 + Math.random() * r * 1.1;
    const hgt = -40 + Math.random() * 260;
    smokePos[ci]   = Math.cos(a) * radSpread;
    smokePos[ci+1] = hgt;
    smokePos[ci+2] = Math.sin(a) * radSpread;
    _smokeVels[ci]   = (Math.random() - 0.5) * 0.08;
    _smokeVels[ci+1] = 0.04 + Math.random() * 0.06;
    _smokeVels[ci+2] = (Math.random() - 0.5) * 0.08;
    smokeAlpha[i] = Math.random();
  }
  const smokeGeo = new THREE.BufferGeometry();
  smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
  const smokeMat = new THREE.PointsMaterial({
    color: 0x1a3a4a,
    size: 90,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    blending: THREE.NormalBlending
  });
  _smokeParts = new THREE.Points(smokeGeo, smokeMat);
  scene.add(_smokeParts);
  _arenaObjs.push(_smokeParts);

  // Second bright smoke layer (additive, cyan tinted, near platform edge)
  const SMOKE2 = _mob ? 150 : 400;
  const s2pos = new Float32Array(SMOKE2 * 3);
  for (let i = 0, ci = 0; i < SMOKE2; i++, ci += 3) {
    const a = Math.random() * Math.PI * 2;
    const ro = r * 0.85 + Math.random() * r * 0.6;
    s2pos[ci]   = Math.cos(a) * ro;
    s2pos[ci+1] = -20 + Math.random() * 140;
    s2pos[ci+2] = Math.sin(a) * ro;
  }
  const s2geo = new THREE.BufferGeometry();
  s2geo.setAttribute('position', new THREE.BufferAttribute(s2pos, 3));
  const smoke2 = new THREE.Points(s2geo, new THREE.PointsMaterial({
    color: 0x004466, size: 55, sizeAttenuation: true,
    transparent: true, opacity: 0.12,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  scene.add(smoke2); _arenaObjs.push(smoke2);
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

  // Pure pitch-black suit — TRON programs are shadows with glowing lines
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.06, metalness: 1.0, envMapIntensity: 2.5
  });
  const armorMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.04, metalness: 1.0, envMapIntensity: 3.0
  });
  // Glowing circuit lines — very bright, feed the bloom pass
  const glowMat = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 1.8,
    roughness: 0.0, metalness: 0.0
  });
  const glowMat2 = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 1.2,
    roughness: 0.0, metalness: 0.0
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: col, emissive: col, emissiveIntensity: 2.2,
    roughness: 0.0, metalness: 0.0, transparent: true, opacity: 0.92
  });

  function add(mesh, x, y, z) { mesh.position.set(x, y, z); group.add(mesh); return mesh; }
  function box(w, h, d, mat)  { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
  function cyl(rt, rb, h, s, mat) { return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, s), mat); }

  // ── BOOTS ────────────────────────────────────────────────────────────────
  for (const ox of [-5, 5]) {
    add(box(7, 5, 9, armorMat),      ox, -13, 0.5);
    add(box(8, 1.5, 10, glowMat),    ox, -10.5, 0.5); // ankle glow band
    add(box(7, 1.5, 9,  glowMat2),   ox, -15.2, 0.5); // toe glow
  }

  // ── LOWER LEGS ───────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-5,-1],[5,1]]) {
    add(box(6, 11, 6, bodyMat),         ox, -4.5, 0);
    add(box(7.5, 2.5, 7.5, armorMat),   ox,  1.5, 0);   // knee cap
    add(box(8.5, 1.5, 8.5, glowMat),    ox,  2.9, 0);   // knee glow ring
    add(box(1.2, 9, 1.2, glowMat2),     ox+sx*2.5, -4, 3.2); // shin stripe
    add(box(1.2, 9, 1.2, glowMat2),     ox-sx*0.5, -4, 3.5); // inner shin stripe
  }

  // ── UPPER LEGS ───────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-5,-1],[5,1]]) {
    add(box(7, 13, 7, bodyMat),       ox, 10.5, 0);
    add(box(8.5, 1.5, 8.5, glowMat),  ox, 17.4, 0);   // hip glow band
    add(box(1.2, 11, 1.2, glowMat2),  ox+sx*2.5, 10.5, 3.5); // outer thigh stripe
  }

  // ── WAIST / PELVIS ────────────────────────────────────────────────────────
  add(box(16, 4, 9, armorMat),   0, 18.5, 0);
  add(box(16, 1.5, 9.5, glowMat), 0, 21.0, 0);   // waist top band
  add(box(16, 1.5, 9.5, glowMat), 0, 16.0, 0);   // waist bottom band
  add(box(1.5, 4, 1.5, glowMat2), 0, 18.5, 5.0); // pelvis front pip

  // ── TORSO ─────────────────────────────────────────────────────────────────
  add(box(15, 17, 8, bodyMat),    0, 29, 0);
  add(box(12, 13, 2, armorMat),   0, 29, 4.5);   // chest plate

  // Vertical spine line
  add(box(1.5, 17, 1.2, glowMat),  0, 29, 5.8);
  // Horizontal chest circuit lines
  add(box(14, 1.5, 1.2, glowMat),  0, 34.5, 5.8);
  add(box(12, 1.5, 1.2, glowMat),  0, 29.5, 5.8);
  add(box(10, 1.5, 1.2, glowMat),  0, 24.5, 5.8);
  // Side torso lines
  add(box(1.2, 12, 1.2, glowMat2), -8.5, 29, 3.5);
  add(box(1.2, 12, 1.2, glowMat2),  8.5, 29, 3.5);

  // Identity core — bright glowing disc on chest
  const coreDisc = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 2.8, 1.0, 24), glowMat);
  coreDisc.rotation.x = Math.PI / 2;
  add(coreDisc, 0, 29, 6.3);
  const coreRing = new THREE.Mesh(new THREE.TorusGeometry(3.6, 0.7, 10, 28), glowMat);
  add(coreRing, 0, 29, 6.0);
  const coreOuter = new THREE.Mesh(new THREE.TorusGeometry(4.8, 0.4, 8, 28), glowMat2);
  add(coreOuter, 0, 29, 5.8);

  // Back spine
  add(box(1.5, 17, 1.2, glowMat),  0, 29, -4.8);
  add(box(12, 1.5, 1.2, glowMat2), 0, 33, -4.8);
  add(box(10, 1.5, 1.2, glowMat2), 0, 26, -4.8);

  // ── SHOULDERS ─────────────────────────────────────────────────────────────
  for (const [ox] of [[-11],[11]]) {
    add(box(7, 6, 10, armorMat),     ox, 35.5, 0);
    add(box(8, 1.5, 11, glowMat),    ox, 38.5, 0);   // shoulder top band
    add(box(8, 1.5, 11, glowMat),    ox, 32.5, 0);   // shoulder bottom band
    add(box(1.5, 6, 1.5, glowMat2),  ox, 35.5, 5.5); // shoulder front pip
  }

  // ── ARMS ──────────────────────────────────────────────────────────────────
  for (const [ox, sx] of [[-10.5,-1],[10.5,1]]) {
    add(box(5.5, 12, 5.5, bodyMat),   ox, 26, 0);
    add(box(6.5, 3, 7, armorMat),     ox, 20, 0);    // elbow
    add(box(7.5, 1.5, 8, glowMat),    ox, 21.8, 0);  // elbow top band
    add(box(7.5, 1.5, 8, glowMat),    ox, 18.2, 0);  // elbow bottom band
    add(box(5, 10, 5, bodyMat),        ox, 13, 0);
    add(box(6, 1.5, 6, glowMat),      ox, 8.5, 0);   // wrist band
    add(box(6, 1.5, 6, glowMat2),     ox, 7.0, 0);   // wrist band 2
    add(box(1.2, 10, 1.2, glowMat2),  ox+sx*2.0, 26, 3.2); // outer arm stripe
    add(box(1.2, 8,  1.2, glowMat2),  ox+sx*2.0, 13, 3.0); // forearm stripe
  }

  // ── NECK ──────────────────────────────────────────────────────────────────
  add(cyl(2.8, 3.5, 5, 8, bodyMat), 0, 39.5, 0);
  add(new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.5, 8, 20), glowMat2), 0, 37.5, 0);

  // ── HELMET ────────────────────────────────────────────────────────────────
  const helmetBase = new THREE.Mesh(new THREE.SphereGeometry(7.8, 22, 16), armorMat);
  helmetBase.scale.set(0.95, 0.88, 1.02);
  add(helmetBase, 0, 48, 0);

  // Helmet circuit lines
  add(box(1.5, 8, 1.5, glowMat),   0, 54, 5.5);    // top fin
  for (const ox of [-7, 7]) {
    add(box(1.2, 11, 1.2, glowMat2), ox, 49, 2.5); // side lines
  }
  // Helmet back band
  add(box(12, 1.5, 1.5, glowMat2), 0, 54.5, -3);

  // Visor — full colored bright slit (the most iconic TRON feature)
  const visorMesh = box(14, 3.5, 3, visorMat);
  add(visorMesh, 0, 48.2, 7.2);
  // Inner visor core — pure white hot center
  add(box(10, 2, 1.2, new THREE.MeshStandardMaterial({
    color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.5,
    roughness: 0, metalness: 0
  })), 0, 48.2, 8.6);

  // ── IDENTITY DISC (on back) ───────────────────────────────────────────────
  const discBody = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 2.5, 32), armorMat);
  discBody.rotation.x = Math.PI / 2;
  add(discBody, 0, 30, -9);

  const discRim = new THREE.Mesh(new THREE.TorusGeometry(9, 1.5, 10, 40), glowMat);
  add(discRim, 0, 30, -9);

  const discMid = new THREE.Mesh(new THREE.TorusGeometry(6, 0.8, 8, 32), glowMat2);
  add(discMid, 0, 30, -9.5);

  const discCenter = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 1, 20), glowMat);
  discCenter.rotation.x = Math.PI / 2;
  add(discCenter, 0, 30, -10.5);

  // ── CHARACTER POINT LIGHT — circuit lines illuminate the floor ────────────
  const bodyLight = new THREE.PointLight(col, 0.8, 90);
  bodyLight.position.set(0, 20, 0);
  group.add(bodyLight);

  // Visor light — colored beam forward from face
  const visorLight = new THREE.SpotLight(col, 1.0, 80, Math.PI / 5, 0.6, 2.0);
  visorLight.position.set(0, 48, 8);
  visorLight.target.position.set(0, 20, 80);
  group.add(visorLight);
  group.add(visorLight.target);

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
  const emitMat = c => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 3.0, roughness: 0, metalness: 0 });

  // Dark metallic body
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(11, 11, 2.2, 40),
    new THREE.MeshStandardMaterial({ color: 0x000810, roughness: 0.02, metalness: 1.0, envMapIntensity: 3.0 })
  );
  group.add(body);

  // Outer rim — brightest
  const rim = new THREE.Mesh(new THREE.TorusGeometry(11, 1.8, 10, 48), emitMat(col));
  rim.rotation.x = Math.PI / 2;
  group.add(rim);

  // Mid ring
  const mid = new THREE.Mesh(new THREE.TorusGeometry(7.5, 0.9, 8, 36), emitMat(col));
  mid.rotation.x = Math.PI / 2;
  group.add(mid);
  group.userData.midRing = mid;

  // Inner ring (counter-rotates)
  const inner = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.6, 8, 28), emitMat(col));
  inner.rotation.x = Math.PI / 2;
  group.add(inner);
  group.userData.innerRing = inner;

  // White-hot center core
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(2.2, 2.2, 0.8, 20),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 5.0, roughness: 0, metalness: 0 })
  );
  group.add(core);

  // Disc PointLight — illuminates floor and players as it flies
  const dLight = new THREE.PointLight(col, 3.0, 200);
  group.add(dLight);
  group.userData.dLight = dLight;

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

// ── Disc trail ────────────────────────────────────────────────────────────
function getOrMakeTrail(ownerId, color) {
  if (discTrails[ownerId]) return discTrails[ownerId];
  const positions = new Float32Array(TRAIL_LEN * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: new THREE.Color(color), size: 16, sizeAttenuation: true,
    transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  scene.add(pts);
  discTrails[ownerId] = { pts, positions, head: 0 };
  return discTrails[ownerId];
}

function updateTrail(ownerId, x, y, z, color) {
  const t = getOrMakeTrail(ownerId, color);
  const ci = t.head * 3;
  t.positions[ci] = x; t.positions[ci+1] = y; t.positions[ci+2] = z;
  t.head = (t.head + 1) % TRAIL_LEN;
  t.pts.geometry.attributes.position.needsUpdate = true;
  t.pts.visible = true;
}

function hideTrail(ownerId) { if (discTrails[ownerId]) discTrails[ownerId].pts.visible = false; }

function removeTrail(ownerId) {
  if (!discTrails[ownerId]) return;
  scene.remove(discTrails[ownerId].pts);
  delete discTrails[ownerId];
}

// ── Derezz explosion ──────────────────────────────────────────────────────
function spawnDerezzEffect(sx, sz, color) {
  const col = new THREE.Color(color);
  const COUNT = 80;
  const pos = new Float32Array(COUNT * 3);
  const vel = [];
  for (let i = 0; i < COUNT; i++) {
    pos[i*3]   = sx + (Math.random()-0.5)*12;
    pos[i*3+1] = 5  + Math.random()*35;
    pos[i*3+2] = sz + (Math.random()-0.5)*12;
    vel.push({ vx:(Math.random()-0.5)*220, vy:30+Math.random()*160, vz:(Math.random()-0.5)*220 });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: col, size: 8, sizeAttenuation: true,
    transparent: true, opacity: 1.0, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  scene.add(pts);
  const flash = new THREE.PointLight(col, 5.0, 300);
  flash.position.set(sx, 25, sz);
  scene.add(flash);
  activeExplosions.push({ pts, pos, vel, flash, age: 0, dur: 1.4 });
  _shakeAmp = Math.max(_shakeAmp, 3.5);
}

function animateExplosions(dt) {
  for (let i = activeExplosions.length - 1; i >= 0; i--) {
    const e = activeExplosions[i];
    e.age += dt;
    const t = e.age / e.dur;
    if (t >= 1) { scene.remove(e.pts); scene.remove(e.flash); activeExplosions.splice(i, 1); continue; }
    const pa = e.pts.geometry.attributes.position;
    for (let j = 0; j < e.vel.length; j++) {
      pa.array[j*3]   += e.vel[j].vx * dt;
      pa.array[j*3+1] += e.vel[j].vy * dt - 120 * dt * t;
      pa.array[j*3+2] += e.vel[j].vz * dt;
    }
    pa.needsUpdate = true;
    e.pts.material.opacity = 1 - t;
    e.flash.intensity = 5.0 * (1 - t * t);
  }
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

// ── Mobile virtual controls ────────────────────────────────────────────────
const mobileAxes = { x: 0, y: 0 };
let _isTouchDevice = false;

function setupMobileControls() {
  _isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  const mc = document.getElementById('mobileControls');
  if (!_isTouchDevice) return;
  mc.classList.add('active');
  document.getElementById('lockMsg').style.display = 'none';

  const joyZone = document.getElementById('joyZone');
  const joyKnob = document.getElementById('joyKnob');
  const lookZone = document.getElementById('lookZone');
  const lookRipple = document.getElementById('lookRipple');
  const JOY_R = 45;
  let joyId = null, joyOriginX = 0, joyOriginY = 0;
  let lookId = null, lookLastX = 0, lookLastY = 0;

  joyZone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    joyId = t.identifier;
    const rect = joyZone.getBoundingClientRect();
    joyOriginX = t.clientX - rect.left;
    joyOriginY = t.clientY - rect.top;
  }, { passive: false });

  joyZone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      const rect = joyZone.getBoundingClientRect();
      let dx = t.clientX - rect.left - joyOriginX;
      let dy = t.clientY - rect.top  - joyOriginY;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist > JOY_R) { dx = dx/dist*JOY_R; dy = dy/dist*JOY_R; }
      joyKnob.style.left = (45 + dx) + 'px';
      joyKnob.style.top  = (45 + dy) + 'px';
      mobileAxes.x = dx / JOY_R;
      mobileAxes.y = dy / JOY_R;
    }
  }, { passive: false });

  const endJoy = e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      joyId = null;
      joyKnob.style.left = '45px'; joyKnob.style.top = '45px';
      mobileAxes.x = 0; mobileAxes.y = 0;
    }
  };
  joyZone.addEventListener('touchend', endJoy);
  joyZone.addEventListener('touchcancel', endJoy);

  // Look zone — drag to rotate camera
  lookZone.addEventListener('touchstart', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (lookId !== null) return;
    lookId = t.identifier;
    lookLastX = t.clientX; lookLastY = t.clientY;
    lookRipple.style.display = 'block';
    lookRipple.style.left = t.clientX + 'px';
    lookRipple.style.top  = t.clientY + 'px';
  }, { passive: false });

  lookZone.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = t.clientX - lookLastX;
      const dy = t.clientY - lookLastY;
      lookLastX = t.clientX; lookLastY = t.clientY;
      const sens = 0.005;
      yaw   -= dx * sens;
      pitch -= dy * sens;
      pitch  = Math.max(-0.55, Math.min(0.55, pitch));
      myFacingX = -Math.sin(yaw);
      myFacingZ = -Math.cos(yaw);
      socket.emit('setFacing', { fx: myFacingX, fy: myFacingZ });
      lookRipple.style.left = t.clientX + 'px';
      lookRipple.style.top  = t.clientY + 'px';
    }
  }, { passive: false });

  const endLook = e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      lookId = null;
      lookRipple.style.display = 'none';
    }
  };
  lookZone.addEventListener('touchend', endLook);
  lookZone.addEventListener('touchcancel', endLook);

  // Action buttons
  document.getElementById('btnThrow').addEventListener('touchstart', e => {
    e.preventDefault(); doThrowDisc();
  }, { passive: false });

  document.getElementById('btnDodge').addEventListener('touchstart', e => {
    e.preventDefault();
    socket.emit('dodge'); Audio.dodge();
  }, { passive: false });

  const blockBtn = document.getElementById('btnBlock');
  blockBtn.addEventListener('touchstart', e => {
    e.preventDefault(); socket.emit('blockStart');
  }, { passive: false });
  blockBtn.addEventListener('touchend',   e => { e.preventDefault(); socket.emit('blockEnd'); }, { passive: false });
  blockBtn.addEventListener('touchcancel',e => { e.preventDefault(); socket.emit('blockEnd'); }, { passive: false });
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
  // Mobile joystick — y axis = forward/backward, x axis = strafe
  if (mobileAxes.x !== 0 || mobileAxes.y !== 0) {
    vx += fwX * (-mobileAxes.y) + stX * mobileAxes.x;
    vy += fwZ * (-mobileAxes.y) + stZ * mobileAxes.x;
  }

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
  let cx = s.x, cy = EYE_H, cz = s.z;
  if (_shakeAmp > 0.05) {
    cx += (Math.random()-0.5) * _shakeAmp;
    cy += (Math.random()-0.5) * _shakeAmp * 0.4;
    cz += (Math.random()-0.5) * _shakeAmp;
    _shakeAmp *= 0.80;
  }
  camera.position.set(cx, cy, cz);
}

// ── Update scene from server state ────────────────────────────────────────
let _discRot = 0;
function updateScene() {
  _discRot += 0.07;
  const seenDiscs = new Set();

  Object.values(players).forEach(p => {
    const group = getOrMakePlayerMesh(p.id, p.color, p.id === myId);

    if (p.id === myId) {
      const s = toScene(p.x, p.y);
      group.position.set(s.x, 0, s.z);

      if (p.hasDisc) {
        seenDiscs.add(p.id);
        const dm = getOrMakeDiscMesh(p.id, p.color);
        dm.visible = true;
        dm.position.set(s.x + Math.cos(yaw) * 12, EYE_H - 12, s.z - Math.sin(yaw) * 12);
        dm.rotation.y = _discRot;
        if (dm.userData.midRing)   dm.userData.midRing.rotation.z   =  _discRot * 1.3;
        if (dm.userData.innerRing) dm.userData.innerRing.rotation.z = -_discRot * 2.1;
        hideTrail(p.id);
      }
      if (p.disc) {
        seenDiscs.add(p.id);
        const ds = toScene(p.disc.x, p.disc.y);
        const dm = getOrMakeDiscMesh(p.id, p.color);
        dm.visible = true;
        dm.position.set(ds.x, DISC_FLY_H, ds.z);
        dm.rotation.y = _discRot;
        if (dm.userData.midRing)   dm.userData.midRing.rotation.z   =  _discRot * 1.3;
        if (dm.userData.innerRing) dm.userData.innerRing.rotation.z = -_discRot * 2.1;
        // pulse disc light
        if (dm.userData.dLight) dm.userData.dLight.intensity = 2.5 + Math.sin(_discRot * 8) * 0.5;
        updateTrail(p.id, ds.x, DISC_FLY_H, ds.z, p.color);
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
      dm.visible = true;
      dm.position.set(s.x + Math.cos(angle) * 10, 22, s.z - Math.sin(angle) * 10);
      dm.rotation.y = _discRot;
      if (dm.userData.midRing)   dm.userData.midRing.rotation.z   =  _discRot * 1.3;
      if (dm.userData.innerRing) dm.userData.innerRing.rotation.z = -_discRot * 2.1;
      hideTrail(p.id);
    } else if (p.disc) {
      seenDiscs.add(p.id);
      const ds = toScene(p.disc.x, p.disc.y);
      const dm = getOrMakeDiscMesh(p.id, p.color);
      dm.visible = true;
      dm.position.set(ds.x, DISC_FLY_H, ds.z);
      dm.rotation.y = _discRot;
      if (dm.userData.midRing)   dm.userData.midRing.rotation.z   =  _discRot * 1.3;
      if (dm.userData.innerRing) dm.userData.innerRing.rotation.z = -_discRot * 2.1;
      if (dm.userData.dLight) dm.userData.dLight.intensity = 2.5 + Math.sin(_discRot * 8) * 0.5;
      updateTrail(p.id, ds.x, DISC_FLY_H, ds.z, p.color);
    }
  });

  Object.keys(playerMeshes).forEach(id => { if (!players[id]) removePlayerMesh(id); });
  Object.keys(discMeshes).forEach(id => {
    if (!seenDiscs.has(id)) { discMeshes[id].visible = false; hideTrail(id); }
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
let _lastTs = 0;
function gameLoop(ts) {
  animId = requestAnimationFrame(gameLoop);
  const dt = Math.min((ts - _lastTs) / 1000, 0.05); _lastTs = ts;
  sendInput();
  updateCamera();
  updateScene();
  animateTiles(ts);
  animateArena(ts);
  animateExplosions(dt);
  if (composer) composer.render(); else renderer.render(scene, camera);
}

// Animate emissive neon — breathing, flicker, and smoke drift
function animateArena(ts) {
  const t = ts * 0.001;
  // Rim slow pulse
  if (rimMesh && rimMesh.material.emissive) {
    rimMesh.material.emissiveIntensity = 3.0 + 0.8 * Math.sin(t * 1.1);
  }
  // Occasional neon flicker
  if (_arenaObjs.length && Math.random() < 0.004) {
    const strips = _arenaObjs.filter(o => o.isMesh && o.material && o.material.emissive);
    if (strips.length) {
      const s = strips[Math.floor(Math.random() * strips.length)];
      const base = s.material.emissiveIntensity;
      s.material.emissiveIntensity = base * (0.3 + Math.random() * 0.4);
      setTimeout(() => { if (s.material) s.material.emissiveIntensity = base; }, 60 + Math.random() * 80);
    }
  }
  // Animate smoke particles
  if (_smokeParts && _smokeVels) {
    const pos = _smokeParts.geometry.attributes.position;
    const n = pos.count;
    const r = arenaInfo.radius || 480;
    for (let i = 0, ci = 0; i < n; i++, ci += 3) {
      pos.array[ci]   += _smokeVels[ci];
      pos.array[ci+1] += _smokeVels[ci+1];
      pos.array[ci+2] += _smokeVels[ci+2];
      // reset if too high or too far
      if (pos.array[ci+1] > 280 || Math.sqrt(pos.array[ci]*pos.array[ci]+pos.array[ci+2]*pos.array[ci+2]) > r * 1.8) {
        const a = Math.random() * Math.PI * 2;
        const ro = r * 0.55 + Math.random() * r * 1.0;
        pos.array[ci]   = Math.cos(a) * ro;
        pos.array[ci+1] = -30 + Math.random() * 40;
        pos.array[ci+2] = Math.sin(a) * ro;
      }
    }
    pos.needsUpdate = true;
    // Slowly rotate the whole smoke field
    _smokeParts.rotation.y += 0.0003;
  }
  // Slowly rotate the big ring overhead
  _bigRings.forEach(m => { m.rotation.z += 0.00028; });
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
    const s = toScene(p.x, p.y);
    spawnDerezzEffect(s.x, s.z, p.color);
    spawnBodyMesh({ x: p.x, y: p.y, color: p.color });
  }
  addKillFeed(killerName || 'VOID', p?.name || id);
  if (id === myId && pointerLocked) document.exitPointerLock();
});

socket.on('discThrown', ({ playerId }) => {
  if (playerId !== myId) { Audio.throwDisc(); _shakeAmp = Math.max(_shakeAmp, 0.6); }
});
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

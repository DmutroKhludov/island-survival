/* ====================================================================
   Островок — ламповая выживалка (3D, мультяшная, тёплые тона)
   Three.js + toon-шейдинг. Логика выживания сохранена, рендер — 3D.
==================================================================== */

import * as THREE from 'three';

const VW = 896, VH = 576;

// ---- Утилиты ----
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const choice = arr => arr[(Math.random() * arr.length) | 0];
const dist2 = (ax, az, bx, bz) => { const dx = ax-bx, dz = az-bz; return dx*dx+dz*dz; };

/* ====================================================================
   Псевдошум для рельефа острова (детерминированный)
==================================================================== */
const SEED = Math.random() * 1000;
function hash(x, z) {
  let h = Math.sin((x * 127.1 + z * 311.7 + SEED) ) * 43758.5453;
  return h - Math.floor(h);
}
function valueNoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf*xf*(3-2*xf), v = zf*zf*(3-2*zf);
  const a = hash(xi, zi), b = hash(xi+1, zi);
  const c = hash(xi, zi+1), d = hash(xi+1, zi+1);
  return lerp(lerp(a,b,u), lerp(c,d,u), v);
}
function fbm(x, z) {
  let f = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < 3; i++) { f += valueNoise(x*freq, z*freq) * amp; amp *= 0.5; freq *= 2; }
  return f;
}

// Аналитическая высота рельефа (метры). Вода на y = 0.
const ISLAND_R = 58;
function terrainHeight(x, z) {
  const d = Math.hypot(x, z) / ISLAND_R;       // 0 центр … 1 берег
  const dome = Math.max(0, 1 - d * d);          // купол суши
  const hills = fbm(x * 0.05 + 10, z * 0.05 + 10);
  let h = dome * 9 + hills * 4 * dome - 1.8;    // края уходят под воду
  return h;
}

/* ====================================================================
   Состояние игры
==================================================================== */
const game = {
  running: false,
  entities: [],
  player: null,         // { obj, x, z, hp, food, energy, warm, ... }
  near: null,
  time: 6 * 60,
  day: 1,
  inventory: {},
  hotbar: ['campfire', 'berry', null, null, null],
  activeSlot: 0,
};

const DAY_MINUTES = 24 * 60;
const GAME_MIN_PER_SEC = 10;

/* ====================================================================
   Предметы и рецепты
==================================================================== */
const ITEMS = {
  wood:     { name: 'Дерево',  icon: '🪵' },
  stone:    { name: 'Камень',  icon: '🪨' },
  berry:    { name: 'Ягоды',   icon: '🫐', food: 14, stam: 12 },
  fish:     { name: 'Рыба',    icon: '🐟', food: 8,  stam: 4 },
  cookedfish:{ name: 'Жареная рыба', icon: '🍤', food: 30, stam: 10 },
  fiber:    { name: 'Волокно', icon: '🌾' },
  campfire: { name: 'Костёр',  icon: '🔥', placeable: 'campfire' },
  axe:      { name: 'Топор',   icon: '🪓', tool: true },
  rod:      { name: 'Удочка',  icon: '🎣', tool: true },
  backpack: { name: 'Рюкзак',  icon: '🎒', equip: true },
};

const BAG_SLOTS = 16, PACK_SLOTS = 12;

const RECIPES = [
  { id: 'campfire', out: 'campfire', icon: '🔥', name: 'Костёр',
    cost: { wood: 5, stone: 3 }, desc: 'Тепло и свет в ночи. Можно жарить рыбу.' },
  { id: 'axe', out: 'axe', icon: '🪓', name: 'Топор',
    cost: { wood: 3, stone: 2 }, desc: 'Рубит деревья вдвое быстрее.', once: true },
  { id: 'rod', out: 'rod', icon: '🎣', name: 'Удочка',
    cost: { wood: 3, fiber: 4 }, desc: 'Ловить рыбу у воды.', once: true },
  { id: 'backpack', out: 'backpack', icon: '🎒', name: 'Рюкзак',
    cost: { fiber: 8, wood: 4 }, desc: '+12 слотов в инвентаре.', once: true },
];

/* ====================================================================
   THREE: сцена, камера, свет
==================================================================== */
let renderer, scene, camera, sun, hemi, ambient;
let waterMesh, waterGeo, waterBaseY;
const groundY = 0;

// тёплая мультяшная палитра
const PALETTE = {
  trunk:  0x9c6b3f,
  foliage:[0x9ec96a, 0x86bb56, 0xb6d77a],
  rock:   0xb9a48c,
  bush:   0x7fae54,
  berry:  0x7b5cd6,
  sand:   0xf2d9a0,
  grass:  0x97c25e,
  grassHi:0xb4d57a,
  water:  0x57c4c0,
  skinTop:0xf2c79c,
  shirt:  0xe2733b,
  pants:  0x4f6d8a,
};

// toon-материал (мультяшная заливка)
function toon(color, opts = {}) {
  return new THREE.MeshToonMaterial(Object.assign({ color }, opts));
}

function initThree() {
  const mount = document.getElementById('game');
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(VW, VH);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  mount.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffe2b0);
  scene.fog = new THREE.Fog(0xffe2b0, 60, 165);

  camera = new THREE.PerspectiveCamera(52, VW / VH, 0.1, 400);

  // солнце (тёплое), мягкая тень
  sun = new THREE.DirectionalLight(0xffd9a0, 1.15);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 80;
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  // тёплый «небо/земля» свет + лёгкий ambient, чтобы ночь была уютной
  hemi = new THREE.HemisphereLight(0xffe9c4, 0x6b5238, 0.65);
  scene.add(hemi);
  ambient = new THREE.AmbientLight(0xffd9b0, 0.25);
  scene.add(ambient);

  setupControls();
}

/* ====================================================================
   Генерация острова (рельеф + объекты)
==================================================================== */
let terrainMesh;
function buildTerrain() {
  const SEG = 120, SIZE = ISLAND_R * 2.4;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = [];
  const cGrass = new THREE.Color(PALETTE.grass);
  const cGrassHi = new THREE.Color(PALETTE.grassHi);
  const cSand = new THREE.Color(PALETTE.sand);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    let h = terrainHeight(x, z);
    pos.setY(i, h);
    let c;
    if (h < 0.6) c = cSand;
    else c = cGrass.clone().lerp(cGrassHi, clamp((h - 1) / 7, 0, 1));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshToonMaterial({ vertexColors: true });
  terrainMesh = new THREE.Mesh(geo, mat);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);

  // подводное песчаное «дно», чтобы за берегом не было пусто
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ISLAND_R * 1.5, 48).rotateX(-Math.PI/2),
    toon(0xdcc28a)
  );
  floor.position.y = -3;
  floor.receiveShadow = true;
  scene.add(floor);
}

function buildWater() {
  waterGeo = new THREE.PlaneGeometry(600, 600, 60, 60);
  waterGeo.rotateX(-Math.PI / 2);
  waterBaseY = 0.18;
  const mat = new THREE.MeshStandardMaterial({
    color: PALETTE.water, transparent: true, opacity: 0.86,
    roughness: 0.35, metalness: 0.0,
  });
  waterMesh = new THREE.Mesh(waterGeo, mat);
  waterMesh.position.y = waterBaseY;
  waterMesh.receiveShadow = false;
  scene.add(waterMesh);
}

/* ---- Меши объектов ---- */
function makeTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.42, 2.4, 6),
    toon(PALETTE.trunk)
  );
  trunk.position.y = 1.2; trunk.castShadow = true;
  g.add(trunk);
  const fol = toon(choice(PALETTE.foliage));
  const blobs = [[0, 3.1, 0, 1.6], [-0.9, 2.5, 0.3, 1.1], [0.9, 2.6, -0.2, 1.05], [0.1, 3.7, 0.1, 1.0]];
  for (const [bx, by, bz, br] of blobs) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(br, 0), fol);
    m.position.set(bx, by, bz); m.castShadow = true;
    g.add(m);
  }
  return g;
}
function makeRock() {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95, 0), toon(PALETTE.rock));
  m.scale.set(rand(0.8,1.3), rand(0.6,0.9), rand(0.8,1.3));
  m.rotation.set(rand(0,3), rand(0,3), rand(0,3));
  m.position.y = 0.45; m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  return g;
}
function makeBush(berries) {
  const g = new THREE.Group();
  const mat = toon(PALETTE.bush);
  for (const [bx,by,bz,br] of [[0,0.55,0,0.75],[-0.5,0.4,0.2,0.55],[0.5,0.42,-0.15,0.55]]) {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(br,0), mat);
    m.position.set(bx,by,bz); m.castShadow = true;
    g.add(m);
  }
  const berryMat = toon(PALETTE.berry);
  g.userData.berryMeshes = [];
  for (let i = 0; i < 4; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), berryMat);
    b.position.set(rand(-0.5,0.5), rand(0.4,0.8), rand(-0.4,0.4));
    g.add(b); g.userData.berryMeshes.push(b);
  }
  setBushBerries(g, berries);
  return g;
}
function setBushBerries(g, n) {
  g.userData.berryMeshes.forEach((b, i) => b.visible = i < n);
}
function makeGrassTuft() {
  const g = new THREE.Group();
  const mat = toon(0x8fb85a);
  for (let i = 0; i < 3; i++) {
    const blade = new THREE.Mesh(new THREE.ConeGeometry(0.08, rand(0.5,0.8), 4), mat);
    blade.position.set(rand(-0.2,0.2), 0.3, rand(-0.2,0.2));
    blade.rotation.z = rand(-0.3,0.3);
    g.add(blade);
  }
  return g;
}

function makeCampfire() {
  const g = new THREE.Group();
  const stoneMat = toon(0x8d8378);
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    const st = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22,0), stoneMat);
    st.position.set(Math.cos(a)*0.6, 0.15, Math.sin(a)*0.6);
    st.castShadow = true; g.add(st);
  }
  const logMat = toon(PALETTE.trunk);
  for (let i = 0; i < 3; i++) {
    const lg = new THREE.Mesh(new THREE.CylinderGeometry(0.1,0.1,0.9,5), logMat);
    lg.rotation.z = Math.PI/2; lg.rotation.y = i * 1.0;
    lg.position.y = 0.18; g.add(lg);
  }
  // пламя
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 0.9, 7),
    new THREE.MeshBasicMaterial({ color: 0xffa53a })
  );
  flame.position.y = 0.7;
  g.add(flame);
  const flame2 = new THREE.Mesh(
    new THREE.ConeGeometry(0.17, 0.55, 7),
    new THREE.MeshBasicMaterial({ color: 0xffe27a })
  );
  flame2.position.y = 0.62;
  g.add(flame2);
  // свет костра
  const light = new THREE.PointLight(0xffa040, 0, 16, 1.6);
  light.position.y = 1.0;
  g.add(light);
  g.userData.flame = flame; g.userData.flame2 = flame2; g.userData.light = light;
  return g;
}

/* ---- Сущности ---- */
function addEntity(type, x, z, opts = {}) {
  const gh = terrainHeight(x, z);
  let obj, e;
  if (type === 'tree')      { obj = makeTree(); e = { r: 1.0, hp: 3, solid: true, sway: rand(0,6.28) }; }
  else if (type === 'rock') { obj = makeRock(); e = { r: 0.9, hp: 3, solid: true }; }
  else if (type === 'bush') { const b = opts.berries ?? 4; obj = makeBush(b); e = { r: 0.8, hp: 2, solid: false, berries: b, regrow: 0 }; }
  else if (type === 'grass'){ obj = makeGrassTuft(); e = { r: 0.4, hp: 1, solid: false }; }
  else if (type === 'campfire') { obj = makeCampfire(); e = { r: 0.9, solid: false, fuel: 60, lit: true, sway: rand(0,6.28) }; }
  obj.position.set(x, gh, z);
  obj.rotation.y = rand(0, Math.PI * 2);
  scene.add(obj);
  const ent = Object.assign({ type, x, z, obj }, e);
  game.entities.push(ent);
  return ent;
}

function removeEntity(e) {
  scene.remove(e.obj);
  e.obj.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
  const i = game.entities.indexOf(e);
  if (i >= 0) game.entities.splice(i, 1);
  if (game.near === e) game.near = null;
}

function scatterWorld() {
  // деревья / камни / кусты на суше
  let placed = 0, tries = 0;
  const want = { tree: 130, rock: 55, bush: 70, grass: 90 };
  const counts = { tree: 0, rock: 0, bush: 0, grass: 0 };
  while (tries < 4000 && placed < 330) {
    tries++;
    const x = rand(-ISLAND_R, ISLAND_R), z = rand(-ISLAND_R, ISLAND_R);
    const h = terrainHeight(x, z);
    if (h < 0.8) continue;                          // не на воде/пляже-кромке
    // выбираем тип по высоте
    let type;
    const r = Math.random();
    if (h > 1.5 && r < 0.42 && counts.tree < want.tree) type = 'tree';
    else if (r < 0.58 && counts.rock < want.rock) type = 'rock';
    else if (r < 0.82 && counts.bush < want.bush) type = 'bush';
    else if (counts.grass < want.grass) type = 'grass';
    else continue;
    // не ставим вплотную к другим solid
    let ok = true;
    if (type === 'tree' || type === 'rock') {
      for (const o of game.entities) {
        if (o.solid && dist2(x, z, o.x, o.z) < 4) { ok = false; break; }
      }
    }
    if (!ok) continue;
    addEntity(type, x, z);
    counts[type]++; placed++;
  }
}

/* ====================================================================
   Игрок (3D-модель)
==================================================================== */
function makePlayerModel() {
  const g = new THREE.Group();
  // ноги
  const legMat = toon(PALETTE.pants);
  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 0.4, 3, 6), legMat);
  legL.position.set(-0.2, 0.45, 0); legL.castShadow = true;
  const legR = legL.clone(); legR.position.x = 0.2;
  g.add(legL, legR);
  // тело
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.5, 4, 8), toon(PALETTE.shirt));
  body.position.y = 1.15; body.castShadow = true;
  g.add(body);
  // руки
  const armMat = toon(PALETTE.skinTop);
  const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.45, 3, 6), armMat);
  armL.position.set(-0.46, 1.15, 0); armL.castShadow = true;
  const armR = armL.clone(); armR.position.x = 0.46;
  g.add(armL, armR);
  // голова
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 12), toon(PALETTE.skinTop));
  head.position.y = 1.85; head.castShadow = true;
  g.add(head);
  // волосы
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.36, 12, 12, 0, Math.PI*2, 0, Math.PI*0.55), toon(0x6b452a));
  hair.position.y = 1.9;
  g.add(hair);
  g.userData = { legL, legR, armL, armR, body };
  return g;
}

function findSpawn() {
  // ищем хорошую траву ближе к центру
  for (let r = 4; r < ISLAND_R; r += 3) {
    for (let a = 0; a < 360; a += 25) {
      const x = Math.cos(a*Math.PI/180) * r, z = Math.sin(a*Math.PI/180) * r;
      if (terrainHeight(x, z) > 2) return { x, z };
    }
  }
  return { x: 0, z: 0 };
}

function initPlayer() {
  const sp = findSpawn();
  const obj = makePlayerModel();
  scene.add(obj);
  game.player = {
    obj, x: sp.x, z: sp.z, dir: 0,
    speed: 7.5, moving: false,
    hp: 100, food: 100, energy: 100, warm: 100,
    swing: 0, step: 0,
  };
  obj.position.set(sp.x, terrainHeight(sp.x, sp.z), sp.z);
}

/* ====================================================================
   Камера от третьего лица + управление мышью
==================================================================== */
const camCtl = { yaw: Math.PI * 0.25, pitch: 0.62, dist: 13, dragging: false, px: 0, py: 0 };
function setupControls() {
  const el = renderer.domElement;
  el.addEventListener('mousedown', e => { camCtl.dragging = true; camCtl.px = e.clientX; camCtl.py = e.clientY; });
  window.addEventListener('mouseup', () => camCtl.dragging = false);
  window.addEventListener('mousemove', e => {
    if (!camCtl.dragging) return;
    camCtl.yaw   -= (e.clientX - camCtl.px) * 0.005;
    camCtl.pitch  = clamp(camCtl.pitch - (e.clientY - camCtl.py) * 0.004, 0.2, 1.2);
    camCtl.px = e.clientX; camCtl.py = e.clientY;
  });
  el.addEventListener('wheel', e => {
    e.preventDefault();
    camCtl.dist = clamp(camCtl.dist + Math.sign(e.deltaY) * 1.2, 7, 22);
  }, { passive: false });
}

function updateCamera() {
  const p = game.player;
  const tx = p.x, ty = terrainHeight(p.x, p.z) + 1.6, tz = p.z;
  const cp = Math.cos(camCtl.pitch), sp = Math.sin(camCtl.pitch);
  const ox = Math.sin(camCtl.yaw) * cp * camCtl.dist;
  const oz = Math.cos(camCtl.yaw) * cp * camCtl.dist;
  const oy = sp * camCtl.dist;
  camera.position.set(tx + ox, ty + oy, tz + oz);
  camera.lookAt(tx, ty - 0.5, tz);
}

/* ====================================================================
   Ввод (по физкоду — работает в любой раскладке)
==================================================================== */
const keys = {};
function codeToKey(e) {
  const c = e.code;
  if (c.startsWith('Key'))   return c.slice(3).toLowerCase();
  if (c.startsWith('Digit')) return c.slice(5);
  if (c.startsWith('Arrow')) return c.toLowerCase();
  if (c === 'Space')         return ' ';
  return e.key.toLowerCase();
}
window.addEventListener('keydown', e => {
  const k = codeToKey(e);
  if (['arrowup','arrowdown','arrowleft','arrowright',' '].includes(k)) e.preventDefault();
  if (!keys[k]) onKeyPress(k);
  keys[k] = true;
});
window.addEventListener('keyup', e => { keys[codeToKey(e)] = false; });

function onKeyPress(k) {
  if (!game.running) return;
  if (k === ' ' || k === 'e') doAction();
  if (k === 'c') toggleCraft();
  if (k === 'i') toggleBag();
  if (k >= '1' && k <= '9') {
    const i = +k - 1;
    if (i < game.hotbar.length) { game.activeSlot = i; useHotbar(i); renderInventory(); }
  }
}

/* ====================================================================
   Движение
==================================================================== */
function isWater(x, z) { return terrainHeight(x, z) < 0.25; }
function blocked(x, z) {
  if (isWater(x, z)) return true;
  for (const e of game.entities) {
    if (e.solid && dist2(x, z, e.x, e.z) < (e.r + 0.5) ** 2) return true;
  }
  return false;
}

function movePlayer(dt) {
  const p = game.player;
  let ix = 0, iz = 0;
  if (keys['w'] || keys['arrowup'])    iz += 1;
  if (keys['s'] || keys['arrowdown'])  iz -= 1;
  if (keys['a'] || keys['arrowleft'])  ix -= 1;
  if (keys['d'] || keys['arrowright']) ix += 1;
  p.moving = (ix || iz) !== 0;

  if (p.moving) {
    // направления относительно камеры (по горизонтали)
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0,1,0)).normalize();
    const mv = new THREE.Vector3()
      .addScaledVector(fwd, iz).addScaledVector(right, ix);
    if (mv.lengthSq() > 0) mv.normalize();

    const sp = p.speed * (p.energy < 12 ? 0.55 : 1) * dt;
    const nx = p.x + mv.x * sp, nz = p.z + mv.z * sp;
    if (!blocked(nx, p.z)) p.x = nx;
    if (!blocked(p.x, nz)) p.z = nz;

    p.dir = Math.atan2(mv.x, mv.z);
    p.step += sp * 2.2;
  }

  // позиция и поворот модели
  const gh = terrainHeight(p.x, p.z);
  const bob = p.moving ? Math.abs(Math.sin(p.step * 2)) * 0.12 : 0;
  p.obj.position.set(p.x, gh + bob, p.z);
  // плавный поворот к направлению движения
  let dy = p.dir - p.obj.rotation.y;
  while (dy > Math.PI) dy -= Math.PI*2;
  while (dy < -Math.PI) dy += Math.PI*2;
  p.obj.rotation.y += dy * 0.2;

  animatePlayerLimbs(p);
}

function animatePlayerLimbs(p) {
  const u = p.obj.userData;
  if (!u) return;
  const sw = p.moving ? Math.sin(p.step * 2) * 0.6 : 0;
  u.legL.rotation.x = sw; u.legR.rotation.x = -sw;
  u.armL.rotation.x = -sw; u.armR.rotation.x = sw;
  // замах
  if (p.swing > 0) {
    u.armR.rotation.x = -1.4 * (p.swing / 12);
    p.swing -= 0.7;
  }
}

/* ====================================================================
   Действия
==================================================================== */
function updateNear() {
  const p = game.player;
  let best = null, bestD = 3.0 * 3.0;
  for (const e of game.entities) {
    const d = dist2(p.x, p.z, e.x, e.z);
    if (d < bestD) { best = e; bestD = d; }
  }
  if (!best) {
    // вода впереди для рыбалки
    const fx = p.x + Math.sin(p.dir) * 2.2, fz = p.z + Math.cos(p.dir) * 2.2;
    if (isWater(fx, fz) && (game.inventory.rod | 0) > 0) {
      game.near = 'water'; showPrompt('🎣 Пробел — рыбачить'); return;
    }
  }
  game.near = best;
  if (best) showPrompt(promptFor(best)); else hidePrompt();
}

function promptFor(e) {
  const hasAxe = (game.inventory.axe | 0) > 0;
  switch (e.type) {
    case 'tree': return `${hasAxe?'🪓':'✊'} Пробел — рубить дерево`;
    case 'rock': return '✊ Пробел — добыть камень';
    case 'bush': return e.berries > 0 ? '🫐 Пробел — собрать ягоды' : '🫐 Ягоды созревают…';
    case 'grass': return '🌾 Пробел — собрать волокно';
    case 'campfire':
      return (game.inventory.fish|0) > 0 ? '🍤 Пробел — пожарить рыбу' : '🔥 Пробел — подкинуть дров';
  }
  return '';
}

function doAction() {
  const p = game.player;
  if (p.energy < 4) { log('Слишком устал…'); return; }
  if (game.near === 'water') { fish(); return; }
  if (!game.near) { log('Тут нечего делать.'); return; }
  const e = game.near;

  if (e.type === 'campfire') { interactCampfire(e); return; }

  p.swing = 12;
  const hasAxe = (game.inventory.axe | 0) > 0;

  if (e.type === 'tree') {
    e.hp -= hasAxe ? 2 : 1;
    p.energy -= 3;
    popEntity(e);
    if (e.hp <= 0) {
      give('wood', (rand(2,4)|0) + 2);
      if (Math.random() < 0.5) give('fiber', 1);
      removeEntity(e); log('🪵 Срубил дерево');
    }
  } else if (e.type === 'rock') {
    e.hp -= 1; p.energy -= 4; popEntity(e);
    if (e.hp <= 0) { give('stone', (rand(2,4)|0)+1); removeEntity(e); log('🪨 Добыл камень'); }
  } else if (e.type === 'bush') {
    if (e.berries > 0) {
      give('berry', e.berries); log(`🫐 Собрал ягоды (${e.berries})`);
      e.berries = 0; setBushBerries(e.obj, 0); e.regrow = 70; p.energy -= 1;
    } else log('Ягоды ещё не созрели.');
  } else if (e.type === 'grass') {
    give('fiber', (rand(1,3)|0)); removeEntity(e); p.energy -= 1; log('🌾 Собрал волокно');
  }
}

// анимация «удара» — короткий подскок объекта
function popEntity(e) {
  e.obj.userData.pop = 1;
}

function interactCampfire(fire) {
  if ((game.inventory.fish|0) > 0 && fire.lit) {
    game.inventory.fish--; give('cookedfish', 1); log('🍤 Пожарил рыбу'); renderInventory(); return;
  }
  if ((game.inventory.wood|0) > 0) {
    game.inventory.wood--; fire.fuel = Math.min(fire.fuel + 25, 120); fire.lit = true;
    log('🔥 Подкинул дров в костёр'); renderInventory(); return;
  }
  log('Нужны дрова, чтобы поддержать огонь.');
}

function fish() {
  if ((game.inventory.rod|0) === 0) { log('Нужна удочка 🎣'); return; }
  const p = game.player; p.energy -= 3; p.swing = 10;
  if (Math.random() < 0.55) { give('fish', 1); log('🐟 Поймал рыбу!'); }
  else log('…рыба сорвалась.');
}

/* ====================================================================
   Инвентарь / крафт
==================================================================== */
function hasBackpack() { return (game.inventory.backpack | 0) > 0; }
function capacity() { return BAG_SLOTS + (hasBackpack() ? PACK_SLOTS : 0); }
function stackCount() {
  return Object.keys(game.inventory).filter(k => k !== 'backpack' && (game.inventory[k]|0) > 0).length;
}
function give(item, n = 1) {
  n = Math.max(1, n | 0);
  if (item !== 'backpack' && (game.inventory[item]|0) === 0 && stackCount() >= capacity()) {
    log('🎒 Инвентарь переполнен!'); return false;
  }
  game.inventory[item] = (game.inventory[item]|0) + n;
  renderInventory(); return true;
}
function hasCost(cost) { return Object.entries(cost).every(([k,v]) => (game.inventory[k]|0) >= v); }
function pay(cost) { Object.entries(cost).forEach(([k,v]) => game.inventory[k] -= v); }

function craft(recipe) {
  if (recipe.once && (game.inventory[recipe.out]|0) > 0) { log('Уже есть.'); return; }
  if (!hasCost(recipe.cost)) { log('Не хватает ресурсов.'); return; }
  pay(recipe.cost); give(recipe.out, 1);
  log(`Сделано: ${ITEMS[recipe.out].icon} ${ITEMS[recipe.out].name}`);
  renderCraft();
}

function useHotbar(i) { useItem(game.hotbar[i]); }
function useItem(item) {
  if (!item || (game.inventory[item]|0) === 0) return;
  const def = ITEMS[item];
  if (def.placeable) placeItem(item);
  else if (def.food) {
    game.inventory[item]--;
    game.player.food = clamp(game.player.food + def.food, 0, 100);
    if (def.stam) game.player.energy = clamp(game.player.energy + def.stam, 0, 100);
    const st = def.stam ? ` ⚡+${def.stam}` : '';
    log(`Съел ${def.icon} ${def.name} (🍖+${def.food}${st})`);
    renderStats(); renderInventory();
  }
}

function placeItem(item) {
  const p = game.player;
  const x = p.x + Math.sin(p.dir) * 2.0, z = p.z + Math.cos(p.dir) * 2.0;
  if (isWater(x, z)) { log('Сюда не поставить.'); return; }
  game.inventory[item]--;
  if (item === 'campfire') { addEntity('campfire', x, z); log('🔥 Развёл костёр'); }
  renderInventory();
}

/* ====================================================================
   Время / статы / мир
==================================================================== */
function updateTime(dt) {
  game.time += dt * GAME_MIN_PER_SEC;
  if (game.time >= DAY_MINUTES) { game.time -= DAY_MINUTES; game.day++; log(`☀️ Наступил день ${game.day}`); }
}
function daylight() {
  const t = game.time / DAY_MINUTES;
  return clamp(Math.sin((t - 0.25) * Math.PI * 2) * 0.5 + 0.5, 0, 1);
}
function phaseInfo() {
  const m = game.time;
  if (m < 5*60)  return ['🌙 Ночь', true];
  if (m < 8*60)  return ['🌅 Утро', false];
  if (m < 17*60) return ['☀️ День', false];
  if (m < 20*60) return ['🌇 Вечер', false];
  if (m < 22*60) return ['🌆 Сумерки', false];
  return ['🌙 Ночь', true];
}

let statAccum = 0;
function updateStats(dt) {
  const p = game.player;
  statAccum += dt;
  if (statAccum < 1) return;
  statAccum = 0;
  const [, isNight] = phaseInfo();

  p.food = clamp(p.food - 0.6, 0, 100);
  if (p.moving) p.energy = clamp(p.energy - 0.5, 0, 100);
  else p.energy = clamp(p.energy + 0.7, 0, 100);

  const fire = nearestLitFire(p.x, p.z, 5.5);
  if (fire) {
    p.warm = clamp(p.warm + 4, 0, 100);
    if (!p.moving) p.energy = clamp(p.energy + 1.2, 0, 100);
  } else if (isNight) p.warm = clamp(p.warm - 2.2, 0, 100);
  else p.warm = clamp(p.warm + 1.5, 0, 100);

  let dmg = 0;
  if (p.food <= 0) dmg += 1.2;
  if (p.warm <= 0) dmg += 1.5;
  if (dmg > 0) p.hp = clamp(p.hp - dmg, 0, 100);
  else if (p.food > 40 && p.warm > 30) p.hp = clamp(p.hp + 0.4, 0, 100);

  if (p.hp <= 0) endGame(false);
  renderStats();
}
function nearestLitFire(x, z, range) {
  let best = null, bd = range*range;
  for (const e of game.entities) {
    if (e.type === 'campfire' && e.lit) {
      const d = dist2(x, z, e.x, e.z);
      if (d < bd) { best = e; bd = d; }
    }
  }
  return best;
}

function updateWorld(dt, t) {
  for (const e of game.entities) {
    if (e.type === 'campfire') {
      const u = e.obj.userData;
      if (e.lit) {
        e.fuel -= dt * 0.6;
        const fl = Math.sin(t*12 + e.sway) * 0.5 + 0.5;
        u.flame.scale.y = 0.8 + fl*0.5; u.flame.scale.x = 1 + fl*0.15;
        u.flame2.scale.y = 0.8 + (1-fl)*0.5;
        u.flame.visible = u.flame2.visible = true;
        u.light.intensity = 6 + fl * 3;
        if (e.fuel <= 0) { e.lit = false; log('🔥 Костёр погас'); }
      } else {
        u.flame.visible = u.flame2.visible = false; u.light.intensity = 0;
      }
    }
    if (e.type === 'bush' && e.regrow > 0) {
      e.regrow -= dt;
      if (e.regrow <= 0) { e.berries = 4; setBushBerries(e.obj, 4); }
    }
    // лёгкое покачивание деревьев + «удар»-подскок
    if (e.type === 'tree') e.obj.rotation.z = Math.sin(t*1.2 + e.sway) * 0.025;
    if (e.obj.userData.pop > 0) {
      e.obj.userData.pop -= dt * 4;
      const s = 1 + Math.max(0, e.obj.userData.pop) * 0.12;
      e.obj.scale.setScalar(s);
    } else if (e.obj.scale.x !== 1) e.obj.scale.setScalar(1);
  }
}

/* ---- освещение по времени суток (тёплое) ---- */
const colDay = new THREE.Color(0xffe2b0);
const colNight = new THREE.Color(0x2a3a55);
const colDusk = new THREE.Color(0xff9d5c);
const sunDay = new THREE.Color(0xffd9a0);
const sunDusk = new THREE.Color(0xff7e3a);
function updateLighting(t) {
  const L = daylight();                       // 0 ночь … 1 день
  // цвет неба/тумана: ночь→день, с закатным оттенком на стыке
  const sky = colNight.clone().lerp(colDay, L);
  const duskAmount = clamp(1 - Math.abs(L - 0.32) * 4, 0, 1); // полоска на восходе/закате
  sky.lerp(colDusk, duskAmount * 0.5);
  scene.background.copy(sky);
  scene.fog.color.copy(sky);

  sun.intensity = 0.15 + L * 1.05;
  sun.color.copy(sunDay).lerp(sunDusk, duskAmount);
  // солнце движется по дуге
  const ang = (game.time / DAY_MINUTES) * Math.PI * 2 - Math.PI/2;
  sun.position.set(Math.cos(ang) * 60, Math.max(8, Math.sin(ang) * 70 + 10), 25);
  sun.target.position.set(game.player.x, 0, game.player.z);

  hemi.intensity = 0.25 + L * 0.5;
  ambient.intensity = 0.18 + L * 0.12;
}

/* ====================================================================
   HUD (DOM)
==================================================================== */
function renderStats() {
  const p = game.player;
  document.getElementById('bar-hp').style.width = p.hp + '%';
  document.getElementById('bar-food').style.width = p.food + '%';
  document.getElementById('bar-energy').style.width = p.energy + '%';
  document.getElementById('bar-warm').style.width = p.warm + '%';
}
function renderClock() {
  const h = (game.time/60)|0, m = (game.time%60)|0;
  document.getElementById('day-label').textContent = 'День ' + game.day;
  document.getElementById('time-label').textContent =
    String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
  document.getElementById('phase-label').textContent = phaseInfo()[0];
}
function renderInventory() {
  const inv = document.getElementById('inventory');
  inv.innerHTML = '';
  game.hotbar.forEach((item, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (i === game.activeSlot ? ' active' : '');
    slot.innerHTML = `<span class="key">${i+1}</span>`;
    if (item) {
      const c = game.inventory[item] | 0;
      slot.innerHTML += `<span>${ITEMS[item].icon}</span><span class="count">${c}</span>`;
      slot.style.opacity = c === 0 ? .4 : 1;
    }
    slot.onclick = () => { game.activeSlot = i; useHotbar(i); renderInventory(); };
    inv.appendChild(slot);
  });
  autoFillHotbar();
  renderBag();
}
function autoFillHotbar() {
  for (const item of Object.keys(game.inventory)) {
    if (item === 'backpack') continue;
    if ((game.inventory[item]|0) > 0 && !game.hotbar.includes(item)) {
      const free = game.hotbar.indexOf(null);
      if (free >= 0) game.hotbar[free] = item;
    }
  }
}
function renderBag() {
  const items = Object.keys(game.inventory).filter(k => k !== 'backpack' && (game.inventory[k]|0) > 0);
  fillGrid(document.getElementById('bag-grid'), items.slice(0, BAG_SLOTS), BAG_SLOTS);
  const packWrap = document.getElementById('bag-pack');
  if (hasBackpack()) {
    packWrap.classList.remove('hidden');
    fillGrid(document.getElementById('pack-grid'), items.slice(BAG_SLOTS, BAG_SLOTS+PACK_SLOTS), PACK_SLOTS);
  } else packWrap.classList.add('hidden');
}
function fillGrid(el, items, total) {
  el.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const item = items[i];
    const slot = document.createElement('div');
    slot.className = 'slot bag-slot';
    if (item) {
      const c = game.inventory[item] | 0;
      slot.innerHTML = `<span>${ITEMS[item].icon}</span><span class="count">${c}</span>`;
      slot.title = ITEMS[item].name;
      slot.onclick = () => useItem(item);
    }
    el.appendChild(slot);
  }
}
function renderCraft() {
  const list = document.getElementById('craft-list');
  list.innerHTML = '';
  for (const r of RECIPES) {
    const owned = r.once && (game.inventory[r.out]|0) > 0;
    const can = hasCost(r.cost) && !owned;
    const cost = Object.entries(r.cost).map(([k,v]) => `${ITEMS[k].icon}${v}`).join('  ');
    const div = document.createElement('div');
    div.className = 'recipe';
    div.innerHTML = `
      <div class="r-ico">${r.icon}</div>
      <div class="r-body">
        <div class="r-name">${r.name}</div>
        <div class="r-cost">${r.desc}<br>Нужно: ${cost}</div>
      </div>
      <button ${can ? '' : 'disabled'}>${owned ? '✓ есть' : 'Сделать'}</button>`;
    div.querySelector('button').onclick = () => craft(r);
    list.appendChild(div);
  }
}
function toggleCraft() {
  const el = document.getElementById('craft');
  el.classList.toggle('hidden');
  if (!el.classList.contains('hidden')) renderCraft();
}
function toggleBag() {
  const el = document.getElementById('bag');
  el.classList.toggle('hidden');
  if (!el.classList.contains('hidden')) renderBag();
}
function showPrompt(t) { const el = document.getElementById('prompt'); el.textContent = t; el.classList.add('show'); }
function hidePrompt() { document.getElementById('prompt').classList.remove('show'); }
function log(text) {
  const el = document.getElementById('log');
  const m = document.createElement('div'); m.className = 'msg'; m.textContent = text;
  el.appendChild(m); setTimeout(() => m.remove(), 4500);
  while (el.children.length > 5) el.removeChild(el.firstChild);
}

/* ====================================================================
   Цикл
==================================================================== */
let last = 0, clock = 0;
function loop(ts) {
  const dt = Math.min((ts - last) / 1000, 0.05); last = ts; clock += dt;
  if (game.running) {
    movePlayer(dt);
    updateNear();
    updateTime(dt);
    updateStats(dt);
    updateWorld(dt, clock);
    renderClock();
  } else {
    // лёгкое вращение камеры на старте
    camCtl.yaw += dt * 0.08;
  }
  updateLighting(clock);
  updateCamera();
  // анимация воды
  if (waterGeo) {
    const pos = waterGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, Math.sin(x*0.15 + clock*1.3) * 0.12 + Math.cos(z*0.18 + clock) * 0.12);
    }
    pos.needsUpdate = true;
    waterMesh.position.y = waterBaseY;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

/* ====================================================================
   Старт / конец
==================================================================== */
function startGame() {
  // чистим прошлые сущности
  for (const e of [...game.entities]) removeEntity(e);
  game.entities = [];
  scatterWorld();
  if (game.player) { scene.remove(game.player.obj); }
  initPlayer();

  game.inventory = {};
  game.hotbar = ['campfire', 'berry', null, null, null];
  game.activeSlot = 0;
  game.time = 6 * 60; game.day = 1; game.running = true;
  give('wood', 3);
  renderStats(); renderInventory(); renderClock();
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('gameover').classList.add('hidden');
  log('🏝️ Ты на острове. Осмотрись.');
}
function endGame(won) {
  game.running = false;
  const go = document.getElementById('gameover');
  document.getElementById('go-title').textContent = won ? '🌟 Спасён!' : '💀 Конец пути';
  document.getElementById('go-text').innerHTML = won
    ? `Ты продержался ${game.day} дней и дождался корабля.`
    : `Остров оказался суровым. Ты продержался <b>${game.day}</b> ${dayWord(game.day)}.<br>Но волны всё помнят.`;
  go.classList.remove('hidden');
}
function dayWord(n) {
  const a = n%10, b = n%100;
  if (a === 1 && b !== 11) return 'день';
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return 'дня';
  return 'дней';
}

/* ====================================================================
   Загрузка
==================================================================== */
initThree();
buildTerrain();
buildWater();
scatterWorld();
initPlayer();

document.getElementById('start-btn').onclick = startGame;
document.getElementById('restart-btn').onclick = startGame;
requestAnimationFrame(loop);

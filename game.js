/* ====================================================================
   Островок — ламповая выживалка (3D, мультяшная, тёплые тона)
   Three.js + toon-шейдинг. Логика выживания сохранена, рендер — 3D.
==================================================================== */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const VW = 896, VH = 576;

// ---- Утилиты ----
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
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
const BEACH_TOP = 1.2;                          // высота, ниже которой — песок
function terrainHeight(x, z) {
  const d = Math.hypot(x, z) / ISLAND_R;       // 0 центр … 1 берег
  const dome = Math.max(0, 1 - d * d);          // купол суши
  const hills = fbm(x * 0.05 + 10, z * 0.05 + 10);
  let h = dome * 9 + hills * 4 * dome - 1.8;    // края уходят под воду
  // широкий пологий песчаный пляж: в прибрежном кольце сжимаем перепад высот
  const beach = smooth01((d - 0.55) / 0.35);   // 0 в глубине острова → 1 у берега
  h = lerp(h, h * 0.4 + 0.25, beach);
  return h;
}

/* ====================================================================
   Состояние игры
==================================================================== */
const game = {
  running: false,
  entities: [],
  colliders: [],        // невидимые круги-преграды (корпус корабля и т.п.)
  player: null,         // { obj, x, z, hp, food, energy, warm, ... }
  near: null,
  fishing: null,        // состояние мини-игры рыбалки
  time: 6 * 60,
  day: 1,
  inventory: {},
  hotbar: [null, null, null, null, null],
  bagSlots: new Array(16).fill(null),
  packSlots: new Array(12).fill(null),
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
  coconut:  { name: 'Кокос',   icon: '🥥', food: 18, stam: 8 },
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
  scene.add(camera);                 // чтобы предмет-в-руке (ребёнок камеры) рендерился

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

  initHeldItems();
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
    if (h < BEACH_TOP - 0.3) c = cSand;
    else if (h < BEACH_TOP + 0.3) c = cSand.clone().lerp(cGrass, (h - (BEACH_TOP - 0.3)) / 0.6);
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

/* ---- Загрузка моделей-пропов (Kenney pirate kit) ---- */
const gltfLoader = new GLTFLoader();

// находим точку берега вдоль заданного угла (где суша уходит под воду)
function findShore(angleDeg) {
  const a = angleDeg * Math.PI / 180;
  for (let r = 4; r < ISLAND_R + 12; r += 0.5) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (terrainHeight(x, z) < 0.45) return { x, z, a, r };
  }
  return { x: Math.cos(a) * ISLAND_R, z: Math.sin(a) * ISLAND_R, a, r: ISLAND_R };
}

function loadProps() {
  // корабль, севший на мель у берега
  gltfLoader.load('assets/ship-pirate-small.glb', (gltf) => {
    const ship = gltf.scene;
    ship.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        o.material.side = THREE.DoubleSide;   // паруса — тонкая геометрия
      }
    });
    // нормализуем масштаб: самая длинная сторона ≈ 13 единиц
    const box = new THREE.Box3().setFromObject(ship);
    const size = new THREE.Vector3(); box.getSize(size);
    ship.scale.setScalar(13 / Math.max(size.x, size.y, size.z));
    const shore = findShore(35);
    ship.position.set(shore.x, 0.2, shore.z);
    ship.rotation.y = -shore.a + Math.PI / 2;   // носом вдоль берега
    ship.rotation.z = 0.07;                      // лёгкий крен «на мели»
    scene.add(ship);
    game.ship = ship;
    buildShipCollision(ship);
    setupDeck(ship);
    game.shore = shore;
    placePalmsNear();
  }, undefined, (err) => console.error('ship load error', err));
}

// строим коллизию по форме корпуса: цепочка кругов вдоль длинной оси
function buildShipCollision(ship) {
  // локальные габариты без трансформа (единичная модель)
  const p = ship.position.clone(), r = ship.rotation.clone(), s = ship.scale.clone();
  ship.position.set(0,0,0); ship.rotation.set(0,0,0); ship.scale.set(1,1,1);
  ship.updateMatrixWorld(true);
  const local = new THREE.Box3().setFromObject(ship);
  ship.position.copy(p); ship.rotation.copy(r); ship.scale.copy(s);
  ship.updateMatrixWorld(true);

  const size = new THREE.Vector3(); local.getSize(size);
  const center = new THREE.Vector3(); local.getCenter(center);
  const lenAxis = size.x >= size.z ? 'x' : 'z';
  const lenLocal = Math.max(size.x, size.z);
  const widthWorld = Math.min(size.x, size.z) * s.x;
  const rad = Math.max(1.0, widthWorld * 0.4);              // радиус кружков
  const n = Math.max(2, Math.round(lenLocal * s.x / (rad * 1.2)));

  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1) - 0.5) * lenLocal * 0.82;        // вдоль киля (локально)
    const pt = new THREE.Vector3(center.x, 0, center.z);
    if (lenAxis === 'x') pt.x = center.x + t; else pt.z = center.z + t;
    pt.applyMatrix4(ship.matrixWorld);                      // в мировые координаты
    game.colliders.push({ x: pt.x, z: pt.z, r: rad });
  }
}

let palmProto = null;
function placePalmsNear() {
  gltfLoader.load('assets/palm-straight.glb', (gltf) => {
    palmProto = gltf.scene;
    spawnPalms();
  });
}

// диапазон песчаного пляжа вдоль луча (радиусы: вход в песок → кромка воды)
function beachSpan(ang) {
  let rGrass = null, rWater = null;
  for (let r = 8; r < ISLAND_R + 12; r += 0.4) {
    const h = terrainHeight(Math.cos(ang) * r, Math.sin(ang) * r);
    if (rGrass === null && h < BEACH_TOP) rGrass = r;
    if (rGrass !== null && h < 0.32) { rWater = r; break; }
  }
  return { rGrass, rWater };
}

// пальмы — добываемые объекты: рубятся как дерево и роняют кокосы.
// Растут по всему песчаному берегу острова.
function spawnPalms() {
  if (!palmProto) return;
  const N = 16;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2 + rand(-0.16, 0.16);
    const { rGrass, rWater } = beachSpan(ang);
    if (rGrass == null || rWater == null || rWater - rGrass < 1.5) continue;
    const r = lerp(rGrass, rWater, rand(0.2, 0.65));   // на песке, чуть в глубине от воды
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    const gh = terrainHeight(x, z);
    if (gh < 0.35) continue;
    if (!spaceFree(x, z, 2.2)) continue;               // не вплотную к другим объектам
    let nearProp = false;                              // и не внутри корабля
    for (const c of game.colliders)
      if (dist2(x, z, c.x, c.z) < (c.r + 1.4) ** 2) { nearProp = true; break; }
    if (nearProp) continue;
    const palm = palmProto.clone(true);
    palm.traverse(o => { if (o.isMesh) o.castShadow = true; });
    const box = new THREE.Box3().setFromObject(palm);
    const size = new THREE.Vector3(); box.getSize(size);
    const sc = 6 / Math.max(size.x, size.y, size.z);
    palm.scale.setScalar(sc);
    palm.position.set(x, gh, z);
    palm.rotation.y = rand(0, 6.28);
    scene.add(palm);
    const ent = { type: 'palm', x, z, obj: palm, r: 0.7, hp: 4, solid: true,
                  keepGeo: true, baseScale: sc, sway: rand(0, 6.28),
                  coconuts: 2 + (Math.random() * 2 | 0) };
    palm.userData.entity = ent;             // клон делит геометрию — не диспозим её
    game.entities.push(ent);
  }
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
  obj.userData.entity = ent;        // чтобы луч прицела находил сущность по мешу
  game.entities.push(ent);
  return ent;
}

function removeEntity(e) {
  scene.remove(e.obj);
  if (!e.keepGeo) e.obj.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
  const i = game.entities.indexOf(e);
  if (i >= 0) game.entities.splice(i, 1);
  if (game.near === e) game.near = null;
}

// визуальный «след» объекта (с учётом кроны/разброса), чтобы они не налезали
const FOOT = { tree: 2.2, rock: 1.2, bush: 1.0, grass: 0.5, campfire: 1.0 };

// свободно ли место для объекта с footprint footR (круги не должны пересекаться)
function spaceFree(x, z, footR) {
  for (const o of game.entities) {
    const of = FOOT[o.type] ?? o.r;
    if (dist2(x, z, o.x, o.z) < (footR + of) ** 2) return false;
  }
  return true;
}

function scatterWorld() {
  // деревья / камни / кусты на суше
  let placed = 0, tries = 0;
  const want = { tree: 130, rock: 55, bush: 70, grass: 90 };
  const counts = { tree: 0, rock: 0, bush: 0, grass: 0 };
  while (tries < 9000 && placed < 330) {
    tries++;
    const x = rand(-ISLAND_R, ISLAND_R), z = rand(-ISLAND_R, ISLAND_R);
    const h = terrainHeight(x, z);
    if (h < BEACH_TOP + 0.4) continue;              // ничего не растёт на песке/воде
    // выбираем тип по высоте
    let type;
    const r = Math.random();
    if (h > 1.5 && r < 0.42 && counts.tree < want.tree) type = 'tree';
    else if (r < 0.58 && counts.rock < want.rock) type = 'rock';
    else if (r < 0.82 && counts.bush < want.bush) type = 'bush';
    else if (counts.grass < want.grass) type = 'grass';
    else continue;
    // не ставим, если след пересекается с любым уже стоящим объектом
    if (!spaceFree(x, z, FOOT[type])) continue;
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

/* ---- Топор в руке (вид от первого лица) ---- */
function makeAxeModel() {
  const g = new THREE.Group();
  // рукоять
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.62, 6), toon(0x8a5a2b));
  handle.position.y = 0.31;            // низ рукояти (хват) — в начале координат: замах крутится здесь
  g.add(handle);
  // обмотка у основания рукояти
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.13, 6), toon(0x49321f));
  grip.position.y = 0.09;
  g.add(grip);
  // лезвие — выгнутый клин (узнаваемый профиль топора), тонкий по Z
  const blade = new THREE.Shape();
  blade.moveTo(0, -0.085);
  blade.lineTo(0, 0.085);
  blade.lineTo(0.17, 0.135);
  blade.quadraticCurveTo(0.25, 0, 0.17, -0.135);
  blade.lineTo(0, -0.085);
  const bladeGeo = new THREE.ExtrudeGeometry(blade, { depth: 0.05, bevelEnabled: false });
  bladeGeo.translate(0, 0, -0.025);
  const bladeMesh = new THREE.Mesh(bladeGeo, toon(0xb9c0c6, { side: THREE.DoubleSide }));
  bladeMesh.position.set(-0.02, 0.59, 0);
  bladeMesh.scale.x = -1;                 // остриё смотрит к центру (−X)
  g.add(bladeMesh);
  // обух (задняя часть головы) — с внешней стороны
  const poll = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.13, 0.08), toon(0x868d93));
  poll.position.set(0.03, 0.59, 0);
  g.add(poll);
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

// базовая «поза» топора в руке + опорное смещение от камеры
const AXE_BASE_ROT = { x: 0.1, y: -0.2, z: -0.55 };
const AXE_BASE_POS = { x: 0.05, y: -0.4, z: -0.55 };
let heldGroup = null, heldAxe = null;
function initHeldItems() {
  heldGroup = new THREE.Group();
  heldGroup.scale.setScalar(0.55);
  camera.add(heldGroup);                 // крепим к камере → двигается со взглядом
  heldAxe = makeAxeModel();
  heldAxe.rotation.set(AXE_BASE_ROT.x, AXE_BASE_ROT.y, AXE_BASE_ROT.z);
  heldGroup.add(heldAxe);
  heldGroup.visible = false;
}

// показываем топор, если он выбран в хотбаре; анимируем покачивание и замах
function updateHeld() {
  if (!heldGroup) return;
  const p = game.player;
  const show = game.running && p && !menuOpen()
            && game.hotbar[game.activeSlot] === 'axe' && (game.inventory.axe | 0) > 0;
  heldGroup.visible = show;
  if (!show) return;
  const bob = p.moving ? Math.sin(p.step * 2) * 0.014 : 0;
  const sway = p.moving ? Math.cos(p.step) * 0.012 : 0;
  // замах: p.swing 12→0 после удара, плавная дуга «вниз-к-центру»
  const s = clamp(p.swing / 12, 0, 1);
  const chop = Math.sin(s * Math.PI);
  heldGroup.position.set(AXE_BASE_POS.x + sway, AXE_BASE_POS.y + bob, AXE_BASE_POS.z);
  heldAxe.rotation.set(AXE_BASE_ROT.x + chop * 0.35,
                       AXE_BASE_ROT.y,
                       AXE_BASE_ROT.z + chop * 1.25);
}

// место под игрока должно быть на траве и без объектов рядом
function playerSpotFree(x, z) {
  if (terrainHeight(x, z) <= 2) return false;
  for (const o of game.entities) {
    if (o.solid && dist2(x, z, o.x, o.z) < (o.r + 1.2) ** 2) return false;
  }
  for (const c of game.colliders) {
    if (dist2(x, z, c.x, c.z) < (c.r + 1.2) ** 2) return false;
  }
  return true;
}

function findSpawn() {
  // ищем хорошую траву ближе к центру, по спирали, без объектов вплотную
  for (let r = 4; r < ISLAND_R; r += 2) {
    for (let a = 0; a < 360; a += 12) {
      const x = Math.cos(a*Math.PI/180) * r, z = Math.sin(a*Math.PI/180) * r;
      if (playerSpotFree(x, z)) return { x, z };
    }
  }
  return { x: 0, z: 0 };
}

function initPlayer() {
  const sp = findSpawn();
  const obj = makePlayerModel();
  obj.visible = false;            // от первого лица собственное тело не показываем
  scene.add(obj);
  game.player = {
    obj, x: sp.x, z: sp.z, dir: 0,
    y: terrainHeight(sp.x, sp.z), mode: 'ground', ladder: null,
    speed: 7.5, moving: false,
    hp: 100, food: 100, energy: 100, warm: 100,
    swing: 0, step: 0,
  };
  obj.position.set(sp.x, terrainHeight(sp.x, sp.z), sp.z);
}

/* ====================================================================
   Камера от первого лица + захват мыши (Pointer Lock)
==================================================================== */
const EYE_HEIGHT = 1.7;
const camCtl = { yaw: Math.PI * 0.25, pitch: 0.0, locked: false };
function setupControls() {
  const el = renderer.domElement;

  // ЛКМ — действие по тому, на что наведён прицел (и захват курсора)
  el.addEventListener('mousedown', e => {
    if (e.button !== 0 || !game.running) return;
    if (menuOpen()) return;
    doAction();
    try { const r = el.requestPointerLock?.(); if (r && r.catch) r.catch(() => {}); } catch (_) {}
  });
  document.addEventListener('pointerlockchange', () => {
    camCtl.locked = (document.pointerLockElement === el);
  });

  // свободный обзор: камера крутится от ДВИЖЕНИЯ мыши над игрой, без кнопок.
  // При захвате курсора события приходят на сам canvas — тот же обработчик.
  el.addEventListener('mousemove', e => {
    if (!game.running) return;
    const k = camCtl.locked ? 0.0024 : 0.004;
    const mx = clamp(e.movementX || 0, -90, 90);     // отсечь рывки при возврате курсора
    const my = clamp(e.movementY || 0, -90, 90);
    camCtl.yaw  -= mx * k;
    camCtl.pitch = clamp(camCtl.pitch - my * k, -1.35, 1.35);
  });
}

function updateCamera() {
  const p = game.player;
  // покачивание головы при ходьбе
  const bob = (p.moving && game.running) ? Math.sin(p.step * 2) * 0.05 : 0;
  const feet = (p.y !== undefined) ? p.y : terrainHeight(p.x, p.z);
  const ex = p.x, ey = feet + EYE_HEIGHT + bob, ez = p.z;
  camera.position.set(ex, ey, ez);
  const cp = Math.cos(camCtl.pitch);
  const dx = Math.sin(camCtl.yaw) * cp;
  const dy = Math.sin(camCtl.pitch);
  const dz = Math.cos(camCtl.yaw) * cp;
  camera.lookAt(ex + dx, ey + dy, ez + dz);
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
  for (const c of game.colliders) {
    if (dist2(x, z, c.x, c.z) < (c.r + 0.5) ** 2) return true;
  }
  return false;
}

/* ====================================================================
   Лестницы и палуба корабля (лазание + ходьба по палубе)
==================================================================== */
const CLIMB_SPEED = 3.2;          // м/с по лестнице
const LADDER_GRAB = 1.2;          // радиус «захвата» лестницы у основания
const _UP = new THREE.Vector3(0, 1, 0);

function makeLadder(height) {
  const g = new THREE.Group();
  const railMat = toon(0x9c6b3f), rungMat = toon(0x7a5230);
  const railGeo = new THREE.BoxGeometry(0.09, height, 0.09);
  const railL = new THREE.Mesh(railGeo, railMat); railL.position.set(-0.3, height / 2, 0);
  const railR = new THREE.Mesh(railGeo, railMat); railR.position.set(0.3, height / 2, 0);
  g.add(railL, railR);
  const n = Math.max(2, Math.round(height / 0.42));
  const rungGeo = new THREE.BoxGeometry(0.72, 0.08, 0.08);
  for (let i = 0; i <= n; i++) {
    const r = new THREE.Mesh(rungGeo, rungMat);
    r.position.set(0, (i / n) * height, 0.03);
    g.add(r);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// палуба + две лестницы по бортам; вызывается один раз после загрузки корабля
function setupDeck(ship) {
  const box = new THREE.Box3().setFromObject(ship);
  const c = new THREE.Vector3(); box.getCenter(c);
  const ry = ship.rotation.y, deckY = 3.0;
  const cos = Math.cos(ry), sin = Math.sin(ry);
  const c2w = (lx, lz) => ({ x: c.x + lx * cos - lz * sin, z: c.z + lx * sin + lz * cos });
  const D = {
    cx: c.x, cz: c.z, ry, deckY,
    lxMin: -4.7, lxMax: 2.7, lzMin: -2.7, lzMax: 2.7,   // ходимая палуба (локальные оси)
    ladders: [],
  };
  game.deck = D;
  // настройки бортов: lx вдоль киля, baseLz — линия лестницы у борта,
  // deckLz — выход на палубу (внутрь), inset — прижать меш к корпусу
  const cfgs = [
    { lx: 0,  baseLz: 3.2,  deckLz: 2.4,  inset: 0 },     // борт A (у мачты)
    { lx: -2, baseLz: -2.9, deckLz: -2.1, inset: 0.22 },  // борт B (прижата к корпусу)
  ];
  for (const cfg of cfgs) {
    const b = c2w(cfg.lx, cfg.baseLz);   // низ лестницы (борт)
    const t = c2w(cfg.lx, cfg.deckLz);   // точка выхода на палубу
    const baseY = Math.max(0.2, terrainHeight(b.x, b.z));
    let nx = b.x - t.x, nz = b.z - t.z; const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const L = { bx: b.x, bz: b.z, tx: t.x, tz: t.z, nx, nz, baseY, topY: deckY };
    D.ladders.push(L);
    const lad = makeLadder(deckY - baseY + 0.15);
    lad.position.set(b.x - nx * cfg.inset, baseY, b.z - nz * cfg.inset);  // прижать к борту
    lad.rotation.y = ry + Math.PI / 2;   // плоскостью к борту (перекладины горизонтально)
    scene.add(lad);
    L.mesh = lad;
  }
}

function nearestLadder(x, z, maxD) {
  if (!game.deck) return null;
  let best = null, bd = maxD * maxD;
  for (const L of game.deck.ladders) {
    const d = dist2(x, z, L.bx, L.bz);
    if (d < bd) { bd = d; best = L; }
  }
  return best;
}

// за пределами прямоугольника палубы (локальные оси корабля)?
function deckBlocked(x, z) {
  const D = game.deck;
  const dx = x - D.cx, dz = z - D.cz;
  const lx = dx * Math.cos(D.ry) + dz * Math.sin(D.ry);
  const lz = -dx * Math.sin(D.ry) + dz * Math.cos(D.ry);
  return lx < D.lxMin || lx > D.lxMax || lz < D.lzMin || lz > D.lzMax;
}

// движение по лестнице: W — вверх, S — вниз; x,z примагничены к лестнице
function climbMove(p, dt, iz) {
  const L = p.ladder;
  p.x = L.bx; p.z = L.bz;
  p.y = clamp(p.y + iz * CLIMB_SPEED * dt, L.baseY, L.topY);
  p.moving = iz !== 0;
  p.step += Math.abs(iz) * dt * 4;
  if (p.y >= L.topY - 0.03) {            // наверх — шаг на палубу
    p.x = L.tx; p.z = L.tz; p.y = game.deck.deckY; p.mode = 'deck'; p.ladder = null;
  } else if (p.y <= L.baseY + 0.03 && iz < 0) {   // вниз — на землю
    p.y = terrainHeight(p.x, p.z); p.mode = 'ground'; p.ladder = null;
  }
  p.obj.position.set(p.x, p.y, p.z);
  p.obj.rotation.y = p.dir;
  animatePlayerLimbs(p);
}

// на палубе у края лестницы и жмём «вниз» → начать спуск
function tryDescend(p) {
  for (const L of game.deck.ladders) {
    if (dist2(p.x, p.z, L.tx, L.tz) < 1.2 * 1.2 && (keys['s'] || keys['arrowdown'])) {
      p.mode = 'climb'; p.ladder = L; p.x = L.bx; p.z = L.bz; p.y = L.topY - 0.12;
      return;
    }
  }
}

function movePlayer(dt) {
  const p = game.player;
  let ix = 0, iz = 0;
  if (keys['w'] || keys['arrowup'])    iz += 1;
  if (keys['s'] || keys['arrowdown'])  iz -= 1;
  if (keys['a'] || keys['arrowleft'])  ix -= 1;
  if (keys['d'] || keys['arrowright']) ix += 1;
  p.dir = camCtl.yaw;

  if (p.mode === 'climb') { climbMove(p, dt, iz); return; }

  p.moving = (ix || iz) !== 0;
  let nx = p.x, nz = p.z;
  if (p.moving) {
    const fwd = new THREE.Vector3(Math.sin(camCtl.yaw), 0, Math.cos(camCtl.yaw));
    const right = new THREE.Vector3().crossVectors(fwd, _UP).normalize();
    const mv = new THREE.Vector3().addScaledVector(fwd, iz).addScaledVector(right, ix);
    if (mv.lengthSq() > 0) mv.normalize();
    const sp = p.speed * (p.energy < 12 ? 0.55 : 1) * dt;
    nx = p.x + mv.x * sp; nz = p.z + mv.z * sp;
    p.step += sp * 2.2;
  }

  if (p.mode === 'deck') {
    if (!deckBlocked(nx, p.z)) p.x = nx;
    if (!deckBlocked(p.x, nz)) p.z = nz;
    p.y = game.deck.deckY;
    tryDescend(p);
  } else {
    if (!blocked(nx, p.z)) p.x = nx;
    if (!blocked(p.x, nz)) p.z = nz;
    p.y = terrainHeight(p.x, p.z);
    const L = nearestLadder(p.x, p.z, LADDER_GRAB);
    if (L && (keys['w'] || keys['arrowup'])) {     // у основания и жмём вверх → лезем
      p.mode = 'climb'; p.ladder = L; p.x = L.bx; p.z = L.bz; p.y = Math.max(p.y, L.baseY);
    }
  }

  p.obj.position.set(p.x, p.y, p.z);
  p.obj.rotation.y = p.dir;
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
const _raycaster = new THREE.Raycaster();
const _center = new THREE.Vector2(0, 0);   // центр экрана = прицел
const REACH = 5;                           // дальность взаимодействия (м)

// поднимаемся по иерархии меша до сущности игры
function rootEntity(o) {
  while (o) { if (o.userData && o.userData.entity) return o.userData.entity; o = o.parent; }
  return null;
}

// подсказки по лестнице (имеют приоритет; вызывается после updateNear)
function updateLadderPrompt() {
  const p = game.player;
  if (!game.deck || !game.running) return;
  if (p.mode === 'climb') { game.near = null; showPrompt('⬆ W вверх · ⬇ S вниз'); return; }
  if (p.mode === 'deck') {
    for (const L of game.deck.ladders)
      if (dist2(p.x, p.z, L.tx, L.tz) < 1.3 * 1.3) { showPrompt('⬇ S — спуститься'); return; }
    return;
  }
  const L = nearestLadder(p.x, p.z, LADDER_GRAB);
  if (L) showPrompt('⬆ W — взобраться');
}

function updateNear() {
  const p = game.player;
  // во время лазания / на палубе обычные взаимодействия не нужны
  if (p.mode === 'climb' || p.mode === 'deck') {
    game.near = null;
    if (!game.fishing) hidePrompt();
    return;
  }
  _raycaster.setFromCamera(_center, camera);
  _raycaster.far = REACH;

  // лучом проверяем только объекты поблизости (для скорости)
  const R2 = (REACH + 3) ** 2;
  const roots = [];
  for (const e of game.entities) if (dist2(p.x, p.z, e.x, e.z) < R2) roots.push(e.obj);

  let found = null;
  for (const h of _raycaster.intersectObjects(roots, true)) {
    const ent = rootEntity(h.object);
    if (ent) { found = ent; break; }
  }
  if (found) { game.near = found; showPrompt(promptFor(found)); return; }

  // рыбалка: прицел смотрит на воду перед собой (если ещё не рыбачим)
  const fx = p.x + Math.sin(p.dir) * 2.4, fz = p.z + Math.cos(p.dir) * 2.4;
  if (!game.fishing && isWater(fx, fz) && (game.inventory.rod | 0) > 0) {
    game.near = 'water'; showPrompt('🎣 ЛКМ — рыбачить'); return;
  }
  game.near = null;
  if (!game.fishing) hidePrompt();   // во время рыбалки подсказку ведёт updateFishing
}

function promptFor(e) {
  const hasAxe = (game.inventory.axe | 0) > 0;
  switch (e.type) {
    case 'tree': return `${hasAxe?'🪓':'✊'} ЛКМ — рубить дерево`;
    case 'palm': return `${hasAxe?'🪓':'✊'} ЛКМ — срубить пальму`;
    case 'rock': return '✊ ЛКМ — добыть камень';
    case 'bush': return e.berries > 0 ? '🫐 ЛКМ — собрать ягоды' : '🫐 Ягоды созревают…';
    case 'grass': return '🌾 ЛКМ — собрать волокно';
    case 'campfire':
      return (game.inventory.fish|0) > 0 ? '🍤 ЛКМ — пожарить рыбу' : '🔥 ЛКМ — подкинуть дров';
    case 'fishbite': return '🐟 ЛКМ — подсечь!';
  }
  return '';
}

function doAction() {
  const p = game.player;
  // подсечь прыгающую рыбу — мгновенно, без затрат сил
  if (game.near && game.near.type === 'fishbite') { catchFish(game.near); return; }
  if (p.energy < 4) { log('Слишком устал…'); return; }
  if (game.near === 'water') { startFishing(); return; }
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
  } else if (e.type === 'palm') {
    e.hp -= hasAxe ? 2 : 1;
    p.energy -= 3;
    popEntity(e);
    if (e.hp <= 0) {
      const n = e.coconuts, px = e.x, pz = e.z;
      give('wood', (rand(1,3)|0) + 1);
      removeEntity(e);
      log('🌴 Срубил пальму — кокосы упали на землю');
      for (let k = 0; k < n; k++)
        dropPickup('coconut', px + rand(-0.6, 0.6), pz + rand(-0.6, 0.6), 3);
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

/* ---- Рыбалка как мини-игра ---- */
function makeBobber() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), toon(0xe34b4b));
  const bot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), toon(0xf2efe6));
  top.position.y = 0.05; bot.position.y = -0.07; bot.scale.y = 0.6;
  g.add(top, bot);
  return g;
}
function makeFishJumper() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), toon(0x7fbcd6));
  body.scale.set(1.6, 0.85, 0.7);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.32, 6), toon(0x6aa8c4));
  tail.rotation.z = -Math.PI / 2; tail.position.x = -0.52;
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 6), toon(0x20242a));
  eye.position.set(0.3, 0.09, 0.13);
  g.add(body, tail, eye);
  return g;
}

function startFishing() {
  if ((game.inventory.rod | 0) === 0) { log('Нужна удочка 🎣'); return; }
  if (game.fishing) return;
  const p = game.player;
  // ищем воду перед собой (в пределах досягаемости прицела)
  let fx = 0, fz = 0, found = false;
  for (let dd = 2.4; dd <= 4.0; dd += 0.35) {
    const x = p.x + Math.sin(p.dir) * dd, z = p.z + Math.cos(p.dir) * dd;
    if (isWater(x, z)) { fx = x; fz = z; found = true; break; }
  }
  if (!found) { log('Подойди ближе к воде.'); return; }
  p.energy = clamp(p.energy - 2, 0, 100); renderStats();
  const bob = makeBobber(); bob.position.set(fx, 0.2, fz); scene.add(bob);
  game.fishing = { state: 'wait', timer: rand(1.2, 2.8), x: fx, z: fz, bob, fishEnt: null, jumpT: 0, jumps: 3 };
  log('🎣 Закинул удочку… жди поклёвки');
}

function updateFishing(dt, t) {
  const f = game.fishing;
  if (!f) return;
  if (f.state === 'wait') {
    f.bob.position.y = 0.2 + Math.sin(t * 4) * 0.04;
    f.timer -= dt;
    if (f.timer <= 0) startJump(f);
    showPrompt('🎣 Жди поклёвки…');
  } else if (f.state === 'jump') {
    f.jumpT += dt / 1.15;
    if (f.jumpT >= 1) { endJump(f); return; }
    const y = 0.2 + Math.sin(f.jumpT * Math.PI) * 1.4;   // дуга прыжка
    const obj = f.fishEnt.obj;
    obj.position.set(f.x, y, f.z);
    obj.rotation.y = f.dir + Math.PI / 2;
    obj.rotation.z = (f.jumpT - 0.5) * 2.4;               // переворот в воздухе
    // подсказка, пока прицел не на рыбе
    if (game.near !== f.fishEnt) showPrompt('🐟 Лови момент — наведись!');
  }
}

function startJump(f) {
  const fish = makeFishJumper();
  fish.position.set(f.x, 0.2, f.z);
  scene.add(fish);
  const ent = { type: 'fishbite', x: f.x, z: f.z, obj: fish, solid: false };
  fish.userData.entity = ent;
  game.entities.push(ent);
  f.fishEnt = ent; f.dir = game.player.dir; f.jumpT = 0; f.state = 'jump';
  splash(f.x, f.z);
}

function endJump(f) {
  removeFishEnt(f);
  f.jumps--;
  if (f.jumps <= 0) { log('…рыба сорвалась.'); endFishing(); }
  else { f.state = 'wait'; f.timer = rand(0.5, 1.1); }
}

function removeFishEnt(f) {
  if (f.fishEnt) { removeEntity(f.fishEnt); f.fishEnt = null; }
}

function endFishing() {
  const f = game.fishing;
  if (!f) return;
  removeFishEnt(f);
  if (f.bob) scene.remove(f.bob);
  game.fishing = null;
  hidePrompt();
}

function catchFish() {
  splash(game.fishing?.x ?? game.player.x, game.fishing?.z ?? game.player.z);
  give('fish', 1);
  log('🐟 Поймал рыбу!');
  endFishing();
}

// маленький всплеск из частиц-«брызг»
function splash(x, z) {
  const mat = toon(0xbfe6ea);
  for (let i = 0; i < 8; i++) {
    const drop = new THREE.Mesh(new THREE.SphereGeometry(0.06, 5, 5), mat);
    drop.position.set(x, 0.2, z);
    const a = rand(0, 6.28), sp = rand(0.6, 1.4);
    drop.userData.v = { x: Math.cos(a) * sp, y: rand(1.5, 2.8), z: Math.sin(a) * sp, life: 1 };
    scene.add(drop);
    splashDrops.push(drop);
  }
}
const splashDrops = [];
function updateSplash(dt) {
  for (let i = splashDrops.length - 1; i >= 0; i--) {
    const d = splashDrops[i], v = d.userData.v;
    d.position.x += v.x * dt; d.position.z += v.z * dt;
    d.position.y += v.y * dt; v.y -= 9 * dt;
    v.life -= dt * 1.4;
    if (v.life <= 0 || d.position.y < 0.1) { scene.remove(d); splashDrops.splice(i, 1); }
  }
}

/* ---- Упавшие предметы (кокосы): лежат на земле, подбираются при подходе ---- */
function makeCoconut() {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), toon(0x7a4a28));
  shell.castShadow = true;
  g.add(shell);
  const spot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), toon(0xc8a06a));
  spot.position.set(0.08, 0.12, 0.05);
  g.add(spot);
  return g;
}
const pickups = [];
function dropPickup(item, x, z, fromY) {
  const obj = makeCoconut();
  obj.position.set(x, fromY, z);
  scene.add(obj);
  const a = rand(0, 6.28), spd = rand(0.7, 1.7);
  pickups.push({ obj, item, x, z, y: fromY,
    vx: Math.cos(a) * spd, vz: Math.sin(a) * spd, vy: rand(1.5, 3),
    landed: false, bob: rand(0, 6.28) });
}
// хватит ли места под предмет (чтобы не спамить «переполнено» у лежащего кокоса)
function canTake(item) {
  if (findItemSlot(item)) return true;
  if (game.hotbar.includes(null) || game.bagSlots.includes(null)) return true;
  if (hasBackpack() && game.packSlots.includes(null)) return true;
  return false;
}
function updatePickups(dt, t) {
  const p = game.player;
  for (let i = pickups.length - 1; i >= 0; i--) {
    const d = pickups[i];
    if (!d.landed) {
      d.x += d.vx * dt; d.z += d.vz * dt;
      d.y += d.vy * dt; d.vy -= 9 * dt;
      const gh = terrainHeight(d.x, d.z) + 0.22;
      if (d.y <= gh) { d.y = gh; d.landed = true; }
      d.obj.position.set(d.x, d.y, d.z);
      d.obj.rotation.x += dt * 5; d.obj.rotation.z += dt * 4;
    } else {
      const gh = terrainHeight(d.x, d.z) + 0.24;
      d.obj.position.y = gh + Math.sin(t * 3 + d.bob) * 0.06;   // мягкое покачивание
      d.obj.rotation.y += dt * 1.4;
      if (game.running && p && dist2(p.x, p.z, d.x, d.z) < 1.6 * 1.6 && canTake(d.item)) {
        give(d.item, 1);
        log(`${ITEMS[d.item].icon} Подобрал ${ITEMS[d.item].name}`);
        removePickup(i);
      }
    }
  }
}
function removePickup(i) {
  const d = pickups[i];
  scene.remove(d.obj);
  d.obj.traverse(o => { if (o.geometry) o.geometry.dispose?.(); });
  pickups.splice(i, 1);
}
function clearPickups() {
  for (let i = pickups.length - 1; i >= 0; i--) removePickup(i);
}

/* ====================================================================
   Инвентарь / крафт
==================================================================== */
function hasBackpack() { return (game.inventory.backpack | 0) > 0; }

function findItemSlot(item) {
  let i = game.hotbar.indexOf(item);
  if (i >= 0) return { arr: 'hotbar', idx: i };
  i = game.bagSlots.indexOf(item);
  if (i >= 0) return { arr: 'bag', idx: i };
  i = game.packSlots.indexOf(item);
  if (i >= 0) return { arr: 'pack', idx: i };
  return null;
}
function getSlotArray(name) {
  if (name === 'hotbar') return game.hotbar;
  if (name === 'bag') return game.bagSlots;
  return game.packSlots;
}
function cleanupSlots() {
  const clean = arr => { for (let i = 0; i < arr.length; i++) if (arr[i] && (game.inventory[arr[i]]|0) <= 0) arr[i] = null; };
  clean(game.hotbar); clean(game.bagSlots); clean(game.packSlots);
}

function give(item, n = 1) {
  n = Math.max(1, n | 0);
  if (item === 'backpack') {
    game.inventory[item] = (game.inventory[item]|0) + n;
    renderInventory(); return true;
  }
  if (!findItemSlot(item)) {
    let placed = false, fi;
    fi = game.hotbar.indexOf(null);
    if (fi >= 0) { game.hotbar[fi] = item; placed = true; }
    if (!placed) { fi = game.bagSlots.indexOf(null); if (fi >= 0) { game.bagSlots[fi] = item; placed = true; } }
    if (!placed && hasBackpack()) { fi = game.packSlots.indexOf(null); if (fi >= 0) { game.packSlots[fi] = item; placed = true; } }
    if (!placed) { log('🎒 Инвентарь переполнен!'); return false; }
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
    // лёгкое покачивание деревьев/пальм + «удар»-подскок
    if (e.type === 'tree' || e.type === 'palm') e.obj.rotation.z = Math.sin(t*1.2 + e.sway) * 0.025;
    const base = e.baseScale || 1;
    if (e.obj.userData.pop > 0) {
      e.obj.userData.pop -= dt * 4;
      const s = base * (1 + Math.max(0, e.obj.userData.pop) * 0.12);
      e.obj.scale.setScalar(s);
    } else if (e.obj.scale.x !== base) e.obj.scale.setScalar(base);
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
let dragSource = null;

function setupSlotDrag(el, arrName, idx) {
  const arr = getSlotArray(arrName);
  const item = arr[idx];
  if (item && (game.inventory[item]|0) > 0) el.draggable = true;
  el.addEventListener('dragstart', e => {
    const it = getSlotArray(arrName)[idx];
    if (!it || (game.inventory[it]|0) <= 0) { e.preventDefault(); return; }
    dragSource = { arr: arrName, idx };
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); dragSource = null; });
  el.addEventListener('dragover', e => { if (dragSource) { e.preventDefault(); el.classList.add('drag-over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => {
    e.preventDefault(); el.classList.remove('drag-over');
    if (!dragSource) return;
    const sArr = getSlotArray(dragSource.arr), dArr = getSlotArray(arrName);
    const tmp = sArr[dragSource.idx]; sArr[dragSource.idx] = dArr[idx]; dArr[idx] = tmp;
    dragSource = null;
    renderInventory();
  });
}

function renderInventory() {
  cleanupSlots();
  const inv = document.getElementById('inventory');
  inv.innerHTML = '';
  game.hotbar.forEach((item, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (i === game.activeSlot ? ' active' : '');
    slot.innerHTML = `<span class="key">${i+1}</span>`;
    if (item && (game.inventory[item]|0) > 0) {
      const c = game.inventory[item] | 0;
      slot.innerHTML += `<span>${ITEMS[item].icon}</span><span class="count">${c}</span>`;
    }
    setupSlotDrag(slot, 'hotbar', i);
    slot.onclick = () => { game.activeSlot = i; useHotbar(i); renderInventory(); };
    inv.appendChild(slot);
  });
  renderBag();
}

function renderBag() {
  fillGrid(document.getElementById('bag-grid'), 'bag', BAG_SLOTS);
  const packWrap = document.getElementById('bag-pack');
  if (hasBackpack()) {
    packWrap.classList.remove('hidden');
    fillGrid(document.getElementById('pack-grid'), 'pack', PACK_SLOTS);
  } else packWrap.classList.add('hidden');
}
function fillGrid(el, arrName, total) {
  const slots = getSlotArray(arrName);
  el.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const item = slots[i];
    const slot = document.createElement('div');
    slot.className = 'slot bag-slot';
    if (item && (game.inventory[item]|0) > 0) {
      const c = game.inventory[item] | 0;
      slot.innerHTML = `<span>${ITEMS[item].icon}</span><span class="count">${c}</span>`;
      slot.title = ITEMS[item].name;
      slot.onclick = () => useItem(item);
    }
    setupSlotDrag(slot, arrName, i);
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
  if (!el.classList.contains('hidden')) { renderCraft(); document.exitPointerLock(); }
  updateCursor();
}
function toggleBag() {
  const el = document.getElementById('bag');
  el.classList.toggle('hidden');
  if (!el.classList.contains('hidden')) { renderBag(); document.exitPointerLock(); }
  updateCursor();
}

// открыто ли какое-либо окно (крафт/инвентарь)
function menuOpen() {
  return !document.getElementById('craft').classList.contains('hidden')
      || !document.getElementById('bag').classList.contains('hidden');
}

// курсор скрыт во время игры (свободный обзор) и виден, когда открыто меню
function updateCursor() {
  renderer.domElement.style.cursor = (game.running && !menuOpen()) ? 'none' : 'default';
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
    updateLadderPrompt();
    updateFishing(dt, clock);
    updateTime(dt);
    updateStats(dt);
    updateWorld(dt, clock);
    updateSplash(dt);
    updatePickups(dt, clock);
    renderClock();
  } else {
    // лёгкое вращение камеры на старте
    camCtl.yaw += dt * 0.08;
  }
  updateLighting(clock);
  updateCamera();
  updateHeld();
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
  endFishing();
  clearPickups();
  for (const e of [...game.entities]) removeEntity(e);
  game.entities = [];
  scatterWorld();
  if (palmProto) spawnPalms();
  if (game.player) { scene.remove(game.player.obj); }
  initPlayer();

  game.inventory = {};
  game.hotbar = [null, null, null, null, null];
  game.bagSlots = new Array(BAG_SLOTS).fill(null);
  game.packSlots = new Array(PACK_SLOTS).fill(null);
  game.activeSlot = 0;
  game.time = 6 * 60; game.day = 1; game.running = true;
  give('wood', 3);
  renderStats(); renderInventory(); renderClock();
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('gameover').classList.add('hidden');
  updateCursor();
  log('🏝️ Ты на острове. Осмотрись.');
}
function endGame(won) {
  game.running = false;
  updateCursor();
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
loadProps();
initPlayer();

document.getElementById('start-btn').onclick = startGame;
document.getElementById('restart-btn').onclick = startGame;
requestAnimationFrame(loop);

// debug-хуки (для отладки в превью)
window.__dbg = { game, camCtl, startGame, THREE, blocked, get camera() { return camera; }, updateNear, doAction, startFishing, terrainHeight, dropPickup, get pickups() { return pickups; },
  get heldGroup() { return heldGroup; }, get heldAxe() { return heldAxe; }, AXE_BASE_ROT, AXE_BASE_POS,
  get deck() { return game.deck; } };

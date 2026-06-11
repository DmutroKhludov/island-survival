const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = 3001;
const SEED = Math.random() * 1000;
const players = new Map();
const harvested = [];          // id уничтоженных объектов (для опоздавших игроков)
const drops = new Map();       // pid -> { pid, item, count, x, z } — выброшенные мешки
const placed = [];             // поставленные объекты (костры): { objType, x, z, id, rot }
let nextId = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.glb':  'model/gltf-binary',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const filePath = path.resolve(__dirname, '.' + url);
  if (!filePath.startsWith(path.resolve(__dirname))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = nextId++;
  players.set(id, { ws, x: 0, z: 0, y: 0, dir: 0, moving: false });

  const existing = [];
  for (const [pid, p] of players) {
    if (pid !== id) existing.push({ id: pid, x: p.x, z: p.z, y: p.y, dir: p.dir, moving: p.moving });
  }
  ws.send(JSON.stringify({ type: 'init', id, seed: SEED, players: existing, harvested, drops: [...drops.values()], placed }));
  broadcast({ type: 'join', id }, id);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'move') {
        const p = players.get(id);
        if (!p) return;
        p.x = msg.x; p.z = msg.z; p.y = msg.y;
        p.dir = msg.dir; p.moving = msg.moving;
        broadcast({ type: 'move', id, x: msg.x, z: msg.z, y: msg.y, dir: msg.dir, moving: msg.moving }, id);
      } else if (msg.type === 'harvest') {
        // сломанный/собранный объект; 'remove' — навсегда (запоминаем для опоздавших)
        if (msg.action !== 'berry' && !harvested.includes(msg.id)) harvested.push(msg.id);
        broadcast({ type: 'harvest', id: msg.id, action: msg.action || 'remove' }, id);
      } else if (msg.type === 'drop') {
        // игрок выбросил мешок с предметами
        drops.set(msg.pid, { pid: msg.pid, item: msg.item, count: msg.count, x: msg.x, z: msg.z });
        broadcast({ type: 'drop', pid: msg.pid, item: msg.item, count: msg.count, x: msg.x, z: msg.z }, id);
      } else if (msg.type === 'pickup') {
        // мешок подобрали — убрать у всех
        if (drops.delete(msg.pid)) broadcast({ type: 'pickup', pid: msg.pid }, id);
      } else if (msg.type === 'place') {
        // игрок поставил объект (костёр) — запоминаем и рассылаем
        const obj = { objType: msg.objType, x: msg.x, z: msg.z, id: msg.id, rot: msg.rot };
        if (!placed.some(o => o.id === msg.id)) placed.push(obj);
        broadcast({ type: 'place', ...obj }, id);
      } else if (msg.type === 'fuel') {
        // подкинули дров — обновляем топливо костра (и для опоздавших)
        const o = placed.find(o => o.id === msg.id);
        if (o) { o.fuel = msg.fuel; o.lit = true; }
        broadcast({ type: 'fuel', id: msg.id, fuel: msg.fuel }, id);
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id });
    console.log(`  Игрок ${id} вышел (${players.size} онлайн)`);
  });

  console.log(`  Игрок ${id} подключился (${players.size} онлайн)`);
});

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== excludeId && p.ws.readyState === 1) p.ws.send(data);
  }
}

const localIP = Object.values(os.networkInterfaces())
  .flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';

server.listen(PORT, () => {
  console.log(`\n  \u{1F3DD}️  Островок — мультиплеер-сервер`);
  console.log(`  Локально:        http://localhost:${PORT}`);
  console.log(`  Локальная сеть:  http://${localIP}:${PORT}`);
  console.log(`  Seed:            ${SEED.toFixed(4)}`);
  console.log(`\n  Для интернета запусти:`);
  console.log(`  npx cloudflared tunnel --url http://localhost:${PORT}\n`);
});

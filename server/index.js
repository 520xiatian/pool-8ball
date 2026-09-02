/**
 * 本地联机服务器
 * ---------------------------------------------------------------
 * 用途：在自己电脑上跑联机，供开发者工具 + 局域网内的手机对战。
 * 零依赖，直接 node server/index.js 就能起。
 *
 *   POST /api            所有操作（建房/加入/出杆/…）
 *   GET  /ws?room=&token=  WebSocket，房间一变就推 publicView
 *   GET  /health         健康检查，顺手列出本机可用地址
 *
 * 安全边界（重要）：这是**开发用**服务器，默认监听 0.0.0.0，
 * 没有账号体系、没有 TLS、没有速率限制 —— 局域网内任何人知道
 * 房间 ID 都能连上来看牌局。仅在可信网络里用，别端口转发到公网。
 * 要公网可用请用 Cloudflare 版（cloudflare/ 目录）。
 */
const http = require('http');
const os = require('os');
const { RoomStore } = require('./store.js');
const { Handler } = require('./handler.js');
const RM = require('./logic/room-logic.js');
const WS = require('./ws.js');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const store = new RoomStore();
const handler = new Handler(store);

// 每 10 分钟清一次过期房，防止长跑进程内存无限涨
setInterval(() => {
  const n = store.sweep(RM.ROOM_TTL_MS);
  if (n) console.log('[sweep] 清理了 ' + n + ' 个过期房间，当前 ' + store.size + ' 间');
}, 10 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
  // 开发者工具的请求带 Origin，需要放行；这也是它只能内网用的原因之一
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && req.url.split('?')[0] === '/health') {
    return json(res, 200, { ok: true, rooms: store.size, addresses: localUrls() });
  }

  if (req.method !== 'POST' || req.url.split('?')[0] !== '/api') {
    return json(res, 404, { ok: false, code: 'NOT_FOUND', error: '只支持 POST /api' });
  }

  let body = '';
  let tooLong = false;
  req.on('data', (chunk) => {
    body += chunk;
    // 出杆请求只有几十字节，超过 64KB 必是异常流量
    if (body.length > 65536) { tooLong = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooLong) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) {
      return json(res, 200, { ok: false, code: 'BAD_ARG', error: '请求体不是合法 JSON' });
    }
    json(res, 200, handler.handle(parsed));
  });
});

// ---- WebSocket：房间状态推送 ----

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }

  const roomId = url.searchParams.get('room');
  const token = url.searchParams.get('token') || '';
  const room = roomId ? store.getById(roomId) : null;
  if (!room) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }

  const conn = WS.upgrade(req, socket);
  if (!conn) return;

  const { uidOf } = require('./handler.js');
  const uid = /^[0-9a-f]{16,64}$/.test(token) ? uidOf(token) : '';

  // 立刻推一次当前状态：客户端不必再单独 GET 一遍
  conn.send({ type: 'room', room: RM.publicView(room, uid) });

  const unsubscribe = store.subscribe(roomId, (doc) => {
    if (!doc) {
      conn.send({ type: 'roomGone' });
      conn.close();
      return;
    }
    conn.send({ type: 'room', room: RM.publicView(doc, uid) });
  });

  conn.onMessage = (text) => {
    // 客户端心跳；回一个 pong 让它知道连接还活着
    if (text.indexOf('"ping"') !== -1) conn.send({ type: 'pong' });
  };

  conn.onClose = () => unsubscribe();
});

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

/** 列出本机所有可用的局域网地址，省得用户自己查 IP */
function localUrls() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) out.push('http://' + ni.address + ':' + PORT);
    }
  }
  out.push('http://127.0.0.1:' + PORT);
  return out;
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('台球联机服务器已启动\n');
    console.log('把下面任一地址填进 miniprogram/config.js 的 SERVER_URL：');
    for (const u of localUrls()) console.log('  ' + u);
    console.log('\n开发者工具需勾选「详情 → 本地设置 → 不校验合法域名」。');
    console.log('手机真机预览请用局域网地址（127.0.0.1 只能给模拟器用）。');
    console.log('停止：Ctrl+C\n');
  });
}

module.exports = { server: server, store: store, handler: handler, localUrls: localUrls };

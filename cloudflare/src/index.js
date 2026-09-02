/**
 * Cloudflare Worker 入口
 * ---------------------------------------------------------------
 * 这个 Worker 同时提供网页和 API：
 *
 *   /               → public/index.html（静态资源，由边缘节点直接返回）
 *   POST /api       → 按 roomId/房号 路由到对应的 Durable Object
 *   GET  /ws        → 升级为 WebSocket，交给 Room DO 持有
 *   GET  /health    → 探活
 *
 * 静态资源在 wrangler.toml 的 [assets] 里配置，命中就不进这里，
 * 所以打开网页不消耗 Worker 请求额度。
 *
 * 为什么用 Durable Object 而不是 Worker + KV：
 * 一个房间 = 一个 DO 实例，同一实例的请求由平台**串行**执行，
 * 天然不存在「两人同时出杆」的竞态。这正是回合制对局需要的模型，
 * 比自己在 KV 上手搓乐观锁可靠得多。
 *
 * 免费版（Workers Free）可用 SQLite-backed DO，本项目正是这么配的。
 */
import { Room } from './room.js';
import { Lobby } from './lobby.js';

export { Room, Lobby };

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS'
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function fail(code, error, status = 200) {
  return json({ ok: false, code, error }, status);
}

/** 建房与快速匹配需要全局视角，交给单例 Lobby DO */
function lobbyStub(env) {
  return env.LOBBY.get(env.LOBBY.idFromName('global'));
}

/** 房间 DO：用 roomId 反解出实例，保证同一房间总落在同一实例 */
function roomStub(env, roomId) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

/** roomId 是 DO 的 64 位十六进制 ID，格式不对就别浪费一次 RPC */
function isRoomId(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, backend: 'cloudflare-durable-objects' });
    }

    // ---- WebSocket：直接把连接交给房间 DO 持有 ----
    if (url.pathname === '/ws') {
      const roomId = url.searchParams.get('room');
      if (!isRoomId(roomId)) return new Response('bad room', { status: 404 });
      return roomStub(env, roomId).fetch(request);
    }

    if (url.pathname !== '/api' || request.method !== 'POST') {
      // 走到这里说明既不是静态资源也不是已知 API 路径。
      // 浏览器直接访问未知地址时给一句人话，别甩 JSON 让人一头雾水。
      if (request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html')) {
        return new Response(
          '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8">'
          + '<title>页面不存在</title>'
          + '<body style="background:#0d2b1d;color:#eaf5ee;font-family:sans-serif;'
          + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0">'
          + '<div style="text-align:center"><h1>页面不存在</h1>'
          + '<p><a href="/" style="color:#f4c552">返回台球桌</a></p></div></body></html>',
          { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }
        );
      }
      return fail('NOT_FOUND', '只支持 POST /api', 404);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return fail('BAD_ARG', '请求体不是合法 JSON');
    }
    if (!body || typeof body !== 'object') return fail('BAD_ARG', '请求体不合法');

    // token 由客户端生成并保存在本地，仅用于区分身份
    if (typeof body.token !== 'string' || !/^[0-9a-f]{16,64}$/.test(body.token)) {
      return fail('NO_AUTH', '缺少或非法的身份令牌');
    }

    try {
      return await route(body, env);
    } catch (e) {
      console.error('[worker]', body.action, e && e.stack || e);
      return fail('SERVER_ERROR', '服务器处理失败，请重试');
    }
  }
};

/**
 * 把请求分派到合适的 Durable Object。
 *
 * create / join / quickMatch 需要「房号 → 房间」的全局索引，走 Lobby；
 * 其余操作已知 roomId，直接打到对应 Room，不经过 Lobby 这个瓶颈。
 */
async function route(body, env) {
  switch (body.action) {
    case 'create':
    case 'join':
    case 'quickMatch': {
      const res = await lobbyStub(env).fetch('https://do/lobby', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
    }

    case 'get':
    case 'shoot':
    case 'timeout':
    case 'leave':
    case 'rematch': {
      if (!isRoomId(body.roomId)) {
        // leave 对不存在的房间静默成功，避免退出时弹无意义的错误
        if (body.action === 'leave') return json({ ok: true });
        return fail('NOT_FOUND', '房间不存在或已过期');
      }
      const res = await roomStub(env, body.roomId).fetch('https://do/room', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      return new Response(await res.text(), { status: res.status, headers: JSON_HEADERS });
    }

    default:
      return fail('BAD_ACTION', '未知操作：' + body.action);
  }
}

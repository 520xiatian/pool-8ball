/**
 * Room Durable Object —— 一个房间一个实例
 * ---------------------------------------------------------------
 * DO 的核心价值：同一实例的所有请求由平台**串行**执行。
 * 所以「读房间 → 算规则 → 写回」这段不可能被另一个请求插进来，
 * 回合制对局的竞态问题从根上消失了。
 *
 * WebSocket 用 Hibernation API（acceptWebSocket 而非 accept）：
 * 连接空闲时实例可以休眠，不计 duration 费用。这对台球很关键 ——
 * 玩家思考 30 秒的时间里，DO 完全不产生计算开销。
 */
import RM from './logic/room-logic.js';

const UID_SALT = 'pool-8ball-cf-v1';

/** token → uid。Workers 只有 WebCrypto，所以是异步的 */
async function uidOf(token) {
  const data = new TextEncoder().encode(token + '|' + UID_SALT);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function ok(data) { return Object.assign({ ok: true }, data); }
function fail(code, error) { return { ok: false, code, error }; }
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;   // 内存缓存，避免每次请求都读存储
  }

  /** 懒加载房间文档 */
  async load() {
    if (this.room === null) {
      this.room = (await this.state.storage.get('room')) || null;
    }
    return this.room;
  }

  async save(room) {
    this.room = room;
    await this.state.storage.put('room', room);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ---- WebSocket 升级 ----
    if (request.headers.get('Upgrade') === 'websocket') {
      const room = await this.load();
      if (!room) return new Response('room not found', { status: 404 });

      const token = url.searchParams.get('token') || '';
      const uid = /^[0-9a-f]{16,64}$/.test(token) ? await uidOf(token) : '';

      const pair = new WebSocketPair();
      // Hibernation：休眠期间不计费，唤醒后仍能收到消息
      this.state.acceptWebSocket(pair[1]);
      // uid 挂在连接上，休眠唤醒后还能取回，用来算 publicView 的座位号
      pair[1].serializeAttachment({ uid });

      // 连上先推一次当前状态，客户端不必再单独拉一遍
      try {
        pair[1].send(JSON.stringify({ type: 'room', room: RM.publicView(room, uid) }));
      } catch (e) {}

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    let body;
    try { body = await request.json(); } catch (e) {
      return json(fail('BAD_ARG', '请求体不合法'));
    }
    return json(await this.handle(body));
  }

  /** 休眠唤醒后收到客户端消息（只有心跳） */
  webSocketMessage(ws, message) {
    if (typeof message === 'string' && message.indexOf('"ping"') !== -1) {
      try { ws.send('{"type":"pong"}'); } catch (e) {}
    }
  }

  webSocketClose(ws) {
    try { ws.close(); } catch (e) {}
  }

  webSocketError(ws) {
    try { ws.close(); } catch (e) {}
  }

  /** 房间状态一变就推给所有连接 */
  broadcast() {
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      let uid = '';
      try {
        const att = ws.deserializeAttachment();
        uid = (att && att.uid) || '';
      } catch (e) {}
      try {
        if (!this.room) {
          ws.send(JSON.stringify({ type: 'roomGone' }));
          ws.close();
        } else {
          ws.send(JSON.stringify({ type: 'room', room: RM.publicView(this.room, uid) }));
        }
      } catch (e) { /* 单个连接发送失败不影响其他人 */ }
    }
  }

  async handle(body) {
    const uid = await uidOf(body.token);

    switch (body.action) {
      // Lobby 创建房间后调用它来落地初始文档
      case 'init': return await this.init(body);
      case 'seat': return await this.seat(uid, body);
      case 'get': return await this.get(uid);
      case 'shoot': return await this.apply(uid, body, RM.planShoot);
      case 'timeout': return await this.apply(uid, body, (r, u, e, now) => RM.planTimeout(r, u, now));
      case 'rematch': return await this.apply(uid, body, (r, u, e, now) => RM.planRematch(r, u, now));
      case 'leave': return await this.leave(uid);
      default: return fail('BAD_ACTION', '未知操作：' + body.action);
    }
  }

  async init(body) {
    const existing = await this.load();
    if (existing) return ok({ room: existing });   // 幂等：重复 init 不覆盖
    await this.save(body.room);
    return ok({ room: body.room });
  }

  /** 落座。DO 串行执行，所以这里不需要额外的 CAS */
  async seat(uid, body) {
    const room = await this.load();
    const plan = RM.planJoin(room, uid, body, Date.now());
    if (plan.error) return fail(plan.error.code, plan.error.message);
    if (plan.alreadySeated) return ok({ room: RM.publicView(room, uid), seated: true });

    applyPatch(room, plan.patch);
    await this.save(room);
    this.broadcast();
    return ok({ room: RM.publicView(room, uid), seated: true });
  }

  async get(uid) {
    const room = await this.load();
    if (!room) return fail('NOT_FOUND', '房间不存在或已过期');
    return ok({ room: RM.publicView(room, uid) });
  }

  /** 通用执行器：出计划 → 校验 guard → 写回 → 广播 */
  async apply(uid, body, planner) {
    const room = await this.load();
    if (!room) return fail('NOT_FOUND', '房间不存在或已过期');

    const plan = planner(room, uid, body, Date.now());
    if (plan.error) return fail(plan.error.code, plan.error.message);

    // DO 已保证串行，guard 只用来挡客户端自己的重放/双击
    if (plan.guard && !guardOk(room, plan.guard)) {
      const ce = plan.conflictError || { code: 'STALE_SHOT', message: '状态已更新，请稍候重试' };
      return fail(ce.code, ce.message);
    }

    applyPatch(room, plan.patch);
    await this.save(room);
    this.broadcast();
    return ok(plan.result || {});
  }

  async leave(uid) {
    const room = await this.load();
    if (!room) return ok({});

    const plan = RM.planLeave(room, uid, Date.now());
    if (plan.noop) return ok({});

    if (plan.destroy) {
      this.room = null;
      await this.state.storage.deleteAll();
      this.broadcast();     // 推 roomGone 让对手别干等
      return ok({});
    }

    applyPatch(room, plan.patch);
    await this.save(room);
    this.broadcast();
    return ok(plan.result || {});
  }
}

/** 把点号路径的 patch 应用到文档上 */
function applyPatch(doc, patch) {
  for (const key of Object.keys(patch)) {
    setPath(doc, key, patch[key]);
  }
}

function guardOk(doc, guard) {
  for (const key of Object.keys(guard)) {
    const actual = getPath(doc, key);
    const expect = guard[key];
    if (expect === null || expect === undefined) {
      if (actual !== null && actual !== undefined) return false;
    } else if (typeof expect === 'object') {
      if (JSON.stringify(actual) !== JSON.stringify(expect)) return false;
    } else if (actual !== expect) {
      return false;
    }
  }
  return true;
}

function getPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object') {
      cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Lobby Durable Object —— 全局单例，只做两件事
 * ---------------------------------------------------------------
 *  1. 房号 → roomId 的索引（客户端输 6 位房号要能找到房间）
 *  2. 快速匹配的等待队列
 *
 * 为什么单独一个 DO：Room DO 的 ID 是随机的 64 位十六进制串，
 * 没有全局索引就没法「按房号找房」。而 Cloudflare 上没有可跨 DO
 * 查询的数据库，索引只能自己维护。
 *
 * 单例会成为瓶颈吗？只有建房/加入/匹配走这里，出杆完全不经过它 ——
 * 而出杆才是高频操作。真正的对局压力全部落在各自的 Room DO 上。
 */
import RM from './logic/room-logic.js';

function ok(data) { return Object.assign({ ok: true }, data); }
function fail(code, error) { return { ok: false, code, error }; }
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

/** WebCrypto 版随机整数，避免 Math.random 生成可预测的房号 */
function randomInt(n) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % n;
}

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.index = null;   // code → { roomId, createdAt, isPublic }
  }

  async load() {
    if (this.index === null) {
      this.index = (await this.state.storage.get('index')) || {};
    }
    return this.index;
  }

  async save() {
    await this.state.storage.put('index', this.index);
  }

  async fetch(request) {
    let body;
    try { body = await request.json(); } catch (e) {
      return json(fail('BAD_ARG', '请求体不合法'));
    }

    try {
      switch (body.action) {
        case 'create': return json(await this.create(body));
        case 'join': return json(await this.join(body));
        case 'quickMatch': return json(await this.quickMatch(body));
        default: return json(fail('BAD_ACTION', '未知操作：' + body.action));
      }
    } catch (e) {
      console.error('[lobby]', body.action, e && e.stack || e);
      return json(fail('SERVER_ERROR', '服务器处理失败，请重试'));
    }
  }

  /** 每次进 Lobby 顺手清一次过期索引，成本极低 */
  async sweep(now) {
    const index = await this.load();
    let dirty = false;
    for (const code of Object.keys(index)) {
      if (now - index[code].createdAt > RM.ROOM_TTL_MS) {
        delete index[code];
        dirty = true;
      }
    }
    if (dirty) await this.save();
    return index;
  }

  async create(body) {
    const now = Date.now();
    const index = await this.sweep(now);

    // 生成不冲突的房号。理论上 32^6 ≈ 10 亿种，重试几次足够
    let code = null;
    for (let i = 0; i < 12; i++) {
      const c = RM.genCode(randomInt);
      if (!index[c]) { code = c; break; }
    }
    if (!code) return fail('SERVER_BUSY', '房号分配失败，请重试');

    const roomId = this.env.ROOM.newUniqueId().toString();
    const uid = await this.uidFor(body.token);

    const doc = RM.newRoomDoc(uid, body, now, randomInt);
    doc.code = code;          // 用 Lobby 分配的、确认不冲突的房号覆盖随机值
    doc._id = roomId;

    const res = await this.roomFetch(roomId, { action: 'init', token: body.token, room: doc });
    if (!res.ok) return res;

    index[code] = { roomId, createdAt: now, isPublic: !!body.isPublic };
    await this.save();

    return ok({ room: RM.publicView(doc, uid) });
  }

  async join(body) {
    const code = String(body.code || '').toUpperCase().trim();
    if (!RM.isValidCode(code)) return fail('BAD_CODE', '房间号是 6 位字母数字');

    const index = await this.sweep(Date.now());
    const entry = index[code];
    if (!entry) return fail('NOT_FOUND', '房间不存在或已过期');

    const res = await this.roomFetch(entry.roomId, {
      action: 'seat', token: body.token, name: body.name
    });
    // 房间自己说满了/不存在，就把索引清掉，避免下次还引导用户过去
    if (!res.ok && (res.code === 'NOT_FOUND')) {
      delete index[code];
      await this.save();
    }
    if (res.ok && res.room) {
      // 落座成功说明房间已开局，从公开匹配池里移除
      if (entry.isPublic && res.room.status === 'playing') {
        entry.isPublic = false;
        await this.save();
      }
    }
    return res;
  }

  async quickMatch(body) {
    const now = Date.now();
    const index = await this.sweep(now);
    const cutoff = now - RM.MATCH_WINDOW_MS;

    // 找最早创建的公开等待房，先来先匹
    const candidates = Object.keys(index)
      .filter(c => index[c].isPublic && index[c].createdAt > cutoff)
      .sort((a, b) => index[a].createdAt - index[b].createdAt)
      .slice(0, 5);

    for (const code of candidates) {
      const entry = index[code];
      const res = await this.roomFetch(entry.roomId, {
        action: 'seat', token: body.token, name: body.name
      });
      if (res.ok && res.room) {
        // 已在房内（自己开的房）不算匹配成功，继续找下一个
        if (res.room.seat === 0 && res.room.status === 'waiting') continue;
        if (res.room.status === 'playing') {
          entry.isPublic = false;
          await this.save();
        }
        return res;
      }
      if (res.code === 'NOT_FOUND') {
        delete index[code];
        await this.save();
      }
    }

    return await this.create(Object.assign({}, body, { isPublic: true }));
  }

  /** 调用某个 Room DO */
  async roomFetch(roomId, payload) {
    const stub = this.env.ROOM.get(this.env.ROOM.idFromString(roomId));
    const res = await stub.fetch('https://do/room', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const out = await res.json();
    // 把 roomId 补进去：客户端后续所有请求都要带它
    if (out.ok && out.room && !out.room._id) out.room._id = roomId;
    return out;
  }

  /** 与 Room DO 用同一份 salt，保证算出的 uid 一致 */
  async uidFor(token) {
    const data = new TextEncoder().encode(token + '|pool-8ball-cf-v1');
    const buf = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }
}

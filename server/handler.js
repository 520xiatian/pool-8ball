/**
 * 请求处理核心（与传输层解耦）
 * ---------------------------------------------------------------
 * 单独拆出来是为了能直接单测：不用起 HTTP 服务，
 * 直接 handle({action:'create', token:'x'}) 就能验证行为。
 *
 * 房间状态机来自 logic/room-logic.js —— 与微信云函数、
 * Cloudflare Worker 是同一份代码，判定绝不会漂移。
 */
const crypto = require('crypto');
const RM = require('./logic/room-logic.js');

const UID_SALT = 'pool-8ball-local-v1';

/** token → 内部 uid。存哈希而非原文，日志里泄露也没关系 */
function uidOf(token) {
  return crypto.createHash('sha256').update(token + '|' + UID_SALT).digest('hex').slice(0, 16);
}

function ok(data) { return Object.assign({ ok: true }, data); }
function fail(code, msg) { return { ok: false, code: code, error: msg }; }
function randomInt(n) { return crypto.randomInt(n); }

class Handler {
  constructor(store) {
    this.store = store;
  }

  /**
   * 处理一个请求。
   * @param {Object} body { action, token, ... }
   * @returns {Object} 与云函数完全一致的返回结构
   */
  handle(body) {
    if (!body || typeof body !== 'object') return fail('BAD_ARG', '请求体不合法');

    const token = body.token;
    // token 是客户端自己生成的 32 位十六进制串，格式必须校验
    if (typeof token !== 'string' || !/^[0-9a-f]{16,64}$/.test(token)) {
      return fail('NO_AUTH', '缺少或非法的身份令牌');
    }
    const uid = uidOf(token);

    try {
      switch (body.action) {
        case 'create': return this.create(uid, body);
        case 'join': return this.join(uid, body);
        case 'quickMatch': return this.quickMatch(uid, body);
        case 'get': return this.get(uid, body);
        case 'shoot': return this.apply(uid, body, RM.planShoot);
        case 'timeout': return this.apply(uid, body, (r, u, e, now) => RM.planTimeout(r, u, now));
        case 'leave': return this.leave(uid, body);
        case 'rematch': return this.apply(uid, body, (r, u, e, now) => RM.planRematch(r, u, now));
        default: return fail('BAD_ACTION', '未知操作：' + body.action);
      }
    } catch (e) {
      console.error('[handler]', body.action, e);
      return fail('SERVER_ERROR', '服务器处理失败，请重试');
    }
  }

  create(uid, body) {
    const doc = this.store.create(RM.newRoomDoc(uid, body, Date.now(), randomInt));
    return ok({ room: RM.publicView(doc, uid) });
  }

  join(uid, body) {
    const code = String(body.code || '').toUpperCase().trim();
    if (!RM.isValidCode(code)) return fail('BAD_CODE', '房间号是 6 位字母数字');

    const room = this.store.findByCode(code, Date.now() - RM.ROOM_TTL_MS);
    if (!room) return fail('NOT_FOUND', '房间不存在或已过期');
    return this.seatInto(uid, room, body);
  }

  seatInto(uid, room, body) {
    const plan = RM.planJoin(room, uid, body, Date.now());
    if (plan.error) return fail(plan.error.code, plan.error.message);
    if (plan.alreadySeated) return ok({ room: RM.publicView(room, uid) });

    if (!this.store.update(room._id, plan.patch, plan.guard)) {
      return fail(plan.conflictError.code, plan.conflictError.message);
    }
    const fresh = this.store.getById(room._id) || room;
    return ok({ room: RM.publicView(fresh, uid) });
  }

  quickMatch(uid, body) {
    const f = RM.matchFilter(Date.now());
    const candidates = this.store.findWaitingPublic(f.createdAfter, 5);
    for (const room of candidates) {
      if (RM.seatOf(room, uid) !== -1) continue;   // 别把自己塞进自己的房
      const r = this.seatInto(uid, room, body);
      if (r.ok) return r;
    }
    return this.create(uid, Object.assign({}, body, { isPublic: true }));
  }

  get(uid, body) {
    const room = this.roomOf(body);
    if (!room) return fail('NOT_FOUND', '房间不存在或已过期');
    return ok({ room: RM.publicView(room, uid) });
  }

  /** 通用执行器：读房间 → 出计划 → 带 guard 写回 */
  apply(uid, body, planner) {
    const room = this.roomOf(body);
    if (!room) return fail('NOT_FOUND', '房间不存在或已过期');

    const plan = planner(room, uid, body, Date.now());
    if (plan.error) return fail(plan.error.code, plan.error.message);

    if (!this.store.update(room._id, plan.patch, plan.guard)) {
      const ce = plan.conflictError || { code: 'STALE_SHOT', message: '状态已更新，请稍候重试' };
      return fail(ce.code, ce.message);
    }
    return ok(plan.result || {});
  }

  leave(uid, body) {
    const room = this.roomOf(body);
    if (!room) return ok({});

    const plan = RM.planLeave(room, uid, Date.now());
    if (plan.noop) return ok({});
    if (plan.destroy) {
      this.store.remove(room._id);
      return ok({});
    }
    this.store.update(room._id, plan.patch, null);
    return ok(plan.result || {});
  }

  roomOf(body) {
    const id = body.roomId;
    if (!id || typeof id !== 'string' || id.length > 128) return null;
    return this.store.getById(id);
  }
}

module.exports = { Handler: Handler, uidOf: uidOf };

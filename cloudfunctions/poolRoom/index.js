/**
 * 云函数 poolRoom —— 微信云开发后端
 * ---------------------------------------------------------------
 * 权威裁判：客户端只上传「一杆的意图」，胜负相关的状态变更全部由
 * 服务端用同一份 rules.js 重算。任何一端改本地代码都改不了结果。
 *
 * 房间状态机在 logic/room-logic.js —— 那份代码同时被本地服务器和
 * Cloudflare Worker 复用。本文件只负责把「操作计划」翻译成云开发的
 * 数据库调用，业务判断一行都不重复写。
 *
 * 注意：logic/ 是 miniprogram/logic 的副本（云函数不能引用小程序
 * 目录）。改完物理或规则务必跑 node scripts/sync-logic.js。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
const RM = require('./logic/room-logic.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const COLL = 'pool_rooms';

/**
 * 房间文档必须「所有用户可读」，watch 才能收到推送。
 * 因此绝不能把 openid 原文写进文档 —— 那等于把对手的用户标识
 * 暴露给任何能读到该文档的人。这里只存不可逆的短哈希。
 */
const UID_SALT = 'pool-8ball-v1';
function uidOf(openid) {
  return crypto.createHash('sha256').update(openid + '|' + UID_SALT).digest('hex').slice(0, 16);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return fail('NO_AUTH', '无法获取用户身份');
  const uid = uidOf(OPENID);

  try {
    switch (event.action) {
      case 'create': return await createRoom(uid, event);
      case 'join': return await joinRoom(uid, event);
      case 'quickMatch': return await quickMatch(uid, event);
      case 'get': return await getRoom(uid, event);
      case 'shoot': return await applyPlan(uid, event, RM.planShoot);
      case 'timeout': return await applyPlan(uid, event, (room, u, ev, now) => RM.planTimeout(room, u, now));
      case 'leave': return await leave(uid, event);
      case 'rematch': return await applyPlan(uid, event, (room, u, ev, now) => RM.planRematch(room, u, now));
      default: return fail('BAD_ACTION', '未知操作：' + event.action);
    }
  } catch (e) {
    console.error('[poolRoom]', event.action, e);
    // 不把原始异常抛给客户端，避免泄露内部实现细节
    return fail('SERVER_ERROR', '服务器处理失败，请重试');
  }
};

function ok(data) { return Object.assign({ ok: true }, data); }
function fail(code, msg) { return { ok: false, code: code, error: msg }; }
function randomInt(n) { return crypto.randomInt(n); }

/**
 * 读房间文档。文档不存在时云开发会抛异常而不是返回 null，
 * 这里统一收敛成 null，让调用方都走 NOT_FOUND 分支。
 */
async function fetchRoom(roomId) {
  if (!roomId || typeof roomId !== 'string' || roomId.length > 128) return null;
  try {
    const res = await db.collection(COLL).doc(roomId).get();
    return res && res.data ? res.data : null;
  } catch (e) {
    return null;
  }
}

/**
 * 通用执行器：读房间 → 让 room-logic 出计划 → 带 guard 条件写回。
 *
 * guard 就是乐观锁。云开发的 where().update() 只在条件仍成立时才写，
 * 返回 updated === 0 说明有人抢先改过，此时按计划里的 conflictError 拒绝。
 */
async function applyPlan(uid, event, planner) {
  const room = await fetchRoom(event.roomId);
  if (!room) return fail('NOT_FOUND', '房间不存在或已过期');

  const plan = planner(room, uid, event, Date.now());
  if (plan.error) return fail(plan.error.code, plan.error.message);

  const where = Object.assign({ _id: room._id }, plan.guard || {});
  const upd = await db.collection(COLL).where(where).update({ data: plan.patch });
  if (upd.stats.updated === 0) {
    const ce = plan.conflictError || { code: 'STALE_SHOT', message: '状态已更新，请稍候重试' };
    return fail(ce.code, ce.message);
  }
  return ok(plan.result || {});
}

async function createRoom(uid, event) {
  const doc = RM.newRoomDoc(uid, event, Date.now(), randomInt);
  const res = await db.collection(COLL).add({ data: doc });
  doc._id = res._id;
  return ok({ room: RM.publicView(doc, uid) });
}

async function joinRoom(uid, event) {
  const code = String(event.code || '').toUpperCase().trim();
  if (!RM.isValidCode(code)) return fail('BAD_CODE', '房间号是 6 位字母数字');

  const q = await db.collection(COLL)
    .where({ code: code, createdAt: _.gt(Date.now() - RM.ROOM_TTL_MS) })
    .orderBy('createdAt', 'desc').limit(1).get();
  if (!q.data.length) return fail('NOT_FOUND', '房间不存在或已过期');

  return await seatInto(uid, q.data[0], event);
}

/** 落座：已在房内直接返回，有空位则用 guard 原子占位 */
async function seatInto(uid, room, event) {
  const plan = RM.planJoin(room, uid, event, Date.now());
  if (plan.error) return fail(plan.error.code, plan.error.message);
  if (plan.alreadySeated) return ok({ room: RM.publicView(room, uid) });

  const where = Object.assign({ _id: room._id }, plan.guard);
  const upd = await db.collection(COLL).where(where).update({ data: plan.patch });
  if (upd.stats.updated === 0) {
    return fail(plan.conflictError.code, plan.conflictError.message);
  }

  const fresh = await fetchRoom(room._id);
  return ok({ room: RM.publicView(fresh || room, uid) });
}

/** 快速匹配：先塞进公开的等待房，没有就自己开一间 */
async function quickMatch(uid, event) {
  const f = RM.matchFilter(Date.now());
  const q = await db.collection(COLL).where({
    status: f.status,
    isPublic: f.isPublic,
    createdAt: _.gt(f.createdAfter)
  }).orderBy('createdAt', 'asc').limit(5).get();

  for (const room of q.data) {
    if (RM.seatOf(room, uid) !== -1) continue;   // 别把自己塞进自己的房
    const r = await seatInto(uid, room, event);
    if (r.ok) return r;
  }
  return await createRoom(uid, Object.assign({}, event, { isPublic: true }));
}

async function getRoom(uid, event) {
  const room = await fetchRoom(event.roomId);
  if (!room) return fail('NOT_FOUND', '房间不存在或已过期');
  return ok({ room: RM.publicView(room, uid) });
}

/** 离开：对局中算认输；等待中房主退出则销毁房间 */
async function leave(uid, event) {
  const room = await fetchRoom(event.roomId);
  if (!room) return ok({});

  const plan = RM.planLeave(room, uid, Date.now());
  if (plan.noop) return ok({});
  if (plan.destroy) {
    await db.collection(COLL).doc(room._id).remove();
    return ok({});
  }
  await db.collection(COLL).doc(room._id).update({ data: plan.patch });
  return ok(plan.result || {});
}

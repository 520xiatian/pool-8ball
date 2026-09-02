/**
 * 共享房间状态机
 * ---------------------------------------------------------------
 * 三套后端（微信云开发 / 本地 Node / Cloudflare Worker）共用这一份
 * 房间逻辑。这样切换托管方式时，规则、权限、乐观锁的行为完全一致，
 * 不会出现「本地能打赢、线上判犯规」这种最难查的问题。
 *
 * 设计约定：本模块是**纯函数**，不碰任何数据库 API。每个入口拿到
 * 当前房间快照，返回一份「操作计划」：
 *
 *   { error: {code, message} }              → 拒绝，原样返回给客户端
 *   { patch: {...}, guard: {...}, ... }     → 请把 patch 写进这份文档，
 *                                             但仅当 guard 条件仍成立
 *
 * guard 用点号路径表达（如 'game.shotIndex': 3），因为云开发的
 * where().update() 正好吃这种格式；本地和 Worker 端则直接逐条比对。
 * 这是各后端唯一需要自己实现的部分。
 */
const R = require('./rules.js');
const P = require('./physics.js');

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;  // 房间 2 小时后视为过期
const TURN_MS = 45 * 1000;               // 每回合限时
const MATCH_WINDOW_MS = 10 * 60 * 1000;  // 快速匹配只看 10 分钟内的房

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉了 0/O/1/I 等易混字符

function err(code, message) { return { error: { code: code, message: message } }; }

/** 6 位房间号。randomInt 由调用方注入，便于测试时固定序列 */
function genCode(randomInt) {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

function isValidCode(code) {
  return typeof code === 'string' && /^[0-9A-Z]{6}$/.test(code);
}

function seatOf(room, uid) {
  const ps = (room && room.players) || [];
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] && ps[i].uid === uid) return i;
  }
  return -1;
}

/** 昵称消毒：去掉控制字符并限长，避免奇怪内容画到对手屏幕上 */
function safeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || fallback;
}

/**
 * 对外房间视图：只给昵称，绝不含 uid。
 * 云开发下房间文档对所有登录用户可读，任何身份标识都不能出现在里面。
 */
function publicView(room, uid) {
  return {
    _id: room._id,
    code: room.code,
    status: room.status,
    seat: seatOf(room, uid),
    players: (room.players || []).map(p => p ? { name: p.name, ready: !!p.ready } : null),
    game: room.game,
    lastShot: room.lastShot || null,
    turnDeadline: room.turnDeadline || 0,
    rematchVotes: room.rematchVotes || {},
    updatedAt: room.updatedAt
  };
}

/** 新房间的完整初始文档（不含 _id，由存储层分配） */
function newRoomDoc(uid, opts, now, randomInt) {
  return {
    code: genCode(randomInt),
    status: 'waiting',
    isPublic: !!(opts && opts.isPublic),
    players: [
      { uid: uid, name: safeName(opts && opts.name, '房主'), ready: true },
      null
    ],
    game: R.createGame(0),
    lastShot: null,
    rematchVotes: {},
    turnDeadline: 0,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 落座计划。房间已满或已在房内都有明确结果，
 * guard 保证并发下只有一个人能占到 1 号位。
 */
function planJoin(room, uid, opts, now) {
  if (!room) return err('NOT_FOUND', '房间不存在或已过期');
  if (seatOf(room, uid) !== -1) return { alreadySeated: true };
  if (room.players[1]) return err('ROOM_FULL', '房间已满');
  if (room.status !== 'waiting') return err('ROOM_FULL', '对局已经开始了');
  if (now - room.createdAt > ROOM_TTL_MS) return err('NOT_FOUND', '房间已过期');

  return {
    guard: { 'players.1': null },
    patch: {
      'players.1': { uid: uid, name: safeName(opts && opts.name, '挑战者'), ready: true },
      status: 'playing',
      turnDeadline: now + TURN_MS,
      updatedAt: now
    },
    conflictError: { code: 'ROOM_FULL', message: '房间刚被占满，换一个吧' }
  };
}

/** 快速匹配的候选筛选条件，各后端按自己的查询语法翻译 */
function matchFilter(now) {
  return { status: 'waiting', isPublic: true, createdAfter: now - MATCH_WINDOW_MS };
}

/**
 * 出杆计划 —— 整套联机方案的核心校验。
 *
 * 客户端只上传意图（方向 + 力度），这里用**权威球态**重跑物理与规则。
 * 即使有人改了本地代码宣布自己赢了，服务端算出来不是那样就不算。
 */
function planShoot(room, uid, event, now) {
  if (!room) return err('NOT_FOUND', '房间不存在或已过期');
  if (room.status !== 'playing') return err('NOT_PLAYING', '对局未开始或已结束');

  const seat = seatOf(room, uid);
  if (seat === -1) return err('NOT_IN_ROOM', '你不在这个房间里');

  const game = room.game;
  if (game.winner !== -1) return err('GAME_OVER', '对局已结束');
  if (game.turn !== seat) return err('NOT_YOUR_TURN', '还没轮到你出杆');

  // 乐观锁：客户端必须带上它认为的当前杆号，挡住重放与并发双击
  if (typeof event.shotIndex === 'number' && event.shotIndex !== game.shotIndex) {
    return err('STALE_SHOT', '状态已更新，请稍候重试');
  }

  const shot = sanitizeShot(event.shot, game.ballInHand);
  if (!shot) return err('BAD_SHOT', '出杆参数不合法');

  const result = R.applyShot(game, shot);
  const finished = result.state.winner !== -1;
  const lastShot = {
    by: seat,
    shot: shot,
    log: result.log,
    at: now,
    index: result.state.shotIndex
  };

  return {
    guard: { 'game.shotIndex': game.shotIndex },
    patch: {
      game: result.state,
      status: finished ? 'finished' : 'playing',
      // 只存出杆参数，不存上百帧坐标：两端本地重算即可，省流量也省存储
      lastShot: lastShot,
      rematchVotes: {},
      turnDeadline: finished ? 0 : now + TURN_MS,
      updatedAt: now
    },
    result: { game: result.state, lastShot: lastShot },
    conflictError: { code: 'STALE_SHOT', message: '状态已更新，请稍候重试' }
  };
}

/** 出杆参数消毒：把一切非法输入挡在物理引擎之外 */
function sanitizeShot(raw, ballInHand) {
  if (!raw || typeof raw !== 'object') return null;
  const dx = toInt(raw.dx);
  const dy = toInt(raw.dy);
  let power = toInt(raw.power);
  if (dx === null || dy === null || power === null) return null;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) > 20000 || Math.abs(dy) > 20000) return null;
  // 力度夹取而不拒绝：网络抖动改几个数值不该让玩家白打一杆
  power = Math.min(Math.max(power, 50), 1000);

  const shot = { dx: dx, dy: dy, power: power };
  if (ballInHand) {
    const cx = toNum(raw.cueX);
    const cy = toNum(raw.cueY);
    if (cx !== null && cy !== null) {
      shot.cueX = Math.min(Math.max(cx, 0), P.TABLE.W);
      shot.cueY = Math.min(Math.max(cy, 0), P.TABLE.H);
    }
  }
  return shot;
}

function toInt(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return Math.round(v);
}

function toNum(v) {
  if (typeof v !== 'number' || !isFinite(v)) return null;
  return v;
}

/**
 * 超时换手。只允许**等待方**发起（谁在等谁催），并由服务端复核
 * 时间戳 —— 否则改本地时钟就能偷对手的回合。
 */
function planTimeout(room, uid, now) {
  if (!room) return err('NOT_FOUND', '房间不存在或已过期');
  if (room.status !== 'playing') return err('NOT_PLAYING', '对局未在进行');

  const seat = seatOf(room, uid);
  if (seat === -1) return err('NOT_IN_ROOM', '你不在这个房间里');
  if (room.game.turn === seat) return err('BAD_ARG', '不能催自己');
  if (!room.turnDeadline || now < room.turnDeadline) {
    return err('TOO_EARLY', '还没到超时时间');
  }

  const next = R.timeoutSwitch(room.game);
  const lastShot = {
    by: room.game.turn,
    shot: null,
    log: next.lastMessage,
    at: now,
    index: next.shotIndex
  };
  return {
    guard: { 'game.shotIndex': room.game.shotIndex },
    patch: {
      game: next,
      lastShot: lastShot,
      turnDeadline: now + TURN_MS,
      updatedAt: now
    },
    result: { game: next },
    conflictError: { code: 'STALE_SHOT', message: '状态已更新' }
  };
}

/**
 * 离开房间。
 * 对局中退出算认输，让对手立刻结束等待，而不是干等 45 秒超时。
 */
function planLeave(room, uid, now) {
  if (!room) return { noop: true };
  const seat = seatOf(room, uid);
  if (seat === -1) return { noop: true };

  if (room.status === 'playing' && room.game.winner === -1) {
    const next = R.forfeit(room.game, seat);
    return {
      patch: {
        game: next,
        status: 'finished',
        lastShot: { by: seat, shot: null, log: next.lastMessage, at: now, index: next.shotIndex },
        turnDeadline: 0,
        updatedAt: now
      },
      result: { game: next }
    };
  }

  // 还在等人时房主退出：直接销毁，避免留下永远等不到人的僵尸房
  if (room.status === 'waiting' && seat === 0) return { destroy: true };
  return { noop: true };
}

/**
 * 再来一局：需双方都点过才真正重开，避免一方还在看战绩就被拉进新局。
 * 票上记着「针对哪一局」投的，所以旧票不会污染下一局。
 */
function planRematch(room, uid, now) {
  if (!room) return err('NOT_FOUND', '房间不存在或已过期');
  const seat = seatOf(room, uid);
  if (seat === -1) return err('NOT_IN_ROOM', '你不在这个房间里');
  if (room.status !== 'finished') return err('BAD_STATE', '当前对局还没结束');
  if (!room.players[0] || !room.players[1]) return err('BAD_STATE', '对手已离开');

  const stamp = room.game.shotIndex;
  const votes = Object.assign({}, room.rematchVotes || {});
  votes[String(seat)] = stamp;

  if (!(votes['0'] === stamp && votes['1'] === stamp)) {
    return {
      patch: { rematchVotes: votes, updatedAt: now },
      result: { waitingForOpponent: true }
    };
  }

  const loser = room.game.winner === 0 ? 1 : 0;   // 败者先手，符合线下习惯
  const game = R.createGame(loser);
  return {
    patch: {
      game: game,
      status: 'playing',
      lastShot: null,
      rematchVotes: {},
      turnDeadline: now + TURN_MS,
      updatedAt: now
    },
    result: { game: game }
  };
}

module.exports = {
  ROOM_TTL_MS: ROOM_TTL_MS,
  TURN_MS: TURN_MS,
  MATCH_WINDOW_MS: MATCH_WINDOW_MS,
  genCode: genCode,
  isValidCode: isValidCode,
  seatOf: seatOf,
  safeName: safeName,
  publicView: publicView,
  newRoomDoc: newRoomDoc,
  planJoin: planJoin,
  matchFilter: matchFilter,
  planShoot: planShoot,
  planTimeout: planTimeout,
  planLeave: planLeave,
  planRematch: planRematch,
  sanitizeShot: sanitizeShot
};

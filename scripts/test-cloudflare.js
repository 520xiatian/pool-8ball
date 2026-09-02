/**
 * Cloudflare Worker 端到端测试
 * ---------------------------------------------------------------
 * 打真实的 wrangler dev（本地 workerd 运行时，与线上同一套引擎），
 * 验证 Durable Object 版后端的行为与云开发/本地服务器完全一致。
 *
 * 用法：
 *   1. cd cloudflare && npx wrangler dev --port 8788 --local
 *   2. node scripts/test-cloudflare.js
 *
 * 环境变量 CF_BASE 可覆盖地址（默认 http://127.0.0.1:8788），
 * 填线上 workers.dev 域名就能直接验证生产部署。
 */
const assert = require('assert');
const path = require('path');

const BASE = (process.env.CF_BASE || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');

/**
 * Node 18+ 的内置 fetch 默认**不读** HTTP_PROXY / HTTPS_PROXY，
 * 需要 NODE_USE_ENV_PROXY=1 才生效。在中国大陆访问 workers.dev
 * 基本都要走代理，所以这里检测到代理但没开开关时自动重启一次自己。
 */
if (process.env.NODE_USE_ENV_PROXY !== '1' &&
    (process.env.HTTPS_PROXY || process.env.https_proxy ||
     process.env.HTTP_PROXY || process.env.http_proxy) &&
    !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(BASE)) {
  const { spawnSync } = require('child_process');
  console.log('检测到代理环境变量，以 NODE_USE_ENV_PROXY=1 重新启动…');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' })
  });
  process.exit(r.status === null ? 1 : r.status);
}

const RULES = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'rules.js'));

const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(BASE);
// 打线上要跨境往返（可能还过代理），超时给宽一些
const WS_TIMEOUT = IS_LOCAL ? 8000 : 25000;

const TA = 'a'.repeat(32);
const TB = 'b'.repeat(32);
const TC = 'c'.repeat(32);
const SHOT = { dx: 10000, dy: 0, power: 900 };

/**
 * 生成一次性 token。
 * wrangler dev --local 会把 DO 状态持久化到 .wrangler/，
 * 跨轮次运行时上一轮的公开等待房还在。涉及快速匹配的用例必须用
 * 新身份，否则会撞上「你已经在这个房间里」。
 */
function tok() {
  let s = '';
  for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return s;
}

let pass = 0;
let fail = 0;
let skipped = false;
const queue = [];
function test(name, body) { queue.push({ name, body }); }
function section(title) { queue.push({ section: title }); }

async function post(body) {
  const res = await fetch(BASE + '/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

function openSocket(roomId, token) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(WS_BASE + '/ws?room=' + roomId + '&token=' + token);
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), WS_TIMEOUT);
    s.addEventListener('open', () => { clearTimeout(timer); resolve(s); });
    s.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); });
  });
}

function waitFor(sock, predicate, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.removeEventListener('message', onMsg);
      reject(new Error('等待超时（' + (label || '消息') + '）'));
    }, ms || WS_TIMEOUT);
    function onMsg(ev) {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!predicate(msg)) return;
      clearTimeout(timer);
      sock.removeEventListener('message', onMsg);
      resolve(msg);
    }
    sock.addEventListener('message', onMsg);
  });
}

/** 建一间已开局的房，返回 { roomId, code, room } */
async function openRoom() {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  assert.strictEqual(c.ok, true, '建房失败：' + JSON.stringify(c));
  const j = await post({ action: 'join', token: TB, code: c.room.code, name: 'Bob' });
  assert.strictEqual(j.ok, true, '加入失败：' + JSON.stringify(j));
  return { roomId: c.room._id, code: c.room.code, room: j.room };
}

/**
 * 把公开等待房都消耗掉，让快速匹配用例从干净状态开始。
 *
 * 需要这一步是因为 wrangler dev --local 会把 DO 状态持久化到
 * .wrangler/ 目录，上一轮跑测试留下的等待房下一轮还在，
 * 快速匹配就会匹到那些旧房而不是本轮新建的。
 *
 * 每次 quickMatch 要么匹进一间旧房（把它变成 playing，等于清掉），
 * 要么自己开一间新的（此时用同一 token 退出即销毁）。
 */
async function drainPublicRooms() {
  for (let i = 0; i < 12; i++) {
    const t = tok();
    const r = await post({ action: 'quickMatch', token: t, name: 'drain' });
    if (!r.ok) return;

    if (r.room.status === 'waiting') {
      // 池子已空：这间是刚为自己开的，退出即销毁
      await post({ action: 'leave', token: t, roomId: r.room._id });
      return;
    }
    // 匹进了旧房：退出让它结束，不再出现在匹配池里
    await post({ action: 'leave', token: t, roomId: r.room._id });
  }
}

section('基础路由');

test('/health 可用', async () => {
  const res = await fetch(BASE + '/health');
  const body = await res.json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.backend, 'cloudflare-durable-objects');
});

test('非法路径与非法 JSON 被安全拒绝', async () => {
  const r404 = await fetch(BASE + '/nope');
  assert.strictEqual(r404.status, 404);

  const res = await fetch(BASE + '/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ broken'
  });
  const body = await res.json();
  assert.strictEqual(body.ok, false);
  assert.strictEqual(body.code, 'BAD_ARG');
});

test('token 非法一律拒绝', async () => {
  for (const bad of [undefined, '', 'short', 'ZZZZ' + 'z'.repeat(28), 12345]) {
    const r = await post({ action: 'create', token: bad });
    assert.strictEqual(r.ok, false, JSON.stringify(bad) + ' 竟然通过了');
    assert.strictEqual(r.code, 'NO_AUTH');
  }
});

test('未知 action 被拒绝', async () => {
  const r = await post({ action: 'nonsense', token: TA });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BAD_ACTION');
});

section('房间生命周期');

test('建房：6 位房号，房主坐 0 号位，roomId 是 DO ID', async () => {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  assert.match(c.room.code, /^[0-9A-Z]{6}$/, '房号格式不对：' + c.room.code);
  assert.match(c.room._id, /^[0-9a-f]{64}$/, 'roomId 不是 DO ID：' + c.room._id);
  assert.strictEqual(c.room.seat, 0);
  assert.strictEqual(c.room.status, 'waiting');
  assert.strictEqual(c.room.players[0].name, 'Alice');
});

test('房间视图不含 token 或 uid', async () => {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  const json = JSON.stringify(c.room);
  assert.ok(json.indexOf(TA) === -1, '视图泄露了 token');
  assert.ok(json.indexOf('uid') === -1, '视图泄露了 uid：' + json);
});

test('昵称被消毒：限长 12', async () => {
  const c = await post({ action: 'create', token: TA, name: 'X'.repeat(40) });
  assert.ok(c.room.players[0].name.length <= 12, '昵称没限长：' + c.room.players[0].name);
});

test('加入：房号格式错 / 不存在 / 正常落座', async () => {
  const bad = await post({ action: 'join', token: TB, code: 'ZZ' });
  assert.strictEqual(bad.code, 'BAD_CODE');

  const notFound = await post({ action: 'join', token: TB, code: 'AAAAAA' });
  assert.strictEqual(notFound.code, 'NOT_FOUND');

  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  const j = await post({ action: 'join', token: TB, code: c.room.code, name: 'Bob' });
  assert.strictEqual(j.ok, true, JSON.stringify(j));
  assert.strictEqual(j.room.seat, 1);
  assert.strictEqual(j.room.status, 'playing');
  assert.ok(j.room.turnDeadline > Date.now(), '没设置回合截止时间');
  assert.match(j.room._id, /^[0-9a-f]{64}$/, '加入返回的 roomId 缺失');
});

test('第三人无法挤进满房', async () => {
  const { code } = await openRoom();
  const r = await post({ action: 'join', token: TC, code: code, name: 'Carol' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'ROOM_FULL');
});

test('同一人重复加入自己的房不会占掉第二个位置', async () => {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  const again = await post({ action: 'join', token: TA, code: c.room.code, name: 'Alice' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.room.seat, 0, '重复加入应仍是 0 号位');
  assert.strictEqual(again.room.players[1], null, '不该把自己塞进 1 号位');
});

test('快速匹配：第一人开房等待，第二人匹进同一房', async () => {
  await drainPublicRooms();
  const t1 = tok();
  const t2 = tok();

  const first = await post({ action: 'quickMatch', token: t1, name: 'P1' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.room.status, 'waiting', '池子已清空，第一人应开新房等待');

  const second = await post({ action: 'quickMatch', token: t2, name: 'P2' });
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.strictEqual(second.room.status, 'playing', '第二人应直接开局');
  assert.strictEqual(second.room._id, first.room._id, '两人应在同一房');
  assert.strictEqual(second.room.seat, 1, '第二人应坐 1 号位');
});

test('快速匹配不会把自己匹配给自己', async () => {
  await drainPublicRooms();
  const t = tok();
  const first = await post({ action: 'quickMatch', token: t, name: 'Solo' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  const again = await post({ action: 'quickMatch', token: t, name: 'Solo' });
  assert.strictEqual(again.ok, true, JSON.stringify(again));
  assert.notStrictEqual(again.room.status, 'playing', '自己跟自己开局了');
});

section('出杆与权限');

test('房主先手：Alice 能出杆，Bob 不能', async () => {
  const { roomId } = await openRoom();
  const bob = await post({ action: 'shoot', token: TB, roomId, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(bob.code, 'NOT_YOUR_TURN');

  const alice = await post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(alice.ok, true, JSON.stringify(alice));
  assert.strictEqual(alice.game.shotIndex, 1);
});

test('局外人不能出杆', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'shoot', token: TC, roomId, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(r.code, 'NOT_IN_ROOM');
});

test('重放同一杆被 shotIndex 挡住', async () => {
  const { roomId } = await openRoom();
  const first = await post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(first.ok, true);
  const replay = await post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(replay.ok, false);
  assert.ok(replay.code === 'STALE_SHOT' || replay.code === 'NOT_YOUR_TURN', '实际：' + replay.code);
});

test('非法出杆参数被拒', async () => {
  const { roomId } = await openRoom();
  const bad = [null, 'hack', { dx: 0, dy: 0, power: 500 }, { dx: NaN, dy: 1, power: 500 },
               { dx: 1, dy: 0, power: 'max' }, { dx: 999999, dy: 0, power: 500 }];
  for (const shot of bad) {
    const r = await post({ action: 'shoot', token: TA, roomId, shot, shotIndex: 0 });
    assert.strictEqual(r.code, 'BAD_SHOT', JSON.stringify(shot) + ' → ' + r.code);
  }
});

test('超范围力度被夹取到 1000', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'shoot', token: TA, roomId, shot: { dx: 10000, dy: 0, power: 999999 }, shotIndex: 0 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.lastShot.shot.power, 1000);
});

test('Worker 判定与客户端本地算的完全一致', async () => {
  const { roomId, room } = await openRoom();
  const local = RULES.applyShot(room.game, SHOT);
  const r = await post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(
    JSON.stringify(r.game.balls),
    JSON.stringify(local.state.balls),
    'Worker 与客户端球态不一致 —— 联机会出现「我明明进了球」的争执'
  );
  assert.strictEqual(r.game.turn, local.state.turn, '回合归属不一致');
  assert.strictEqual(r.game.winner, local.state.winner, '胜负判定不一致');
});

test('lastShot 只带出杆参数，不带帧坐标', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 });
  assert.ok(!('frames' in r.lastShot), 'lastShot 带了 frames');
  assert.ok(JSON.stringify(r.lastShot).length < 300, 'lastShot 太大');
});

test('并发出杆只有一个成功（DO 串行 + guard）', async () => {
  const { roomId } = await openRoom();
  // 同时发 5 个相同 shotIndex 的请求
  const results = await Promise.all([0, 0, 0, 0, 0].map(() =>
    post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 })
  ));
  const okCount = results.filter(r => r.ok).length;
  assert.strictEqual(okCount, 1, '应只有 1 个成功，实际 ' + okCount);
});

section('超时 / 退出 / 再战');

test('未到超时就催 → TOO_EARLY', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'timeout', token: TB, roomId });
  assert.strictEqual(r.code, 'TOO_EARLY');
});

test('不能催自己', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'timeout', token: TA, roomId });
  // 当前是 A 的回合，A 催自己应被拒（BAD_ARG 或 TOO_EARLY 都算挡住了）
  assert.strictEqual(r.ok, false);
  assert.ok(r.code === 'BAD_ARG' || r.code === 'TOO_EARLY', '实际：' + r.code);
});

test('局外人不能触发超时', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'timeout', token: TC, roomId });
  assert.strictEqual(r.code, 'NOT_IN_ROOM');
});

test('对局中退出 = 认输，对手获胜', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'leave', token: TA, roomId });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.game.winner, 1, 'Alice 认输应判 Bob 胜');
});

test('局外人 leave 不影响对局', async () => {
  const { roomId } = await openRoom();
  await post({ action: 'leave', token: TC, roomId });
  const g = await post({ action: 'get', token: TA, roomId });
  assert.strictEqual(g.room.status, 'playing', '局外人把对局搞结束了');
});

test('对局未结束不能 rematch', async () => {
  const { roomId } = await openRoom();
  const r = await post({ action: 'rematch', token: TA, roomId });
  assert.strictEqual(r.code, 'BAD_STATE');
});

test('rematch 需双方确认，且败者先手', async () => {
  const { roomId } = await openRoom();
  await post({ action: 'leave', token: TA, roomId });   // A 认输 → B 胜

  const first = await post({ action: 'rematch', token: TB, roomId });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.waitingForOpponent, true, '单方点击就重开了');

  const second = await post({ action: 'rematch', token: TA, roomId });
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.ok(second.game, '双方点齐应返回新局');
  assert.strictEqual(second.game.shotIndex, 0, '新局 shotIndex 应归零');
  assert.strictEqual(second.game.balls.filter(b => b.active).length, 16, '新局应摆满 16 颗球');
  assert.strictEqual(second.game.turn, 0, '败者 Alice(seat 0) 应先手');
});

test('房主退出等待房后房间消失', async () => {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  await post({ action: 'leave', token: TA, roomId: c.room._id });
  const g = await post({ action: 'get', token: TA, roomId: c.room._id });
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.code, 'NOT_FOUND');
});

test('非法 roomId 都被安全拒绝', async () => {
  for (const roomId of [undefined, '', 123, 'not-a-do-id', 'x'.repeat(200), { a: 1 }]) {
    const r = await post({ action: 'get', token: TA, roomId });
    assert.strictEqual(r.ok, false, JSON.stringify(roomId) + ' 竟然成功了');
    assert.notStrictEqual(r.code, 'SERVER_ERROR', JSON.stringify(roomId) + ' 触发了异常：' + r.error);
  }
});

section('WebSocket 推送');

test('连上即收到当前房间状态，座位号正确', async () => {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  const sock = await openSocket(c.room._id, TA);
  try {
    const first = await waitFor(sock, m => m.type === 'room', WS_TIMEOUT, '首次快照');
    assert.strictEqual(first.room.code, c.room.code);
    assert.strictEqual(first.room.seat, 0, 'token 应被识别为 0 号位');
  } finally { sock.close(); }
});

test('对手加入时房主立刻收到推送', async () => {
  const c = await post({ action: 'create', token: TA, name: 'Alice' });
  const sock = await openSocket(c.room._id, TA);
  try {
    await waitFor(sock, m => m.type === 'room', WS_TIMEOUT, '首次快照');
    const waiting = waitFor(sock, m => m.type === 'room' && m.room.status === 'playing', WS_TIMEOUT, '开局推送');
    await post({ action: 'join', token: TB, code: c.room.code, name: 'Bob' });
    const msg = await waiting;
    assert.strictEqual(msg.room.players[1].name, 'Bob');
  } finally { sock.close(); }
});

test('A 出杆，B 通过推送收到同一杆参数（联机主链路）', async () => {
  const { roomId } = await openRoom();
  const sockB = await openSocket(roomId, TB);
  try {
    const first = await waitFor(sockB, m => m.type === 'room', WS_TIMEOUT, '首次快照');
    assert.strictEqual(first.room.seat, 1, 'Bob 应是 1 号位');

    const waiting = waitFor(sockB, m => m.type === 'room' && m.room.game.shotIndex === 1, WS_TIMEOUT, '出杆推送');
    const shootRes = await post({ action: 'shoot', token: TA, roomId, shot: SHOT, shotIndex: 0 });
    assert.strictEqual(shootRes.ok, true, JSON.stringify(shootRes));

    const msg = await waiting;
    assert.strictEqual(msg.room.lastShot.by, 0, '应标明是 0 号位出的杆');
    assert.deepStrictEqual(msg.room.lastShot.shot, SHOT, '推送的出杆参数与上传的不一致');
    assert.strictEqual(
      JSON.stringify(msg.room.game.balls),
      JSON.stringify(shootRes.game.balls),
      '推送球态与权威结果不一致'
    );
    console.log('       （lastShot ' + JSON.stringify(msg.room.lastShot).length
      + ' 字节，房间快照 ' + JSON.stringify(msg.room).length + ' 字节）');
  } finally { sockB.close(); }
});

test('心跳 ping 得到 pong', async () => {
  const c = await post({ action: 'create', token: TA });
  const sock = await openSocket(c.room._id, TA);
  try {
    await waitFor(sock, m => m.type === 'room', WS_TIMEOUT, '首次快照');
    const waiting = waitFor(sock, m => m.type === 'pong', WS_TIMEOUT, 'pong');
    sock.send('{"type":"ping"}');
    await waiting;
  } finally { sock.close(); }
});

test('连接不存在的房间被拒绝', async () => {
  let rejected = false;
  try {
    const s = await openSocket('f'.repeat(64), TA);
    s.close();
  } catch (e) { rejected = true; }
  assert.strictEqual(rejected, true, '不存在的房间竟然连上了');
});

test('房主退出等待房后订阅者收到 roomGone', async () => {
  const c = await post({ action: 'create', token: TA });
  const sock = await openSocket(c.room._id, TA);
  try {
    await waitFor(sock, m => m.type === 'room', WS_TIMEOUT, '首次快照');
    const waiting = waitFor(sock, m => m.type === 'roomGone', WS_TIMEOUT, 'roomGone');
    await post({ action: 'leave', token: TA, roomId: c.room._id });
    await waiting;
  } finally { sock.close(); }
});

// ---------- 执行 ----------

(async () => {
  console.log('\n=== Cloudflare Worker 端到端测试 ===');
  console.log('目标：' + BASE + '\n');

  // 先探活，服务没起就直接给出提示而不是刷 20 条超时
  try {
    const res = await fetch(BASE + '/health', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.log('连不上 Worker：' + e.message);
    if (/127\.0\.0\.1|localhost/.test(BASE)) {
      console.log('\n请先在另一个终端启动本地模拟：');
      console.log('  cd cloudflare');
      console.log('  npx wrangler dev --port 8788 --local\n');
    } else {
      console.log('\n检查项：');
      console.log('  1. 部署是否成功：cd cloudflare && npx wrangler deploy');
      console.log('  2. workers.dev 在中国大陆常被 DNS 干扰，需要代理');
      console.log('  3. 若已设代理，确认 HTTPS_PROXY 环境变量可用\n');
    }
    process.exit(2);
  }

  for (const t of queue) {
    if (t.section) { console.log('\n[' + t.section + ']'); continue; }
    try {
      await t.body();
      pass++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      fail++;
      console.log('  FAIL ' + t.name + '\n       ' + e.message);
    }
  }

  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(46) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();

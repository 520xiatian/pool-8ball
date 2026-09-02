/**
 * 本地服务器端到端测试
 * ---------------------------------------------------------------
 * 真的起一个 HTTP 服务，用真的 WebSocket 客户端连上去，
 * 验证「A 出杆 → B 通过推送收到」这条链路。
 *
 * 用 Node 内置的 WebSocket（Node 22+ 全局可用），不装依赖。
 * 用法：node scripts/test-server.js
 */
const assert = require('assert');
const path = require('path');

const { RoomStore } = require(path.join(__dirname, '..', 'server', 'store.js'));
const { Handler } = require(path.join(__dirname, '..', 'server', 'handler.js'));
const RM = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'room-logic.js'));

let pass = 0;
let fail = 0;
const queue = [];
function test(name, body) { queue.push({ name: name, body: body }); }
/** 分组标题：入队而非立即打印，否则会全部挤在测试结果之前 */
function section(title) { queue.push({ section: title }); }

const TA = 'a'.repeat(32);   // Alice 的 token
const TB = 'b'.repeat(32);   // Bob
const TC = 'c'.repeat(32);   // 局外人 Carol
const SHOT = { dx: 10000, dy: 0, power: 900 };

function freshHandler() {
  return new Handler(new RoomStore());
}

// ---------- 纯 Handler 层（不起网络） ----------

section('Handler 层');

test('token 缺失或格式非法一律拒绝', () => {
  const h = freshHandler();
  for (const bad of [undefined, '', 'short', 'ZZZ' + 'z'.repeat(29), 123, { a: 1 }]) {
    const r = h.handle({ action: 'create', token: bad });
    assert.strictEqual(r.ok, false, JSON.stringify(bad) + ' 居然通过了');
    assert.strictEqual(r.code, 'NO_AUTH');
  }
});

test('建房 → 加入 → 开局，座位与状态正确', () => {
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA, name: 'Alice' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.room.seat, 0);
  assert.strictEqual(c.room.status, 'waiting');

  const j = h.handle({ action: 'join', token: TB, code: c.room.code, name: 'Bob' });
  assert.strictEqual(j.ok, true);
  assert.strictEqual(j.room.seat, 1);
  assert.strictEqual(j.room.status, 'playing');
});

test('房间视图不含 token 或 uid', () => {
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA, name: 'Alice' });
  const json = JSON.stringify(c.room);
  assert.ok(json.indexOf(TA) === -1, '视图泄露了 token');
  assert.ok(json.indexOf('uid') === -1, '视图泄露了 uid');
});

test('回合归属：Alice 先手，Bob 出杆被拒', () => {
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA });
  h.handle({ action: 'join', token: TB, code: c.room.code });
  const id = c.room._id;

  const bob = h.handle({ action: 'shoot', token: TB, roomId: id, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(bob.code, 'NOT_YOUR_TURN');

  const alice = h.handle({ action: 'shoot', token: TA, roomId: id, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(alice.ok, true, JSON.stringify(alice));
  assert.strictEqual(alice.game.shotIndex, 1);
});

test('重放同一杆被 shotIndex 挡住', () => {
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA });
  h.handle({ action: 'join', token: TB, code: c.room.code });
  const id = c.room._id;

  assert.strictEqual(h.handle({ action: 'shoot', token: TA, roomId: id, shot: SHOT, shotIndex: 0 }).ok, true);
  const replay = h.handle({ action: 'shoot', token: TA, roomId: id, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(replay.ok, false);
  assert.ok(replay.code === 'STALE_SHOT' || replay.code === 'NOT_YOUR_TURN', '实际: ' + replay.code);
});

test('局外人既不能出杆也不能催超时', () => {
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA });
  h.handle({ action: 'join', token: TB, code: c.room.code });
  const id = c.room._id;

  assert.strictEqual(h.handle({ action: 'shoot', token: TC, roomId: id, shot: SHOT }).code, 'NOT_IN_ROOM');
  h.store.getById(id).turnDeadline = Date.now() - 1000;
  assert.strictEqual(h.handle({ action: 'timeout', token: TC, roomId: id }).code, 'NOT_IN_ROOM');
});

test('本地与云开发对同一杆判定完全一致', () => {
  const RULES = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'rules.js'));
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA });
  const j = h.handle({ action: 'join', token: TB, code: c.room.code });

  const local = RULES.applyShot(j.room.game, SHOT);
  const r = h.handle({ action: 'shoot', token: TA, roomId: c.room._id, shot: SHOT, shotIndex: 0 });
  assert.strictEqual(JSON.stringify(r.game.balls), JSON.stringify(local.state.balls),
    '服务端与客户端球态不一致');
  assert.strictEqual(r.game.turn, local.state.turn);
});

test('过期房间无法用房号加入', () => {
  const h = freshHandler();
  const c = h.handle({ action: 'create', token: TA });
  // 把创建时间推回到 TTL 之外
  h.store.getById(c.room._id).createdAt = Date.now() - RM.ROOM_TTL_MS - 1000;
  const j = h.handle({ action: 'join', token: TB, code: c.room.code });
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.code, 'NOT_FOUND');
});

test('sweep 清理过期房间', () => {
  const h = freshHandler();
  const c1 = h.handle({ action: 'create', token: TA });
  const c2 = h.handle({ action: 'create', token: TB });
  h.store.getById(c1.room._id).createdAt = Date.now() - RM.ROOM_TTL_MS - 1;
  const n = h.store.sweep(RM.ROOM_TTL_MS);
  assert.strictEqual(n, 1, '应清掉 1 间');
  assert.strictEqual(h.store.getById(c1.room._id), null);
  assert.ok(h.store.getById(c2.room._id), '不该误删新房');
});

test('store.update 的 guard 生效', () => {
  const store = new RoomStore();
  const doc = store.create({ code: 'AAAAAA', game: { shotIndex: 3 }, players: [null, null], createdAt: Date.now() });
  assert.strictEqual(store.update(doc._id, { code: 'BBBBBB' }, { 'game.shotIndex': 3 }), true);
  assert.strictEqual(store.getById(doc._id).code, 'BBBBBB');
  assert.strictEqual(store.update(doc._id, { code: 'CCCCCC' }, { 'game.shotIndex': 999 }), false);
  assert.strictEqual(store.getById(doc._id).code, 'BBBBBB', 'guard 不匹配却写入了');
});

// ---------- 端到端：真 HTTP + 真 WebSocket ----------

section('端到端 HTTP + WebSocket');

const srv = require(path.join(__dirname, '..', 'server', 'index.js'));

/** 起服务，返回 base url 与关闭函数 */
function listen() {
  return new Promise((resolve) => {
    // 端口 0 = 让系统分配空闲端口，避免与用户已开的服务冲突
    const s = srv.server.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      resolve({
        base: 'http://127.0.0.1:' + port,
        ws: 'ws://127.0.0.1:' + port,
        close: () => new Promise((r) => s.close(r))
      });
    });
  });
}

async function post(base, body) {
  const res = await fetch(base + '/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return await res.json();
}

/** 等一条满足条件的 WebSocket 消息，超时则报错 */
function waitFor(sock, predicate, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.removeEventListener('message', onMsg);
      reject(new Error('等待超时（' + (label || '消息') + '）'));
    }, ms || 4000);

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

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 4000);
    s.addEventListener('open', () => { clearTimeout(timer); resolve(s); });
    s.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); });
  });
}

test('E2E: /health 可用并列出局域网地址', async () => {
  const h = await listen();
  try {
    const res = await fetch(h.base + '/health');
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(Array.isArray(body.addresses) && body.addresses.length > 0, '没有返回可用地址');
  } finally { await h.close(); }
});

test('E2E: 非法路径与非法 JSON 都被安全拒绝', async () => {
  const h = await listen();
  try {
    const r404 = await fetch(h.base + '/nope');
    assert.strictEqual(r404.status, 404);

    const res = await fetch(h.base + '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json'
    });
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.code, 'BAD_ARG');
  } finally { await h.close(); }
});

test('E2E: WebSocket 连上即收到当前房间状态', async () => {
  const h = await listen();
  let sock;
  try {
    const c = await post(h.base, { action: 'create', token: TA, name: 'Alice' });
    sock = await openSocket(h.ws + '/ws?room=' + c.room._id + '&token=' + TA);
    const first = await waitFor(sock, (m) => m.type === 'room', 4000, '首次房间快照');
    assert.strictEqual(first.room.code, c.room.code);
    assert.strictEqual(first.room.seat, 0, 'token 应被识别为 0 号位');
  } finally {
    if (sock) sock.close();
    await h.close();
  }
});

test('E2E: 对手加入时，房主通过推送立刻收到', async () => {
  const h = await listen();
  let sock;
  try {
    const c = await post(h.base, { action: 'create', token: TA, name: 'Alice' });
    sock = await openSocket(h.ws + '/ws?room=' + c.room._id + '&token=' + TA);
    await waitFor(sock, (m) => m.type === 'room', 4000, '首次快照');

    const waiting = waitFor(sock, (m) => m.type === 'room' && m.room.status === 'playing', 4000, '开局推送');
    await post(h.base, { action: 'join', token: TB, code: c.room.code, name: 'Bob' });
    const msg = await waiting;
    assert.strictEqual(msg.room.players[1].name, 'Bob');
  } finally {
    if (sock) sock.close();
    await h.close();
  }
});

test('E2E: A 出杆，B 通过推送收到同一杆参数（联机主链路）', async () => {
  const h = await listen();
  let sockB;
  try {
    const c = await post(h.base, { action: 'create', token: TA, name: 'Alice' });
    await post(h.base, { action: 'join', token: TB, code: c.room.code, name: 'Bob' });

    sockB = await openSocket(h.ws + '/ws?room=' + c.room._id + '&token=' + TB);
    const first = await waitFor(sockB, (m) => m.type === 'room', 4000, '首次快照');
    assert.strictEqual(first.room.seat, 1, 'Bob 应是 1 号位');

    const waiting = waitFor(sockB, (m) => m.type === 'room' && m.room.game.shotIndex === 1, 4000, '出杆推送');
    const shootRes = await post(h.base, {
      action: 'shoot', token: TA, roomId: c.room._id, shot: SHOT, shotIndex: 0
    });
    assert.strictEqual(shootRes.ok, true, JSON.stringify(shootRes));

    const msg = await waiting;
    assert.strictEqual(msg.room.lastShot.by, 0, '推送里应标明是 0 号位出的杆');
    assert.deepStrictEqual(msg.room.lastShot.shot, SHOT, '推送的出杆参数与上传的不一致');
    // 关键：B 能靠这份参数本地重放出与服务端一致的画面
    assert.strictEqual(
      JSON.stringify(msg.room.game.balls),
      JSON.stringify(shootRes.game.balls),
      '推送的球态与服务端权威结果不一致'
    );
  } finally {
    if (sockB) sockB.close();
    await h.close();
  }
});

test('E2E: 推送体积远小于传坐标（验证省流量的说法）', async () => {
  const h = await listen();
  let sock;
  try {
    const c = await post(h.base, { action: 'create', token: TA });
    await post(h.base, { action: 'join', token: TB, code: c.room.code });
    sock = await openSocket(h.ws + '/ws?room=' + c.room._id + '&token=' + TB);
    await waitFor(sock, (m) => m.type === 'room', 4000, '首次快照');

    const waiting = waitFor(sock, (m) => m.type === 'room' && m.room.game.shotIndex === 1, 4000, '出杆推送');
    await post(h.base, { action: 'shoot', token: TA, roomId: c.room._id, shot: SHOT, shotIndex: 0 });
    const msg = await waiting;

    const shotBytes = JSON.stringify(msg.room.lastShot).length;
    assert.ok(!('frames' in msg.room.lastShot), 'lastShot 里带了 frames');
    assert.ok(shotBytes < 300, 'lastShot 太大了（' + shotBytes + ' 字节）');
    console.log('       （lastShot ' + shotBytes + ' 字节，整个房间快照 '
      + JSON.stringify(msg.room).length + ' 字节）');
  } finally {
    if (sock) sock.close();
    await h.close();
  }
});

test('E2E: 心跳 ping 得到 pong 回应', async () => {
  const h = await listen();
  let sock;
  try {
    const c = await post(h.base, { action: 'create', token: TA });
    sock = await openSocket(h.ws + '/ws?room=' + c.room._id + '&token=' + TA);
    await waitFor(sock, (m) => m.type === 'room', 4000, '首次快照');

    const waiting = waitFor(sock, (m) => m.type === 'pong', 4000, 'pong');
    sock.send('{"type":"ping"}');
    await waiting;
  } finally {
    if (sock) sock.close();
    await h.close();
  }
});

test('E2E: 连接不存在的房间被拒绝', async () => {
  const h = await listen();
  try {
    let rejected = false;
    try {
      const s = await openSocket(h.ws + '/ws?room=nope&token=' + TA);
      s.close();
    } catch (e) { rejected = true; }
    assert.strictEqual(rejected, true, '不存在的房间竟然连上了');
  } finally { await h.close(); }
});

test('E2E: 房主退出等待房后，订阅者收到 roomGone', async () => {
  const h = await listen();
  let sock;
  try {
    const c = await post(h.base, { action: 'create', token: TA });
    sock = await openSocket(h.ws + '/ws?room=' + c.room._id + '&token=' + TA);
    await waitFor(sock, (m) => m.type === 'room', 4000, '首次快照');

    const waiting = waitFor(sock, (m) => m.type === 'roomGone', 4000, 'roomGone');
    await post(h.base, { action: 'leave', token: TA, roomId: c.room._id });
    await waiting;
  } finally {
    if (sock) sock.close();
    await h.close();
  }
});

// ---------- 执行 ----------

(async () => {
  console.log('\n=== 本地联机服务器测试 ===');
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

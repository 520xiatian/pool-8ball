/**
 * 无头自测：不打开开发者工具也能验证物理与规则。
 * 用法：node scripts/test-logic.js
 */
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'physics.js'));
const R = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'rules.js'));

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}

console.log('\n[球堆摆放]');
test('16 颗球，无重叠，全在台面内', () => {
  const balls = P.createRack();
  assert.strictEqual(balls.length, 16);
  for (const b of balls) {
    assert.ok(b.x >= P.TABLE.R - 1 && b.x <= P.TABLE.W - P.TABLE.R + 1, '球 ' + b.id + ' x 越界: ' + b.x);
    assert.ok(b.y >= P.TABLE.R - 1 && b.y <= P.TABLE.H - P.TABLE.R + 1, '球 ' + b.id + ' y 越界: ' + b.y);
  }
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const dx = balls[i].x - balls[j].x;
      const dy = balls[i].y - balls[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      assert.ok(d >= P.TABLE.R * 2 - 0.01, '球 ' + balls[i].id + '/' + balls[j].id + ' 重叠, d=' + d);
    }
  }
});

test('球号 0..15 齐全，黑八在第三排中心', () => {
  const balls = P.createRack();
  const ids = balls.map(b => b.id).sort((a, b) => a - b);
  assert.deepStrictEqual(ids, [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
  const eight = balls.find(b => b.id === 8);
  assert.ok(Math.abs(eight.y - P.CENTER_Y) < 0.01, '黑八不在中线: ' + eight.y);
});

console.log('\n[物理模拟]');
test('全部球最终静止，且不会飞出台面', () => {
  const balls = P.createRack();
  const sim = P.simulate(balls, { dx: 10000, dy: 0, power: 1000 });
  assert.ok(sim.frames.length > 0, '没有产生动画帧');
  assert.ok(sim.frames.length < P.TABLE.MAX_FRAMES, '模拟没收敛，跑满了 ' + sim.frames.length + ' 帧');
  for (const b of sim.balls) {
    if (!b.active) continue;
    assert.strictEqual(b.vx, 0, '球 ' + b.id + ' 仍在移动');
    assert.strictEqual(b.vy, 0, '球 ' + b.id + ' 仍在移动');
    assert.ok(b.x >= -1 && b.x <= P.TABLE.W + 1, '球 ' + b.id + ' 飞出台面 x=' + b.x);
    assert.ok(b.y >= -1 && b.y <= P.TABLE.H + 1, '球 ' + b.id + ' 飞出台面 y=' + b.y);
  }
});

test('开球必然碰到球堆（firstHit 有值）', () => {
  const sim = P.simulate(P.createRack(), { dx: 10000, dy: 0, power: 900 });
  assert.notStrictEqual(sim.events.firstHit, -1, '开球空杆了');
});

test('同一杆重复模拟结果完全一致（确定性）', () => {
  const balls = P.createRack();
  const shot = { dx: 9701, dy: 2425, power: 777 };
  const a = P.simulate(balls, shot);
  const b = P.simulate(balls, shot);
  assert.strictEqual(JSON.stringify(a.balls), JSON.stringify(b.balls), '两次模拟球态不同');
  assert.strictEqual(JSON.stringify(a.frames), JSON.stringify(b.frames), '两次模拟帧序列不同');
  assert.strictEqual(JSON.stringify(a.events), JSON.stringify(b.events), '两次模拟事件不同');
});

test('模拟不修改输入球态', () => {
  const balls = P.createRack();
  const before = JSON.stringify(balls);
  P.simulate(balls, { dx: 10000, dy: 500, power: 800 });
  assert.strictEqual(JSON.stringify(balls), before, 'simulate 污染了入参');
});

test('白球直冲角袋 → 判定 cueScratch', () => {
  // 只留白球，正对左上角袋打
  const balls = [{ id: 0, x: 200, y: 200, vx: 0, vy: 0, active: true }];
  const sim = P.simulate(balls, { dx: -10000, dy: -10000, power: 700 });
  assert.strictEqual(sim.events.cueScratch, true, '白球没进袋');
});

test('台上只有白球 → firstHit = -1（空杆）', () => {
  const balls = [{ id: 0, x: 500, y: 250, vx: 0, vy: 0, active: true }];
  const sim = P.simulate(balls, { dx: 10000, dy: 0, power: 200 });
  assert.strictEqual(sim.events.firstHit, -1);
  assert.strictEqual(sim.events.cueScratch, false, '轻推不该进袋');
});

test('库边反弹被正确计数', () => {
  // 从中线水平打向右库，力度足够往返
  const balls = [{ id: 0, x: 500, y: 250, vx: 0, vy: 0, active: true }];
  const sim = P.simulate(balls, { dx: 10000, dy: 0, power: 800 });
  assert.ok(sim.events.anyCushion > 0, '没有记录到库边碰撞');
  assert.strictEqual(sim.events.cueScratch, false, '中线水平球不该进袋');
});

test('极低力度也能收敛', () => {
  const sim = P.simulate(P.createRack(), { dx: 10000, dy: 0, power: 50 });
  assert.ok(sim.frames.length < P.TABLE.MAX_FRAMES, '低力度没收敛');
});

console.log('\n[自由球摆位]');
test('findFreeSpot 返回台面内且不与他球重叠的点', () => {
  const balls = P.createRack();
  // 故意选在球堆正中间
  const eight = balls.find(b => b.id === 8);
  const spot = P.findFreeSpot(balls, eight.x, eight.y);
  assert.ok(spot.x >= P.TABLE.R && spot.x <= P.TABLE.W - P.TABLE.R, 'x 越界: ' + spot.x);
  assert.ok(spot.y >= P.TABLE.R && spot.y <= P.TABLE.H - P.TABLE.R, 'y 越界: ' + spot.y);
  for (const b of balls) {
    if (!b.active || b.id === 0) continue;
    const dx = b.x - spot.x;
    const dy = b.y - spot.y;
    assert.ok(Math.sqrt(dx * dx + dy * dy) >= P.TABLE.R * 2, '与球 ' + b.id + ' 重叠');
  }
});

console.log('\n[方向量化]');
test('quantizeAim 输出整数且模长约 10000', () => {
  const q = P.quantizeAim(3.7, -8.1);
  assert.ok(Number.isInteger(q.dx) && Number.isInteger(q.dy), '不是整数');
  const len = Math.sqrt(q.dx * q.dx + q.dy * q.dy);
  assert.ok(Math.abs(len - 10000) < 2, '模长偏差过大: ' + len);
});

test('零向量有兜底，不产生 NaN', () => {
  const q = P.quantizeAim(0, 0);
  assert.ok(Number.isFinite(q.dx) && Number.isFinite(q.dy));
  assert.ok(q.dx !== 0 || q.dy !== 0);
});

console.log('\n[规则裁决]');
test('白球落袋 → 犯规 + 换手 + 对手拿自由球', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.balls = [{ id: 0, x: 200, y: 200, vx: 0, vy: 0, active: true },
             { id: 3, x: 800, y: 400, vx: 0, vy: 0, active: true },
             { id: 8, x: 700, y: 100, vx: 0, vy: 0, active: true }];
  const res = R.applyShot(g, { dx: -10000, dy: -10000, power: 700 });
  assert.strictEqual(res.state.turn, 1, '没有换手');
  assert.strictEqual(res.state.ballInHand, true, '对手没拿到自由球');
  assert.ok(res.log.indexOf('白球落袋') !== -1, '播报不含白球落袋: ' + res.log);
});

test('犯规后白球重新回到台面', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.balls = [{ id: 0, x: 200, y: 200, vx: 0, vy: 0, active: true },
             { id: 3, x: 800, y: 400, vx: 0, vy: 0, active: true }];
  const res = R.applyShot(g, { dx: -10000, dy: -10000, power: 700 });
  const cue = res.state.balls[0];
  assert.strictEqual(cue.active, true, '白球没回到台面');
  assert.ok(cue.x > 0 && cue.x < P.TABLE.W, '白球位置非法');
});

test('归属分配：进全色球则己方全色、对手花色', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  // 3 号球贴在左下角袋口正前方，白球正对它打
  g.balls = [
    { id: 0, x: 300, y: 300, vx: 0, vy: 0, active: true },
    { id: 3, x: 200, y: 400, vx: 0, vy: 0, active: true },
    { id: 8, x: 700, y: 100, vx: 0, vy: 0, active: true },
    { id: 11, x: 750, y: 300, vx: 0, vy: 0, active: true }
  ];
  const res = R.applyShot(g, { dx: -7071, dy: 7071, power: 620 });
  if (res.state.groups[0] !== R.GROUP.NONE) {
    assert.strictEqual(res.state.groups[0], R.GROUP.SOLID, '己方应为全色');
    assert.strictEqual(res.state.groups[1], R.GROUP.STRIPE, '对手应为花色');
  }
});

test('开球杆不分配球组（大众打法）', () => {
  const g = R.createGame(0);
  const res = R.applyShot(g, { dx: 10000, dy: 0, power: 1000 });
  assert.strictEqual(res.state.groups[0], R.GROUP.NONE, '开球杆不该定归属');
  assert.strictEqual(res.state.groups[1], R.GROUP.NONE);
});

test('未清台就打进黑八 → 立即判负', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.groups = [R.GROUP.SOLID, R.GROUP.STRIPE];
  // 己方还剩 3 号；黑八摆在袋口，白球正对黑八
  g.balls = [
    { id: 0, x: 300, y: 300, vx: 0, vy: 0, active: true },
    { id: 8, x: 200, y: 400, vx: 0, vy: 0, active: true },
    { id: 3, x: 800, y: 100, vx: 0, vy: 0, active: true }
  ];
  const res = R.applyShot(g, { dx: -7071, dy: 7071, power: 620 });
  if (res.state.balls.find(b => b.id === 8).active === false) {
    assert.strictEqual(res.state.winner, 1, '提前打进黑八应判对手胜');
  }
});

test('清台后打进黑八 → 获胜', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.groups = [R.GROUP.SOLID, R.GROUP.STRIPE];
  // 己方全色球已清空，只剩黑八和对手的球
  g.balls = [
    { id: 0, x: 300, y: 300, vx: 0, vy: 0, active: true },
    { id: 8, x: 200, y: 400, vx: 0, vy: 0, active: true },
    { id: 11, x: 800, y: 100, vx: 0, vy: 0, active: true }
  ];
  assert.strictEqual(R.isOnEight(g, 0), true, '前提：应处于打黑八阶段');
  const res = R.applyShot(g, { dx: -7071, dy: 7071, power: 620 });
  if (res.state.balls.find(b => b.id === 8).active === false) {
    assert.strictEqual(res.state.winner, 0, '清台后进黑八应获胜');
  }
});

test('该打黑八却先碰别的球 → 犯规', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.groups = [R.GROUP.SOLID, R.GROUP.STRIPE];
  g.balls = [
    { id: 0, x: 300, y: 250, vx: 0, vy: 0, active: true },
    { id: 11, x: 500, y: 250, vx: 0, vy: 0, active: true },   // 对手球在正前方
    { id: 8, x: 800, y: 100, vx: 0, vy: 0, active: true }
  ];
  const res = R.applyShot(g, { dx: 10000, dy: 0, power: 600 });
  assert.strictEqual(res.state.turn, 1, '应换手');
  assert.strictEqual(res.state.ballInHand, true, '应给对手自由球');
});

test('空杆 → 犯规换手', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.balls = [{ id: 0, x: 500, y: 250, vx: 0, vy: 0, active: true },
             { id: 3, x: 500, y: 100, vx: 0, vy: 0, active: true }];
  // 朝着没有球的方向轻推
  const res = R.applyShot(g, { dx: 0, dy: 10000, power: 300 });
  assert.strictEqual(res.state.turn, 1, '空杆应换手');
  assert.ok(res.log.indexOf('空杆') !== -1 || res.log.indexOf('犯规') !== -1, '播报: ' + res.log);
});

test('applyShot 不修改输入 state', () => {
  const g = R.createGame(0);
  const before = JSON.stringify(g);
  R.applyShot(g, { dx: 10000, dy: 0, power: 800 });
  assert.strictEqual(JSON.stringify(g), before, 'applyShot 污染了入参');
});

test('shotIndex 每杆递增（联机乐观锁依赖它）', () => {
  let g = R.createGame(0);
  assert.strictEqual(g.shotIndex, 0);
  g = R.applyShot(g, { dx: 10000, dy: 0, power: 900 }).state;
  assert.strictEqual(g.shotIndex, 1);
  g = R.applyShot(g, { dx: -10000, dy: 0, power: 400 }).state;
  assert.strictEqual(g.shotIndex, 2);
});

test('自由球坐标越界时被夹取到合法位置', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.ballInHand = true;
  g.balls = [{ id: 0, x: 100, y: 100, vx: 0, vy: 0, active: true },
             { id: 3, x: 800, y: 250, vx: 0, vy: 0, active: true }];
  // 故意给一个越界坐标
  const res = R.applyShot(g, { dx: 10000, dy: 0, power: 500, cueX: -9999, cueY: 99999 });
  const cue = res.state.balls[0];
  assert.ok(cue.x >= 0 && cue.x <= P.TABLE.W, '白球 x 未夹取: ' + cue.x);
  assert.ok(cue.y >= 0 && cue.y <= P.TABLE.H, '白球 y 未夹取: ' + cue.y);
});

test('自由球摆位不会落在袋口吞噬范围内', () => {
  const balls = [{ id: 0, x: 100, y: 100, vx: 0, vy: 0, active: true },
                 { id: 3, x: 800, y: 250, vx: 0, vy: 0, active: true }];
  // 四个角 + 两个腰袋位置都试一遍
  const probes = [[-999, -999], [9999, -999], [-999, 9999], [9999, 9999], [500, -999], [500, 9999]];
  for (const [px, py] of probes) {
    const spot = P.findFreeSpot(balls, px, py);
    for (const p of P.POCKETS) {
      const d = Math.sqrt((p.x - spot.x) * (p.x - spot.x) + (p.y - spot.y) * (p.y - spot.y));
      assert.ok(d > p.r + P.TABLE.R,
        '摆位 (' + spot.x.toFixed(1) + ',' + spot.y.toFixed(1) + ') 离袋口太近: d=' + d.toFixed(1));
    }
  }
});

test('合法的自由球出杆后，自由球标记被清除', () => {
  const g = R.createGame(0);
  g.isBreak = false;
  g.ballInHand = true;
  g.balls = [{ id: 0, x: 100, y: 100, vx: 0, vy: 0, active: true },
             { id: 3, x: 600, y: 250, vx: 0, vy: 0, active: true }];
  // 摆到 3 号球正左侧，直线撞上去
  const res = R.applyShot(g, { dx: 10000, dy: 0, power: 600, cueX: 300, cueY: 250 });
  assert.strictEqual(res.state.ballInHand, false,
    '未犯规的出杆后不该还持自由球（log: ' + res.log + '）');
});

console.log('\n[人机对手]');
test('BOT 在各阶段都能给出合法出杆', () => {
  const BOT = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'bot.js'));
  const cases = [
    (() => { const g = R.createGame(1); return g; })(),
    (() => {
      const g = R.createGame(1);
      g.isBreak = false;
      g.groups = [R.GROUP.SOLID, R.GROUP.STRIPE];
      return g;
    })(),
    (() => {
      const g = R.createGame(1);
      g.isBreak = false;
      g.ballInHand = true;
      g.groups = [R.GROUP.SOLID, R.GROUP.STRIPE];
      return g;
    })()
  ];
  for (const g of cases) {
    const shot = BOT.pickShot(g, 1);
    assert.ok(Number.isInteger(shot.dx) && Number.isInteger(shot.dy), 'dx/dy 不是整数');
    assert.ok(shot.dx !== 0 || shot.dy !== 0, '零方向向量');
    assert.ok(shot.power > 0 && shot.power <= 1000, 'power 越界: ' + shot.power);
    // 出杆必须能被规则正常消化
    const res = R.applyShot(g, shot);
    assert.ok(res.state.shotIndex === g.shotIndex + 1, 'BOT 出杆未被规则接受');
  }
});

console.log('\n[整局压力测试]');
test('BOT 自我对战 60 杆内不崩、不出现非法状态', () => {
  const BOT = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'bot.js'));
  let g = R.createGame(0);
  let shots = 0;
  while (g.winner === -1 && shots < 60) {
    const shot = BOT.pickShot(g, 2);
    const res = R.applyShot(g, shot);
    g = res.state;
    shots++;

    // 每杆后都校验局面自洽
    const cue = g.balls[0];
    assert.strictEqual(cue.active, true, '第 ' + shots + ' 杆后白球不在台上');
    assert.ok(Number.isFinite(cue.x) && Number.isFinite(cue.y), '第 ' + shots + ' 杆后白球坐标是 NaN');
    for (const b of g.balls) {
      if (!b.active) continue;
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), '球 ' + b.id + ' 坐标 NaN');
      assert.ok(b.x >= -1 && b.x <= P.TABLE.W + 1, '球 ' + b.id + ' 越界 x=' + b.x);
      assert.ok(b.y >= -1 && b.y <= P.TABLE.H + 1, '球 ' + b.id + ' 越界 y=' + b.y);
    }
    assert.ok(g.turn === 0 || g.turn === 1, 'turn 非法: ' + g.turn);
  }
  console.log('       （共走了 ' + shots + ' 杆，winner=' + g.winner + '）');
});

console.log('\n[客户端与各后端逻辑一致性]');
test('三套后端的 physics/rules/room-logic 都与小程序端同步', () => {
  const fs = require('fs');
  const targets = [
    ['云函数', path.join(__dirname, '..', 'cloudfunctions', 'poolRoom', 'logic')],
    ['本地服务器', path.join(__dirname, '..', 'server', 'logic')],
    ['Cloudflare', path.join(__dirname, '..', 'cloudflare', 'src', 'logic')]
  ];
  for (const f of ['physics.js', 'rules.js', 'room-logic.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'logic', f), 'utf8');
    for (const [label, dir] of targets) {
      const dst = path.join(dir, f);
      assert.ok(fs.existsSync(dst), label + '缺少 ' + f + '，请运行 node scripts/sync-logic.js');
      // 副本多一行自动生成 banner，去掉首行再比
      const body = fs.readFileSync(dst, 'utf8').split('\n').slice(1).join('\n');
      assert.strictEqual(body, src,
        label + '的 ' + f + ' 与小程序端不一致，请运行 node scripts/sync-logic.js');
    }
  }
});

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('='.repeat(46) + '\n');
process.exit(fail === 0 ? 0 : 1);

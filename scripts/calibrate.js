// 物理参数标定：验证新的滑动/滚动两段摩擦、力度曲线、袋口互补性
const path = require('path');
const P = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'physics.js'));
const RULES = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'rules.js'));
const T = P.TABLE;

console.log('=== 袋口缺口与判定半径是否互补 ===');
for (const p of P.POCKETS) {
  console.log(`袋 (${p.x},${p.y}) r=${p.r} → 缺口半宽 m=${p.m.toFixed(2)}，贴库球心距袋心 sqrt(m²+R²)=${Math.sqrt(p.m * p.m + T.R * T.R).toFixed(2)} (应 = r)`);
}

console.log('\n=== 球是否还会飞出台面 ===');
let escaped = 0, checked = 0;
for (let seed = 0; seed < 400; seed++) {
  // 确定性遍历一圈方向 × 力度
  const a = seed % 40 / 40 * Math.PI * 2;
  const pw = 300 + (seed % 8) * 100;
  const balls = [
    { id: 0, x: 200 + (seed % 7) * 80, y: 100 + (seed % 5) * 75, vx: 0, vy: 0, active: true },
    { id: 3, x: 700, y: 250, vx: 0, vy: 0, active: true },
    { id: 11, x: 760, y: 300, vx: 0, vy: 0, active: true }
  ];
  const q = P.quantizeAim(Math.cos(a), Math.sin(a));
  const sim = P.simulate(balls, { dx: q.dx, dy: q.dy, power: pw });
  // 检查所有中间帧，球心不应出现在台面外
  for (const f of sim.frames) {
    for (let k = 0; k < f.length; k += 3) {
      checked++;
      if (f[k + 1] < -0.01 || f[k + 1] > T.W + 0.01 || f[k + 2] < -0.01 || f[k + 2] > T.H + 0.01) escaped++;
    }
  }
}
console.log(`检查 ${checked} 个球位，飞出台面 ${escaped} 次 ${escaped === 0 ? '✓' : '✗'}`);

console.log('\n=== 力度 → 走位距离（空台单球滑行）===');
console.log('拖动%  实际滑行(台长)  线性度');
for (const frac of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const pw = Math.round(frac * 1000);
  const balls = [{ id: 0, x: T.R + 2, y: 250, vx: 0, vy: 0, active: true }];
  const sim = P.simulate(balls, { dx: 10000, dy: 3, power: pw });
  // 累计总路程
  let dist = 0;
  for (let i = 1; i < sim.frames.length; i++) {
    dist += Math.hypot(sim.frames[i][1] - sim.frames[i - 1][1], sim.frames[i][2] - sim.frames[i - 1][2]);
  }
  console.log(`  ${(frac * 100).toFixed(0).padStart(3)}%      ${(dist / T.W).toFixed(2)}        ${(dist / T.W / frac).toFixed(2)}`);
}

console.log('\n=== 定杆：正面对心击打，白球撞后跟进多少 ===');
for (const pw of [300, 500, 700, 1000]) {
  const balls = [
    { id: 0, x: 200, y: 250, vx: 0, vy: 0, active: true },
    { id: 3, x: 400, y: 250, vx: 0, vy: 0, active: true }
  ];
  const sim = P.simulate(balls, { dx: 10000, dy: 0, power: pw });
  const cue = sim.balls.find(b => b.id === 0);
  const tgt = sim.balls.find(b => b.id === 3);
  const contactX = 400 - T.R * 2;
  console.log(`power ${String(pw).padStart(4)}: 白球停在 x=${cue.x.toFixed(1)}（接触点 ${contactX.toFixed(1)}）跟进 ${(cue.x - contactX).toFixed(1)}unit=${((cue.x - contactX) / (T.R * 2)).toFixed(2)}球径，目标球走到 x=${tgt.active ? tgt.x.toFixed(1) : '落袋'}`);
}

console.log('\n=== 一杆时长 ===');
for (const pw of [200, 400, 600, 800, 1000]) {
  const sim = P.simulate(P.createRack(), { dx: 10000, dy: 0, power: pw });
  console.log(`power ${String(pw).padStart(4)} → ${String(sim.frames.length).padStart(3)} 帧 = ${(sim.frames.length / 60).toFixed(2)}s  库${sim.events.anyCushion}次  落袋[${sim.events.potted}]  音效${sim.audio.length / 3}条`);
}

console.log('\n=== 收尾几帧（是否有余韵）===');
{
  const balls = [{ id: 0, x: T.R + 2, y: 250, vx: 0, vy: 0, active: true }];
  const sim = P.simulate(balls, { dx: 10000, dy: 3, power: 500 });
  const n = sim.frames.length;
  console.log('总帧', n, '=', (n / 60).toFixed(2), 's');
  for (const i of [1, 5, 15, 30, 60, n - 30, n - 10, n - 3, n - 1].filter(x => x > 0 && x < n)) {
    const d = Math.hypot(sim.frames[i][1] - sim.frames[i - 1][1], sim.frames[i][2] - sim.frames[i - 1][2]);
    console.log(`  frame ${String(i).padStart(3)}/${n}: 每帧 ${d.toFixed(2)}unit`);
  }
}

console.log('\n=== 确定性 ===');
{
  const balls = P.createRack();
  const shot = { dx: 9701, dy: 2425, power: 777 };
  const a = P.simulate(balls, shot);
  const b = P.simulate(balls, shot);
  console.log('球态一致:', JSON.stringify(a.balls) === JSON.stringify(b.balls));
  console.log('帧序一致:', JSON.stringify(a.frames) === JSON.stringify(b.frames));
  console.log('音轨一致:', JSON.stringify(a.audio) === JSON.stringify(b.audio));
  console.log('球态字段:', Object.keys(a.balls[0]).join(','), '（不应含 rv）');
}

console.log('\n=== MAX_FRAMES 收敛压力 ===');
{
  let worst = 0, worstDesc = '';
  for (let s = 0; s < 200; s++) {
    const a = s / 200 * Math.PI * 2;
    const q = P.quantizeAim(Math.cos(a), Math.sin(a));
    const sim = P.simulate(P.createRack(), { dx: q.dx, dy: q.dy, power: 1000 });
    if (sim.frames.length > worst) { worst = sim.frames.length; worstDesc = `角度 ${(a * 180 / Math.PI).toFixed(0)}°`; }
  }
  console.log(`满力最长一杆 ${worst} 帧 = ${(worst / 60).toFixed(2)}s (${worstDesc})，上限 ${T.MAX_FRAMES} ${worst < T.MAX_FRAMES ? '✓' : '✗'}`);
}

console.log('\n=== 音轨规模 ===');
{
  const sim = P.simulate(P.createRack(), { dx: 10000, dy: 0, power: 1000 });
  console.log('开球满力音效条数 =', sim.audio.length / 3);
  const types = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < sim.audio.length; i += 3) types[sim.audio[i + 1]]++;
  console.log('球撞球', types[1], '撞库', types[2], '落袋', types[3]);
  console.log('前 8 条:', JSON.stringify(sim.audio.slice(0, 24)));
}

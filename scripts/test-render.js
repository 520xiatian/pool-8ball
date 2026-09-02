// 渲染器几何自测：投影/反投影往返、fit 包围盒、视角连续性
// 用法：node scripts/test-render.js
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'physics.js'));
const RENDER = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'renderer.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** 极简的 CanvasRenderingContext2D 替身：只记录调用，不真画 */
function fakeCtx() {
  const calls = [];
  const noop = function () {};
  const c = {
    calls: calls,
    canvas: null,
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '',
    textAlign: '', textBaseline: '',
    // 变换栈：为了让 ellipsePath 的 save/restore 配平检查有意义
    _depth: 0,
    save() { this._depth++; calls.push(['save']); },
    restore() { this._depth--; assert.ok(this._depth >= 0, 'restore 多于 save'); calls.push(['restore']); },
    scale: noop, translate: noop, rotate: noop, setTransform: noop,
    beginPath() { calls.push(['beginPath']); },
    closePath: noop, moveTo: noop, lineTo: noop, arcTo: noop, rect: noop,
    arc: noop, ellipse: noop,
    fill() { calls.push(['fill']); },
    stroke() { calls.push(['stroke']); },
    clip: noop, clearRect: noop, fillRect: noop, fillText: noop,
    setLineDash: noop,
    createLinearGradient() { return { addColorStop: noop }; },
    createRadialGradient() { return { addColorStop: noop }; }
  };
  return c;
}

function makeRenderer(w, h, tilt) {
  const ctx = fakeCtx();
  const canvas = { width: 0, height: 0, style: {} };
  const r = RENDER.createRenderer(canvas, ctx, w, h, 2);
  if (tilt !== undefined) r.setTilt(tilt);
  return { r: r, ctx: ctx, canvas: canvas };
}

console.log('\n[投影 / 反投影往返]');
[0, 0.25, 0.5, 0.75, 1].forEach(t => {
  test('tilt=' + t + ' 时 toLogic(toScreen(p)) 回到原点', () => {
    const { r } = makeRenderer(800, 500, t);
    // 覆盖台面四角、边中点、台心
    const pts = [];
    for (const x of [0, P.TABLE.R, P.TABLE.W / 2, P.TABLE.W - P.TABLE.R, P.TABLE.W]) {
      for (const y of [0, P.TABLE.R, P.TABLE.H / 2, P.TABLE.H - P.TABLE.R, P.TABLE.H]) {
        pts.push([x, y]);
      }
    }
    let worst = 0;
    for (const [x, y] of pts) {
      const s = r.toScreen(x, y);
      const back = r.toLogic(s.x, s.y);
      const err = Math.max(Math.abs(back.x - x), Math.abs(back.y - y));
      if (err > worst) worst = err;
    }
    assert.ok(worst < 1e-6, '最大往返误差 ' + worst + ' 逻辑单位');
  });
});

console.log('\n[整张台子落在画布内]');
[[800, 500], [400, 700], [1200, 400], [360, 640], [900, 300]].forEach(([w, h]) => {
  [0, 0.5, 1].forEach(t => {
    test(`${w}x${h} tilt=${t}：台子含木框不越界`, () => {
      const { r } = makeRenderer(w, h, t);
      const oW = P.TABLE.W + 27, oH = P.TABLE.H + 27;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const x of [-27, P.TABLE.W / 2, oW]) {
        for (const y of [-27, P.TABLE.H / 2, oH]) {
          for (const z of [0, 16, P.TABLE.R * 2]) {   // 含球心高度
            const p = r.project(x, y, z);
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
          }
        }
      }
      assert.ok(minX >= -1, '左越界 ' + minX.toFixed(1));
      assert.ok(minY >= -1, '上越界 ' + minY.toFixed(1));
      assert.ok(maxX <= w + 1, '右越界 ' + maxX.toFixed(1) + ' > ' + w);
      assert.ok(maxY <= h + 1, '下越界 ' + maxY.toFixed(1) + ' > ' + h);
      // 也不能缩得太小，否则等于白留一大片
      assert.ok((maxX - minX) > w * 0.5 || (maxY - minY) > h * 0.5,
        '台子太小：' + (maxX - minX).toFixed(0) + 'x' + (maxY - minY).toFixed(0));
    });
  });
});

console.log('\n[tilt=0 与旧版 2D 画面等价]');
test('tilt=0 时球心高度不影响屏幕位置（正交俯视）', () => {
  const { r } = makeRenderer(800, 500, 0);
  const a = r.project(500, 250, 0);
  const b = r.project(500, 250, P.TABLE.R);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9,
    '俯视下高度产生了位移：' + JSON.stringify([a, b]));
});

test('tilt=0 时同一 y 上所有点缩放一致（无透视）', () => {
  const { r } = makeRenderer(800, 500, 0);
  const k0 = r.project(0, 0, 0).k;
  const k1 = r.project(1000, 500, 0).k;
  assert.strictEqual(k0, 1, 'k 不为 1');
  assert.strictEqual(k1, 1, 'k 不为 1');
});

test('tilt=0 时 x 与 y 比例相同（正圆袋口 / 不变形）', () => {
  const { r } = makeRenderer(800, 500, 0);
  const o = r.project(500, 250, 0);
  const dx = r.project(600, 250, 0).x - o.x;
  const dy = r.project(500, 350, 0).y - o.y;
  assert.ok(Math.abs(dx - dy) < 1e-9, '各向不等比：' + dx + ' vs ' + dy);
});

console.log('\n[3D 透视性质]');
test('tilt=1 时近端比远端大', () => {
  const { r } = makeRenderer(800, 500, 1);
  const far = r.project(500, 0, 0).k;
  const near = r.project(500, 500, 0).k;
  assert.ok(near > far * 1.15, '透视太弱：near=' + near.toFixed(3) + ' far=' + far.toFixed(3));
});

test('tilt=1 时纵向被压缩（俯角小于 90°）', () => {
  const { r } = makeRenderer(800, 500, 1);
  const o = r.project(500, 250, 0);
  const dx = Math.abs(r.project(600, 250, 0).x - o.x);
  const dy = Math.abs(r.project(500, 350, 0).y - o.y);
  assert.ok(dy < dx * 0.95, '纵向没压缩：dx=' + dx.toFixed(1) + ' dy=' + dy.toFixed(1));
});

test('tilt=1 时球心抬高会让球往屏幕上方移', () => {
  const { r } = makeRenderer(800, 500, 1);
  const ground = r.project(500, 250, 0);
  const center = r.project(500, 250, P.TABLE.R);
  assert.ok(center.y < ground.y - 1, '球心没抬起来');
});

test('球半径随远近变化，且都是正数', () => {
  const { r } = makeRenderer(800, 500, 1);
  const near = r.ballRadiusAt(500, 490);
  const far = r.ballRadiusAt(500, 10);
  assert.ok(far > 0 && near > far, `近 ${near.toFixed(1)} 应大于远 ${far.toFixed(1)}`);
});

console.log('\n[视角连续性：不能有跳变]');
test('tilt 从 0 连续走到 1，台心投影平滑移动', () => {
  const { r } = makeRenderer(800, 500);
  let prev = null, worst = 0;
  for (let i = 0; i <= 200; i++) {
    r.setTilt(i / 200);
    const p = r.project(500, 250, 0);
    if (prev) {
      const jump = Math.hypot(p.x - prev.x, p.y - prev.y);
      if (jump > worst) worst = jump;
    }
    prev = p;
  }
  assert.ok(worst < 6, '相邻 tilt 步之间跳了 ' + worst.toFixed(2) + 'px');
});

test('tilt 全程反投影都稳定（不出现 NaN / 巨大值）', () => {
  const { r } = makeRenderer(800, 500);
  for (let i = 0; i <= 100; i++) {
    r.setTilt(i / 100);
    for (const sx of [0, 400, 800]) {
      for (const sy of [0, 250, 500]) {
        const p = r.toLogic(sx, sy);
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y),
          `tilt=${i / 100} 屏幕(${sx},${sy}) → ${JSON.stringify(p)}`);
        assert.ok(Math.abs(p.x) < 1e5 && Math.abs(p.y) < 1e5,
          `tilt=${i / 100} 反投影爆了：${JSON.stringify(p)}`);
      }
    }
  }
});

test('setTilt 夹取越界输入', () => {
  const { r } = makeRenderer(800, 500);
  r.setTilt(-3); assert.strictEqual(r.getTilt(), 0);
  r.setTilt(9);  assert.strictEqual(r.getTilt(), 1);
});

console.log('\n[绘制不崩、save/restore 配平]');
[0, 0.5, 1].forEach(t => {
  test('tilt=' + t + ' 画整局不抛异常且变换栈配平', () => {
    const { r, ctx } = makeRenderer(800, 500, t);
    const balls = P.createRack();
    r.clear();
    r.drawTable();
    for (const b of balls) r.advanceSpin(b);
    r.drawBalls(balls);
    r.strokeOnCloth(100, 100, 900, 400);
    r.strokeCircleOnCloth(500, 250, P.TABLE.R);
    assert.strictEqual(ctx._depth, 0, '变换栈没配平，剩余深度 ' + ctx._depth);
    assert.ok(ctx.calls.length > 50, '几乎没画东西：' + ctx.calls.length + ' 次调用');
  });
});

test('drawBalls 不修改入参顺序与内容', () => {
  const { r } = makeRenderer(800, 500, 1);
  const balls = P.createRack();
  const before = JSON.stringify(balls);
  r.drawBalls(balls);
  assert.strictEqual(JSON.stringify(balls), before, 'drawBalls 污染了入参');
});

test('滚动相位随位移累积，摆位跳变时不累积', () => {
  const { r } = makeRenderer(800, 500, 0);
  const b = { id: 3, x: 100, y: 250, active: true };
  r.advanceSpin(b);                       // 建立初始位置
  b.x = 110; r.advanceSpin(b);            // 正常滚动 10 单位
  b.x = 900; r.advanceSpin(b);            // 摆位跳变，不该积分
  // 没有直接读相位的接口，用「画出来的号码位置」间接验证不会突变
  // 这里只要求不抛异常、且后续绘制正常
  r.drawBall(b);
});

console.log('\n=============================================='
  + '\n通过 ' + pass + ' 项，失败 ' + fail + ' 项'
  + '\n==============================================\n');
process.exit(fail ? 1 : 0);

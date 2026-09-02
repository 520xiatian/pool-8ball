/**
 * Canvas 2D 渲染器 —— 俯视 2D ⇄ 透视 3D 平滑互转
 * ---------------------------------------------------------------
 * 逻辑坐标（1000×500 的台面平面）→ 屏幕坐标的换算全部集中在这里，其余
 * 代码一律只用逻辑坐标。物理、规则、联机三层完全不受视角和屏幕尺寸影响。
 *
 * 视角由一个 tilt ∈ [0,1] 控制，中间值都是合法画面，所以「切视角」不是
 * 两套渲染器互换，而是同一台相机在连续移动：
 *
 *   tilt = 0  仰角 90°，透视强度 0 → 正交俯视，与旧版 2D 画面逐像素等价
 *   tilt = 1  仰角 48°，视距 1250 → 透视，库边有厚度、近大远小
 *
 * 关键取舍：透视强度按 1/D 线性插值而不是插 D。直接插视距的话，前 90%
 * 的行程画面几乎不动，最后一瞬间猛地拉进来。
 *
 * 本文件可以放心用 sin/cos/atan2 —— 它只画画，不参与任何判定，各端浮点
 * 差异最多让高光偏半个像素。physics.js 那边的确定性禁令不适用于此。
 */
const P = require('./physics.js');

// 球色表：0 白，1-7 全色，8 黑，9-15 花色（同色带白条）
const COLORS = {
  0: '#f6f6f2', 1: '#e8b923', 2: '#2c5fbf', 3: '#c0392b', 4: '#6c3fa0',
  5: '#e07b39', 6: '#2e8b57', 7: '#7b2d26', 8: '#1d1d1f',
  9: '#e8b923', 10: '#2c5fbf', 11: '#c0392b', 12: '#6c3fa0',
  13: '#e07b39', 14: '#2e8b57', 15: '#7b2d26'
};

const TAU = Math.PI * 2;

// 位移超过这么多就不是「滚过去的」而是摆位/换局，此时不把假位移积分进
// 滚动相位，否则球会凭空自转半圈。
const TELEPORT_D = P.TABLE.R * 6;

// ---- 相机 ----
const PHI_TOP = Math.PI / 2;          // 俯视：正上方
const PHI_3D = 48 * Math.PI / 180;    // 3D：视线与台面成 48°
const DIST_3D = 1250;                 // 3D 视点到台心的距离（台长 1000）
const PAD = 26;                       // 画面四周留白（px）

// 库边木框几何，单位与台面一致
const RAIL_W = 27;                    // 台面外沿宽度
const RAIL_H = 16;                    // 库边高出台布多少（真实约球径的 0.63）

/**
 * 建立渲染器。
 *
 * @param canvas/ctx  画布与 2D 上下文
 * @param cssW/cssH   画布的 CSS 尺寸
 * @param dpr         设备像素比
 * @returns 渲染接口；视角用 setTilt(0..1) 控制，见文件头注释
 */
function createRenderer(canvas, ctx, cssW, cssH, dpr) {
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const HALF_W = P.TABLE.W / 2;
  const HALF_H = P.TABLE.H / 2;

  // ---- 当前相机状态，setTilt 里重算 ----
  let tilt = 0;
  let sinPhi = 1;      // 仰角正弦：台面 y 方向在屏幕上被压缩的比例
  let persp = 0;       // 透视强度 = 1/D，0 即正交
  let scale = 1;       // 逻辑单位 → 屏幕像素
  let camX = 0;        // 视点在台面平面上的投影（始终看台心）
  let camY = 0;
  let originX = 0;     // 台心在屏幕上的位置
  let originY = 0;

  setTilt(0);

  /**
   * 把台面坐标 (x, y) 加上离台布的高度 z，投到屏幕。
   *
   * 相机架在台面近侧正上方、俯角 phi，始终看向台心：
   *   视点     = (0, D·cosφ, D·sinφ)      —— 台心为原点，Z 轴垂直向上
   *   屏幕右   = 台面长边方向，不受俯角影响
   *   屏幕上   = (0, -sinφ, cosφ)          —— 台面短边与竖直方向的混合
   *
   * 于是 screenY = ly·sinφ − z·cosφ：俯视时 φ=90°，cosφ=0，高度对画面毫无
   * 影响（正对着看，球心抬高 R 也不会挪位）；越倾斜 cosφ 越大，库边和球的
   * 厚度才逐渐"立"起来。
   *
   * 透视放大 k = 1/(1 − persp·(ly·cosφ + z·sinφ))：离相机近（ly 大、位置高）
   * 的东西更大。persp = 0 时退化为正交投影。
   */
  function project(x, y, z) {
    const lx = x - HALF_W;              // 相对台心
    const ly = y - HALF_H;
    const cosP = cosPhi();
    const zz = z || 0;
    const k = 1 / (1 - persp * (ly * cosP + zz * sinPhi));
    return {
      x: originX + lx * scale * k,
      y: originY + (ly * sinPhi - zz * cosP) * scale * k,
      k: k                              // 该点的缩放比，画球时要用
    };
  }

  function cosPhi() {
    // sinPhi 已知，取正的余弦（俯角总在 0..90°）
    const c = 1 - sinPhi * sinPhi;
    return c <= 0 ? 0 : Math.sqrt(c);
  }

  /** 兼容旧接口：台布平面上的点 */
  function toScreen(x, y) {
    return project(x, y, 0);
  }

  /**
   * 屏幕坐标反投影回台布平面（z = 0），用于把手指位置换成瞄准点。
   *
   * 因为 k 只依赖 ly，可以先从屏幕 y 单独解出 ly，再回代求 lx，不用迭代：
   *   v = (sy − originY)/scale = ly·sinφ / (1 − persp·cosφ·ly)
   *   ⇒ ly = v / (sinφ + v·persp·cosφ)
   */
  function toLogic(sx, sy) {
    const cosP = cosPhi();
    const v = (sy - originY) / scale;
    const denom = sinPhi + v * persp * cosP;
    // denom → 0 表示这条屏幕射线与台面平行（打在地平线上），兜底回台心
    const ly = denom === 0 ? 0 : v / denom;
    const k = 1 / (1 - persp * ly * cosP);
    const lx = (sx - originX) / (scale * k);
    return { x: lx + HALF_W, y: ly + HALF_H };
  }

  /**
   * 设定视角。t ∈ [0,1]，0 = 俯视 2D，1 = 透视 3D，中间值是合法的过渡画面。
   * 每次改完都要重算 scale/origin，让台面（含库边和 3D 下抬起的近边）
   * 始终完整落在画布里。
   */
  function setTilt(t) {
    tilt = t < 0 ? 0 : (t > 1 ? 1 : t);
    const phi = PHI_TOP + (PHI_3D - PHI_TOP) * tilt;
    sinPhi = Math.sin(phi);
    // 透视强度插 1/D 而不是 D：直接插 D 的话前 90% 行程画面几乎不动
    persp = tilt / DIST_3D;
    fit();
  }

  /**
   * 求出能让整张台子（连木框）刚好塞进画布的 scale 和台心屏幕位置。
   *
   * 直接解析求解很麻烦（scale 影响透视、透视又影响包围盒），但投影对 scale
   * 是线性齐次的：先用 scale = 1 投出包围盒，再按画布尺寸整体放大即可。
   */
  function fit() {
    scale = 1;
    originX = 0;
    originY = 0;

    // 取台面四角 + 四边中点的上下两个高度，覆盖整个可见外壳
    const xs = [-RAIL_W, P.TABLE.W / 2, P.TABLE.W + RAIL_W];
    const ys = [-RAIL_W, P.TABLE.H / 2, P.TABLE.H + RAIL_W];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < ys.length; j++) {
        for (let h = 0; h <= 1; h++) {
          const p = project(xs[i], ys[j], h * RAIL_H);
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
      }
    }

    const availW = cssW - PAD * 2;
    const availH = cssH - PAD * 2;
    scale = Math.min(availW / (maxX - minX), availH / (maxY - minY));
    // 把包围盒中心摆到画布中心
    originX = cssW / 2 - (minX + maxX) / 2 * scale;
    originY = cssH / 2 - (minY + maxY) / 2 * scale;
  }

  function getTilt() { return tilt; }

  /** 球在当前视角下的屏幕半径（透视下随远近变化，故要传球位） */
  function ballRadiusAt(x, y) {
    return P.TABLE.R * scale * project(x, y, P.TABLE.R).k;
  }

  function clear() {
    ctx.clearRect(0, 0, cssW, cssH);
  }

  // ---- 球面滚动相位 ----
  //
  // 号码和腰带跟着位移转起来，是「在滚」和「在滑」的分水岭：球面纹理不动
  // 的话，大脑立刻判定这是两个圆片在平移，物理算得多准都会觉得发飘。
  //
  // 不做严格的球面贴图投影（25 像素的球上纯属浪费），而是把号码圈和腰带
  // 当成球面同一处的花纹：沿运动方向前后扫（sin 相位）、越靠边缘越窄、
  // 转到背面就淡出。三样一起动足够读成「在滚」。
  const spin = {};

  function spinOf(b) {
    let s = spin[b.id];
    if (!s) { s = spin[b.id] = { x: b.x, y: b.y, a: 0, dx: 1, dy: 0 }; }
    return s;
  }

  /**
   * 按本帧位移推进滚动相位。每帧对每颗球调一次，且必须在 drawBall 之前。
   * 独立成函数而不是塞进 drawBall，因为瞄准预览会重复绘制同一颗球，
   * 那时不该再积分一次相位。
   */
  function advanceSpin(b) {
    const s = spinOf(b);
    const mx = b.x - s.x;
    const my = b.y - s.y;
    s.x = b.x;
    s.y = b.y;
    const d = Math.sqrt(mx * mx + my * my);
    if (d === 0) return;
    if (d > TELEPORT_D) return;          // 摆位/换局：不积分假位移
    s.a += d / P.TABLE.R;                // 滚过弧长 = 位移 ⇒ 转角 = 位移/半径
    if (s.a > TAU * 1024) s.a -= TAU * 1024;   // 防长局累积成大浮点数
    s.dx = mx / d;
    s.dy = my / d;
  }

  /** 换局 / 自由球摆位后清掉相位，免得新局第一帧凭空转半圈 */
  function resetSpin() {
    for (const k in spin) delete spin[k];
  }

  // ================== 台面 ==================

  /** 沿一串台面坐标点连成路径（可带统一高度） */
  function pathAlong(pts, z) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = project(pts[i][0], pts[i][1], z);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  }

  /**
   * 画整张台子。绘制顺序即遮挡顺序（画家算法）：
   * 木框顶面 → 台布 → 袋洞 → 远端库皮内立面 → 近端木框外立面。
   *
   * 只画**朝向相机**的立面。相机架在台面中轴线正上方（x = 台心），所以
   * 左右两侧那些 x = 常数的立面是正侧向对着相机的，几何上完全看不见 ——
   * 画了反而在台布左右边缘留下两道贴边的亮线。
   */
  function drawTable() {
    const W = P.TABLE.W;
    const H = P.TABLE.H;
    const oW = W + RAIL_W;    // 木框外沿
    const oH = H + RAIL_W;
    const solid = tilt > 0.001;   // 正俯视时 cosφ = 0，高度不产生位移，立面无从可见

    // ---- 木框顶面（一整圈，含四角）----
    ctx.fillStyle = '#6b4423';
    pathAlong([[-RAIL_W, -RAIL_W], [oW, -RAIL_W], [oW, oH], [-RAIL_W, oH]], RAIL_H);
    ctx.fill();

    // ---- 台布 ----
    ctx.fillStyle = '#1b7a4e';
    pathAlong([[0, 0], [W, 0], [W, H], [0, H]], 0);
    ctx.fill();

    // 台布明暗：远端稍亮、近端压暗，3D 下这层渐变承担大半的纵深感
    const top = project(W / 2, 0, 0);
    const bot = project(W / 2, H, 0);
    const g = ctx.createLinearGradient(top.x, top.y, bot.x, bot.y);
    g.addColorStop(0, 'rgba(255,255,255,' + (0.06 + 0.05 * tilt) + ')');
    g.addColorStop(0.55, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,' + (0.14 + 0.10 * tilt) + ')');
    ctx.save();
    pathAlong([[0, 0], [W, 0], [W, H], [0, H]], 0);
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();

    // ---- 开球线 ----
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const b0 = project(P.BREAK_X, 0, 0);
    const b1 = project(P.BREAK_X, H, 0);
    ctx.moveTo(b0.x, b0.y);
    ctx.lineTo(b1.x, b1.y);
    ctx.stroke();

    // ---- 袋洞：椭圆（俯视时正圆，倾斜后被 sinφ 压扁）----
    for (let i = 0; i < P.POCKETS.length; i++) {
      const pk = P.POCKETS[i];
      const c = project(pk.x, pk.y, 0);
      const rx = pk.r * scale * c.k * 0.92;
      ellipsePath(c.x, c.y, rx, rx * sinPhi);
      ctx.fillStyle = '#0a0a0a';
      ctx.fill();
    }

    // ---- 远端库皮内立面 ----
    // 台布远边（z=0）与木框顶面内沿（z=RAIL_H）之间那道竖直的绿边。
    // 不画的话这里会露出一条 10px 左右的木色缝。
    if (solid) {
      ctx.fillStyle = '#15603d';
      ctx.beginPath();
      let p = project(0, 0, 0);        ctx.moveTo(p.x, p.y);
      p = project(W, 0, 0);            ctx.lineTo(p.x, p.y);
      p = project(W, 0, RAIL_H);       ctx.lineTo(p.x, p.y);
      p = project(0, 0, RAIL_H);       ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 近端木框外立面：整张台子"有厚度"主要靠它 ----
    if (solid) {
      const nf = project(W / 2, oH, RAIL_H);
      const nb = project(W / 2, oH, 0);
      const wg = ctx.createLinearGradient(nf.x, nf.y, nb.x, nb.y);
      wg.addColorStop(0, '#5a381d');
      wg.addColorStop(1, '#33200f');
      ctx.fillStyle = wg;
      ctx.beginPath();
      let p = project(-RAIL_W, oH, RAIL_H); ctx.moveTo(p.x, p.y);
      p = project(oW, oH, RAIL_H);          ctx.lineTo(p.x, p.y);
      p = project(oW, oH, 0);               ctx.lineTo(p.x, p.y);
      p = project(-RAIL_W, oH, 0);          ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 库边内沿描边，把台布和木框分开 ----
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1.5;
    pathAlong([[0, 0], [W, 0], [W, H], [0, H]], 0);
    ctx.stroke();
  }

  /**
   * 画椭圆路径（不填充，调用方自己 fill/stroke）。
   * 小程序端 Canvas 不保证有 ctx.ellipse，所以用变换 + arc 兜底。
   *
   * 注意：路径点在加入时就被当前变换矩阵吃掉了，所以 restore 之后再
   * fill 得到的形状仍然是椭圆 —— 但纯色填充才安全，渐变会按 restore
   * 后的矩阵解释。需要渐变的地方（球体）不要走这里。
   */
  function ellipsePath(cx, cy, rx, ry) {
    if (rx <= 0.01) rx = 0.01;
    if (ry <= 0.01) ry = 0.01;
    ctx.save();
    ctx.beginPath();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    ctx.arc(0, 0, rx, 0, TAU);
    ctx.restore();
  }

  // ================== 球 ==================

  /**
   * 画一颗球。球心离台布 R 高，所以 3D 下球体比它的落点更靠上 —— 这个
   * 位移加上单独画的落地阴影，就是"球坐在台面上"而不是"贴在台面上"的
   * 全部来源。
   */
  function drawBall(b) {
    const base = project(b.x, b.y, 0);        // 落点（阴影用）
    const c = project(b.x, b.y, P.TABLE.R);   // 球心
    const r = P.TABLE.R * scale * c.k;
    const color = COLORS[b.id] || '#ccc';
    const sp = spinOf(b);

    // 运动方向要投到屏幕上再用：3D 下纵向被压缩，直接拿逻辑方向会让
    // 号码朝着错误的方向扫。
    const a0 = project(b.x, b.y, P.TABLE.R);
    const a1 = project(b.x + sp.dx * 10, b.y + sp.dy * 10, P.TABLE.R);
    let ux = a1.x - a0.x;
    let uy = a1.y - a0.y;
    const ul = Math.sqrt(ux * ux + uy * uy);
    if (ul < 1e-6) { ux = 1; uy = 0; } else { ux /= ul; uy /= ul; }

    // 号码/腰带在球面上的相位：沿运动方向前后扫，转到背面时淡出
    const bob = Math.sin(sp.a) * r * 0.5;
    const facing = Math.cos(sp.a);
    const faceX = c.x + ux * bob;
    const faceY = c.y + uy * bob;

    // ---- 落地阴影：贴在台布上，所以是压扁的椭圆 ----
    ctx.fillStyle = 'rgba(0,0,0,' + (0.30 - 0.06 * tilt) + ')';
    ellipsePath(base.x + r * 0.16, base.y + r * 0.10 * sinPhi,
                r * 0.98, r * 0.98 * sinPhi);
    ctx.fill();

    // ---- 球体 ----
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, TAU);
    ctx.fill();

    // ---- 花色球腰带：跟着滚动扫过球面，越靠边缘越窄 ----
    if (b.id >= 9) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, TAU);
      ctx.clip();
      ctx.translate(c.x, c.y);
      ctx.rotate(Math.atan2(uy, ux));
      ctx.fillStyle = '#f6f6f2';
      const halfBand = r * (0.32 * Math.abs(facing) + 0.10);
      ctx.fillRect(bob - halfBand, -r, halfBand * 2, r * 2);
      ctx.restore();
    }

    // ---- 号码圈：转到背面（cos < 0）时淡出 ----
    // 少了淡出会看到号码从球一边平移到另一边，像贴纸在滑而不是球在滚
    if (b.id !== 0 && facing > -0.15 && r > 3) {
      const rr = r * 0.46 * Math.min(1, Math.abs(facing) + 0.35);
      ctx.save();
      ctx.globalAlpha = Math.min(1, (facing + 0.15) / 0.5);
      ctx.fillStyle = '#f6f6f2';
      ctx.beginPath();
      ctx.arc(faceX, faceY, rr, 0, TAU);
      ctx.fill();
      if (rr > 4) {
        ctx.fillStyle = '#222';
        ctx.font = 'bold ' + Math.max(8, rr * 1.55) + 'px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(b.id), faceX, faceY + rr * 0.08);
      }
      ctx.restore();
    }

    // ---- 光照：高光固定在光源方向、不随球转，正是它反衬出"球在转"----
    const hl = ctx.createRadialGradient(c.x - r * 0.35, c.y - r * 0.42, r * 0.05,
                                        c.x - r * 0.35, c.y - r * 0.42, r * 1.15);
    hl.addColorStop(0, 'rgba(255,255,255,0.5)');
    hl.addColorStop(0.42, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, TAU);
    ctx.fill();

    // 边缘暗角：3D 下加重，让球读起来是个体而不是个圆盘
    const rim = ctx.createRadialGradient(c.x, c.y, r * 0.55, c.x, c.y, r);
    rim.addColorStop(0, 'rgba(0,0,0,0)');
    rim.addColorStop(1, 'rgba(0,0,0,' + (0.18 + 0.16 * tilt) + ')');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, TAU);
    ctx.fill();
  }

  /**
   * 画一批球。3D 下必须按纵深排序（远的先画）否则近球会被远球盖住；
   * 阴影统一先画完，免得近球的阴影糊到相邻的远球身上。
   * 入参不会被修改。
   */
  function drawBalls(list) {
    const order = [];
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].active !== false) order.push(list[i]);
    }
    order.sort(function (p, q) { return p.y - q.y; });
    for (let i = 0; i < order.length; i++) drawBall(order[i]);
  }

  // ================== 台面上的辅助线 ==================
  //
  // 瞄准线、预测线这类东西必须贴着台布画（z = 0），不能按球心高度画 ——
  // 否则 3D 下线会浮在球上方，看起来对不准。

  /** 沿台布画一条线段 */
  function strokeOnCloth(x0, y0, x1, y1) {
    const a = project(x0, y0, 0);
    const b = project(x1, y1, 0);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  /** 在台布上画一个圈（3D 下自动压成椭圆），用于落点预览、自由球光环 */
  function strokeCircleOnCloth(x, y, rLogic) {
    const c = project(x, y, 0);
    const rx = rLogic * scale * c.k;
    ellipsePath(c.x, c.y, rx, rx * sinPhi);
    ctx.stroke();
  }

  return {
    // 相机
    setTilt: setTilt,
    getTilt: getTilt,
    project: project,
    toScreen: toScreen,
    toLogic: toLogic,
    get scale() { return scale; },
    ballRadiusAt: ballRadiusAt,
    // 兼容旧调用：俯视下的球半径。3D 下各球半径不同，应改用 ballRadiusAt
    get ballRadius() { return P.TABLE.R * scale; },
    // 绘制
    clear: clear,
    drawTable: drawTable,
    drawBall: drawBall,
    drawBalls: drawBalls,
    strokeOnCloth: strokeOnCloth,
    strokeCircleOnCloth: strokeCircleOnCloth,
    // 滚动相位
    advanceSpin: advanceSpin,
    resetSpin: resetSpin,
    ctx: ctx
  };
}

module.exports = { createRenderer: createRenderer, COLORS: COLORS };

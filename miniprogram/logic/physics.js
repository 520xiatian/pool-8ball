/**
 * 确定性 2D 台球物理引擎
 * ---------------------------------------------------------------
 * 联机方案的地基：两端只同步「一杆的参数」，各自本地跑同一份物理，
 * 结果必须逐位一致。因此这里有两条硬约束：
 *
 *  1) 只用 + - * / 和 Math.sqrt —— 这些在 IEEE-754 下结果唯一。
 *     绝不在模拟循环里用 sin/cos/atan2/pow/random（各 JS 引擎实现可
 *     能有 1ulp 差异，安卓 V8 与 iOS JavaScriptCore 就可能不一样）。
 *  2) 击球方向以「量化后的整数向量」传输，本地再用 sqrt 归一化。
 *
 * 输出 frames 供渲染回放，保证画面与判定同源。
 */

// ---- 台面几何（内部逻辑单位；渲染时整体等比缩放）----
//
// 袋口开度**不再是独立参数**：每个袋的「库边缺口半宽」直接等于它的判定
// 半径。以前缺口 30 > 腰袋判定 23，中间那 7 个单位是条死带 —— 球从那里
// 走，库边已经撤了但袋又抓不住，于是飞出台面再被 nearestPocket() 强判进
// 袋，画面上还能看见球穿出台边。缺口与判定同宽后两者严格互补：进得去缺
// 口的球一定被抓住，抓不住的球一定撞库。
const T = {
  W: 1000,          // 台面内沿长
  H: 500,           // 台面内沿宽
  R: 12.4,          // 球半径
  CORNER_POCKET: 25,// 角袋判定半径（同时是该袋的库边缺口半宽）
  SIDE_POCKET: 23,  // 腰袋判定半径（同上）
  CUSHION_E: 0.72,  // 库边弹性（真实库皮约 0.6~0.75；早先的 0.92 会让球
                    // 在库间弹个没完，像弹珠机而不是台球）
  BALL_E: 0.95,     // 球间弹性
  // 摩擦分两段（滑动 ≈ 滚动阻力的 8 倍，接近真实台球），三个数是配套标定
  // 的，改一个就得重算，别单独动。当前取值下：
  //   · 满力自由滑行 ≈ 2.2 个台长、约 4.0s（常用五成力 ≈ 1.1 台长）
  //   · 满力单帧位移 = 1450/60 ≈ 24.2 unit，略小于一个球径（24.8）——
  //     再快下去球在相邻两帧之间就会跳过一整个球位，插值也救不回来。
  A_SLIDE: 2180,    // 滑动摩擦减速度 (unit/s^2)
  A_ROLL: 275,      // 滚动阻力减速度 (unit/s^2)
  STOP_V: 6,        // 静止阈值 (unit/s)
  MAX_V: 1450,      // 满杆初速
  FRAME_DT: 1 / 60, // 一渲染帧
  MAX_FRAMES: 900   // 15 秒保险丝，防止极端情况死循环
};

const POCKETS = [
  { x: 0,       y: 0,     r: T.CORNER_POCKET },
  { x: T.W / 2, y: 0,     r: T.SIDE_POCKET },
  { x: T.W,     y: 0,     r: T.CORNER_POCKET },
  { x: 0,       y: T.H,   r: T.CORNER_POCKET },
  { x: T.W / 2, y: T.H,   r: T.SIDE_POCKET },
  { x: T.W,     y: T.H,   r: T.CORNER_POCKET }
];

// 给每个袋算出「库边缺口半宽」m = sqrt(r² - R²)。
//
// 推导：球心贴到库边线（离边 R）时，若它与袋心的横向偏移小于 m，
// 那么它到袋心的距离 sqrt(m² + R²) < r，这一帧必被判落袋；偏移大于 m
// 的球则落在缺口之外，库边照常反弹。两者严格互补 —— 不存在「库边已经
// 撤了、袋又抓不住」的死带。
//
// 旧版把缺口写成固定的 MOUTH = 30，比腰袋判定半径 23 还宽，中间那圈就是
// 死带：贴库走的球从那里出去，库边不反弹、袋口也没抓住，于是飞出台面，
// 再被下面的 nearestPocket() 兜底强判进袋 —— 画面上能看见球穿出台边。
for (let i = 0; i < POCKETS.length; i++) {
  const p = POCKETS[i];
  p.m = Math.sqrt(p.r * p.r - T.R * T.R);
}

// ---- 音效事件类型（写进 simulate 返回的 audio 里，供渲染端播声）----
const SFX_BALL = 1;    // 球撞球
const SFX_CUSHION = 2; // 撞库
const SFX_POCKET = 3;  // 落袋

// 低于这个速度的撞击不记声音：慢速蹭碰在真台上本来也听不见，
// 而且开球那一瞬间的余震能省掉几十条无用事件。
const SFX_MIN_V = 20;

// 开球线与球堆位置
const BREAK_X = T.W * 0.22;
const FOOT_X = T.W * 0.72;
const CENTER_Y = T.H / 2;

// 物理子步：每渲染帧再切 10 份，保证高速球不穿透
const SUBSTEPS = 10;
const SUB_DT = T.FRAME_DT / SUBSTEPS;

// 刚体球从纯滑动过渡到纯滚动后剩下的速度比例（角动量守恒的标准结论：
// I = 2/5·mR² ⇒ v_roll = 5/7·v0）。用来算「滚动门槛速度」，见 stepOnce
// 末尾的摩擦段。硬编码成除法而不是 0.714…，保证各端逐位一致。
const SLIDE_TO_ROLL = 5 / 7;

/** 0 = 白球，1..7 全色，8 = 黑八，9..15 花色 */
function createRack() {
  const balls = [];
  balls.push({ id: 0, x: BREAK_X, y: CENTER_Y, vx: 0, vy: 0, active: true });

  // 中式八球标准三角摆放：黑八在第三排正中，两底角一全一花
  const order = [1, 9, 2, 10, 8, 11, 3, 12, 4, 13, 5, 14, 6, 15, 7];
  const gap = T.R * 2 + 0.35;      // 球心间距（留极小缝隙避免初始重叠）
  const rowDx = gap * 0.8660254037844386; // gap * sqrt(3)/2，常量硬编码保证跨端一致
  let k = 0;
  for (let row = 0; row < 5; row++) {
    const x = FOOT_X + row * rowDx;
    const y0 = CENTER_Y - row * gap / 2;
    for (let i = 0; i <= row; i++) {
      balls.push({ id: order[k++], x: x, y: y0 + i * gap, vx: 0, vy: 0, active: true });
    }
  }
  balls.sort(function (a, b) { return a.id - b.id; });
  return balls;
}

/** 深拷贝球态（模拟前必做，避免污染上一杆的权威状态） */
function cloneBalls(balls) {
  const out = new Array(balls.length);
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    out[i] = { id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, active: b.active };
  }
  return out;
}

/** 判断某点是否落在袋口缺口内（该段库边不反弹） */
function inPocketMouth(px, py, axis) {
  for (let i = 0; i < POCKETS.length; i++) {
    const p = POCKETS[i];
    if (axis === 'y' && p.y === py && px > p.x - p.m && px < p.x + p.m) return true;
    if (axis === 'x' && p.x === px && py > p.y - p.m && py < p.y + p.m) return true;
  }
  return false;
}

/**
 * 模拟一杆到全部球静止。
 *
 * @param {Array}  balls  起始球态（本函数不修改入参）
 * @param {Object} shot   { dx, dy, power }
 *        dx/dy：方向向量，**整数**（由 UI 量化，见 quantizeAim），内部归一化
 *        power：0..1000 的**整数**力度
 * @returns {Object} { balls, frames, events, audio }
 *        frames：[[x,y,x,y,...]] 逐帧坐标（含 active 标记压缩），供渲染回放
 *        events：本杆判定所需的全部事件，交给 rules.js 裁决
 *        audio ：[帧号, 类型, 力度0..1000] 三元组，供渲染端在对应帧播声。
 *                声音由物理产生而不是渲染端猜，回放和判定才对得上。
 */
function simulate(balls, shot) {
  const state = cloneBalls(balls);
  const byId = {};
  let cueIdx = -1;
  for (let i = 0; i < state.length; i++) {
    byId[state[i].id] = state[i];
    if (state[i].id === 0) cueIdx = i;
  }

  // 「滚动门槛速度」，按 state 下标平行存放而不是挂在球对象上 ——
  // 球态会被序列化进房间文档同步给对手，不该混进这种一杆之内的临时量。
  const rollV = new Array(state.length);
  for (let i = 0; i < state.length; i++) rollV[i] = 0;

  const events = {
    firstHit: -1,        // 白球第一颗碰到的球号，-1 表示空杆
    potted: [],          // 本杆落袋球号（按落袋顺序）
    cueScratch: false,   // 白球落袋
    cushionAfterHit: 0,  // 碰球后的库边次数（判「碰库」规则）
    anyCushion: 0
  };

  // 本帧内攒下的撞击声，帧末统一打上帧号
  const sfx = [];
  const audio = [];

  // ---- 施加初速：整数方向向量 → 单位向量 ----
  const cue = byId[0];
  if (!cue || !cue.active) return { balls: state, frames: [], events: events, audio: audio };
  const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy);
  if (len === 0) return { balls: state, frames: [], events: events, audio: audio };

  // 力度→初速取平方根：球的滑行距离正比于 v²，直接线性映射的话
  // 「拖到 30%」只能走 9% 的距离，前半段推不动、后半段骤然暴力。
  // 开根之后拖动距离和实际走位近似成正比，中段走位力度才有分辨率。
  const speed = T.MAX_V * Math.sqrt(shot.power / 1000);
  cue.vx = shot.dx / len * speed;
  cue.vy = shot.dy / len * speed;
  rollV[cueIdx] = speed * SLIDE_TO_ROLL;

  const frames = [];
  let guard = 0;

  while (guard++ < T.MAX_FRAMES) {
    for (let s = 0; s < SUBSTEPS; s++) stepOnce(state, events, sfx, rollV);
    frames.push(snapshot(state));
    // 一帧之内可能撞好几下，同类只留最响的那声：真实听感也是被最响的
    // 那一下盖住，而且能挡住开球瞬间几十条几乎同时的事件把音频轨塞爆。
    if (sfx.length) {
      const frameNo = frames.length - 1;
      const loudest = [0, 0, 0, 0];   // 按类型索引存最大响度
      for (let k = 0; k < sfx.length; k++) {
        const t = sfx[k][0];
        if (sfx[k][1] > loudest[t]) loudest[t] = sfx[k][1];
      }
      for (let t = 1; t <= 3; t++) {
        if (loudest[t] > 0) audio.push(frameNo, t, loudest[t]);
      }
      sfx.length = 0;
    }
    if (allResting(state)) break;
  }

  return { balls: state, frames: frames, events: events, audio: audio };
}

/** 把撞击速度折成 0..1000 的响度，超过满杆速就压满 */
function loudness(v) {
  const x = v / T.MAX_V * 1000;
  return x > 1000 ? 1000 : (x < 0 ? 0 : Math.round(x));
}

/** 一个物理子步：移动 → 落袋 → 库边 → 球球碰撞 → 摩擦减速 */
function stepOnce(state, ev, sfx, rollV) {
  let i, j;

  for (i = 0; i < state.length; i++) {
    const b = state[i];
    if (!b.active) continue;
    b.x += b.vx * SUB_DT;
    b.y += b.vy * SUB_DT;
  }

  // ---- 落袋 ----
  for (i = 0; i < state.length; i++) {
    const b = state[i];
    if (!b.active) continue;
    let pocketed = -1;
    for (j = 0; j < POCKETS.length; j++) {
      const p = POCKETS[j];
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      if (dx * dx + dy * dy <= p.r * p.r) { pocketed = j; break; }
    }
    // 兜底：万一还是有球溜出台面（缺口与判定半径现在严格互补，理论上到不了
    // 这里），归给最近的袋，免得球飞出去永不返回、模拟一直跑到 MAX_FRAMES。
    if (pocketed === -1 &&
        (b.x < -T.R || b.x > T.W + T.R || b.y < -T.R || b.y > T.H + T.R)) {
      pocketed = nearestPocket(b.x, b.y);
    }
    if (pocketed !== -1) {
      sfx.push([SFX_POCKET, loudness(Math.sqrt(b.vx * b.vx + b.vy * b.vy))]);
      b.active = false;
      b.vx = 0;
      b.vy = 0;
      rollV[i] = 0;
      if (b.id === 0) ev.cueScratch = true;
      else ev.potted.push(b.id);
    }
  }

  // ---- 库边反弹（袋口缺口处不反弹，让球能进袋）----
  //
  // 撞库会吃掉一部分速度，也会把「已经滚起来」的球重新蹭成滑动状态，
  // 所以反弹后要把 rv 重设成新速度对应的滚动阈值。
  for (i = 0; i < state.length; i++) {
    const b = state[i];
    if (!b.active) continue;
    let bounced = 0;
    if (b.x < T.R && b.vx < 0 && !inPocketMouth(0, b.y, 'x')) {
      bounced = -b.vx;
      b.x = T.R; b.vx = -b.vx * T.CUSHION_E; countCushion(ev);
    } else if (b.x > T.W - T.R && b.vx > 0 && !inPocketMouth(T.W, b.y, 'x')) {
      bounced = b.vx;
      b.x = T.W - T.R; b.vx = -b.vx * T.CUSHION_E; countCushion(ev);
    }
    if (b.y < T.R && b.vy < 0 && !inPocketMouth(b.x, 0, 'y')) {
      if (-b.vy > bounced) bounced = -b.vy;
      b.y = T.R; b.vy = -b.vy * T.CUSHION_E; countCushion(ev);
    } else if (b.y > T.H - T.R && b.vy > 0 && !inPocketMouth(b.x, T.H, 'y')) {
      if (b.vy > bounced) bounced = b.vy;
      b.y = T.H - T.R; b.vy = -b.vy * T.CUSHION_E; countCushion(ev);
    }
    if (bounced > 0) {
      rollV[i] = Math.sqrt(b.vx * b.vx + b.vy * b.vy) * SLIDE_TO_ROLL;
      if (bounced >= SFX_MIN_V) sfx.push([SFX_CUSHION, loudness(bounced)]);
    }
  }

  // ---- 球球弹性碰撞（等质量，沿法线交换动量）----
  const d2 = T.R * 2;
  for (i = 0; i < state.length; i++) {
    const a = state[i];
    if (!a.active) continue;
    for (j = i + 1; j < state.length; j++) {
      const b = state[j];
      if (!b.active) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist2 = dx * dx + dy * dy;
      if (dist2 > d2 * d2 || dist2 === 0) continue;

      const dist = Math.sqrt(dist2);
      const nx = dx / dist;
      const ny = dy / dist;

      // 记录白球首次触球（判空杆 / 打错球）
      if (ev.firstHit === -1) {
        if (a.id === 0) ev.firstHit = b.id;
        else if (b.id === 0) ev.firstHit = a.id;
      }

      // 分离重叠，各退一半，避免抖动粘连
      const overlap = d2 - dist;
      if (overlap > 0) {
        const hx = nx * overlap / 2;
        const hy = ny * overlap / 2;
        a.x -= hx; a.y -= hy;
        b.x += hx; b.y += hy;
      }

      // 法向相对速度；只有在靠近时才处理
      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const vn = rvx * nx + rvy * ny;
      if (vn > 0) continue;
      const imp = -vn * T.BALL_E;
      a.vx -= imp * nx; a.vy -= imp * ny;
      b.vx += imp * nx; b.vy += imp * ny;

      // 撞击会把两颗球都打回滑动状态：被撞的球从静止起步、撞人的球速度骤变，
      // 谁都不可能还保持着原来的滚动。这就是「定杆」的由来 —— 正面对心撞完
      // 白球几乎不动，随后台布摩擦才慢慢把它重新蹭成滚动往前跟一点。
      rollV[i] = Math.sqrt(a.vx * a.vx + a.vy * a.vy) * SLIDE_TO_ROLL;
      rollV[j] = Math.sqrt(b.vx * b.vx + b.vy * b.vy) * SLIDE_TO_ROLL;

      if (-vn >= SFX_MIN_V) sfx.push([SFX_BALL, loudness(-vn)]);
    }
  }

  // ---- 台布摩擦：滑动段高摩擦，转入滚动后阻力小一个量级 ----
  //
  // 真实台球分两段：击球瞬间球是「滑」的（球面相对台布打滑，μ≈0.2），
  // 摩擦力矩很快把它转起来，达到 v = ωR 后进入纯滚动，此后只剩滚动阻力
  // （小约一个数量级）。所以远球的手感是「窜出去 → 悠悠滚很久 → 收住」。
  // 旧版一路恒定减速度，掉速线性，钝而无余韵。
  //
  // rollV[i] 是这颗球「滚起来」的速度门槛：速度还在它之上就算滑动段，
  // 掉到门槛以下就当已经滚起来了，换用小阻力。
  for (i = 0; i < state.length; i++) {
    const b = state[i];
    if (!b.active) continue;
    const sp2 = b.vx * b.vx + b.vy * b.vy;
    if (sp2 === 0) continue;
    const sp = Math.sqrt(sp2);
    if (sp <= T.STOP_V) { b.vx = 0; b.vy = 0; rollV[i] = 0; continue; }
    const dv = (sp > rollV[i] ? T.A_SLIDE : T.A_ROLL) * SUB_DT;
    const k = (sp - dv) / sp;
    if (k <= 0) { b.vx = 0; b.vy = 0; rollV[i] = 0; } else { b.vx *= k; b.vy *= k; }
  }
}

function countCushion(ev) {
  ev.anyCushion++;
  if (ev.firstHit !== -1) ev.cushionAfterHit++;
}

/** 离指定点最近的袋（用于处理冲出袋口开度的球） */
function nearestPocket(x, y) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < POCKETS.length; i++) {
    const dx = x - POCKETS[i].x;
    const dy = y - POCKETS[i].y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function allResting(state) {
  for (let i = 0; i < state.length; i++) {
    const b = state[i];
    if (b.active && (b.vx !== 0 || b.vy !== 0)) return false;
  }
  return true;
}

/** 压缩快照：[id, x, y] 三元组，只含在台球，渲染端按 id 取色 */
function snapshot(state) {
  const arr = [];
  for (let i = 0; i < state.length; i++) {
    const b = state[i];
    if (!b.active) continue;
    arr.push(b.id, Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100);
  }
  return arr;
}

/**
 * 把手指瞄准的浮点角度量化成整数向量。
 * 联机只传整数，杜绝浮点序列化误差导致两端物理分叉。
 */
function quantizeAim(dxFloat, dyFloat) {
  const len = Math.sqrt(dxFloat * dxFloat + dyFloat * dyFloat);
  if (len === 0) return { dx: 10000, dy: 0 };
  return {
    dx: Math.round(dxFloat / len * 10000),
    dy: Math.round(dyFloat / len * 10000)
  };
}

/**
 * 白球自由摆放时，找一个不与他球重叠、也不在袋口吞噬范围内的合法点。
 * 用于开球和罚球后的摆位。
 *
 * 袋口检查不能省：台面边缘（y = H - R - 1）离腰袋中心只有 13.4，
 * 小于腰袋判定半径 23，白球一放上去下一帧就被判落袋。
 */
function findFreeSpot(balls, x, y) {
  const d2 = T.R * 2 + 0.5;
  let px = Math.min(Math.max(x, T.R + 1), T.W - T.R - 1);
  let py = Math.min(Math.max(y, T.R + 1), T.H - T.R - 1);
  for (let ring = 0; ring < 40; ring++) {
    const step = ring * T.R * 0.8;
    // 8 个方向的固定偏移，确定性且够密
    const offs = ring === 0 ? [[0, 0]] : [
      [step, 0], [-step, 0], [0, step], [0, -step],
      [step * 0.7071, step * 0.7071], [-step * 0.7071, step * 0.7071],
      [step * 0.7071, -step * 0.7071], [-step * 0.7071, -step * 0.7071]
    ];
    for (let o = 0; o < offs.length; o++) {
      const cx = Math.min(Math.max(px + offs[o][0], T.R + 1), T.W - T.R - 1);
      const cy = Math.min(Math.max(py + offs[o][1], T.R + 1), T.H - T.R - 1);

      // 离任何袋口都要足够远，否则一放下就被吞
      let ok = true;
      for (let k = 0; k < POCKETS.length; k++) {
        const p = POCKETS[k];
        const pdx = p.x - cx;
        const pdy = p.y - cy;
        const safe = p.r + T.R;
        if (pdx * pdx + pdy * pdy < safe * safe) { ok = false; break; }
      }
      if (!ok) continue;

      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (!b.active || b.id === 0) continue;
        const ddx = b.x - cx;
        const ddy = b.y - cy;
        if (ddx * ddx + ddy * ddy < d2 * d2) { ok = false; break; }
      }
      if (ok) return { x: cx, y: cy };
    }
  }
  return { x: BREAK_X, y: CENTER_Y };
}

module.exports = {
  TABLE: T,
  POCKETS: POCKETS,
  BREAK_X: BREAK_X,
  CENTER_Y: CENTER_Y,
  SFX_BALL: SFX_BALL,
  SFX_CUSHION: SFX_CUSHION,
  SFX_POCKET: SFX_POCKET,
  createRack: createRack,
  cloneBalls: cloneBalls,
  simulate: simulate,
  quantizeAim: quantizeAim,
  findFreeSpot: findFreeSpot
};

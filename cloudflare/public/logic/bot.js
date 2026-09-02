/* 自动生成，请勿直接修改：源文件在 miniprogram/logic/，改完运行 node scripts/sync-logic.js */
(function (global) {
'use strict';
var module = { exports: {} };
var exports = module.exports;
var require = global.__poolRequire;
// ---- 源文件开始（勿改此行）----
/**
 * 单机人机对手
 * ---------------------------------------------------------------
 * 思路：候选采样 + 真实物理试算打分。因为 physics.simulate 是纯函数，
 * 直接拿它当「搜索的评估器」即可 —— AI 看到的世界和玩家完全一样。
 * 采样量 48 方向 × 5 力度 = 240 次试算，中端机上一次思考 < 250ms。
 */
const P = require('./physics.js');
const R = require('./rules.js');

const ANGLE_SAMPLES = 48;   // 圆周方向采样数

// 力度候选。必须覆盖整条力度带：power→初速改成开平方之后，
// [420,620,820] 那组全挤在 63%~91% 初速里，BOT 只会大力砸球，
// 轻推和中等走位根本不在候选里，进球率掉了近一半。
const POWER_SAMPLES = [120, 300, 550, 800, 1000];

/** 难度：0 新手（加大扰动）/ 1 普通 / 2 高手 */
function pickShot(state, difficulty) {
  const me = state.turn;
  const myGroup = state.groups[me];
  const onEight = R.isOnEight(state, me);
  const targets = legalTargets(state, me, myGroup, onEight);

  let best = null;
  let bestScore = -Infinity;

  for (let a = 0; a < ANGLE_SAMPLES; a++) {
    // 用查表式定点方向，避开 sin/cos 保持与主引擎同源的整数向量
    const dir = DIRS[Math.floor(a * DIRS.length / ANGLE_SAMPLES)];
    for (let p = 0; p < POWER_SAMPLES.length; p++) {
      const shot = { dx: dir[0], dy: dir[1], power: POWER_SAMPLES[p] };
      const sim = P.simulate(state.balls, shot);
      const score = evaluate(state, sim.events, targets, onEight, myGroup);
      if (score > bestScore) {
        bestScore = score;
        best = shot;
      }
    }
  }

  if (!best) best = { dx: DIRS[0][0], dy: DIRS[0][1], power: 600 };

  // 按难度加入手抖：新手偏差大，高手几乎不抖
  const jitter = difficulty === 2 ? 0 : (difficulty === 1 ? 220 : 700);
  if (jitter > 0) {
    const jx = (Math.random() - 0.5) * jitter;
    const jy = (Math.random() - 0.5) * jitter;
    const q = P.quantizeAim(best.dx + jx, best.dy + jy);
    best = { dx: q.dx, dy: q.dy, power: best.power };
  }

  // 自由球时把白球摆到台面中线附近，简单但够用
  if (state.ballInHand) {
    const spot = P.findFreeSpot(state.balls, P.BREAK_X, P.CENTER_Y);
    best.cueX = spot.x;
    best.cueY = spot.y;
  }
  return best;
}

/** 本方合法目标球号集合 */
function legalTargets(state, me, myGroup, onEight) {
  const out = {};
  if (onEight) { out[8] = true; return out; }
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    if (!b.active || b.id === 0 || b.id === 8) continue;
    if (myGroup === R.GROUP.NONE || R.ballGroup(b.id) === myGroup) out[b.id] = true;
  }
  return out;
}

/** 打分：进己方球最高，犯规重罚，碰库保底 */
function evaluate(state, ev, targets, onEight, myGroup) {
  let score = 0;

  if (ev.cueScratch) score -= 900;
  if (ev.firstHit === -1) return -2000;
  if (!targets[ev.firstHit]) score -= 500;

  for (let i = 0; i < ev.potted.length; i++) {
    const id = ev.potted[i];
    if (id === 8) {
      score += onEight ? 5000 : -5000;
    } else if (targets[id]) {
      score += 1000;
    } else {
      score -= 350; // 帮对手清台
    }
  }

  if (ev.potted.length === 0 && ev.cushionAfterHit === 0) score -= 400;
  if (ev.potted.length === 0) score += ev.cushionAfterHit * 12; // 至少做个安全球
  return score;
}

/**
 * 64 个方向的整数向量（单位向量放大 10000 后取整）。
 * 只在模块加载时算一次，之后 AI 出杆和玩家出杆走完全相同的整数量化通道。
 * 这里可以用 sin/cos —— 结果立即取整，且人机对战不涉及跨端一致性。
 */
const DIRS = (function () {
  const list = [];
  for (let i = 0; i < 64; i++) {
    const t = i / 64 * Math.PI * 2;
    list.push([Math.round(Math.cos(t) * 10000), Math.round(Math.sin(t) * 10000)]);
  }
  return list;
})();

module.exports = { pickShot: pickShot };
// ---- 源文件结束（勿改此行）----
global.__poolModules["bot.js"] = module.exports;
})(typeof window !== 'undefined' ? window : globalThis);

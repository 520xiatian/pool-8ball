/* 自动生成，请勿直接修改：源文件在 miniprogram/logic/，改完运行 node scripts/sync-logic.js */
/**
 * 中式八球（黑八）规则裁决
 * ---------------------------------------------------------------
 * 纯函数：applyShot(state, shot) → 新 state + 本杆播报。
 * 客户端用它跑画面，云函数用**同一份文件**校验，两边结论必然一致。
 *
 * 采用的规则集（简化但完整可玩，避免歧义）：
 *  - 开球后第一颗合法落袋的球决定归属（全色 1-7 / 花色 9-15）
 *  - 未定归属前落袋任何非黑八球都不算犯规，但不指定花色则继续
 *  - 犯规：白球落袋、空杆、先碰对方球、碰球后无球落袋且无球碰库、
 *          清完己方球前打进黑八、黑八与己方球同杆落袋
 *  - 犯规惩罚：对手获得「自由球」（可拖动白球到任意合法位置）
 *  - 己方球全部落袋后进入「打黑八」阶段，黑八入袋即胜
 */
const P = require('./physics.js');

const GROUP = { NONE: 0, SOLID: 1, STRIPE: 2 }; // 全色 / 花色

/** 新开一局 */
function createGame(firstPlayer) {
  return {
    balls: P.createRack(),
    turn: firstPlayer || 0,          // 0 / 1
    groups: [GROUP.NONE, GROUP.NONE],// 两位玩家的球组
    ballInHand: false,               // 当前出杆方是否持自由球
    isBreak: true,                   // 是否开球杆
    winner: -1,                      // -1 进行中
    shotIndex: 0,                    // 已完成杆数，作为乐观锁版本号
    lastMessage: '开球'
  };
}

function ballGroup(id) {
  if (id >= 1 && id <= 7) return GROUP.SOLID;
  if (id >= 9 && id <= 15) return GROUP.STRIPE;
  return GROUP.NONE; // 0 白球 / 8 黑八
}

/** 某玩家己方球是否已清台（可以打黑八） */
function isOnEight(state, player) {
  const g = state.groups[player];
  if (g === GROUP.NONE) return false;
  for (let i = 0; i < state.balls.length; i++) {
    const b = state.balls[i];
    if (b.active && ballGroup(b.id) === g) return false;
  }
  return true;
}

function groupName(g) {
  if (g === GROUP.SOLID) return '全色球';
  if (g === GROUP.STRIPE) return '花色球';
  return '未定';
}

/**
 * 执行一杆并裁决。
 *
 * @param {Object} state 当前局面（不修改入参）
 * @param {Object} shot  { dx, dy, power, cueX?, cueY? }
 *                       cueX/cueY 仅在 ballInHand 时生效
 * @returns {Object} { state, frames, audio, log }
 *                  audio 是 physics 产出的撞击声轨，只给渲染端用；
 *                  服务端裁决不看它，也不会写进房间文档。
 */
function applyShot(state, shot) {
  const next = {
    balls: P.cloneBalls(state.balls),
    turn: state.turn,
    groups: [state.groups[0], state.groups[1]],
    ballInHand: false,
    isBreak: false,
    winner: state.winner,
    shotIndex: state.shotIndex + 1,
    lastMessage: ''
  };

  const me = state.turn;
  const foe = me === 0 ? 1 : 0;

  // 自由球：先把白球摆到指定位置（服务端同样会做合法性夹取）
  if (state.ballInHand && typeof shot.cueX === 'number') {
    const spot = P.findFreeSpot(next.balls, shot.cueX, shot.cueY);
    const cue = next.balls[0];
    cue.x = spot.x;
    cue.y = spot.y;
    cue.vx = 0;
    cue.vy = 0;
    cue.active = true;
  }

  const sim = P.simulate(next.balls, shot);
  next.balls = sim.balls;
  const ev = sim.events;

  // ---------- 犯规判定 ----------
  let foul = false;
  const reasons = [];

  if (ev.firstHit === -1) {
    foul = true;
    reasons.push('空杆未碰到球');
  } else {
    const myGroup = next.groups[me];
    const onEight = isOnEight(state, me);
    // 该打黑八时必须先碰黑八；否则必须先碰己方球（归属未定时任意目标球都合法）
    if (onEight && ev.firstHit !== 8) {
      foul = true;
      reasons.push('该打黑八，却先碰了 ' + ev.firstHit + ' 号');
    } else if (!onEight && myGroup !== GROUP.NONE && ballGroup(ev.firstHit) !== myGroup) {
      foul = true;
      reasons.push('先碰到了对方球 / 黑八');
    }
  }

  if (ev.cueScratch) {
    foul = true;
    reasons.push('白球落袋');
  }

  // 碰球后既无落袋也无碰库 → 消极防守，判犯规
  if (!foul && ev.potted.length === 0 && ev.cushionAfterHit === 0) {
    foul = true;
    reasons.push('碰球后无球落袋且未碰库');
  }

  // ---------- 归属分配（开球杆不定归属，符合大众打法）----------
  const potted = ev.potted;
  if (next.groups[me] === GROUP.NONE && !state.isBreak && !foul) {
    for (let i = 0; i < potted.length; i++) {
      const g = ballGroup(potted[i]);
      if (g !== GROUP.NONE) {
        next.groups[me] = g;
        next.groups[foe] = g === GROUP.SOLID ? GROUP.STRIPE : GROUP.SOLID;
        break;
      }
    }
  }

  // ---------- 黑八结算 ----------
  const eightPotted = potted.indexOf(8) !== -1;
  if (eightPotted) {
    const wasOnEight = isOnEight(state, me);
    if (!wasOnEight || foul) {
      // 提前打进黑八 / 打黑八这杆同时犯规 → 直接判负
      next.winner = foe;
      next.lastMessage = '黑八提前落袋或犯规，' + playerName(foe) + '获胜';
      return { state: next, frames: sim.frames, audio: sim.audio, log: next.lastMessage };
    }
    next.winner = me;
    next.lastMessage = playerName(me) + '打进黑八，获胜！';
    return { state: next, frames: sim.frames, audio: sim.audio, log: next.lastMessage };
  }

  // ---------- 换手判定 ----------
  let continueTurn = false;
  if (!foul) {
    const myGroup = next.groups[me];
    for (let i = 0; i < potted.length; i++) {
      // 归属刚定或已定：进己方球则连打
      if (myGroup !== GROUP.NONE && ballGroup(potted[i]) === myGroup) { continueTurn = true; break; }
      // 开球杆进球也连打
      if (state.isBreak) { continueTurn = true; break; }
    }
  }

  if (foul) {
    next.turn = foe;
    next.ballInHand = true;
    next.lastMessage = '犯规：' + reasons.join('；') + '，对手获得自由球';
  } else if (continueTurn) {
    next.turn = me;
    next.lastMessage = '进球 ' + potted.join('、') + '，继续出杆';
    if (next.groups[me] !== state.groups[me] && next.groups[me] !== GROUP.NONE) {
      next.lastMessage += '（你的球组：' + groupName(next.groups[me]) + '）';
    }
  } else {
    next.turn = foe;
    next.lastMessage = potted.length ? ('落袋 ' + potted.join('、') + '，换手') : '未进球，换手';
  }

  // 白球被打进后重新入场（自由球阶段由出杆方摆放，这里先给个默认位）
  const cue = next.balls[0];
  if (!cue.active) {
    const spot = P.findFreeSpot(next.balls, P.BREAK_X, P.CENTER_Y);
    cue.x = spot.x;
    cue.y = spot.y;
    cue.vx = 0;
    cue.vy = 0;
    cue.active = true;
  }

  return { state: next, frames: sim.frames, audio: sim.audio, log: next.lastMessage };
}

function playerName(p) {
  return p === 0 ? '房主' : '挑战者';
}

/** 超时/认输等外部事件：直接换手或判负 */
function forfeit(state, loser) {
  const next = JSON.parse(JSON.stringify(state));
  next.winner = loser === 0 ? 1 : 0;
  next.lastMessage = playerName(loser) + '认输';
  next.shotIndex = state.shotIndex + 1;
  return next;
}

function timeoutSwitch(state) {
  const next = JSON.parse(JSON.stringify(state));
  next.turn = state.turn === 0 ? 1 : 0;
  next.ballInHand = false;
  next.isBreak = false;
  next.shotIndex = state.shotIndex + 1;
  next.lastMessage = '超时未出杆，自动换手';
  return next;
}

module.exports = {
  GROUP: GROUP,
  createGame: createGame,
  applyShot: applyShot,
  ballGroup: ballGroup,
  isOnEight: isOnEight,
  groupName: groupName,
  playerName: playerName,
  forfeit: forfeit,
  timeoutSwitch: timeoutSwitch
};

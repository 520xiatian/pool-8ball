const P = require('../../logic/physics.js');
const RULES = require('../../logic/rules.js');
const BOT = require('../../logic/bot.js');
const NET = require('../../logic/net.js');
const RENDER = require('../../logic/renderer.js');
const CONFIG = require('../../config.js');

// 撞击音效。文件由 scripts/gen-sfx.js 合成（~5KB，随包走，不联网）。
// 三种音色靠 playbackRate 区分，所以只需要这一个文件。
const SFX = { hit: '/assets/hit.wav' };

// 视角切换时长（秒）。太快晃眼，太慢显得拖沓。
const TILT_SECONDS = 0.55;

/** 视角缓动曲线：两头慢中间快，比线性顺眼 */
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

Page({
  data: {
    mode: 'solo',
    roomCode: '',
    waiting: false,
    myTurn: false,
    turn: 0,
    busy: false,           // 走球动画中，禁止操作
    ballInHand: false,
    gameOver: false,
    overText: '',
    rematchWaiting: false,
    message: '开球',
    powerPct: 0,
    countdown: 0,
    p0Name: '我', p1Name: '电脑',
    p0Group: '未定', p1Group: '未定',
    is3D: false,           // 视角开关的显示态
    soundOn: true
  },

  onLoad(query) {
    this.mode = query.mode === 'online' ? 'online' : 'solo';
    this.difficulty = Number(query.difficulty || 1);
    this.roomId = query.roomId || '';
    this.mySeat = this.mode === 'solo' ? 0 : -1;

    // 非渲染态一律放在实例上，不进 setData —— 球态每帧都变，
    // 走 setData 会把 60fps 拖成 10fps。
    this.game = null;
    this.frames = null;
    // 播放进度按**秒**记而不是帧下标：frames 是按 1/60 生成的，
    // 若按 rAF tick 逐帧消费，120Hz 屏上整杆会快一倍。
    this.playT = 0;
    this.lastT = 0;
    this.audio = null;
    this.audioIdx = 0;
    this.aiming = false;
    this.aimStart = null;
    this.aimNow = null;
    this.playedIndex = 0;   // 已在本地播放过的杆号
    this.watcher = null;
    this.rafId = 0;
    this.pendingShot = false;
    // 视角：tilt 当前值，tiltTarget 目标值，每帧向目标缓动
    this.tilt = 0;
    this.tiltTarget = 0;

    // 读回上次的偏好
    try {
      const v = wx.getStorageSync('poolView3D');
      const s = wx.getStorageSync('poolSoundOff');
      this.tilt = this.tiltTarget = v ? 1 : 0;
      this.soundOn = !s;
    } catch (e) { this.soundOn = true; }
    this.setData({ is3D: this.tiltTarget === 1, soundOn: this.soundOn });

    wx.setNavigationBarTitle({
      title: this.mode === 'solo' ? '单机练习' : '房间 ' + (query.code || '')
    });
    this.setData({ mode: this.mode, roomCode: query.code || '' });

    this.initCanvas().then(() => {
      if (this.mode === 'solo') this.startSolo();
      else this.startOnline();
    });
  },

  onUnload() {
    this.teardown();
  },

  onHide() {
    // 切后台时停掉渲染循环，省电；watch 保留，回来能立刻同步上
    if (this.rafId && this.canvas) this.canvas.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  },

  teardown() {
    if (this.rafId && this.canvas) this.canvas.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
    if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
    // 音频实例不释放会一直占着系统音频通道
    if (this.sfxPool) {
      for (const a of this.sfxPool) { try { a.destroy(); } catch (e) {} }
      this.sfxPool = null;
    }
  },

  /** 取 canvas 节点并建立渲染器 */
  initCanvas() {
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery();
      q.select('#table').fields({ node: true, size: true }).exec((res) => {
        const info = res && res[0];
        if (!info || !info.node) {
          this.setData({ message: 'Canvas 初始化失败，请重进页面' });
          return resolve();
        }
        const canvas = info.node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio;
        this.canvas = canvas;
        this.renderer = RENDER.createRenderer(canvas, ctx, info.width, info.height, dpr);
        this.renderer.setTilt(this.tilt);
        resolve();
      });
    });
  },

  // ==================== 音效 ====================
  //
  // 小程序没有 WebAudio，用 InnerAudioContext 池播放极短音频。
  // 音频文件由 SFX_DATA 里的 base64 WAV 提供（几百字节，随包走，不联网）。
  // 池化是必须的：撞库连响时若每次 createInnerAudioContext，安卓上会卡顿。

  initSfx() {
    if (this.sfxPool) return;
    this.sfxPool = [];
    this.sfxNext = 0;
    if (!wx.createInnerAudioContext) { this.sfxPool = null; return; }
    for (let i = 0; i < 4; i++) {
      try {
        const a = wx.createInnerAudioContext({ useWebAudioImplement: true });
        a.src = SFX.hit;
        this.sfxPool.push(a);
      } catch (e) { /* 老版本基础库不支持就算了，静默降级 */ }
    }
    if (!this.sfxPool.length) this.sfxPool = null;
  },

  /**
   * 播一次撞击声。
   * @param kind 1 球撞球 / 2 撞库 / 3 落袋
   * @param power 0..1000
   */
  playHit(kind, power) {
    if (!this.soundOn) return;
    this.initSfx();
    if (!this.sfxPool) return;
    const a = this.sfxPool[this.sfxNext++ % this.sfxPool.length];
    try {
      a.stop();
      a.volume = Math.max(0.05, Math.min(1, power / 1000));
      // 用倍速区分音色：球撞球脆、撞库沉、落袋更沉
      if (a.playbackRate !== undefined) {
        a.playbackRate = kind === 1 ? 1.6 : (kind === 2 ? 0.85 : 0.6);
      }
      a.play();
    } catch (e) {}
  },

  /** 出杆瞬间：击球声 + 一下短震动 */
  playCue(power) {
    this.playHit(1, Math.round(power * 0.75));
    if (wx.vibrateShort) {
      try { wx.vibrateShort({ type: power > 600 ? 'medium' : 'light' }); } catch (e) {}
    }
  },

  // ==================== 单机 ====================

  startSolo() {
    this.game = RULES.createGame(0);
    this.mySeat = 0;
    this.setData({
      p0Name: '我', p1Name: ['电脑·新手', '电脑·普通', '电脑·高手'][this.difficulty],
      waiting: false
    });
    this.syncHud();
    this.loop();
  },

  // ==================== 联机 ====================

  async startOnline() {
    // 先摆一副静态球台：万一首次拉取失败，也不会是一片空白。
    // mySeat 仍是 -1，此时不可操作，等推送到达再对齐。
    if (!this.game) this.game = RULES.createGame(0);

    try {
      const res = await NET.callFn('get', { roomId: this.roomId });
      this.applyRoom(res.room);
    } catch (e) {
      this.setData({ message: '同步失败：' + e.message + '（正在重试）' });
    }

    // 实时监听：服务端一改房间文档，这里立刻收到
    this.watcher = NET.watchRoom(this.roomId, {
      onChange: (doc) => this.onRoomChange(doc),
      onError: () => this.setData({ message: '连接中断，正在重连…' })
    });

    this.startTurnTimer();
    this.loop();
  },

  /** 首次拉取的完整房间视图 */
  applyRoom(room) {
    this.mySeat = room.seat;
    this.game = room.game;
    this.playedIndex = room.game.shotIndex;  // 进房时不回放历史
    this.turnDeadline = room.turnDeadline;
    this.setData({
      roomCode: room.code,
      waiting: room.status === 'waiting',
      p0Name: (room.players[0] && room.players[0].name) || '房主',
      p1Name: (room.players[1] && room.players[1].name) || '等待中',
      message: room.game.lastMessage || '开球'
    });
    this.syncHud();
  },

  /**
   * 实时推送的处理 —— 联机体验的关键。
   *
   * 服务端只发「谁出了什么杆」，不发上百帧坐标。这里拿上一个权威
   * 局面 + 这一杆参数，本地重跑物理得到动画，再把结果对齐到服务端
   * 的权威 state。省流量，且天然抗抖动。
   *
   * 两种后端推来的对象字段一致：云开发推原始文档，自建服务端推
   * publicView。后者额外带 seat，顺手用它校正座位号。
   */
  onRoomChange(doc) {
    if (!doc || !doc.game) return;

    const room = {
      code: doc.code,
      status: doc.status,
      players: doc.players || [],
      game: doc.game,
      lastShot: doc.lastShot,
      turnDeadline: doc.turnDeadline
    };
    this.turnDeadline = room.turnDeadline;
    if (typeof doc.seat === 'number' && doc.seat !== -1) this.mySeat = doc.seat;

    this.setData({
      waiting: room.status === 'waiting',
      p0Name: (room.players[0] && room.players[0].name) || '房主',
      p1Name: (room.players[1] && room.players[1].name) || '等待中'
    });

    const shot = room.lastShot;
    const newIndex = room.game.shotIndex;
    const prevIndex = this.playedIndex;

    // 对手点了「再来一局」并成功重开：局面被重置，收起结算浮层
    if (room.status === 'playing' && room.game.winner === -1 && this.data.gameOver) {
      this.playedIndex = room.game.shotIndex;
      this.frames = null;
      this.audio = null;
      this.pendingResult = null;
      this.authoritative = null;
      if (this.renderer) this.renderer.resetSpin();
      this.setData({ gameOver: false, busy: false, rematchWaiting: false, message: '新一局开始' });
      this.game = room.game;
      this.syncHud();
      this.startTurnTimer();
      return;
    }

    // 没有新杆（比如只是有人加入），直接同步局面
    if (!shot || newIndex <= this.playedIndex) {
      this.game = room.game;
      this.authoritative = null;
      this.syncHud();
      this.setData({ message: room.game.lastMessage || this.data.message });
      this.checkOver(room.game);
      return;
    }

    // 自己出的杆：本地已经在放动画了，只需接收权威结果做校正
    if (shot.by === this.mySeat) {
      this.playedIndex = newIndex;
      this.authoritative = room.game;
      if (!this.frames) this.settleTo(room.game);
      return;
    }

    // 对手出的杆：本地重放
    this.playedIndex = newIndex;

    // 只有「正好差一杆」才能安全重放 —— 本地 this.game 必须是这一杆的
    // 起始局面。弱网丢过推送导致跳号时，重放会算出错误画面，
    // 这时直接快照到权威局面，宁可少一段动画也不能错。
    const canReplay = shot.shot && this.game && newIndex === prevIndex + 1;
    if (canReplay) {
      const replay = RULES.applyShot(this.game, shot.shot);
      // 对手那一杆的击球声也要有 —— 少了它，对面出杆时画面动了却毫无动静
      this.playCue(shot.shot.power || 500);
      this.startPlayback(replay);
      this.authoritative = room.game;   // 动画播完后对齐到这份
      this.setData({ busy: true, message: shot.log || room.game.lastMessage });
    } else {
      // 超时/认输，或跳号需要强制对齐
      this.settleTo(room.game);
      this.setData({ message: shot.log || room.game.lastMessage });
    }
    this.checkOver(room.game);
  },

  /** 动画结束后，用服务端权威 state 覆盖本地推算结果 */
  settleTo(game) {
    this.game = game;
    this.frames = null;
    this.audio = null;
    this.playT = 0;
    this.authoritative = null;
    this.setData({ busy: false, message: game.lastMessage || '' });
    this.syncHud();
    this.checkOver(game);
  },

  checkOver(game) {
    if (game.winner === -1) return;
    const iWon = game.winner === this.mySeat;
    this.setData({
      gameOver: true,
      busy: false,
      overText: this.mode === 'solo'
        ? (game.winner === 0 ? '你赢了！' : '电脑赢了')
        : (iWon ? '你赢了！' : '你输了')
    });
    if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });
  },

  /** 回合倒计时；到点由等待方发起 timeout，服务端复核 */
  startTurnTimer() {
    if (this.timerId) clearInterval(this.timerId);
    this.timerId = setInterval(() => {
      if (!this.game || this.game.winner !== -1 || this.data.waiting) {
        if (this.data.countdown !== 0) this.setData({ countdown: 0 });
        return;
      }
      const left = this.turnDeadline ? Math.ceil((this.turnDeadline - Date.now()) / 1000) : 0;
      const show = Math.max(0, Math.min(CONFIG.TURN_SECONDS, left));
      if (show !== this.data.countdown) this.setData({ countdown: show });

      if (left <= 0 && this.game.turn !== this.mySeat && !this.timeoutSent) {
        this.timeoutSent = true;
        NET.callFn('timeout', { roomId: this.roomId })
          .catch(() => {})
          .then(() => { setTimeout(() => { this.timeoutSent = false; }, 3000); });
      }
    }, 500);
  },

  syncHud() {
    if (!this.game) return;
    const g = this.game;
    const myTurn = g.turn === this.mySeat && g.winner === -1 && !this.data.waiting;
    this.setData({
      turn: g.turn,
      myTurn: myTurn,
      ballInHand: g.ballInHand,
      p0Group: RULES.groupName(g.groups[0]),
      p1Group: RULES.groupName(g.groups[1])
    });
    // 单机模式下轮到电脑，安排它出杆
    if (this.mode === 'solo' && g.turn === 1 && g.winner === -1 && !this.frames) {
      this.scheduleBot();
    }
  },

  scheduleBot() {
    if (this.botPending) return;
    this.botPending = true;
    this.setData({ busy: true, message: '电脑思考中…' });
    // 给一点思考时间，纯即时出杆反而显得假
    setTimeout(() => {
      this.botPending = false;
      if (!this.game || this.game.winner !== -1) return;
      const shot = BOT.pickShot(this.game, this.difficulty);
      this.playCue(shot.power);
      this.runShotLocal(shot);
    }, 700);
  },

  // ==================== 触摸交互 ====================

  onTouchStart(e) {
    if (!this.canShoot()) return;
    const t = e.touches[0];
    const pt = this.renderer.toLogic(t.x, t.y);

    // 自由球阶段：先判断是不是要拖白球摆位
    if (this.game.ballInHand) {
      const cue = this.game.balls[0];
      const dx = pt.x - cue.x;
      const dy = pt.y - cue.y;
      // 触摸半径给宽一些，手指没那么准
      if (dx * dx + dy * dy < (P.TABLE.R * 4) * (P.TABLE.R * 4)) {
        this.draggingCue = true;
        return;
      }
    }

    this.aiming = true;
    this.aimStart = pt;
    this.aimNow = pt;
  },

  onTouchMove(e) {
    const t = e.touches[0];
    const pt = this.renderer.toLogic(t.x, t.y);

    if (this.draggingCue) {
      const spot = P.findFreeSpot(this.game.balls, pt.x, pt.y);
      const cue = this.game.balls[0];
      cue.x = spot.x;
      cue.y = spot.y;
      return;
    }

    if (!this.aiming) return;
    this.aimNow = pt;
    const pct = Math.round(this.currentPower() / 10);
    if (pct !== this.data.powerPct) this.setData({ powerPct: pct });
  },

  onTouchEnd() {
    if (this.draggingCue) { this.draggingCue = false; return; }
    if (!this.aiming) return;
    this.aiming = false;

    const power = this.currentPower();
    this.setData({ powerPct: 0 });
    // 低于 25 算误触取消。取 25（而非早先的 60）是因为力度→初速改成开平方
    // 之后，25 已经能推着球走小半个球径，轻推轻碰这类手法用得上。
    if (power < 25) return;

    // 拉杆方向：手指往后拉，球往前走（像真实拉杆）
    const cue = this.game.balls[0];
    const dirX = cue.x - this.aimNow.x;
    const dirY = cue.y - this.aimNow.y;
    if (dirX === 0 && dirY === 0) return;

    const q = P.quantizeAim(dirX, dirY);
    const shot = { dx: q.dx, dy: q.dy, power: power };
    if (this.game.ballInHand) {
      shot.cueX = cue.x;
      shot.cueY = cue.y;
    }

    this.playCue(power);
    if (this.mode === 'solo') this.runShotLocal(shot);
    else this.sendShot(shot);
  },

  /**
   * 力度 = 拉杆距离，映射到 0..1000 的整数。
   *
   * 3D 下按台面平面上的逻辑距离算（而不是屏幕像素），所以同样的手指行程
   * 在两个视角下给出同样的力度 —— 换视角不会改手感。
   */
  currentPower() {
    if (!this.aimStart || !this.aimNow) return 0;
    const cue = this.game.balls[0];
    const dx = this.aimNow.x - cue.x;
    const dy = this.aimNow.y - cue.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxPull = P.TABLE.W * 0.32;   // 拉满的距离
    const p = Math.min(dist / maxPull, 1);
    return Math.round(p * 1000);
  },

  canShoot() {
    return this.game && !this.data.busy && !this.data.gameOver
      && !this.data.waiting && this.game.turn === this.mySeat
      && this.game.winner === -1 && !this.pendingShot;
  },

  // ==================== 出杆执行 ====================

  /** 起动画：重置播放时钟与音轨游标。所有出杆路径都走这里 */
  startPlayback(result) {
    this.frames = result.frames;
    this.audio = result.audio || null;
    this.audioIdx = 0;
    this.playT = 0;
  },

  /** 单机：本地算完直接生效 */
  runShotLocal(shot) {
    const result = RULES.applyShot(this.game, shot);
    this.startPlayback(result);
    this.pendingResult = result.state;
    this.setData({ busy: true, message: '走球中…' });
  },

  /**
   * 联机：本地立刻起动画（0 延迟手感），同时把这一杆发给服务端。
   * 服务端用同一份 rules 重算并广播，动画播完后对齐权威结果。
   * 若服务端拒绝（不是你的回合、状态过期），回滚到权威局面。
   */
  async sendShot(shot) {
    this.pendingShot = true;
    const before = this.game;

    const local = RULES.applyShot(before, shot);
    this.startPlayback(local);
    this.pendingResult = local.state;
    this.setData({ busy: true, message: '走球中…' });

    try {
      const res = await NET.callFn('shoot', {
        roomId: this.roomId,
        shot: shot,
        shotIndex: before.shotIndex
      });
      this.playedIndex = res.game.shotIndex;
      this.authoritative = res.game;
      this.timeoutSent = false;
      // 动画还在播就等它播完；已播完则立即对齐
      if (!this.frames) this.settleTo(res.game);
    } catch (e) {
      // 出杆被拒：丢弃本地动画，拉一次权威状态回滚
      this.frames = null;
      this.audio = null;
      this.pendingResult = null;
      this.setData({ busy: false, message: '出杆无效：' + e.message });
      try {
        const fresh = await NET.callFn('get', { roomId: this.roomId });
        this.game = fresh.room.game;
        this.playedIndex = fresh.room.game.shotIndex;
        this.turnDeadline = fresh.room.turnDeadline;
        this.syncHud();
      } catch (_) {}
    } finally {
      this.pendingShot = false;
    }
  },

  // ==================== 渲染循环 ====================

  loop() {
    if (!this.canvas || !this.renderer) return;
    if (this.rafId) return;   // 已在跑，别开第二个循环（rematch 时会重复调用）
    this.lastT = 0;           // 下一帧重新对时
    const step = (now) => {
      this.draw(now);
      this.rafId = this.canvas.requestAnimationFrame(step);
    };
    this.rafId = this.canvas.requestAnimationFrame(step);
  },

  onShow() {
    // 从后台回来时重启渲染循环
    if (!this.rafId && this.canvas) this.loop();
  },

  /**
   * 一帧。
   *
   * @param now rAF 时间戳（毫秒）。动画进度按真实时间推进，而不是"一 tick
   *            一帧"—— 后者在 120Hz 屏上会让整杆快一倍，且每台设备不一样。
   */
  draw(now) {
    const r = this.renderer;
    if (!r || !this.game) return;

    let dt = 0;
    if (now) {
      if (this.lastT) dt = Math.min((now - this.lastT) / 1000, 0.05);
      this.lastT = now;
    }

    // 视角向目标缓动。dt 为 0（首帧、刚从后台回来）时不推进，
    // 否则会一步跳到目标，白瞎了过渡。
    if (this.tilt !== this.tiltTarget && dt > 0) {
      const d = this.tiltTarget - this.tilt;
      const stepAmt = dt / TILT_SECONDS;
      if (Math.abs(d) <= stepAmt) this.tilt = this.tiltTarget;
      else this.tilt += (d > 0 ? stepAmt : -stepAmt);
      r.setTilt(easeInOut(this.tilt));
    }

    r.clear();
    r.drawTable();

    if (this.frames) { this.drawPlayback(r, dt); return; }

    const balls = this.game.balls;
    for (let i = 0; i < balls.length; i++) {
      if (balls[i].active) r.advanceSpin(balls[i]);
    }
    r.drawBalls(balls);

    if (this.aiming) this.drawAim(r);
    if (this.game.ballInHand && this.game.turn === this.mySeat && !this.data.busy) {
      this.drawCueHalo(r);
    }
  },

  /**
   * 播放一杆的动画：按真实时间在 60Hz 帧序列之间插值。
   * 插值让高刷屏真的更顺滑（而不是更快），低刷屏也不丢球位。
   */
  drawPlayback(r, dt) {
    this.playT += dt;

    const pos = this.playT / P.TABLE.FRAME_DT;
    const last = this.frames.length - 1;

    // 播到该出声的帧就把攒下的音效放出来
    if (this.audio) {
      while (this.audioIdx < this.audio.length && this.audio[this.audioIdx] <= pos) {
        this.playHit(this.audio[this.audioIdx + 1], this.audio[this.audioIdx + 2]);
        this.audioIdx += 3;
      }
    }

    if (pos >= last) {
      // 先把最后一帧画出来再结算，避免"最后一帧没显示就跳局面"
      this.drawFrame(r, this.frames[last], null, 0);
      const final = this.authoritative || this.pendingResult;
      this.frames = null;
      this.audio = null;
      this.pendingResult = null;
      if (final) this.settleTo(final);
      else this.setData({ busy: false });
      return;
    }

    const i = Math.floor(pos);
    this.drawFrame(r, this.frames[i], this.frames[i + 1], pos - i);
  },

  /**
   * 画一帧（可与下一帧插值）。
   * frames 只含在台面上的球，所以两帧的球集合可能不同（中间有球落袋）；
   * 按 id 配对，配不上的（刚落袋）就用当前帧位置，不插值。
   */
  drawFrame(r, f, next, t) {
    const list = [];
    for (let i = 0; i < f.length; i += 3) {
      const id = f[i];
      let x = f[i + 1];
      let y = f[i + 2];
      if (next && t > 0) {
        for (let j = 0; j < next.length; j += 3) {
          if (next[j] === id) {
            x += (next[j + 1] - x) * t;
            y += (next[j + 2] - y) * t;
            break;
          }
        }
      }
      const b = { id: id, x: x, y: y, active: true };
      r.advanceSpin(b);
      list.push(b);
    }
    r.drawBalls(list);
  },

  /**
   * 瞄准辅助：拉杆线 + 预测线 + 目标球虚影。
   * 全部贴着台布画，这样 3D 下线条是躺在台面上的而不是浮在球上方 ——
   * 后者看着永远对不准。
   */
  drawAim(r) {
    const ctx = r.ctx;
    const cue = this.game.balls[0];

    // 拉杆虚线（手指侧）
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    r.strokeOnCloth(cue.x, cue.y, this.aimNow.x, this.aimNow.y);
    ctx.restore();

    // 出球方向
    let dx = cue.x - this.aimNow.x;
    let dy = cue.y - this.aimNow.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    dx /= len;
    dy /= len;

    const hit = this.castRay(cue, dx, dy);

    ctx.save();
    ctx.strokeStyle = 'rgba(244,197,82,0.9)';
    ctx.lineWidth = 2;
    r.strokeOnCloth(cue.x, cue.y, hit.x, hit.y);

    // 白球停靠位置的虚影
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    r.strokeCircleOnCloth(hit.x, hit.y, P.TABLE.R);

    // 被撞球的受力方向短线
    if (hit.ball) {
      let nx = hit.ball.x - hit.x;
      let ny = hit.ball.y - hit.y;
      const nl = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= nl; ny /= nl;
      ctx.strokeStyle = 'rgba(109,223,156,0.85)';
      ctx.lineWidth = 2;
      r.strokeOnCloth(hit.ball.x, hit.ball.y,
                      hit.ball.x + nx * P.TABLE.R * 5, hit.ball.y + ny * P.TABLE.R * 5);
    }
    ctx.restore();
  },

  /**
   * 瞄准线求交：沿方向步进，找最近的球或库边。
   * 步进法而非解析求解 —— 只用于画辅助线，精度够且代码短；
   * 真正的判定始终走 physics.simulate。
   */
  castRay(cue, dx, dy) {
    const step = P.TABLE.R * 0.5;
    const maxDist = P.TABLE.W * 1.2;
    const d2 = P.TABLE.R * 2;
    let x = cue.x;
    let y = cue.y;

    for (let travelled = 0; travelled < maxDist; travelled += step) {
      x += dx * step;
      y += dy * step;

      if (x < P.TABLE.R || x > P.TABLE.W - P.TABLE.R ||
          y < P.TABLE.R || y > P.TABLE.H - P.TABLE.R) {
        return { x: x, y: y, ball: null };
      }

      const balls = this.game.balls;
      for (let i = 1; i < balls.length; i++) {
        const b = balls[i];
        if (!b.active) continue;
        const ddx = b.x - x;
        const ddy = b.y - y;
        if (ddx * ddx + ddy * ddy <= d2 * d2) {
          return { x: x, y: y, ball: b };
        }
      }
    }
    return { x: x, y: y, ball: null };
  },

  /** 自由球时给白球加个提示光环 */
  drawCueHalo(r) {
    const ctx = r.ctx;
    const cue = this.game.balls[0];
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(244,197,82,0.85)';
    ctx.lineWidth = 2;
    r.strokeCircleOnCloth(cue.x, cue.y, P.TABLE.R * 1.9);
    ctx.restore();
  },

  // ==================== 视角 / 音效开关 ====================

  onToggleView() {
    const to3D = this.tiltTarget < 0.5;
    this.tiltTarget = to3D ? 1 : 0;
    this.setData({ is3D: to3D });
    try { wx.setStorageSync('poolView3D', to3D ? 1 : ''); } catch (e) {}
  },

  onToggleSound() {
    this.soundOn = !this.soundOn;
    this.setData({ soundOn: this.soundOn });
    try { wx.setStorageSync('poolSoundOff', this.soundOn ? '' : 1); } catch (e) {}
  },

  // ==================== 底部按钮 ====================

  onCopyCode() {
    wx.setClipboardData({ data: this.data.roomCode });
  },

  async onRematch() {
    if (this.mode === 'solo') {
      this.setData({ gameOver: false, busy: false, message: '开球' });
      this.frames = null;
      this.audio = null;
      this.pendingResult = null;
      this.authoritative = null;
      // 球要重摆了，清掉滚动相位，免得新局第一帧球凭空自转
      if (this.renderer) this.renderer.resetSpin();
      this.startSolo();
      return;
    }
    try {
      const res = await NET.callFn('rematch', { roomId: this.roomId });
      if (res.waitingForOpponent) {
        // 只有自己点了，等对手；真正重开由 watch 推送触发
        this.setData({ rematchWaiting: true });
        wx.showToast({ title: '已发起，等待对手确认', icon: 'none' });
        return;
      }
      this.game = res.game;
      this.playedIndex = res.game.shotIndex;
      this.frames = null;
      this.audio = null;
      this.authoritative = null;
      this.pendingResult = null;
      if (this.renderer) this.renderer.resetSpin();
      this.setData({ gameOver: false, busy: false, rematchWaiting: false, message: '新一局开始' });
      this.syncHud();
      this.startTurnTimer();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  onBack() {
    // 对局中退出 = 认输，先告知服务端再返回，别让对手干等
    if (this.mode === 'online' && this.game && this.game.winner === -1 && !this.data.waiting) {
      wx.showModal({
        title: '退出对局',
        content: '中途退出将判定为认输，确定吗？',
        success: (res) => {
          if (!res.confirm) return;
          NET.callFn('leave', { roomId: this.roomId }).catch(() => {});
          wx.navigateBack();
        }
      });
      return;
    }
    if (this.mode === 'online') NET.callFn('leave', { roomId: this.roomId }).catch(() => {});
    wx.navigateBack();
  }
});

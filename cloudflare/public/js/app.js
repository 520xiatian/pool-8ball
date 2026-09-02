/**
 * Web 版游戏主控
 * ---------------------------------------------------------------
 * 与小程序 pages/game/game.js 同一套流程，只是把 wx API 换成 DOM。
 * 物理、规则、AI、渲染全部复用 /logic 下的文件 —— 那是与服务端
 * 逐字节相同的代码，所以联机判定不会分叉。
 */
(function () {
  'use strict';

  var P = window.__poolModules['physics.js'];
  var RULES = window.__poolModules['rules.js'];
  var BOT = window.__poolModules['bot.js'];
  var RENDER = window.__poolModules['renderer.js'];
  var NET = window.PoolNet;

  var TURN_SECONDS = 45;

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var lobbyEl = $('lobby');
  var gameEl = $('game');
  var canvas = $('table');
  var msgEl = $('msg');
  var hintEl = $('hint');
  var timerEl = $('timer');
  var powerFill = $('powerFill');
  var powerNum = $('powerNum');
  var waitOverlay = $('waitOverlay');
  var overOverlay = $('overOverlay');
  var toastEl = $('toast');

  // ---------- 状态 ----------
  var S = {
    mode: 'solo',          // solo | online
    difficulty: 1,
    game: null,
    mySeat: 0,
    roomId: '',
    roomCode: '',
    // '' 表示还没进任何对局。刻意不用 'playing' 当初值 ——
    // 否则「是否已开局」的判断在页面刚加载时就为真了。
    status: '',
    frames: null,
    // 播放进度用**秒**记而不是帧下标：frames 是按 1/60 生成的，
    // 早先按 rAF tick 逐帧消费，144Hz 屏上整杆会快 2.4 倍。
    playT: 0,
    lastT: 0,
    audio: null,
    audioIdx: 0,
    authoritative: null,   // 联机：动画播完后要对齐到的权威局面
    pendingResult: null,   // 单机 / 联机本地预测结果
    playedIndex: 0,
    turnDeadline: 0,
    busy: false,
    gameOver: false,
    pendingShot: false,
    botPending: false,
    timeoutSent: false,
    watcher: null,
    renderer: null,
    rafId: 0,
    timerId: 0,
    // 视角：tilt 是当前值，tiltTarget 是目标值，每帧向目标靠近
    tilt: 0,
    tiltTarget: 0,
    // 交互
    aiming: false,
    aimNow: null,
    draggingCue: false,
    pointerId: null
  };

  var toastTimer = 0;
  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 2200);
  }

  function setMsg(t) { msgEl.textContent = t || ''; }
  function setHint(t, warn) {
    hintEl.textContent = t;
    hintEl.className = warn ? 'hint hint--warn' : 'hint';
  }

  // ================== 音效 ==================
  //
  // 全部用 WebAudio 合成，不加载任何音频文件：击球声本质就是一段几毫秒的
  // 噪声脉冲加快速衰减，合成出来比找素材更好调，也不用多一次网络请求。
  //
  // AudioContext 必须在用户手势里创建/恢复 —— 浏览器的自动播放策略会把
  // 页面加载时创建的 context 挂在 suspended 上，永远不出声。

  var AC = null;
  var sfxOn = true;

  function audioReady() {
    if (!sfxOn) return null;
    if (!AC) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) { sfxOn = false; return null; }
      try { AC = new Ctor(); } catch (e) { sfxOn = false; return null; }
    }
    if (AC.state === 'suspended') AC.resume().catch(function () {});
    return AC.state === 'closed' ? null : AC;
  }

  /** 一小段白噪声，合成撞击的"咔"。缓存复用，避免每次现填数组 */
  var noiseBuf = null;
  function noise(ac) {
    if (noiseBuf) return noiseBuf;
    var n = Math.floor(ac.sampleRate * 0.12);
    noiseBuf = ac.createBuffer(1, n, ac.sampleRate);
    var d = noiseBuf.getChannelData(0);
    // 固定线性同余序列而不是 Math.random：同一杆重播两次听起来一样
    var seed = 12345;
    for (var i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x3fffffff) - 1;
    }
    return noiseBuf;
  }

  /**
   * 播一次撞击声。
   * @param kind 1 球撞球 / 2 撞库 / 3 落袋
   * @param power 0..1000，来自物理的撞击强度
   */
  function playHit(kind, power) {
    var ac = audioReady();
    if (!ac) return;
    var v = power / 1000;
    if (v <= 0) return;

    var src = ac.createBufferSource();
    src.buffer = noise(ac);

    var bp = ac.createBiquadFilter();
    var gain = ac.createGain();
    var now = ac.currentTime;

    if (kind === 1) {
      // 象牙球对撞：高频、极短、力度越大音调越高
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + v * 2600;
      bp.Q.value = 1.6;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.10 + 0.55 * v, now + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05 + 0.05 * v);
      src.playbackRate.value = 1.6;
    } else if (kind === 2) {
      // 撞库：库皮吸掉高频，剩下沉闷的"咚"
      bp.type = 'lowpass';
      bp.frequency.value = 420 + v * 700;
      bp.Q.value = 0.8;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08 + 0.34 * v, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.10 + 0.06 * v);
      src.playbackRate.value = 0.75;
    } else {
      // 落袋：球撞袋底再滚一下，低频 + 稍长的尾巴
      bp.type = 'lowpass';
      bp.frequency.value = 300 + v * 400;
      bp.Q.value = 0.7;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.14 + 0.30 * v, now + 0.010);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      src.playbackRate.value = 0.55;
    }

    src.connect(bp);
    bp.connect(gain);
    gain.connect(ac.destination);
    src.start(now);
    src.stop(now + 0.4);
  }

  /** 出杆瞬间：皮头击打白球，比球撞球更"闷"一点，另外带一下震动 */
  function playCue(power) {
    var ac = audioReady();
    if (ac) {
      var v = power / 1000;
      var src = ac.createBufferSource();
      src.buffer = noise(ac);
      var bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900 + v * 1200;
      bp.Q.value = 1.1;
      var gain = ac.createGain();
      var now = ac.currentTime;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.10 + 0.40 * v, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);
      src.playbackRate.value = 1.2;
      src.connect(bp); bp.connect(gain); gain.connect(ac.destination);
      src.start(now);
      src.stop(now + 0.3);
    }
    // 触屏设备上，震动比声音更能传达"打出去了"
    if (navigator.vibrate) {
      try { navigator.vibrate(Math.round(8 + power / 1000 * 22)); } catch (e) {}
    }
  }

  // ================== 画布 ==================

  /** 建立（或屏幕尺寸变化后重建）渲染器 */
  function setupCanvas() {
    var rect = canvas.parentElement.getBoundingClientRect();
    var w = Math.max(1, Math.floor(rect.width));
    var h = Math.max(1, Math.floor(rect.height));
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);   // 超过 2.5 纯浪费性能

    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    var ctx = canvas.getContext('2d');
    // createRenderer 会自己设 canvas.width/height 并 scale(dpr)，
    // 但 ctx 的变换是累积的，所以每次重建前先复位
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    S.renderer = RENDER.createRenderer(canvas, ctx, w, h, dpr);
    S.renderer.setTilt(S.tilt);
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    if (gameEl.classList.contains('screen--on') === false) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setupCanvas, 150);
  });

  window.addEventListener('orientationchange', function () {
    setTimeout(setupCanvas, 300);
  });

  // ================== 渲染循环 ==================

  function loop() {
    if (S.rafId) return;   // 已在跑，别开第二个
    S.lastT = 0;           // 下一帧重新对时，避免用上次停循环前的旧时刻
    var step = function (now) {
      draw(now);
      S.rafId = requestAnimationFrame(step);
    };
    S.rafId = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (S.rafId) cancelAnimationFrame(S.rafId);
    S.rafId = 0;
    S.lastT = 0;
  }

  // 视角切换时长（秒）。太快会晃眼，太慢显得拖沓。
  var TILT_SECONDS = 0.55;

  /**
   * 一帧。
   *
   * @param now rAF 给的时间戳（毫秒）。所有随时间推进的东西都按它算真实
   *            时间差，而不是"一 tick 一步"—— 后者在 120/144Hz 屏上会让
   *            整杆动画快 2~2.4 倍，且每台设备手感都不一样。
   */
  function draw(now) {
    var r = S.renderer;
    if (!r || !S.game) return;

    // 帧间隔。首帧、以及后台切回来的那一帧，dt 会异常大，夹到 50ms。
    var dt = 0;
    if (now) {
      if (S.lastT) dt = Math.min((now - S.lastT) / 1000, 0.05);
      S.lastT = now;
    }

    // 视角向目标缓动。dt 为 0（首帧、或刚从后台切回）时不推进，
    // 否则会一步跳到目标，白瞎了这段过渡。
    if (S.tilt !== S.tiltTarget && dt > 0) {
      var d = S.tiltTarget - S.tilt;
      var stepAmt = dt / TILT_SECONDS;
      if (Math.abs(d) <= stepAmt) S.tilt = S.tiltTarget;
      else S.tilt += (d > 0 ? stepAmt : -stepAmt);
      r.setTilt(easeInOut(S.tilt));
    }

    r.clear();
    r.drawTable();

    // 有动画帧就放帧，否则画静态局面
    if (S.frames) {
      drawPlayback(r, dt);
      return;
    }

    var balls = S.game.balls;
    for (var k = 0; k < balls.length; k++) {
      if (balls[k].active) r.advanceSpin(balls[k]);
    }
    r.drawBalls(balls);

    if (S.aiming && S.aimNow) drawAim(r);
    if (S.game.ballInHand && S.game.turn === S.mySeat && !S.busy && !S.gameOver) {
      drawCueHalo(r);
    }
  }

  /** 视角缓动曲线：两头慢中间快，比线性顺眼 */
  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
  }

  /**
   * 播放一杆的动画。
   *
   * 按真实时间在 frames 之间插值：帧序列是 60Hz 生成的，而屏幕可能是
   * 60/90/120/144Hz。插值让高刷屏真的更顺滑（而不是更快），也让低刷屏
   * 不丢球位。
   */
  function drawPlayback(r, dt) {
    S.playT += dt;

    var fps = 1 / P.TABLE.FRAME_DT;
    var pos = S.playT * fps;                 // 浮点帧位置
    var last = S.frames.length - 1;

    // 播到该出声的帧就把攒下的音效放出来（可能一帧多条、也可能跨过多帧）
    if (S.audio) {
      while (S.audioIdx < S.audio.length && S.audio[S.audioIdx] <= pos) {
        playHit(S.audio[S.audioIdx + 1], S.audio[S.audioIdx + 2]);
        S.audioIdx += 3;
      }
    }

    if (pos >= last) {
      // 播完：先把最后一帧画出来，再结算，避免"最后一帧没显示就跳局面"
      drawFrame(r, S.frames[last], null, 0);
      var final = S.authoritative || S.pendingResult;
      S.frames = null;
      S.audio = null;
      S.pendingResult = null;
      if (final) settleTo(final);
      else { S.busy = false; syncHud(); }
      return;
    }

    var i = Math.floor(pos);
    drawFrame(r, S.frames[i], S.frames[i + 1], pos - i);
  }

  /**
   * 画一帧（可与下一帧插值）。
   *
   * frames 是压缩过的 [id, x, y, id, x, y, ...]，且**只含在台面上的球** ——
   * 所以两帧的球集合可能不同（中间有球落袋）。按 id 配对，配不上的（刚落袋）
   * 就用当前帧的位置，不插值。
   */
  function drawFrame(r, f, next, t) {
    var list = [];
    for (var i = 0; i < f.length; i += 3) {
      var id = f[i];
      var x = f[i + 1];
      var y = f[i + 2];
      if (next && t > 0) {
        for (var j = 0; j < next.length; j += 3) {
          if (next[j] === id) {
            x += (next[j + 1] - x) * t;
            y += (next[j + 2] - y) * t;
            break;
          }
        }
      }
      var b = { id: id, x: x, y: y, active: true };
      r.advanceSpin(b);
      list.push(b);
    }
    r.drawBalls(list);
  }

  /**
   * 瞄准辅助：拉杆线 + 预测线 + 白球停靠虚影 + 被撞球受力方向。
   * 全部贴着台布画（strokeOnCloth / strokeCircleOnCloth），这样 3D 下线条
   * 是躺在台面上的，而不是浮在球的上方 —— 后者看着永远对不准。
   */
  function drawAim(r) {
    var ctx = r.ctx;
    var cue = S.game.balls[0];

    // 拉杆线：从白球拉向手指反方向
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    r.strokeOnCloth(cue.x, cue.y, S.aimNow.x, S.aimNow.y);
    ctx.restore();

    var dx = cue.x - S.aimNow.x;
    var dy = cue.y - S.aimNow.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    dx /= len;
    dy /= len;

    var hit = castRay(cue, dx, dy);

    ctx.save();
    // 出杆方向线
    ctx.strokeStyle = 'rgba(244,197,82,0.9)';
    ctx.lineWidth = 2;
    r.strokeOnCloth(cue.x, cue.y, hit.x, hit.y);

    // 白球停靠位置的虚影
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    r.strokeCircleOnCloth(hit.x, hit.y, P.TABLE.R);

    // 被撞球的受力方向（球心连线的延长线）
    if (hit.ball) {
      var nx = hit.ball.x - hit.x;
      var ny = hit.ball.y - hit.y;
      var nl = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= nl; ny /= nl;
      ctx.strokeStyle = 'rgba(109,223,156,0.85)';
      ctx.lineWidth = 2;
      r.strokeOnCloth(hit.ball.x, hit.ball.y,
                      hit.ball.x + nx * P.TABLE.R * 5, hit.ball.y + ny * P.TABLE.R * 5);
    }
    ctx.restore();
  }

  /**
   * 瞄准线求交：沿方向步进，找最近的球或库边。
   * 只用于画辅助线，真正的判定始终走 physics.simulate。
   */
  function castRay(cue, dx, dy) {
    var step = P.TABLE.R * 0.5;
    var maxDist = P.TABLE.W * 1.2;
    var d2 = P.TABLE.R * 2;
    var x = cue.x;
    var y = cue.y;

    for (var travelled = 0; travelled < maxDist; travelled += step) {
      x += dx * step;
      y += dy * step;
      if (x < P.TABLE.R || x > P.TABLE.W - P.TABLE.R ||
          y < P.TABLE.R || y > P.TABLE.H - P.TABLE.R) {
        return { x: x, y: y, ball: null };
      }
      var balls = S.game.balls;
      for (var i = 1; i < balls.length; i++) {
        var b = balls[i];
        if (!b.active) continue;
        var ddx = b.x - x;
        var ddy = b.y - y;
        if (ddx * ddx + ddy * ddy <= d2 * d2) return { x: x, y: y, ball: b };
      }
    }
    return { x: x, y: y, ball: null };
  }

  function drawCueHalo(r) {
    var ctx = r.ctx;
    var cue = S.game.balls[0];
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(244,197,82,0.85)';
    ctx.lineWidth = 2;
    r.strokeCircleOnCloth(cue.x, cue.y, P.TABLE.R * 1.9);
    ctx.restore();
  }

  // ================== 触摸 / 鼠标交互 ==================
  // 用 Pointer Events 一套代码同时覆盖触屏和鼠标

  function localPoint(ev) {
    var rect = canvas.getBoundingClientRect();
    return S.renderer.toLogic(ev.clientX - rect.left, ev.clientY - rect.top);
  }

  function canShoot() {
    // renderer 在进入对局后的第一个 rAF 里才建立；在那之前点画布
    // 会因为拿不到坐标换算而报错，所以这里一并挡住
    return S.renderer && S.game && !S.busy && !S.gameOver && S.status === 'playing'
      && S.game.turn === S.mySeat && S.game.winner === -1 && !S.pendingShot;
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!canShoot()) return;
    ev.preventDefault();
    S.pointerId = ev.pointerId;
    // 合成事件（自动化测试）没有真实指针，捕获会抛错，不影响后续瞄准
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    var pt = localPoint(ev);

    // 自由球阶段：先判断是不是要拖白球摆位
    if (S.game.ballInHand) {
      var cue = S.game.balls[0];
      var dx = pt.x - cue.x;
      var dy = pt.y - cue.y;
      var grab = P.TABLE.R * 4;
      if (dx * dx + dy * dy < grab * grab) {
        S.draggingCue = true;
        return;
      }
    }

    S.aiming = true;
    S.aimNow = pt;
    updatePower();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (ev.pointerId !== S.pointerId) return;
    if (!S.aiming && !S.draggingCue) return;
    ev.preventDefault();
    var pt = localPoint(ev);

    if (S.draggingCue) {
      var spot = P.findFreeSpot(S.game.balls, pt.x, pt.y);
      var cue = S.game.balls[0];
      cue.x = spot.x;
      cue.y = spot.y;
      return;
    }
    S.aimNow = pt;
    updatePower();
  });

  function endPointer(ev) {
    if (ev.pointerId !== S.pointerId) return;
    S.pointerId = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}

    if (S.draggingCue) { S.draggingCue = false; return; }
    if (!S.aiming) return;
    S.aiming = false;

    var power = currentPower();
    setPowerBar(0);
    if (power < MIN_POWER) return;   // 轻碰视为取消

    // 拉杆方向：手指往后拉，球往前走
    var cue = S.game.balls[0];
    var dirX = cue.x - S.aimNow.x;
    var dirY = cue.y - S.aimNow.y;
    if (dirX === 0 && dirY === 0) return;

    var q = P.quantizeAim(dirX, dirY);
    var shot = { dx: q.dx, dy: q.dy, power: power };
    if (S.game.ballInHand) {
      shot.cueX = cue.x;
      shot.cueY = cue.y;
    }

    playCue(power);
    if (S.mode === 'solo') runShotLocal(shot);
    else sendShot(shot);
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // 低于这个力度算误触取消。取 25（而非早先的 60）是因为力度→初速改成开
  // 平方后，25 已经能推着球走小半个球径，轻推轻碰这类手法用得上。
  var MIN_POWER = 25;

  /**
   * 力度 = 拉杆距离，映射到 0..1000 的整数。
   *
   * 3D 下拉杆距离按台面平面上的逻辑距离算（而不是屏幕像素），所以同样的
   * 手指行程在两个视角下给出同样的力度 —— 换视角不会改手感。
   */
  function currentPower() {
    if (!S.aimNow || !S.game) return 0;
    var cue = S.game.balls[0];
    var dx = S.aimNow.x - cue.x;
    var dy = S.aimNow.y - cue.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var maxPull = P.TABLE.W * 0.32;
    return Math.round(Math.min(dist / maxPull, 1) * 1000);
  }

  function updatePower() { setPowerBar(Math.round(currentPower() / 10)); }

  function setPowerBar(pct) {
    powerFill.style.width = pct + '%';
    powerNum.textContent = pct + '%';
  }

  // ================== 出杆 ==================

  /** 起动画：重置播放时钟与音轨游标。所有出杆路径都走这里 */
  function startPlayback(result) {
    S.frames = result.frames;
    S.audio = result.audio || null;
    S.audioIdx = 0;
    S.playT = 0;
    S.busy = true;
  }

  /** 单机：本地算完直接生效 */
  function runShotLocal(shot) {
    var result = RULES.applyShot(S.game, shot);
    startPlayback(result);
    S.pendingResult = result.state;
    setMsg('走球中…');
    setHint('走球中…');
  }

  /**
   * 联机：本地立刻起动画（零延迟手感），同时把这一杆发给服务端。
   * 服务端用同一份 rules 重算并广播，动画播完后对齐权威结果。
   * 若服务端拒绝，回滚到权威局面。
   */
  function sendShot(shot) {
    S.pendingShot = true;
    var before = S.game;

    var local = RULES.applyShot(before, shot);
    startPlayback(local);
    S.pendingResult = local.state;
    setMsg('走球中…');

    NET.callFn('shoot', {
      roomId: S.roomId,
      shot: shot,
      shotIndex: before.shotIndex
    }).then(function (res) {
      S.playedIndex = res.game.shotIndex;
      S.authoritative = res.game;
      S.timeoutSent = false;
      if (!S.frames) settleTo(res.game);
    }).catch(function (e) {
      // 出杆被拒：丢弃本地动画，拉一次权威状态回滚
      S.frames = null;
      S.audio = null;
      S.pendingResult = null;
      S.busy = false;
      setMsg('出杆无效：' + e.message);
      return NET.callFn('get', { roomId: S.roomId }).then(function (fresh) {
        applyRoom(fresh.room);
      }).catch(function () {});
    }).then(function () {
      S.pendingShot = false;
    });
  }

  // ================== HUD ==================

  function syncHud() {
    if (!S.game) return;
    var g = S.game;

    $('hud0').className = 'hud__side' + (g.turn === 0 && !S.gameOver ? ' hud__side--on' : '');
    $('hud1').className = 'hud__side hud__side--right' + (g.turn === 1 && !S.gameOver ? ' hud__side--on' : '');
    $('p0Group').textContent = RULES.groupName(g.groups[0]);
    $('p1Group').textContent = RULES.groupName(g.groups[1]);

    if (S.gameOver) {
      setHint('对局已结束');
    } else if (S.status === 'waiting') {
      setHint('等待对手加入…');
    } else if (S.busy) {
      setHint('走球中…');
    } else if (g.turn === S.mySeat) {
      if (g.ballInHand) setHint('自由球：可先拖动白球摆位，再瞄准出杆', true);
      else setHint('按住台面往白球反方向拖动，松手出杆');
    } else {
      setHint('等待对手出杆…');
    }

    // 单机模式下轮到电脑，安排它出杆
    if (S.mode === 'solo' && g.turn === 1 && g.winner === -1 && !S.frames && !S.gameOver) {
      scheduleBot();
    }
  }

  function scheduleBot() {
    if (S.botPending) return;
    S.botPending = true;
    S.busy = true;
    setMsg('电脑思考中…');
    setHint('电脑思考中…');
    // 给一点思考时间，纯即时出杆反而显得假
    setTimeout(function () {
      S.botPending = false;
      if (!S.game || S.game.winner !== -1 || S.gameOver) return;
      var botShot = BOT.pickShot(S.game, S.difficulty);
      playCue(botShot.power);
      runShotLocal(botShot);
    }, 650);
  }

  function settleTo(game) {
    S.game = game;
    S.frames = null;
    S.audio = null;
    S.playT = 0;
    S.authoritative = null;
    S.pendingResult = null;
    S.busy = false;
    setMsg(game.lastMessage || '');
    syncHud();
    checkOver(game);
  }

  function checkOver(game) {
    if (game.winner === -1) return;
    S.gameOver = true;
    S.busy = false;

    var won = S.mode === 'solo' ? (game.winner === 0) : (game.winner === S.mySeat);
    $('overText').textContent = won ? '你赢了！' : (S.mode === 'solo' ? '电脑赢了' : '你输了');
    $('overDesc').textContent = game.lastMessage || '';
    $('btnRematch').disabled = false;
    $('btnRematch').textContent = '再来一局';
    overOverlay.hidden = false;
    stopTimer();
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
    syncHud();
  }

  // ================== 回合倒计时 ==================

  function startTimer() {
    stopTimer();
    S.timerId = setInterval(function () {
      if (!S.game || S.gameOver || S.status !== 'playing') {
        timerEl.textContent = '';
        return;
      }
      var left = S.turnDeadline ? Math.ceil((S.turnDeadline - Date.now()) / 1000) : 0;
      var show = Math.max(0, Math.min(TURN_SECONDS, left));
      timerEl.textContent = show > 0 ? show + 's' : '';

      // 到点由**等待方**发起，服务端会复核时间戳
      if (S.mode === 'online' && left <= 0 && S.game.turn !== S.mySeat && !S.timeoutSent) {
        S.timeoutSent = true;
        NET.callFn('timeout', { roomId: S.roomId }).catch(function () {}).then(function () {
          setTimeout(function () { S.timeoutSent = false; }, 3000);
        });
      }
    }, 500);
  }

  function stopTimer() {
    if (S.timerId) clearInterval(S.timerId);
    S.timerId = 0;
    timerEl.textContent = '';
  }

  // ================== 场景切换 ==================

  function showScreen(which) {
    lobbyEl.className = which === 'lobby' ? 'screen screen--on' : 'screen';
    gameEl.className = which === 'game' ? 'screen screen--on' : 'screen';
    if (which === 'game') {
      // 元素刚显示，必须等布局完成才能量到正确尺寸
      requestAnimationFrame(function () {
        setupCanvas();
        loop();
      });
    } else {
      stopLoop();
    }
  }

  function resetRound() {
    S.frames = null;
    S.audio = null;
    S.playT = 0;
    S.authoritative = null;
    S.pendingResult = null;
    S.busy = false;
    S.gameOver = false;
    S.aiming = false;
    S.draggingCue = false;
    S.pointerId = null;
    setPowerBar(0);
    overOverlay.hidden = true;
    waitOverlay.hidden = true;
    // 球要重摆了，清掉滚动相位，免得新局第一帧球凭空自转
    if (S.renderer) S.renderer.resetSpin();
  }

  // ================== 单机 ==================

  function startSolo() {
    teardownOnline();
    S.mode = 'solo';
    S.mySeat = 0;
    S.status = 'playing';
    S.game = RULES.createGame(0);
    S.playedIndex = 0;
    S.turnDeadline = 0;
    resetRound();

    $('p0Name').textContent = '我';
    $('p1Name').textContent = ['电脑 · 新手', '电脑 · 普通', '电脑 · 高手'][S.difficulty];
    setMsg('开球');
    stopTimer();
    showScreen('game');
    syncHud();
  }

  // ================== 联机 ==================

  function enterOnline(room) {
    teardownOnline();
    S.mode = 'online';
    resetRound();
    applyRoom(room);
    showScreen('game');

    S.watcher = NET.watchRoom(S.roomId, {
      onChange: onRoomChange,
      onError: function () { setMsg('连接中断，正在重连…'); },
      onGone: function () {
        setMsg('房间已关闭');
        toast('房间已关闭');
        setTimeout(backToLobby, 1200);
      }
    });
    startTimer();

    // 把房号写进地址栏，刷新后还能回到同一局，也方便直接分享链接
    try {
      history.replaceState(null, '', '?room=' + S.roomCode);
    } catch (e) {}
  }

  /** 用一份完整房间视图刷新本地状态（首次进入或回滚时用） */
  function applyRoom(room) {
    S.roomId = room._id;
    S.roomCode = room.code;
    S.status = room.status;
    S.game = room.game;
    S.playedIndex = room.game.shotIndex;   // 进房不回放历史
    S.turnDeadline = room.turnDeadline || 0;
    if (typeof room.seat === 'number' && room.seat !== -1) S.mySeat = room.seat;

    updateNames(room);
    updateWaiting(room);
    setMsg(room.game.lastMessage || '开球');
    syncHud();
    if (room.game.winner !== -1) checkOver(room.game);
  }

  function updateNames(room) {
    var ps = room.players || [];
    var n0 = (ps[0] && ps[0].name) || '房主';
    var n1 = (ps[1] && ps[1].name) || '等待中';
    // 给自己加个标记，双方昵称相同时也能分清
    $('p0Name').textContent = n0 + (S.mySeat === 0 ? '（你）' : '');
    $('p1Name').textContent = n1 + (S.mySeat === 1 ? '（你）' : '');
  }

  function updateWaiting(room) {
    if (room.status === 'waiting') {
      $('waitCode').textContent = room.code;
      waitOverlay.hidden = false;
    } else {
      waitOverlay.hidden = true;
    }
  }

  /**
   * 实时推送处理 —— 联机体验的关键。
   *
   * 服务端只发「谁出了什么杆」（91 字节），不发上百帧坐标。
   * 这里拿上一个局面 + 这一杆参数本地重跑物理得到动画，
   * 再把结果对齐到服务端的权威 state。
   */
  function onRoomChange(room) {
    if (!room || !room.game) return;

    S.status = room.status;
    S.turnDeadline = room.turnDeadline || 0;
    if (typeof room.seat === 'number' && room.seat !== -1) S.mySeat = room.seat;
    updateNames(room);
    updateWaiting(room);

    var shot = room.lastShot;
    var newIndex = room.game.shotIndex;
    var prevIndex = S.playedIndex;

    // 对手点了「再来一局」并成功重开：收起结算浮层
    if (room.status === 'playing' && room.game.winner === -1 && S.gameOver) {
      S.playedIndex = newIndex;
      resetRound();
      S.game = room.game;
      setMsg('新一局开始');
      syncHud();
      startTimer();
      return;
    }

    // 没有新杆（比如只是有人加入），直接同步局面
    if (!shot || newIndex <= prevIndex) {
      S.game = room.game;
      S.authoritative = null;
      setMsg(room.game.lastMessage || msgEl.textContent);
      syncHud();
      checkOver(room.game);
      return;
    }

    // 自己出的杆：本地已在放动画，只需接收权威结果做校正
    if (shot.by === S.mySeat) {
      S.playedIndex = newIndex;
      S.authoritative = room.game;
      if (!S.frames) settleTo(room.game);
      return;
    }

    // 对手出的杆：本地重放。
    // 只有「正好差一杆」才能安全重放 —— 本地 S.game 必须是这一杆的起始局面。
    // 弱网丢过推送导致跳号时，重放会算出错误画面，此时直接快照到权威局面。
    S.playedIndex = newIndex;
    var canReplay = shot.shot && S.game && newIndex === prevIndex + 1;
    if (canReplay) {
      var replay = RULES.applyShot(S.game, shot.shot);
      // 对手那一杆的击球声也要有 —— 少了它，对面出杆时画面动了却毫无动静
      playCue(shot.shot.power || 500);
      startPlayback(replay);
      S.authoritative = room.game;
      setMsg(shot.log || room.game.lastMessage);
      syncHud();
    } else {
      settleTo(room.game);
      setMsg(shot.log || room.game.lastMessage);
    }
    checkOver(room.game);
  }

  function teardownOnline() {
    if (S.watcher) { S.watcher.close(); S.watcher = null; }
    stopTimer();
  }

  function backToLobby() {
    teardownOnline();
    resetRound();
    S.mode = 'solo';
    S.roomId = '';
    S.roomCode = '';
    showScreen('lobby');
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }

  // ================== 大厅事件 ==================

  var busyBtn = false;

  /** 联机入口统一加锁，避免手快连点开出两个房间 */
  function withLock(btn, label, fn) {
    if (busyBtn) return;
    busyBtn = true;
    var old = btn.textContent;
    btn.textContent = label;
    btn.disabled = true;
    fn().catch(function (e) {
      toast(e.message || '操作失败', 3000);
    }).then(function () {
      busyBtn = false;
      btn.textContent = old;
      btn.disabled = false;
    });
  }

  $('btnSolo').addEventListener('click', startSolo);

  Array.prototype.forEach.call(document.querySelectorAll('.diff__opt'), function (el) {
    el.addEventListener('click', function () {
      S.difficulty = Number(el.dataset.diff);
      Array.prototype.forEach.call(document.querySelectorAll('.diff__opt'), function (o) {
        o.className = 'diff__opt' + (o === el ? ' diff__opt--on' : '');
      });
    });
  });

  $('btnCreate').addEventListener('click', function () {
    withLock(this, '创建中…', function () {
      return NET.callFn('create', { name: NET.getName() }).then(function (res) {
        enterOnline(res.room);
      });
    });
  });

  $('btnQuick').addEventListener('click', function () {
    withLock(this, '匹配中…', function () {
      return NET.callFn('quickMatch', { name: NET.getName() }).then(function (res) {
        enterOnline(res.room);
        if (res.room.status === 'playing') toast('匹配成功，开始对局');
      });
    });
  });

  $('joinForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = $('codeInput').value.toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (code.length !== 6) return toast('房间号是 6 位');
    joinByCode(code, ev.target.querySelector('button'));
  });

  $('codeInput').addEventListener('input', function () {
    this.value = this.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
  });

  function joinByCode(code, btn) {
    withLock(btn || $('btnQuick'), '加入中…', function () {
      return NET.callFn('join', { code: code, name: NET.getName() }).then(function (res) {
        enterOnline(res.room);
      });
    });
  }

  // ================== 对局内按钮 ==================

  // ---- 视角切换 ----
  //
  // 偏好写进 localStorage：换视角是个人习惯，不该每局重设一次。
  var VIEW_KEY = 'poolView3D';
  var SOUND_KEY = 'poolSoundOff';

  function readPref(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function writePref(key, val) {
    try {
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, val);
    } catch (e) {}
  }

  var btnView = $('btnView');
  var btnSound = $('btnSound');

  function applyView(is3D, animate) {
    S.tiltTarget = is3D ? 1 : 0;
    if (!animate) {
      S.tilt = S.tiltTarget;
      if (S.renderer) S.renderer.setTilt(S.tilt);
    }
    btnView.setAttribute('aria-pressed', is3D ? 'true' : 'false');
    btnView.textContent = is3D ? '3D' : '2D';
  }

  btnView.addEventListener('click', function () {
    var to3D = S.tiltTarget < 0.5;
    applyView(to3D, true);
    writePref(VIEW_KEY, to3D ? '1' : '0');
    // 点按钮本身就是用户手势，顺便把 AudioContext 解锁掉
    audioReady();
  });

  function applySound(on) {
    sfxOn = on;
    btnSound.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnSound.textContent = on ? '🔊' : '🔇';
    if (!on && AC) {
      // 只挂起不关闭：关掉之后没法再 resume，用户再打开就没声了
      AC.suspend().catch(function () {});
    }
  }

  btnSound.addEventListener('click', function () {
    var on = btnSound.getAttribute('aria-pressed') !== 'true';
    applySound(on);
    writePref(SOUND_KEY, on ? null : '1');
    if (on) audioReady();
  });

  $('btnCopyLink').addEventListener('click', function () {
    var link = location.origin + location.pathname + '?room=' + S.roomCode;
    copyText(link).then(function (ok) {
      toast(ok ? '链接已复制，发给朋友即可' : ('复制失败，房号：' + S.roomCode), 3000);
    });
  });

  /** 优先用剪贴板 API；不可用（非 HTTPS 或旧浏览器）时退回 execCommand */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; },
                                                      function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  $('btnCancelWait').addEventListener('click', function () {
    // 等待中退出：房主离开会销毁房间，不留僵尸房
    if (S.roomId) NET.callFn('leave', { roomId: S.roomId }).catch(function () {});
    backToLobby();
  });

  $('btnBackLobby').addEventListener('click', function () {
    if (S.mode === 'online' && S.roomId) {
      NET.callFn('leave', { roomId: S.roomId }).catch(function () {});
    }
    backToLobby();
  });

  $('btnQuit').addEventListener('click', function () {
    if (S.mode === 'solo') return backToLobby();
    // 对局中退出判定认输，先确认
    if (!S.gameOver && S.status === 'playing') {
      if (!confirm('中途退出将判定为认输，确定吗？')) return;
    }
    if (S.roomId) NET.callFn('leave', { roomId: S.roomId }).catch(function () {});
    backToLobby();
  });

  $('btnRematch').addEventListener('click', function () {
    if (S.mode === 'solo') {
      startSolo();
      return;
    }
    var btn = this;
    btn.disabled = true;
    NET.callFn('rematch', { roomId: S.roomId }).then(function (res) {
      if (res.waitingForOpponent) {
        // 只有自己点了，等对手；真正重开由推送触发
        btn.textContent = '等待对手确认…';
        toast('已发起，等待对手确认');
        return;
      }
      S.playedIndex = res.game.shotIndex;
      resetRound();
      S.game = res.game;
      setMsg('新一局开始');
      syncHud();
      startTimer();
    }).catch(function (e) {
      btn.disabled = false;
      toast(e.message || '重开失败', 3000);
    });
  });

  // ================== 生命周期 ==================

  // 切后台停渲染省电；回来重启（watch 仍在，状态会自动补上）
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop();
    else if (gameEl.classList.contains('screen--on')) loop();
  });

  // 关页面前告知服务端，别让对手干等 45 秒
  window.addEventListener('pagehide', function () {
    if (S.mode !== 'online' || !S.roomId || S.gameOver) return;
    try {
      // 页面正在卸载，fetch 可能被中断，用 sendBeacon 更可靠
      var body = JSON.stringify({ action: 'leave', token: NET.getToken(), roomId: S.roomId });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api', new Blob([body], { type: 'application/json' }));
      }
    } catch (e) {}
  });

  // ================== 启动 ==================

  (function init() {
    setPowerBar(0);

    // 恢复上次的视角与音效偏好（不带动画，避免开局先晃一下）
    applyView(readPref(VIEW_KEY) === '1', false);
    applySound(readPref(SOUND_KEY) !== '1');

    // 标记脚本已就绪：既能给 CSS 挂钩，也让自动化测试确认 JS 真的跑起来了
    document.body.dataset.poolReady = '1';

    // 只读状态快照，供调试和自动化测试观察局面推进。
    // 刻意只暴露少量标量，不给出可写引用。
    window.__poolPeek = function () {
      return {
        mode: S.mode,
        status: S.status,
        seat: S.mySeat,
        code: S.roomCode,
        // 渲染器就绪 = 可以接受触摸出杆（它在进入对局后的第一个 rAF 里建立）
        ready: !!S.renderer,
        shotIndex: S.game ? S.game.shotIndex : -1,
        turn: S.game ? S.game.turn : -1,
        winner: S.game ? S.game.winner : -1,
        busy: S.busy,
        gameOver: S.gameOver,
        onTable: S.game ? S.game.balls.filter(function (b) { return b.active; }).length : 0,
        // 视角：tilt 是当前值（过渡中是小数），tiltTarget 是目标值
        tilt: Math.round(S.tilt * 1000) / 1000,
        tiltTarget: S.tiltTarget,
        playing: !!S.frames
      };
    };

    // 带 ?room=XXXXXX 进来的（朋友分享的链接）直接尝试加入
    var m = /[?&]room=([0-9A-Za-z]{6})/.exec(location.search);
    if (m) {
      var code = m[1].toUpperCase();
      $('codeInput').value = code;
      NET.callFn('join', { code: code, name: NET.getName() }).then(function (res) {
        enterOnline(res.room);
      }).catch(function (e) {
        toast('自动加入失败：' + e.message, 3500);
        try { history.replaceState(null, '', location.pathname); } catch (err) {}
      });
    }
  })();
})();

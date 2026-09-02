/**
 * Web 版联机通道
 * ---------------------------------------------------------------
 * 与小程序的 net-ws.js 一一对应，只是把 wx.request / wx.connectSocket
 * 换成 fetch / WebSocket。接口保持一致：
 *
 *   callFn(action, payload) → Promise<result>
 *   watchRoom(roomId, {onChange, onError, onGone}) → { close() }
 *
 * 网页和 API 同源（都由这个 Worker 提供），所以不用配地址、没有 CORS 问题。
 */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'poolPlayerToken';

  /** 取（或首次生成）玩家身份令牌 */
  function getToken() {
    var t = null;
    try { t = localStorage.getItem(TOKEN_KEY); } catch (e) {}
    if (!t || !/^[0-9a-f]{32}$/.test(t)) {
      t = randomHex(32);
      try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
    }
    return t;
  }

  function randomHex(n) {
    var bytes = new Uint8Array(n / 2);
    crypto.getRandomValues(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
    return s;
  }

  /** 昵称：本地记住，用户可改 */
  function getName() {
    var n = null;
    try { n = localStorage.getItem('poolPlayerName'); } catch (e) {}
    if (!n) {
      n = '球手' + (1000 + Math.floor(Math.random() * 9000));
      try { localStorage.setItem('poolPlayerName', n); } catch (e) {}
    }
    return n;
  }

  function callFn(action, payload) {
    var body = Object.assign({ action: action, token: getToken() }, payload || {});
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);

    return fetch('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (res) {
      clearTimeout(timer);
      return res.json().catch(function () {
        throw new Error('服务端返回异常（HTTP ' + res.status + '）');
      });
    }).then(function (r) {
      if (!r || r.ok === false) {
        var err = new Error((r && r.error) || '操作失败');
        err.code = r && r.code;
        throw err;
      }
      return r;
    }).catch(function (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('请求超时，请检查网络');
      throw e;
    });
  }

  /**
   * 建立房间长连接。服务端每次房间状态变化就推 { type:'room', room }。
   *
   * 断线重连是必需的：切后台、锁屏、网络切换都会断，
   * 而台球是回合制，断了不重连就等于卡死在等对手。
   */
  function watchRoom(roomId, handlers) {
    var closed = false;
    var socket = null;
    var retryTimer = null;
    var heartbeat = null;

    function wsUrl() {
      var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
      return proto + location.host + '/ws?room=' + encodeURIComponent(roomId)
        + '&token=' + getToken();
    }

    function start() {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl());
      } catch (e) {
        if (handlers.onError) handlers.onError(e);
        return scheduleRetry();
      }

      socket.addEventListener('open', function () {
        if (closed) return socket.close();
        // 每 25 秒一个心跳：Cloudflare 会掐掉长时间空闲的连接
        heartbeat = setInterval(function () {
          try { socket.send('{"type":"ping"}'); } catch (e) {}
        }, 25000);
      });

      socket.addEventListener('message', function (ev) {
        if (closed) return;
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.type === 'room' && msg.room) {
          if (handlers.onChange) handlers.onChange(msg.room);
        } else if (msg.type === 'roomGone') {
          if (handlers.onGone) handlers.onGone();
        }
      });

      socket.addEventListener('error', function () {
        if (closed) return;
        if (handlers.onError) handlers.onError(new Error('连接出错'));
      });

      socket.addEventListener('close', function () {
        if (closed) return;
        scheduleRetry();
      });
    }

    function scheduleRetry() {
      if (closed || retryTimer) return;
      cleanup();
      retryTimer = setTimeout(function () {
        retryTimer = null;
        start();
      }, 2500);
    }

    function cleanup() {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      if (socket) {
        try { socket.close(); } catch (e) {}
        socket = null;
      }
    }

    start();

    return {
      close: function () {
        closed = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        cleanup();
      }
    };
  }

  global.PoolNet = {
    callFn: callFn,
    watchRoom: watchRoom,
    getToken: getToken,
    getName: getName
  };
})(window);

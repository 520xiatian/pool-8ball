/**
 * 自建服务端通道（本地 Node / Cloudflare Worker 通用）
 * ---------------------------------------------------------------
 * 与云开发版的差别只在实现，接口完全一致：
 *   callFn(action, payload) → HTTP POST /api
 *   watchRoom(roomId, h)    → WebSocket /ws?room=xxx，服务端主动推
 *
 * 身份：首次启动生成一个随机 token 存本地，后续每个请求都带上。
 * 微信云开发有 openid 可用，自建服务端没有，所以自己发一个。
 * 这个 token 只用来区分「谁是谁」，不涉及支付或个人信息。
 */
const CONFIG = require('../config.js');

const TOKEN_KEY = 'poolPlayerToken';

/** 取（或首次生成）玩家身份令牌 */
function getToken() {
  let t = wx.getStorageSync(TOKEN_KEY);
  if (!t) {
    // 32 位十六进制随机串，碰撞概率可忽略
    let s = '';
    for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    t = s;
    wx.setStorageSync(TOKEN_KEY, t);
  }
  return t;
}

function baseUrl() {
  const u = (CONFIG.SERVER_URL || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未配置 SERVER_URL（见 miniprogram/config.js）');
  return u;
}

/** http(s):// → ws(s):// */
function wsUrl(roomId) {
  const u = baseUrl();
  const proto = u.indexOf('https://') === 0 ? 'wss://' : 'ws://';
  const host = u.replace(/^https?:\/\//, '');
  return proto + host + '/ws?room=' + encodeURIComponent(roomId) + '&token=' + getToken();
}

function callFn(action, payload) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = baseUrl() + '/api'; } catch (e) { return reject(e); }

    wx.request({
      url: url,
      method: 'POST',
      header: { 'content-type': 'application/json' },
      data: Object.assign({ action: action, token: getToken() }, payload || {}),
      timeout: 12000,
      success: (res) => {
        const r = res && res.data;
        if (res.statusCode !== 200 || !r) {
          return reject(new Error('服务端返回异常（HTTP ' + res.statusCode + '）'));
        }
        if (r.ok === false) {
          const err = new Error(r.error || '操作失败');
          err.code = r.code;
          return reject(err);
        }
        resolve(r);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';
        // 最常见的两种：地址没填对、真机不允许 http
        if (msg.indexOf('url not in domain list') !== -1) {
          reject(new Error('域名未在小程序后台配置。开发时请在开发者工具里勾选「不校验合法域名」'));
        } else {
          reject(new Error('连不上服务器：' + msg + '（检查 SERVER_URL 与服务是否已启动）'));
        }
      }
    });
  });
}

/**
 * 建立房间长连接。服务端每次房间状态变化就推一条 { type:'room', room }。
 *
 * 断线重连是必需的：切后台、锁屏、地铁进隧道都会断，
 * 而台球是回合制，断了不重连就等于卡死在等对手。
 */
function watchRoom(roomId, handlers) {
  let closed = false;
  let socket = null;
  let retryTimer = null;
  let heartbeat = null;

  function start() {
    if (closed) return;
    let url;
    try { url = wsUrl(roomId); } catch (e) {
      handlers.onError && handlers.onError(e);
      return;
    }

    socket = wx.connectSocket({ url: url, timeout: 10000 });

    socket.onOpen(() => {
      if (closed) return socket.close();
      // 每 25 秒一个心跳：Cloudflare 和多数反代会掐掉空闲连接
      heartbeat = setInterval(() => {
        try { socket.send({ data: '{"type":"ping"}' }); } catch (e) {}
      }, 25000);
    });

    socket.onMessage((res) => {
      if (closed) return;
      let msg;
      try { msg = JSON.parse(res.data); } catch (e) { return; }
      if (msg.type === 'room' && msg.room) {
        handlers.onChange && handlers.onChange(msg.room, 'update');
      }
    });

    socket.onError((err) => {
      if (closed) return;
      handlers.onError && handlers.onError(err);
      scheduleRetry();
    });

    socket.onClose(() => {
      if (closed) return;
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    cleanupSocket();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, CONFIG.WATCH_RETRY_MS);
  }

  function cleanupSocket() {
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (socket) {
      try { socket.close(); } catch (e) {}
      socket = null;
    }
  }

  start();

  return {
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      cleanupSocket();
    }
  };
}

module.exports = { callFn: callFn, watchRoom: watchRoom, getToken: getToken };

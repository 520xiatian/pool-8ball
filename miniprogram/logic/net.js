/**
 * 联机通道分发器
 * ---------------------------------------------------------------
 * 页面只 require 这一个文件，不关心底下是微信云开发还是自建服务器。
 * 两种实现暴露完全相同的接口：
 *
 *   callFn(action, payload) → Promise<result>
 *   watchRoom(roomId, {onChange, onError}) → { close() }
 *
 * 切后端只改 config.js 的 BACKEND，页面代码一行不用动。
 */
const CONFIG = require('../config.js');

function impl() {
  if (CONFIG.BACKEND === 'cloud') return require('./net-cloud.js');
  if (CONFIG.BACKEND === 'ws') return require('./net-ws.js');
  return null;
}

/** 联机是否已配置。给大厅页做入口拦截用 */
function isOnlineReady() {
  if (CONFIG.BACKEND === 'cloud') return !!CONFIG.CLOUD_ENV;
  if (CONFIG.BACKEND === 'ws') return !!(CONFIG.SERVER_URL || '').trim();
  return false;
}

/** 未配置时的具体原因，直接展示给用户 */
function unreadyReason() {
  if (CONFIG.BACKEND === 'none') {
    return '当前是单机模式。想联机请打开 miniprogram/config.js，'
      + '把 BACKEND 改成 cloud（微信云开发）或 ws（自建服务器）。';
  }
  if (CONFIG.BACKEND === 'cloud') return '未填写云开发环境 ID（miniprogram/config.js 的 CLOUD_ENV）';
  if (CONFIG.BACKEND === 'ws') return '未填写服务器地址（miniprogram/config.js 的 SERVER_URL）';
  return '未知的 BACKEND 配置：' + CONFIG.BACKEND;
}

function callFn(action, payload) {
  const m = impl();
  if (!m) return Promise.reject(new Error(unreadyReason()));
  return m.callFn(action, payload);
}

function watchRoom(roomId, handlers) {
  const m = impl();
  if (!m) {
    handlers.onError && handlers.onError(new Error(unreadyReason()));
    return { close() {} };
  }
  return m.watchRoom(roomId, handlers);
}

module.exports = {
  callFn: callFn,
  watchRoom: watchRoom,
  isOnlineReady: isOnlineReady,
  unreadyReason: unreadyReason,
  backend: CONFIG.BACKEND
};

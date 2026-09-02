/**
 * 微信云开发通道
 * ---------------------------------------------------------------
 * callFn  → wx.cloud.callFunction
 * watchRoom → wx.cloud.database().watch()（微信托管的长连接）
 *
 * 这里没有 WebSocket、没有自建服务器。
 */
const CONFIG = require('../config.js');

function callFn(action, payload) {
  return new Promise((resolve, reject) => {
    if (!wx.cloud) return reject(new Error('云开发不可用'));
    wx.cloud.callFunction({
      name: CONFIG.CLOUD_FN,
      data: Object.assign({ action: action }, payload || {}),
      success: (res) => {
        const r = res && res.result;
        if (!r) return reject(new Error('云函数无返回'));
        if (r.ok === false) {
          const err = new Error(r.error || '操作失败');
          err.code = r.code;
          return reject(err);
        }
        resolve(r);
      },
      fail: (err) => {
        // -404011 通常是云函数没上传；单独提示，否则用户会一头雾水
        const msg = (err && err.errMsg) || '';
        if (msg.indexOf('FunctionName parameter') !== -1 || msg.indexOf('-404011') !== -1) {
          reject(new Error('云函数 ' + CONFIG.CLOUD_FN + ' 未部署，请先在开发者工具里右键上传'));
        } else {
          reject(new Error('网络异常：' + msg));
        }
      }
    });
  });
}

/**
 * 监听房间文档变化。
 * @returns {Object} { close() } —— 页面 onUnload 时务必调用
 */
function watchRoom(roomId, handlers) {
  let closed = false;
  let watcher = null;
  let retryTimer = null;

  function start() {
    if (closed) return;
    try {
      watcher = wx.cloud.database().collection(CONFIG.ROOM_COLLECTION)
        .doc(roomId)
        .watch({
          onChange: (snapshot) => {
            if (closed) return;
            const doc = snapshot.docs && snapshot.docs[0];
            if (doc) handlers.onChange && handlers.onChange(doc, snapshot.type);
          },
          onError: (err) => {
            if (closed) return;
            handlers.onError && handlers.onError(err);
            scheduleRetry();
          }
        });
    } catch (e) {
      handlers.onError && handlers.onError(e);
      scheduleRetry();
    }
  }

  function scheduleRetry() {
    if (closed || retryTimer) return;
    try { watcher && watcher.close(); } catch (e) {}
    watcher = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, CONFIG.WATCH_RETRY_MS);
  }

  start();

  return {
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try { watcher && watcher.close(); } catch (e) {}
      watcher = null;
    }
  };
}

module.exports = { callFn: callFn, watchRoom: watchRoom };

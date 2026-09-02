const CONFIG = require('./config.js');

App({
  globalData: {
    onlineReady: false,
    onlineError: ''
  },

  onLaunch() {
    // 只有云开发后端才需要初始化 wx.cloud；ws 后端走普通 request/socket
    if (CONFIG.BACKEND !== 'cloud') {
      this.checkReady();
      return;
    }
    if (!wx.cloud) {
      this.globalData.onlineError = '当前基础库不支持云开发，请升级微信到最新版';
      return;
    }
    if (!CONFIG.CLOUD_ENV) {
      this.globalData.onlineError = '未配置云开发环境 ID（见 miniprogram/config.js）';
      return;
    }
    try {
      wx.cloud.init({ env: CONFIG.CLOUD_ENV, traceUser: true });
      this.globalData.onlineReady = true;
    } catch (e) {
      this.globalData.onlineError = '云开发初始化失败：' + (e && e.message ? e.message : e);
    }
  },

  checkReady() {
    // 延迟 require：net.js 依赖 config，放在这里避免启动期循环引用
    const NET = require('./logic/net.js');
    this.globalData.onlineReady = NET.isOnlineReady();
    if (!this.globalData.onlineReady) {
      this.globalData.onlineError = NET.unreadyReason();
    }
  },

  /** 联机是否可用 */
  canPlayOnline() {
    return this.globalData.onlineReady;
  }
});

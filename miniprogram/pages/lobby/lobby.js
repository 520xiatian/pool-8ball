const app = getApp();
const net = require('../../logic/net.js');

Page({
  data: {
    code: '',
    difficulty: 1,
    cloudError: ''
  },

  onShow() {
    this.setData({ cloudError: app.globalData.onlineError || '' });
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value.toUpperCase().replace(/[^0-9A-Z]/g, '') });
  },

  onDiff(e) {
    this.setData({ difficulty: Number(e.currentTarget.dataset.v) });
  },

  onSolo() {
    wx.navigateTo({ url: '/pages/game/game?mode=solo&difficulty=' + this.data.difficulty });
  },

  /** 联机入口统一先检查后端配置，避免进页面才报错 */
  ensureCloud() {
    if (!app.canPlayOnline()) {
      wx.showModal({
        title: '联机未就绪',
        content: app.globalData.onlineError || net.unreadyReason(),
        showCancel: false
      });
      return false;
    }
    return true;
  },

  async onCreate() {
    if (!this.ensureCloud()) return;
    wx.showLoading({ title: '创建房间…', mask: true });
    try {
      const profile = await this.getProfile();
      const res = await net.callFn('create', { isPublic: false, name: profile.name, avatar: profile.avatar });
      wx.hideLoading();
      this.goRoom(res.room);
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '创建失败', content: e.message, showCancel: false });
    }
  },

  async onQuickMatch() {
    if (!this.ensureCloud()) return;
    wx.showLoading({ title: '匹配中…', mask: true });
    try {
      const profile = await this.getProfile();
      const res = await net.callFn('quickMatch', { name: profile.name, avatar: profile.avatar });
      wx.hideLoading();
      this.goRoom(res.room);
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '匹配失败', content: e.message, showCancel: false });
    }
  },

  async onJoin() {
    if (!this.ensureCloud()) return;
    const code = this.data.code.trim();
    if (code.length !== 6) {
      wx.showToast({ title: '房间号是 6 位', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '加入中…', mask: true });
    try {
      const profile = await this.getProfile();
      const res = await net.callFn('join', { code: code, name: profile.name, avatar: profile.avatar });
      wx.hideLoading();
      this.goRoom(res.room);
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '加入失败', content: e.message, showCancel: false });
    }
  },

  goRoom(room) {
    wx.navigateTo({
      url: '/pages/game/game?mode=online&roomId=' + room._id + '&code=' + room.code
    });
  },

  /**
   * 昵称/头像：不弹授权框。
   * getUserProfile 已被平台收紧，这里用本地缓存的自定义名，
   * 既不打扰用户，也不依赖会变动的接口。
   */
  getProfile() {
    let name = wx.getStorageSync('playerName');
    if (!name) {
      name = '球手' + Math.floor(1000 + Math.random() * 8999);
      wx.setStorageSync('playerName', name);
    }
    return Promise.resolve({ name: name, avatar: '' });
  }
});

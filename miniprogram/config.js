/**
 * 全局配置
 * ---------------------------------------------------------------
 * 只需要改 BACKEND 和它对应的那一段。
 */
module.exports = {
  /**
   * 联机后端：
   *   'none'   仅单机（不联机，不用配任何东西）
   *   'cloud'  微信云开发（无需自备服务器，正式发布推荐）
   *   'ws'     自建 WebSocket 服务：本地 Node 或 Cloudflare Worker
   */
  BACKEND: 'ws',

  // ---- BACKEND = 'cloud' 时用这两项 ----

  /**
   * 云开发环境 ID。
   * 获取方式：微信开发者工具 → 云开发 → 设置 → 环境 ID
   * 形如 pool-8ball-3g1abc2d
   */
  CLOUD_ENV: '',

  // 云函数名（与 cloudfunctions/ 下的目录同名）
  CLOUD_FN: 'poolRoom',

  // 房间集合名（需在云开发控制台创建，权限见 README）
  ROOM_COLLECTION: 'pool_rooms',

  // ---- BACKEND = 'ws' 时用这一项 ----

  /**
   * 服务端地址，不带路径。
   *   Cloudflare：'https://pool-8ball.你的名字.workers.dev'
   *   本地开发：  'http://192.168.1.5:8787'（换成你电脑的局域网 IP）
   *
   * 小程序会自动把它转成 ws:// 或 wss:// 建立长连接。
   * 注意 http:// 只能在开发者工具「不校验合法域名」下用，
   * 真机必须是 https://（详见 README 的域名限制说明）。
   */
  SERVER_URL: 'https://pool-8ball.linyuanyuan365.workers.dev',

  // ---- 通用 ----

  // 每回合限时（秒），需与服务端 room-logic.js 的 TURN_MS 一致
  TURN_SECONDS: 45,

  // 连接断开后的重连间隔（毫秒）
  WATCH_RETRY_MS: 2500
};

# Cloudflare Worker + Durable Objects

**网页和后端一起部署**，自带 HTTPS，免费版够用，一条命令上线。

## 已部署

打开就能玩：https://pool-8ball.linyuanyuan365.workers.dev

- API 端到端测试 35 项、网页真浏览器冒烟 7 项，全部通过
- `../miniprogram/config.js` 也已指向它

更新代码后重新部署：

```powershell
npx wrangler deploy
```

## 部署到你自己的账号

```powershell
cd cloudflare
npm install
npx wrangler login          # 浏览器授权，免费账号即可
npx wrangler deploy
```

输出的地址直接用浏览器打开即可。想同时给小程序用，把地址填进
`miniprogram/config.js`：

```js
BACKEND: 'ws',
SERVER_URL: 'https://pool-8ball.你的名字.workers.dev',
```

部署前想先确认构建没问题（不上传、不需要登录）：

```powershell
npx wrangler deploy --dry-run
```

## 网页与 API 如何共存

`wrangler.toml` 的 `[assets]` 把 `public/` 声明为静态资源目录：

```toml
[assets]
directory = "./public"
```

命中静态文件的请求由 Cloudflare 边缘节点直接返回，**不进 Worker、
不消耗 Worker 请求额度**；匹配不到的（`/api`、`/ws`）才走 Worker 逻辑。

刻意**没有**设 `not_found_handling = "single-page-application"` ——
那会把所有未匹配路径都返回 index.html，连 `/api` 都吃掉，
Worker 永远收不到请求。

浏览器直接访问未知路径时 Worker 会返回一个友好的 HTML 404 页面；
程序式请求（不带 `Accept: text/html`）仍返回 JSON。

## 本地模拟

不消耗额度、不需要登录，跑的是与线上同一套 workerd 运行时：

```powershell
npx wrangler dev --port 8788 --local
```

另开一个终端验证：

```powershell
node ../scripts/test-cloudflare.js   # API 端到端，35 项
node ../scripts/test-web.js          # 网页真浏览器冒烟，7 项
```

也可以指向已部署的地址：

```powershell
$env:CF_BASE = "https://pool-8ball.linyuanyuan365.workers.dev"
node ../scripts/test-cloudflare.js

$env:WEB_BASE = "https://pool-8ball.linyuanyuan365.workers.dev"
node ../scripts/test-web.js
```

> 在中国大陆访问 workers.dev 通常要走代理。两个测试脚本都会自动检测
> `HTTPS_PROXY` 并以 `NODE_USE_ENV_PROXY=1` 重启自己（Node 内置的 fetch
> 默认**不读**代理环境变量），`test-web.js` 还会把代理传给浏览器进程。
> 打线上时超时也会自动放宽。

## 域名限制（网页 vs 小程序）

**网页版没有任何限制** —— 部署完把链接发给谁都能打开玩。

唯一的体验问题：`*.workers.dev` 在中国大陆长期受 DNS 干扰，
国内用户可能连不上。解决办法是在 Cloudflare 绑自己的域名
（控制台 → Workers & Pages → 你的 Worker → Settings → Domains & Routes）。

**微信小程序另有两道门槛**：

- 真机要求 request/socket 的域名在小程序后台配置为合法域名，
  而这要求域名有 **ICP 备案** —— `workers.dev` 和未备案的自有域名都过不了
- 开发者工具勾「不校验合法域名」可以绕过，但只对模拟器和真机调试有效

所以：想让朋友玩，直接给网页链接最省事；一定要走小程序的话，
要么绑备案域名，要么改用微信云开发（`BACKEND: 'cloud'`）。

## 架构

```
请求进来
  ├── 命中 public/ 里的静态文件 → 边缘节点直接返回（不进 Worker）
  └── 未命中 → Worker (src/index.js)
        ├── POST /api  ──┬── create/join/quickMatch → Lobby DO（全局单例）
        │                └── get/shoot/timeout/leave/rematch → Room DO
        ├── GET  /ws   ──── 升级 WebSocket，交给 Room DO 持有
        ├── GET  /health
        └── 其他 → 友好 404（HTML 或 JSON，看 Accept 头）
```

### 为什么用 Durable Objects 而不是 Worker + KV

**一个房间 = 一个 DO 实例，同一实例的请求由平台串行执行。**
"读房间 → 算规则 → 写回"这段不可能被另一个请求插进来，
回合制对局的竞态问题从根上消失，不需要自己在 KV 上手搓 CAS。

测试里有一项专门验证这点：同时发 5 个相同 `shotIndex` 的出杆请求，
只有 1 个成功。

### Lobby DO 会成为瓶颈吗

不会。只有建房、加入、快速匹配走 Lobby —— 它维护「6 位房号 → DO ID」
的索引，因为 DO 的 ID 是随机的 64 位十六进制串，没有索引就没法按房号找房，
而 Cloudflare 上没有可跨 DO 查询的数据库。

**出杆完全不经过 Lobby**，而出杆才是高频操作。对局压力全部落在各自的 Room DO 上。

### WebSocket Hibernation

用 `state.acceptWebSocket()` 而非 `ws.accept()`。连接空闲时实例可以休眠，
不计 duration 费用。玩家思考 30 秒的时间里 DO 完全不产生计算开销。

唤醒后仍能收到消息，靠 `serializeAttachment({uid})` 把身份挂在连接上。

## 免费额度

截至 2026 年 8 月（[官方定价页](https://developers.cloudflare.com/durable-objects/platform/pricing/)）：

- Durable Objects 在 Workers Free 可用，但**只能用 SQLite 存储后端**
  （KV 后端需付费计划）—— `wrangler.toml` 里的 `new_sqlite_classes` 正是这么配的
- 每天 10 万次请求、13,000 GB-s 计算时长，UTC 00:00 重置
- 超出后该类型操作直接报错，不会自动扣费

台球一局几十次请求，这个额度够几百人同时玩。

额度和价格会变，以官方页面为准。

## 文件

| 文件 | 职责 |
|---|---|
| `wrangler.toml` | 静态资源目录、DO 绑定、SQLite migration |
| `public/index.html` | 网页版页面结构 |
| `public/css/style.css` | 样式（含手机横屏适配） |
| `public/js/module-shim.js` | CommonJS 垫片，让浏览器能跑小程序的模块 |
| `public/js/net.js` | fetch + WebSocket 通道 |
| `public/js/app.js` | 游戏主控（渲染循环、交互、联机流程） |
| `public/logic/` | **自动生成**，浏览器版包装，别手改 |
| `src/index.js` | 路由与参数校验 |
| `src/room.js` | Room DO：房间状态 + WebSocket 广播 |
| `src/lobby.js` | Lobby DO：房号索引 + 快速匹配队列 |
| `src/logic/` | **自动生成**，来自 `miniprogram/logic/`，别手改 |

改完 `miniprogram/logic/` 记得跑 `node ../scripts/sync-logic.js` 再 deploy ——
它会同时更新 `src/logic/`（服务端）和 `public/logic/`（浏览器版）。

## 查线上日志

```powershell
npx wrangler tail
```

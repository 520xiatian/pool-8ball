# 本地联机服务器

零依赖的开发用服务器。`node server/index.js` 直接跑，不需要 npm install。

## 用途

给微信开发者工具和局域网内的真机调试提供联机后端。
**不是生产服务器** —— 没有账号体系、没有 TLS、没有速率限制、
房间存在内存里进程重启就清空。

## 启动

```powershell
node server/index.js

# 换端口
$env:PORT = 9000; node server/index.js
```

启动后会列出本机所有可用地址，挑一个填进 `miniprogram/config.js`：

```js
BACKEND: 'ws',
SERVER_URL: 'http://192.168.1.7:8787',
```

开发者工具需勾选**详情 → 本地设置 → 不校验合法域名**。
模拟器用 `127.0.0.1`，真机调试用局域网 IP（手机要和电脑在同一 WiFi）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api` | 所有操作，body 里带 `action` 和 `token` |
| GET | `/ws?room=&token=` | WebSocket，房间一变就推 `publicView` |
| GET | `/health` | 探活，顺便列出本机可用地址 |

`action` 支持：`create` `join` `quickMatch` `get` `shoot` `timeout` `leave` `rematch`
—— 与微信云函数、Cloudflare Worker 完全一致。

## 身份

小程序首次启动生成一个 32 位十六进制随机串存在本地
（`net-ws.js` 的 `getToken`），后续每个请求都带上。
服务端存 `sha256(token + salt)` 的短哈希，不存原文。

云开发有 openid 可用，自建服务端没有，所以自己发一个。
这个 token 只用来区分"谁是谁"，不涉及支付或个人信息。

## 文件

| 文件 | 职责 |
|---|---|
| `index.js` | HTTP + WebSocket 服务，路由与启动 |
| `handler.js` | 请求处理，与传输层解耦所以能直接单测 |
| `store.js` | 内存房间存储 + 订阅推送 + 过期清理 |
| `ws.js` | 手写的极简 WebSocket（握手、文本帧、ping/pong） |
| `logic/` | **自动生成**，来自 `miniprogram/logic/`，别手改 |

## 换成持久化存储

把 `store.js` 换成 SQLite / Redis 实现即可，需要的接口只有：

```
create(doc) → doc（分配 _id）
getById(id) → doc | null
findByCode(code, notBefore) → doc | null
findWaitingPublic(createdAfter, limit) → doc[]
update(id, patch, guard) → boolean   // guard 是点号路径的乐观锁条件
remove(id) → boolean
subscribe(id, fn) → unsubscribe
sweep(ttlMs) → number
```

`handler.js` 和 `room-logic.js` 都不用动。

## 为什么不用 ws 这个 npm 包

为了让 `node server/index.js` 开箱即跑。`ws.js` 只实现了本项目需要的部分：
握手、文本帧收发、ping/pong、关闭。不做分片和压缩扩展 ——
房间推送的 JSON 只有一两 KB，小程序端也不发分片帧。

真要上生产量级，把 `ws.js` 换成 `ws` 包很容易，`index.js` 里只有
`server.on('upgrade')` 那一段需要改。

## 测试

```powershell
node scripts/test-server.js
```

19 项：10 项 Handler 层单测 + 9 项真 HTTP/WebSocket 端到端，
包括「A 出杆 → B 收到推送」这条主链路。

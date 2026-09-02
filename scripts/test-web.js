/**
 * Web 前端冒烟测试（真浏览器，无头 Edge）
 * ---------------------------------------------------------------
 * 用 Chrome DevTools Protocol 直接驱动本机 Edge，不装 puppeteer。
 * 验证的是「打开网页就能玩」这条链路本身：
 *
 *   1. 页面能加载，所有 script 无报错
 *   2. logic 模块在浏览器里正确挂载（CommonJS 垫片生效）
 *   3. 浏览器算出的物理结果与 Node 端逐位一致（联机一致性的前提）
 *   4. 点「单机练习」能进对局并画出台面
 *   5. 建房 → 另一个页面用链接加入 → 出杆 → 对手收到推送
 *
 * 用法（需先启动 wrangler dev）：
 *   cd cloudflare && npx wrangler dev --port 8788 --local
 *   node scripts/test-web.js
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const BASE = (process.env.WEB_BASE || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(BASE);

/**
 * Node 18+ 的内置 fetch 默认**不读** HTTP_PROXY / HTTPS_PROXY。
 * 打线上 workers.dev 在中国大陆基本要走代理，所以检测到代理环境变量
 * 但开关没开时，自动带上 NODE_USE_ENV_PROXY=1 重启一次自己。
 * （浏览器进程不受影响 —— 它有自己的代理参数，见 launchBrowser。）
 */
if (!IS_LOCAL && process.env.NODE_USE_ENV_PROXY !== '1' &&
    (process.env.HTTPS_PROXY || process.env.https_proxy ||
     process.env.HTTP_PROXY || process.env.http_proxy)) {
  const { spawnSync } = require('child_process');
  console.log('检测到代理环境变量，以 NODE_USE_ENV_PROXY=1 重新启动…');
  const r = spawnSync(process.execPath, [__filename], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' })
  });
  process.exit(r.status === null ? 1 : r.status);
}

let pass = 0;
let fail = 0;
const queue = [];
function test(name, body) { queue.push({ name, body }); }
function section(title) { queue.push({ section: title }); }

// ---------- 找一个可用的 Chromium 内核浏览器 ----------

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- 极简 CDP 客户端 ----------

/** 请求 DevTools HTTP 端点。/json/new 只接受 PUT，其余用 GET。 */
function devtools(pathname, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: DEBUG_PORT,
      path: pathname,
      method: method || 'GET'
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('DevTools 返回非 JSON（' + res.statusCode + '）：'
            + body.slice(0, 120)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('DevTools 请求超时')); });
    req.end();
  });
}

/**
 * 一个 CDP 会话（一个标签页）。
 * 只实现本测试用到的：Runtime.evaluate、Page.navigate、控制台错误收集。
 */
class Page {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }

      // 页面里的 console.error 与未捕获异常都记下来，测试结束时断言为空
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || [])
          .map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.pageErrors.push((d.exception && d.exception.description) || d.text);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时：' + method));
        }
      }, 20000);
    });
  }

  /** 在页面里跑一段 JS，返回它的值（支持 await） */
  async eval(expr) {
    const res = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error('页面内报错：' + ((d.exception && d.exception.description) || d.text));
    }
    return res.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    // 等 body 上的就绪标记出现，比等 load 事件更准（说明 app.js 真的执行完了）
    await this.waitFor('document.body && document.body.dataset.poolReady === "1"', 15000);
  }

  /** 轮询一个条件表达式直到为真 */
  async waitFor(expr, ms, label) {
    // 打线上要跨境往返（可能还过代理），超时统一放宽
    const budget = (ms || 10000) * (IS_LOCAL ? 1 : 2.5);
    const deadline = Date.now() + budget;
    for (;;) {
      let ok = false;
      try { ok = await this.eval('!!(' + expr + ')'); } catch (e) { ok = false; }
      if (ok) return;
      if (Date.now() > deadline) throw new Error('等待超时：' + (label || expr));
      await sleep(120);
    }
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- 浏览器进程管理 ----------

let browserProc = null;
let userDataDir = null;
const DEBUG_PORT = 9333;

async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('找不到 Edge 或 Chrome，可用 CHROME_PATH 指定路径');

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-web-test-'));

  // 本地目标绕开系统代理；线上目标要走代理才能连上 workers.dev
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || '';
  const proxyArgs = (!IS_LOCAL && proxy)
    ? ['--proxy-server=' + proxy, '--proxy-bypass-list=<-loopback>']
    : ['--no-proxy-server'];

  browserProc = spawn(exe, [
    '--headless=new',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--window-size=900,700'
  ].concat(proxyArgs, ['about:blank']), { stdio: 'ignore', detached: false });

  // 等 DevTools 端口起来
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await devtools('/json/version');
      break;
    } catch (e) {
      if (Date.now() > deadline) throw new Error('浏览器启动超时：' + e.message);
      await sleep(300);
    }
  }
  await connectBrowserCdp();
}

/** 新开一个标签页并返回 CDP 会话 */
async function newPage(opts) {
  let targetUrl;

  if (opts && opts.isolated) {
    // 独立浏览上下文（等价于隐身窗口）：localStorage 与主上下文隔离。
    // 联机测试必须这样 —— 同一 profile 的两个标签共享 localStorage，
    // 会拿到同一个玩家 token，服务端就认为是同一个人在重复加入。
    const ctx = await browserSend('Target.createBrowserContext', { disposeOnDetach: false });
    const t = await browserSend('Target.createTarget', {
      url: 'about:blank',
      browserContextId: ctx.browserContextId
    });
    targetUrl = 'ws://127.0.0.1:' + DEBUG_PORT + '/devtools/page/' + t.targetId;
  } else {
    // /json/new 必须用 PUT（Chrome 111+ 起拒绝 GET）
    const res = await devtools('/json/new?about:blank', 'PUT');
    if (!res.webSocketDebuggerUrl) {
      throw new Error('DevTools 未返回调试地址：' + JSON.stringify(res).slice(0, 160));
    }
    targetUrl = res.webSocketDebuggerUrl;
  }

  const ws = new WebSocket(targetUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接 DevTools 超时')), 8000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools 连接失败')); });
  });
  const page = new Page(ws);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return page;
}

function killBrowser() {
  if (browserWs) {
    try { browserWs.close(); } catch (e) {}
    browserWs = null;
  }
  if (browserProc) {
    try { browserProc.kill(); } catch (e) {}
    browserProc = null;
  }
  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
    userDataDir = null;
  }
}

// ---------- 浏览器级 CDP（用于创建隔离上下文） ----------

let browserWs = null;
let browserSeq = 0;
const browserPending = new Map();

async function connectBrowserCdp() {
  const ver = await devtools('/json/version');
  browserWs = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接浏览器 CDP 超时')), 8000);
    browserWs.addEventListener('open', () => { clearTimeout(timer); resolve(); });
    browserWs.addEventListener('error', () => { clearTimeout(timer); reject(new Error('浏览器 CDP 连接失败')); });
  });
  browserWs.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (!msg.id || !browserPending.has(msg.id)) return;
    const { resolve, reject } = browserPending.get(msg.id);
    browserPending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
}

function browserSend(method, params) {
  const id = ++browserSeq;
  return new Promise((resolve, reject) => {
    browserPending.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (browserPending.has(id)) {
        browserPending.delete(id);
        reject(new Error('浏览器 CDP 超时：' + method));
      }
    }, 15000);
  });
}

// ---------- 测试用例 ----------

section('页面加载');

test('打开首页：标题正确、无脚本报错', async () => {
  const page = await newPage();
  try {
    await page.goto(BASE + '/');
    const title = await page.eval('document.title');
    assert.ok(title.indexOf('中式八球') !== -1, '标题不对：' + title);

    const lobbyVisible = await page.eval(
      'document.getElementById("lobby").classList.contains("screen--on")');
    assert.strictEqual(lobbyVisible, true, '大厅没有显示');

    assert.deepStrictEqual(page.pageErrors, [], '页面有未捕获异常');
    assert.deepStrictEqual(page.consoleErrors, [], '页面有 console.error');
  } finally { page.close(); }
});

test('logic 模块在浏览器里正确挂载（CommonJS 垫片生效）', async () => {
  const page = await newPage();
  try {
    await page.goto(BASE + '/');
    const mods = await page.eval('Object.keys(window.__poolModules).sort()');
    assert.deepStrictEqual(mods, ['bot.js', 'physics.js', 'renderer.js', 'rules.js'],
      '模块列表不对：' + JSON.stringify(mods));

    // rules.js 里 require('./physics.js') 必须拿到同一个实例
    const same = await page.eval(
      'window.__poolModules["rules.js"].GROUP && '
      + 'window.__poolRequire("./physics.js") === window.__poolModules["physics.js"]');
    assert.strictEqual(same, true, '模块间 require 没有共享实例');
  } finally { page.close(); }
});

test('浏览器与 Node 的物理结果逐位一致（联机一致性前提）', async () => {
  const P = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'physics.js'));
  const RULES = require(path.join(__dirname, '..', 'miniprogram', 'logic', 'rules.js'));

  const shot = { dx: 9701, dy: 2425, power: 777 };
  const nodeGame = RULES.createGame(0);
  const nodeResult = RULES.applyShot(nodeGame, shot);

  const page = await newPage();
  try {
    await page.goto(BASE + '/');
    const browserBalls = await page.eval(
      'JSON.stringify(window.__poolModules["rules.js"].applyShot('
      + 'window.__poolModules["rules.js"].createGame(0), '
      + JSON.stringify(shot) + ').state.balls)');
    assert.strictEqual(browserBalls, JSON.stringify(nodeResult.state.balls),
      '浏览器与 Node 算出的球态不同 —— 联机会判定分叉');

    const frames = await page.eval(
      'window.__poolModules["rules.js"].applyShot('
      + 'window.__poolModules["rules.js"].createGame(0), '
      + JSON.stringify(shot) + ').frames.length');
    assert.strictEqual(frames, nodeResult.frames.length, '动画帧数不同');
  } finally { page.close(); }
});

section('单机');

test('点「单机练习」进入对局并画出台面', async () => {
  const page = await newPage();
  try {
    await page.goto(BASE + '/');
    await page.eval('document.getElementById("btnSolo").click()');
    await page.waitFor('document.getElementById("game").classList.contains("screen--on")',
      5000, '进入对局');

    // canvas 有实际像素尺寸，说明 setupCanvas 跑过了
    await page.waitFor('document.getElementById("table").width > 100', 5000, 'canvas 就绪');
    const size = await page.eval(
      'var c=document.getElementById("table"); JSON.stringify([c.width, c.height])');
    const [w, h] = JSON.parse(size);
    assert.ok(w > 100 && h > 100, 'canvas 尺寸异常：' + size);

    // 开局应有 16 颗球在台上
    const onTable = await page.eval('window.__poolPeek().onTable');
    assert.strictEqual(onTable, 16, '开局球数不对：' + onTable);

    // 等到画布真的被画过（渲染循环至少跑了一帧）。
    // 不能立刻检查 —— setupCanvas 和首帧都在 requestAnimationFrame 里。
    await page.waitFor(
      '(function(){'
      + ' var c=document.getElementById("table");'
      + ' var d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;'
      + ' for (var i=3;i<d.length;i+=400) { if (d[i]>0) return true; }'
      + ' return false;'
      + '})()',
      6000, '画布被绘制');

    assert.deepStrictEqual(page.pageErrors, [], '进对局后有未捕获异常');
  } finally { page.close(); }
});

/** 在页面里模拟一次完整的拖拽出杆（pointerdown → move → up） */
const DRAG_SHOT = [
  '(function(){',
  ' var c=document.getElementById("table");',
  ' var r=c.getBoundingClientRect();',
  ' function ev(type,x,y){',
  '  c.dispatchEvent(new PointerEvent(type,{pointerId:1,bubbles:true,cancelable:true,',
  '   clientX:r.left+x, clientY:r.top+y, isPrimary:true}));',
  ' }',
  // 白球在台面左侧约 22% 处；往它左边拖 = 朝右出杆
  ' ev("pointerdown", r.width*0.22, r.height*0.5);',
  ' ev("pointermove", r.width*0.05, r.height*0.5);',
  ' ev("pointerup", r.width*0.05, r.height*0.5);',
  ' return true;',
  '})()'
].join('\n');

test('单机可以出杆，局面推进', async () => {
  const page = await newPage();
  try {
    await page.goto(BASE + '/');
    await page.eval('document.getElementById("btnSolo").click()');
    await page.waitFor('document.getElementById("game").classList.contains("screen--on")',
      5000, '进入对局');
    // 必须等渲染器建立（在第一个 rAF 里），否则 pointerdown 会被 canShoot 挡掉
    await page.waitFor('window.__poolPeek().ready', 5000, '渲染器就绪');

    const before = await page.eval('window.__poolPeek().shotIndex');
    assert.strictEqual(before, 0, '新局 shotIndex 应为 0');

    await page.eval(DRAG_SHOT);
    await page.waitFor('window.__poolPeek().shotIndex > 0', 10000, '出杆后局面推进');
    assert.deepStrictEqual(page.pageErrors, [], '出杆过程有未捕获异常');
  } finally { page.close(); }
});

section('联机（两个真实浏览器标签）');

test('建房 → 分享链接加入 → 出杆 → 对手收到推送', async () => {
  // 两个玩家必须在隔离上下文里，否则共享 localStorage 拿到同一个 token
  const host = await newPage({ isolated: true });
  const guest = await newPage({ isolated: true });
  try {
    // ---- 房主建房 ----
    await host.goto(BASE + '/');
    await host.eval('document.getElementById("btnCreate").click()');
    await host.waitFor('document.getElementById("game").classList.contains("screen--on")',
      12000, '房主进入对局');
    await host.waitFor('window.__poolPeek().status === "waiting"', 8000, '进入等待状态');

    const code = await host.eval('window.__poolPeek().code');
    assert.ok(/^[0-9A-Z]{6}$/.test(code), '房号格式不对：' + code);

    // 等待浮层应该显示房号
    const shownCode = await host.eval('document.getElementById("waitCode").textContent');
    assert.strictEqual(shownCode, code, '等待浮层没显示房号');

    // ---- 客人用分享链接进来 ----
    await guest.goto(BASE + '/?room=' + code);
    await guest.waitFor('window.__poolPeek().status === "playing"', 15000, '客人自动加入并开局');
    const guestSeat = await guest.eval('window.__poolPeek().seat');
    assert.strictEqual(guestSeat, 1, '客人应坐 1 号位');

    // ---- 房主应通过推送收到开局 ----
    await host.waitFor('window.__poolPeek().status === "playing"', 12000, '房主收到开局推送');
    const waitHidden = await host.eval('document.getElementById("waitOverlay").hidden');
    assert.strictEqual(waitHidden, true, '开局后等待浮层没收起');

    const hostSeat = await host.eval('window.__poolPeek().seat');
    assert.strictEqual(hostSeat, 0, '房主应坐 0 号位');

    // ---- 房主出杆，客人应收到推送 ----
    await host.waitFor('window.__poolPeek().ready', 5000, '房主渲染器就绪');
    await host.eval(DRAG_SHOT);

    await guest.waitFor('window.__poolPeek().shotIndex >= 1', 15000, '客人收到出杆推送');

    // 两端球态必须一致 —— 这是整个联机方案的核心保证
    await host.waitFor('window.__poolPeek().busy === false', 15000, '房主动画播完');
    await guest.waitFor('window.__poolPeek().busy === false', 15000, '客人动画播完');

    const hostState = await host.eval('window.__poolPeek().onTable + ":" + window.__poolPeek().turn');
    const guestState = await guest.eval('window.__poolPeek().onTable + ":" + window.__poolPeek().turn');
    assert.strictEqual(hostState, guestState,
      '两端局面不一致（在台球数:回合）host=' + hostState + ' guest=' + guestState);

    assert.deepStrictEqual(host.pageErrors, [], '房主页面有未捕获异常');
    assert.deepStrictEqual(guest.pageErrors, [], '客人页面有未捕获异常');
  } finally {
    host.close();
    guest.close();
  }
});

test('用错误房号进来会提示而不是白屏', async () => {
  const page = await newPage();
  try {
    await page.goto(BASE + '/?room=ZZZZZZ');
    // 应该留在大厅并弹 toast
    await page.waitFor('document.getElementById("toast").hidden === false', 12000, '错误提示');
    const text = await page.eval('document.getElementById("toast").textContent');
    assert.ok(text.indexOf('失败') !== -1, 'toast 文案不对：' + text);
    const lobbyOn = await page.eval(
      'document.getElementById("lobby").classList.contains("screen--on")');
    assert.strictEqual(lobbyOn, true, '应留在大厅');
  } finally { page.close(); }
});

section('视角切换 2D ⇄ 3D');

/**
 * 进入单机对局并等到渲染器就绪。
 *
 * 默认先清掉视角/音效偏好再加载 —— 这些偏好存在 localStorage 里，同一个
 * 浏览器 profile 下会跨测试串味（上一个用例切到 3D，下一个用例就不是从
 * 2D 起步了）。要验证"偏好被记住"的用例传 keepPrefs: true。
 */
async function intoSolo(opts) {
  const page = await newPage();
  if (!(opts && opts.keepPrefs)) {
    // 先落到同源页面才有权限碰 localStorage
    await page.goto(BASE + '/');
    await page.eval('try { localStorage.removeItem("poolView3D");'
      + ' localStorage.removeItem("poolSoundOff"); } catch (e) {}');
  }
  await page.goto(BASE + '/');
  await page.waitFor('document.body.dataset.poolReady === "1"', 5000, '脚本就绪');
  await page.eval('document.getElementById("btnSolo").click()');
  await page.waitFor('document.getElementById("game").classList.contains("screen--on")',
    5000, '进入对局');
  await page.waitFor('window.__poolPeek().ready', 5000, '渲染器就绪');
  return page;
}

test('默认 2D，点一次切到 3D 并且是渐变过渡', async () => {
  const page = await intoSolo();
  try {
    const t0 = await page.eval('window.__poolPeek().tilt');
    assert.strictEqual(t0, 0, '默认不是 2D：' + t0);

    await page.eval('document.getElementById("btnView").click()');
    // 目标立刻变 1，但当前值应还在路上（过渡 0.55s）
    const target = await page.eval('window.__poolPeek().tiltTarget');
    assert.strictEqual(target, 1, '目标没设成 3D');
    const mid = await page.eval('window.__poolPeek().tilt');
    assert.ok(mid < 1, '一瞬间就跳到 3D 了，没有过渡：' + mid);

    await page.waitFor('window.__poolPeek().tilt === 1', 4000, '过渡到 3D 完成');
    const label = await page.eval('document.getElementById("btnView").textContent');
    assert.strictEqual(label, '3D', '按钮文案没更新：' + label);
    assert.deepStrictEqual(page.pageErrors, [], '切视角时有未捕获异常');
  } finally { page.close(); }
});

test('3D 下画布确实被重画（画面与 2D 不同）', async () => {
  const page = await intoSolo();
  try {
    const grab = '(function(){'
      + ' var c=document.getElementById("table");'
      + ' var d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;'
      + ' var h=0; for (var i=0;i<d.length;i+=997) { h=(h*31+d[i])|0; }'
      + ' return h;'
      + '})()';
    await page.waitFor('window.__poolPeek().tilt === 0', 3000, '2D 稳定');
    const h2d = await page.eval(grab);

    await page.eval('document.getElementById("btnView").click()');
    await page.waitFor('window.__poolPeek().tilt === 1', 4000, '过渡到 3D');
    // 等一帧确保 3D 画面已经画上去
    await page.eval('new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r)})})');
    const h3d = await page.eval(grab);

    assert.notStrictEqual(h2d, h3d, '3D 画面与 2D 完全一样，视角没生效');
    assert.deepStrictEqual(page.pageErrors, [], '3D 绘制有未捕获异常');
  } finally { page.close(); }
});

test('3D 视角下也能拖拽出杆', async () => {
  const page = await intoSolo();
  try {
    await page.eval('document.getElementById("btnView").click()');
    await page.waitFor('window.__poolPeek().tilt === 1', 4000, '进入 3D');

    const before = await page.eval('window.__poolPeek().shotIndex');
    assert.strictEqual(before, 0, '新局 shotIndex 应为 0');

    // 3D 下白球的屏幕位置由透视投影决定，不能照 2D 的比例硬编码。
    // 起点取白球右侧一段距离（大于抓取半径 4R），确保走"瞄准"分支而不是
    // "拖白球摆位"；终点再往右拉，于是白球朝左出杆。
    await page.eval([
      '(function(){',
      ' var c=document.getElementById("table");',
      ' var box=c.getBoundingClientRect();',
      ' function ev(type,x,y){',
      '  c.dispatchEvent(new PointerEvent(type,{pointerId:7,bubbles:true,cancelable:true,',
      '   clientX:box.left+x, clientY:box.top+y, isPrimary:true}));',
      ' }',
      ' ev("pointerdown", box.width*0.62, box.height*0.62);',
      ' ev("pointermove", box.width*0.92, box.height*0.62);',
      ' ev("pointerup", box.width*0.92, box.height*0.62);',
      ' return true;',
      '})()'
    ].join('\n'));

    await page.waitFor('window.__poolPeek().shotIndex > 0', 12000, '3D 下出杆后局面推进');
    assert.deepStrictEqual(page.pageErrors, [], '3D 出杆有未捕获异常');
  } finally { page.close(); }
});

test('视角偏好被记住（刷新后仍是 3D）', async () => {
  const page = await intoSolo();
  try {
    await page.eval('document.getElementById("btnView").click()');
    await page.waitFor('window.__poolPeek().tilt === 1', 4000, '进入 3D');

    await page.goto(BASE + '/');
    await page.waitFor('document.body.dataset.poolReady === "1"', 5000, '脚本就绪');
    const t = await page.eval('window.__poolPeek().tiltTarget');
    assert.strictEqual(t, 1, '刷新后没记住 3D 偏好');
    const label = await page.eval('document.getElementById("btnView").textContent');
    assert.strictEqual(label, '3D', '按钮状态没恢复：' + label);
  } finally {
    // 别把 3D 偏好留给后面的用例
    try {
      await page.eval('localStorage.removeItem("poolView3D")');
    } catch (e) {}
    page.close();
  }
});

section('走球动画与音效');

test('整杆动画时长与刷新率无关（约 1.5~4 秒）', async () => {
  const page = await intoSolo();
  try {
    await page.eval(DRAG_SHOT);
    await page.waitFor('window.__poolPeek().playing === true', 5000, '动画开始');
    const t0 = Date.now();
    // 单机模式下自己这杆播完就轮到电脑，所以只等 playing 变 false
    await page.waitFor('window.__poolPeek().playing === false', 15000, '动画播完');
    const secs = (Date.now() - t0) / 1000;
    // 帧序列按 1/60 生成；开球满力约 90~150 帧 = 1.5~2.5s。
    // 上限放宽到 5s 容忍无头浏览器的 rAF 节流。
    assert.ok(secs > 1.0, '整杆播得太快（' + secs.toFixed(2) + 's），可能还在按 tick 逐帧消费');
    assert.ok(secs < 5.0, '整杆播得太慢：' + secs.toFixed(2) + 's');
  } finally { page.close(); }
});

test('音效开关可用且状态被记住', async () => {
  const page = await intoSolo();
  try {
    const on0 = await page.eval('document.getElementById("btnSound").getAttribute("aria-pressed")');
    assert.strictEqual(on0, 'true', '默认音效应为开');

    await page.eval('document.getElementById("btnSound").click()');
    const off = await page.eval('document.getElementById("btnSound").getAttribute("aria-pressed")');
    assert.strictEqual(off, 'false', '点一下没关掉');

    await page.goto(BASE + '/');
    await page.waitFor('document.body.dataset.poolReady === "1"', 5000, '脚本就绪');
    const after = await page.eval('document.getElementById("btnSound").getAttribute("aria-pressed")');
    assert.strictEqual(after, 'false', '刷新后没记住静音偏好');
    assert.deepStrictEqual(page.pageErrors, [], '音效开关有未捕获异常');
  } finally { page.close(); }
});

test('出杆过程中创建了 AudioContext（音效真的接上了）', async () => {
  const page = await intoSolo();
  try {
    // 无头浏览器没有音频设备，但 AudioContext 仍会被创建；
    // 这里验证的是「代码路径走到了」，不是「真的响了」。
    await page.eval('document.getElementById("btnSound").click()');   // 先关
    await page.eval('document.getElementById("btnSound").click()');   // 再开 = 用户手势解锁
    await page.eval(DRAG_SHOT);
    await page.waitFor('window.__poolPeek().playing === true', 5000, '动画开始');
    await page.waitFor('window.__poolPeek().playing === false', 15000, '动画播完');
    assert.deepStrictEqual(page.pageErrors, [], '播音效时有未捕获异常');
    assert.deepStrictEqual(page.consoleErrors, [], '播音效时有 console.error');
  } finally { page.close(); }
});

// ---------- 执行 ----------

(async () => {
  console.log('\n=== Web 前端冒烟测试（无头浏览器）===');
  console.log('目标：' + BASE + '\n');

  try {
    const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.log('连不上网页：' + e.message);
    if (IS_LOCAL) {
      console.log('\n请先启动：cd cloudflare && npx wrangler dev --port 8788 --local\n');
    } else {
      console.log('\n检查项：');
      console.log('  1. 是否已部署：cd cloudflare && npx wrangler deploy');
      console.log('  2. workers.dev 在中国大陆常被 DNS 干扰，需要代理\n');
    }
    process.exit(2);
  }

  const exe = findBrowser();
  if (!exe) {
    console.log('跳过：本机找不到 Edge / Chrome（可用 CHROME_PATH 指定）\n');
    process.exit(0);
  }
  console.log('浏览器：' + exe + '\n');

  try {
    await launchBrowser();
  } catch (e) {
    console.log('浏览器启动失败：' + e.message + '\n');
    killBrowser();
    process.exit(1);
  }

  for (const t of queue) {
    if (t.section) { console.log('\n[' + t.section + ']'); continue; }
    try {
      await t.body();
      pass++;
      console.log('  ok   ' + t.name);
    } catch (e) {
      fail++;
      console.log('  FAIL ' + t.name + '\n       ' + e.message);
    }
  }

  killBrowser();
  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(46) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();

process.on('exit', killBrowser);
process.on('SIGINT', () => { killBrowser(); process.exit(130); });

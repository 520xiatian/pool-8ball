/**
 * 截图：2D / 过渡中 / 3D 三张，肉眼验证透视是否正确。
 * 用法（需先启动 wrangler dev）：node scripts/shot.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BASE = process.env.WEB_BASE || 'http://127.0.0.1:8788';
const PORT = 9333;
const OUT = path.join(__dirname, '..', '.shots');

function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  return cands.find(p => fs.existsSync(p));
}

function devtools(p, method) {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || 'GET' },
      r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    req.on('error', rej);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

let proc = null;
let userDir = null;

async function main() {
  const exe = findBrowser();
  if (!exe) { console.log('找不到浏览器'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poolshot-'));

  proc = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + userDir, '--no-first-run', '--no-default-browser-check',
    '--window-size=1000,700', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--no-proxy-server', '--disable-gpu'
  ], { stdio: 'ignore' });

  // 等 DevTools 起来
  for (let i = 0; i < 60; i++) {
    try { await devtools('/json/version'); break; } catch (e) { await new Promise(r => setTimeout(r, 250)); }
  }

  const tab = await devtools('/json/new?' + encodeURIComponent(BASE + '/'), 'PUT');
  const WS = tab.webSocketDebuggerUrl;
  const ws = new WebSocket(WS);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message)); else res(m.result);
    }
  });
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Runtime.enable');
  await send('Page.enable');

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
    return r.result.value;
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) {
      if (await evalJs(expr)) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('等待超时: ' + expr);
  };

  const shoot = async (name) => {
    // 等两帧确保画完
    await evalJs('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  ' + f);
    return f;
  };

  await send('Page.navigate', { url: BASE + '/' });
  await waitFor('document.body.dataset.poolReady === "1"');
  await evalJs('try{localStorage.removeItem("poolView3D");localStorage.removeItem("poolSoundOff")}catch(e){}');
  await send('Page.navigate', { url: BASE + '/' });
  await waitFor('document.body.dataset.poolReady === "1"');
  await evalJs('document.getElementById("btnSolo").click()');
  await waitFor('window.__poolPeek().ready');
  await new Promise(r => setTimeout(r, 400));

  console.log('截图输出：');
  await shoot('1-top-2d');

  // 停在中途，看过渡画面
  await evalJs('document.getElementById("btnView").click()');
  await new Promise(r => setTimeout(r, 260));
  await shoot('2-mid-transition');

  await waitFor('window.__poolPeek().tilt === 1');
  await new Promise(r => setTimeout(r, 200));
  await shoot('3-perspective-3d');

  // 瞄准态：必须在出杆之前抓，出杆后就轮到电脑了
  await evalJs([
    '(function(){var c=document.getElementById("table");var b=c.getBoundingClientRect();',
    'function e(t,x,y){c.dispatchEvent(new PointerEvent(t,{pointerId:11,bubbles:true,cancelable:true,clientX:b.left+x,clientY:b.top+y,isPrimary:true}))}',
    'e("pointerdown",b.width*0.30,b.height*0.52);e("pointermove",b.width*0.14,b.height*0.60);})()'
  ].join(''));
  await new Promise(r => setTimeout(r, 200));
  await shoot('4-3d-aiming');
  // 松手让这一杆打出去，顺便抓走球中的一帧
  await evalJs([
    '(function(){var c=document.getElementById("table");var b=c.getBoundingClientRect();',
    'c.dispatchEvent(new PointerEvent("pointerup",{pointerId:11,bubbles:true,cancelable:true,',
    'clientX:b.left+b.width*0.14,clientY:b.top+b.height*0.60,isPrimary:true}));})()'
  ].join(''));
  await waitFor('window.__poolPeek().playing === true', 5000);
  await new Promise(r => setTimeout(r, 300));
  await shoot('5-3d-break');

  ws.close();
}

function cleanup() {
  if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
  if (userDir) { try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) {} userDir = null; }
}

main().then(() => { cleanup(); process.exit(0); })
  .catch(e => { console.log('失败: ' + e.message); cleanup(); process.exit(1); });
process.on('exit', cleanup);

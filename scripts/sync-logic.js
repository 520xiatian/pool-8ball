/**
 * 把 miniprogram/logic 下的纯逻辑同步到各后端与 Web 前端。
 *
 * 为什么需要：所有端必须运行**逐字节相同**的物理、规则、房间状态机，
 * 否则同一杆算出不同结果，就会出现「我明明进了球」的争执。
 * 云函数、Worker、浏览器都不能直接 require 小程序目录，只能复制。
 *
 * 用法：node scripts/sync-logic.js
 * 每次改完 logic/ 下的文件就跑一次，然后重新部署对应端。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram', 'logic');

const BANNER = '/* 自动生成，请勿直接修改：源文件在 miniprogram/logic/，'
  + '改完运行 node scripts/sync-logic.js */\n';

// ---- 服务端：原样复制 CommonJS ----

// renderer/net* 依赖 wx API，bot 只在客户端跑，服务端都不需要
const SERVER_FILES = ['physics.js', 'rules.js', 'room-logic.js'];

const SERVER_TARGETS = [
  path.join(ROOT, 'cloudfunctions', 'poolRoom', 'logic'),
  path.join(ROOT, 'server', 'logic'),
  path.join(ROOT, 'cloudflare', 'src', 'logic')
];

// ---- Web 前端：包装成浏览器可直接 <script> 加载 ----

// 浏览器版不需要 room-logic（那是服务端的），但需要 bot 和 renderer
const WEB_FILES = ['physics.js', 'rules.js', 'bot.js', 'renderer.js'];
const WEB_TARGET = path.join(ROOT, 'cloudflare', 'public', 'logic');

// 剥离包装时用的定位标记，测试脚本靠它取回源文件内容比对
const MARK_BEGIN = '// ---- 源文件开始（勿改此行）----';
const MARK_END = '// ---- 源文件结束（勿改此行）----';

/**
 * 把 CommonJS 模块包成 IIFE。
 * 源码一行不动 —— 只是在外面补上 module/exports/require 三个局部变量，
 * 让浏览器里的 <script> 也能满足 CommonJS 的运行前提。
 */
function wrapForBrowser(name, code) {
  return BANNER
    + '(function (global) {\n'
    + '\'use strict\';\n'
    + 'var module = { exports: {} };\n'
    + 'var exports = module.exports;\n'
    + 'var require = global.__poolRequire;\n'
    + MARK_BEGIN + '\n'
    + code
    + MARK_END + '\n'
    + 'global.__poolModules[' + JSON.stringify(name) + '] = module.exports;\n'
    + '})(typeof window !== \'undefined\' ? window : globalThis);\n';
}

let changed = 0;

function writeIfChanged(dstPath, content, label) {
  const old = fs.existsSync(dstPath) ? fs.readFileSync(dstPath, 'utf8') : null;
  if (old === content) return;
  fs.writeFileSync(dstPath, content, 'utf8');
  changed++;
  console.log('已更新 ' + label);
}

for (const dst of SERVER_TARGETS) {
  fs.mkdirSync(dst, { recursive: true });
  const label = path.relative(ROOT, dst).replace(/\\/g, '/');
  for (const f of SERVER_FILES) {
    const srcPath = path.join(SRC, f);
    if (!fs.existsSync(srcPath)) {
      console.error('缺少源文件：' + srcPath);
      process.exit(1);
    }
    writeIfChanged(path.join(dst, f), BANNER + fs.readFileSync(srcPath, 'utf8'), label + '/' + f);
  }
}

fs.mkdirSync(WEB_TARGET, { recursive: true });
const webLabel = path.relative(ROOT, WEB_TARGET).replace(/\\/g, '/');
for (const f of WEB_FILES) {
  const srcPath = path.join(SRC, f);
  if (!fs.existsSync(srcPath)) {
    console.error('缺少源文件：' + srcPath);
    process.exit(1);
  }
  const wrapped = wrapForBrowser(f, fs.readFileSync(srcPath, 'utf8'));
  writeIfChanged(path.join(WEB_TARGET, f), wrapped, webLabel + '/' + f);
}

if (changed) {
  console.log('\n同步了 ' + changed + ' 个文件。记得重新部署改动过的端：');
  console.log('  · Cloudflare（含网页）→ cd cloudflare && npx wrangler deploy');
  console.log('  · 微信云开发          → 开发者工具里右键 cloudfunctions/poolRoom 上传');
  console.log('  · 本地服务器          → 重启 node server/index.js 即可');
} else {
  console.log('所有端的逻辑代码本来就是一致的。');
}

module.exports = { MARK_BEGIN: MARK_BEGIN, MARK_END: MARK_END };

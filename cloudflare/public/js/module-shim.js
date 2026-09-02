/**
 * 极简 CommonJS 垫片
 * ---------------------------------------------------------------
 * 为什么需要：physics.js / rules.js / bot.js / renderer.js 是给小程序
 * 写的 CommonJS 模块，用了 require 和 module.exports。为了让浏览器也能
 * **一字不改**地跑同一份代码（这是联机判定一致的前提），
 * 这里补上 require 的实现，由 sync-logic.js 生成的 IIFE 包装调用。
 *
 * 必须在 logic/*.js 之前加载。
 */
window.__poolModules = {};

window.__poolRequire = function (spec) {
  // 源码里写的是 './physics.js' 这类相对路径，取文件名即可
  var name = String(spec).replace(/^.*\//, '');
  var mod = window.__poolModules[name];
  if (!mod) {
    throw new Error('模块尚未加载：' + spec + '（检查 index.html 里的 script 顺序）');
  }
  return mod;
};

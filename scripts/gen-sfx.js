/**
 * 生成小程序端用的撞击音效 WAV。
 * ---------------------------------------------------------------
 * 网页端用 WebAudio 现场合成，小程序没有 WebAudio，只能播真实音频文件。
 * 与其去找素材（授权、体积、音色都不可控），不如按同一套参数合成一个：
 * 一段极短的带通噪声脉冲 + 指数衰减，就是球撞球的"咔"。
 *
 * 播放时用 InnerAudioContext 的 volume 控制力度、playbackRate 区分
 * 球撞球 / 撞库 / 落袋三种音色，所以只需要一个文件。
 *
 * 用法：node scripts/gen-sfx.js
 */
const fs = require('fs');
const path = require('path');

const RATE = 22050;          // 22kHz 足够，文件小一半
const DUR = 0.11;            // 110ms，尾巴留给 playbackRate 拉长
const N = Math.floor(RATE * DUR);

// 固定线性同余序列，不用 Math.random —— 每次生成的文件逐字节相同，
// 这样重跑脚本不会在 git 里产生无意义的差异。
let seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x3fffffff - 1;
}

// 二阶带通：把白噪声压到 ~2.2kHz 附近，听起来像硬球相撞而不是"嘶"
const F0 = 2200;
const Q = 1.5;
const w0 = 2 * Math.PI * F0 / RATE;
const alpha = Math.sin(w0) / (2 * Q);
const b0 = alpha, b1 = 0, b2 = -alpha;
const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;

const samples = new Float32Array(N);
let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
for (let i = 0; i < N; i++) {
  const x0 = rnd();
  const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2
             - (a1 / a0) * y1 - (a2 / a0) * y2;
  x2 = x1; x1 = x0;
  y2 = y1; y1 = y0;

  // 冲击包络：2ms 起振，之后指数衰减
  const t = i / RATE;
  const attack = Math.min(1, t / 0.002);
  const decay = Math.exp(-t / 0.018);
  samples[i] = y0 * attack * decay;
}

// 归一化到 -1..1 的 92%，留点余量避免播放端削波
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(samples[i]));
const gain = peak > 0 ? 0.92 / peak : 1;

// ---- 打包成 16bit 单声道 PCM WAV ----
const dataBytes = N * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);        // fmt chunk 大小
buf.writeUInt16LE(1, 20);         // PCM
buf.writeUInt16LE(1, 22);         // 单声道
buf.writeUInt32LE(RATE, 24);
buf.writeUInt32LE(RATE * 2, 28);  // 字节率
buf.writeUInt16LE(2, 32);         // 每帧字节
buf.writeUInt16LE(16, 34);        // 位深
buf.write('data', 36);
buf.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < N; i++) {
  let v = Math.round(samples[i] * gain * 32767);
  if (v > 32767) v = 32767;
  if (v < -32768) v = -32768;
  buf.writeInt16LE(v, 44 + i * 2);
}

const out = path.join(__dirname, '..', 'miniprogram', 'assets', 'hit.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, buf);
console.log('已生成 ' + path.relative(path.join(__dirname, '..'), out).replace(/\\/g, '/')
  + '  ' + buf.length + ' 字节');

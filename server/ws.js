/**
 * 极简 WebSocket 服务端（零依赖）
 * ---------------------------------------------------------------
 * 只实现本项目需要的部分：握手、文本帧收发、ping/pong、关闭。
 * 不做分片（fragmentation）与压缩扩展 —— 房间推送的 JSON 都只有
 * 几百字节，小程序端也不会发分片帧。
 *
 * 之所以不用 ws 这个 npm 包：让 `node server/index.js` 开箱即跑，
 * 不需要 npm install。真要上生产量级再换成 ws 也很容易。
 */
const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

/** 计算握手响应里的 Sec-WebSocket-Accept */
function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 把字符串编成一个服务端→客户端的文本帧（服务端发送不掩码） */
function encodeFrame(str, opcode) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 高 32 位留 0：单帧不可能超过 4GB
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | (opcode === undefined ? OP.TEXT : opcode);  // FIN=1
  return Buffer.concat([header, payload]);
}

/**
 * 一条 WebSocket 连接。
 * 用法：new WSConnection(socket) 后挂 onMessage / onClose。
 */
class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._fireClose());
    socket.on('error', () => this._fireClose());
    // 空闲 90 秒没任何数据就断开：客户端每 25 秒会发心跳，正常不会触发
    socket.setTimeout(90000, () => this.close());
  }

  send(obj) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(typeof obj === 'string' ? obj : JSON.stringify(obj), OP.TEXT));
    } catch (e) {
      this._fireClose();
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeFrame('', OP.CLOSE));
      this.socket.end();
    } catch (e) {}
    this._fireClose();
  }

  _fireClose() {
    if (this._closeFired) return;
    this._closeFired = true;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);

    // 一个 TCP 包里可能有多个帧，也可能只有半个帧，循环到解不出为止
    for (;;) {
      const frame = this._readFrame();
      if (!frame) return;

      if (frame.opcode === OP.CLOSE) return this.close();
      if (frame.opcode === OP.PING) {
        try { this.socket.write(encodeFrame(frame.payload.toString('utf8'), OP.PONG)); } catch (e) {}
        continue;
      }
      if (frame.opcode === OP.PONG) continue;
      if (frame.opcode === OP.TEXT && this.onMessage) {
        this.onMessage(frame.payload.toString('utf8'));
      }
    }
  }

  /** 从缓冲区尝试切出一个完整帧；不够则返回 null 等更多数据 */
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;

    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      const hi = b.readUInt32BE(2);
      // 超过 4GB 的帧只可能是恶意或错乱，直接断开
      if (hi !== 0) { this.close(); return null; }
      len = b.readUInt32BE(6);
      offset = 10;
    }

    // 单帧上限 64KB：正常请求远小于此，防止内存被打爆
    if (len > 65536) { this.close(); return null; }

    const maskLen = masked ? 4 : 0;
    if (b.length < offset + maskLen + len) return null;

    let payload;
    if (masked) {
      const mask = b.slice(offset, offset + 4);
      payload = Buffer.from(b.slice(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    } else {
      payload = Buffer.from(b.slice(offset, offset + len));
    }

    this.buf = b.slice(offset + maskLen + len);
    return { opcode: opcode, payload: payload };
  }
}

/**
 * 处理 HTTP upgrade 请求，完成握手并返回连接对象。
 * 握手失败返回 null（已自行关闭 socket）。
 */
function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  return new WSConnection(socket);
}

module.exports = { upgrade: upgrade, WSConnection: WSConnection, encodeFrame: encodeFrame, OP: OP };

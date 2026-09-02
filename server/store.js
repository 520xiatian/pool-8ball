/**
 * 内存房间存储 + 订阅推送
 * ---------------------------------------------------------------
 * 本地服务器不接数据库：房间是临时的，进程重启就该清空。
 * 需要持久化的话，把这个类换成 SQLite/Redis 实现即可，
 * 接口只有 create / getById / findByCode / update / remove / subscribe。
 *
 * 单进程 Node 是单线程事件循环，所以「读—改—写」天然不会被打断。
 * 但 guard 检查仍然保留 —— 它挡的是**客户端**的重放和并发双击，
 * 那与线程模型无关。
 */
class RoomStore {
  constructor() {
    this.rooms = new Map();      // roomId → doc
    this.subs = new Map();       // roomId → Set<fn>
    this.seq = 0;
  }

  _id() {
    // 时间前缀 + 递增序号：可读、有序、单进程内绝不重复
    return Date.now().toString(36) + '-' + (++this.seq).toString(36);
  }

  create(doc) {
    const id = this._id();
    doc._id = id;
    this.rooms.set(id, doc);
    return doc;
  }

  getById(id) {
    return this.rooms.get(id) || null;
  }

  /** 按房号找最新创建的那间（房号可能因过期房重复） */
  findByCode(code, notBefore) {
    let best = null;
    for (const doc of this.rooms.values()) {
      if (doc.code !== code) continue;
      if (notBefore && doc.createdAt < notBefore) continue;
      if (!best || doc.createdAt > best.createdAt) best = doc;
    }
    return best;
  }

  /** 快速匹配候选：公开、等待中、够新，按创建时间升序 */
  findWaitingPublic(createdAfter, limit) {
    const out = [];
    for (const doc of this.rooms.values()) {
      if (doc.status === 'waiting' && doc.isPublic && doc.createdAt > createdAfter) out.push(doc);
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out.slice(0, limit || 5);
  }

  /**
   * 带 guard 的更新。guard 用点号路径（与云开发 where 语法一致），
   * 任一条件不匹配就整体放弃，返回 false。
   */
  update(id, patch, guard) {
    const doc = this.rooms.get(id);
    if (!doc) return false;

    if (guard) {
      for (const k of Object.keys(guard)) {
        if (!deepEqual(getPath(doc, k), guard[k])) return false;
      }
    }
    for (const k of Object.keys(patch)) setPath(doc, k, patch[k]);
    this.notify(id);
    return true;
  }

  remove(id) {
    const existed = this.rooms.delete(id);
    if (existed) {
      // 通知订阅者房间已消失，让客户端能给出提示而不是干等
      const set = this.subs.get(id);
      if (set) for (const fn of set) { try { fn(null); } catch (e) {} }
      this.subs.delete(id);
    }
    return existed;
  }

  subscribe(id, fn) {
    if (!this.subs.has(id)) this.subs.set(id, new Set());
    this.subs.get(id).add(fn);
    return () => {
      const set = this.subs.get(id);
      if (!set) return;
      set.delete(fn);
      if (set.size === 0) this.subs.delete(id);
    };
  }

  notify(id) {
    const set = this.subs.get(id);
    if (!set || set.size === 0) return;
    const doc = this.rooms.get(id);
    if (!doc) return;
    for (const fn of set) {
      try { fn(doc); } catch (e) { /* 单个订阅者出错不影响其他人 */ }
    }
  }

  /** 清理过期房间，避免长跑进程内存无限增长 */
  sweep(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    let n = 0;
    for (const [id, doc] of this.rooms) {
      if (doc.createdAt < cutoff) { this.remove(id); n++; }
    }
    return n;
  }

  get size() { return this.rooms.size; }
}

function getPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object') {
      cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  // guard 里的 null 要能匹配 undefined（空座位可能是任一种）
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a !== 'object' || typeof b !== 'object' || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { RoomStore: RoomStore, getPath: getPath, setPath: setPath };

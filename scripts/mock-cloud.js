/**
 * wx-server-sdk 的最小 mock + 内存数据库
 * ---------------------------------------------------------------
 * 目的：让 cloudfunctions/poolRoom/index.js 能在本机 Node 里跑起来，
 * 从而用真实代码验证权限校验、乐观锁、状态机，而不必反复上传云函数。
 *
 * 只实现 index.js 实际用到的 API 子集，够用就好。
 */
const crypto = require('crypto');

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 按 'a.b.1.c' 取值 */
function getPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 按 'a.b.1.c' 赋值，中间层不存在时按需创建 */
function setPath(obj, path, value) {
  const parts = path.split('.');
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

/** 命令对象：{ $op: 'gt', value } */
function isCommand(v) {
  return v && typeof v === 'object' && typeof v.$op === 'string';
}

function matchOne(doc, key, cond) {
  const actual = getPath(doc, key);
  if (isCommand(cond)) {
    switch (cond.$op) {
      case 'gt': return actual > cond.value;
      case 'lt': return actual < cond.value;
      case 'eq': return actual === cond.value;
      case 'neq': return actual !== cond.value;
      default: throw new Error('mock 未实现的命令: ' + cond.$op);
    }
  }
  if (cond === null) return actual === null || actual === undefined;
  if (typeof cond === 'object') {
    return JSON.stringify(actual) === JSON.stringify(cond);
  }
  return actual === cond;
}

function matches(doc, where) {
  for (const k of Object.keys(where)) {
    if (k === '_id') {
      if (doc._id !== where._id) return false;
      continue;
    }
    if (!matchOne(doc, k, where[k])) return false;
  }
  return true;
}

class Query {
  constructor(coll, where) {
    this.coll = coll;
    this._where = where || {};
    this._order = null;
    this._limit = 100;
  }
  where(w) { this._where = Object.assign({}, this._where, w); return this; }
  orderBy(field, dir) { this._order = { field: field, dir: dir }; return this; }
  limit(n) { this._limit = n; return this; }

  _rows() {
    let rows = this.coll.docs.filter(d => matches(d, this._where));
    if (this._order) {
      const f = this._order.field;
      const sign = this._order.dir === 'desc' ? -1 : 1;
      rows = rows.slice().sort((a, b) => {
        const av = getPath(a, f);
        const bv = getPath(b, f);
        if (av === bv) return 0;
        return av > bv ? sign : -sign;
      });
    }
    return rows.slice(0, this._limit);
  }

  async get() { return { data: this._rows().map(deepClone) }; }

  async update(opts) {
    const rows = this._rows();
    let updated = 0;
    for (const row of rows) {
      for (const k of Object.keys(opts.data)) {
        setPath(row, k, deepClone(opts.data[k]));
      }
      updated++;
    }
    return { stats: { updated: updated } };
  }

  async remove() {
    const rows = this._rows();
    for (const row of rows) {
      const i = this.coll.docs.indexOf(row);
      if (i !== -1) this.coll.docs.splice(i, 1);
    }
    return { stats: { removed: rows.length } };
  }
}

class DocRef {
  constructor(coll, id) { this.coll = coll; this.id = id; }
  _find() { return this.coll.docs.find(d => d._id === this.id) || null; }
  async get() {
    const d = this._find();
    if (!d) {
      // 真实云开发在文档不存在时会抛错，这里保持一致，
      // 好让 index.js 里的 try/catch 路径也被测到
      const err = new Error('document.get: document does not exist');
      err.errCode = -1;
      throw err;
    }
    return { data: deepClone(d) };
  }
  async update(opts) {
    const d = this._find();
    if (!d) return { stats: { updated: 0 } };
    for (const k of Object.keys(opts.data)) setPath(d, k, deepClone(opts.data[k]));
    return { stats: { updated: 1 } };
  }
  async remove() {
    const d = this._find();
    if (!d) return { stats: { removed: 0 } };
    this.coll.docs.splice(this.coll.docs.indexOf(d), 1);
    return { stats: { removed: 1 } };
  }
}

class Collection {
  constructor(name) { this.name = name; this.docs = []; }
  doc(id) { return new DocRef(this, id); }
  where(w) { return new Query(this, w); }
  orderBy(f, d) { return new Query(this, {}).orderBy(f, d); }
  limit(n) { return new Query(this, {}).limit(n); }
  async get() { return new Query(this, {}).get(); }
  async add(opts) {
    const id = crypto.randomBytes(12).toString('hex');
    const doc = Object.assign({ _id: id }, deepClone(opts.data));
    this.docs.push(doc);
    return { _id: id };
  }
}

class Database {
  constructor() {
    this.colls = {};
    this.command = {
      gt: (v) => ({ $op: 'gt', value: v }),
      lt: (v) => ({ $op: 'lt', value: v }),
      eq: (v) => ({ $op: 'eq', value: v }),
      neq: (v) => ({ $op: 'neq', value: v })
    };
  }
  collection(name) {
    if (!this.colls[name]) this.colls[name] = new Collection(name);
    return this.colls[name];
  }
  reset() { this.colls = {}; }
}

const _db = new Database();
let _openid = 'openid-default';

const mock = {
  DYNAMIC_CURRENT_ENV: 'mock-env',
  init() {},
  database() { return _db; },
  getWXContext() { return { OPENID: _openid, APPID: 'mock-appid' }; },

  // 测试辅助
  __setOpenid(v) { _openid = v; },
  __db: _db,
  __reset() { _db.reset(); }
};

module.exports = mock;

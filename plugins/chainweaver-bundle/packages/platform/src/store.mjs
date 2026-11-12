import { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

export class Problem extends Error {
  constructor(status, message) { super(message); this.status = status }
}
export const id = () => randomUUID()
const tokenHash = value => createHash('sha256').update(value).digest('hex')
const publicAccount = row => row && ({ id: row.id, username: row.username, role: row.role, uid: row.uid, disabled: !!row.disabled, createdAt: row.created_at })
function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) throw new Problem(400, '密码长度应为 6–128 个字符')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`
}
function verifyPassword(password, hash) {
  if (typeof password !== 'string' || password.length > 128) return false
  const [salt, stored] = hash.split(':'); const actual = scryptSync(password, salt, 32)
  const expected = Buffer.from(stored, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
export class Store {
  constructor(root, { bootstrap = true, uidRegistry } = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 });this.uidRegistry=uidRegistry
    const keyFile = join(root, 'master.key')
    try { this.key = readFileSync(keyFile) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if(existsSync(join(root,'platform.sqlite'))&&statSync(join(root,'platform.sqlite')).size>0)throw new Error('平台加密密钥缺失，请恢复原 master.key 后启动')
      this.key = randomBytes(32); writeFileSync(keyFile, this.key, { flag: 'wx', mode: 0o600 })
    }
    if (this.key.length !== 32) throw new Error('平台加密密钥无效')
    this.db = new DatabaseSync(join(root, 'platform.sqlite'))
    chmodSync(join(root,'platform.sqlite'),0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, uid INTEGER UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), epoch INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(user_id TEXT PRIMARY KEY REFERENCES accounts(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtimes(user_id TEXT PRIMARY KEY REFERENCES accounts(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache_leases(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, repository_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL, subject TEXT, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
    if (bootstrap && this.db.prepare('SELECT count(*) AS n FROM accounts').get().n === 0) this.createAccount('admin', '123456', 'admin')
    // 重启后未完成的执行先等待用户确认，不能直接当作成功或重复运行。
    for (const row of this.all('executions')) {
      if (['running', 'queued', 'preparing'].includes(row.value.status)) this.put('executions', row.id, { ...row.value, status: 'interrupted', reason: '服务重启，请确认后恢复' }, row.user_id)
    }
  }
  createAccount(username, password, role = 'user') {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,63}$/.test(username)) throw new Problem(400, '账号名应为 2–64 位字母、数字、点、横线或下划线')
    if (!['admin', 'user'].includes(role)) throw new Problem(400, '账号角色无效')
    let uid=Number(this.db.prepare('SELECT coalesce(max(uid),99999)+1 AS uid FROM accounts').get().uid)
    if(this.uidRegistry)uid=this.allocateIdentity()
    const account = { id: id(), username, role, uid, createdAt: new Date().toISOString() }
    try { this.db.prepare('INSERT INTO accounts(id,username,uid,password,role,created_at) VALUES(?,?,?,?,?,?)').run(account.id, username, uid, hashPassword(password), role, account.createdAt) }
    catch (error) { if ((error.errcode === 2067 || error.code?.includes('SQLITE_CONSTRAINT'))) throw new Problem(409, '账号已存在'); throw error }
    return this.account(account.id)
  }
  allocateIdentity(){mkdirSync(dirname(this.uidRegistry),{recursive:true,mode:0o700});const registry=new DatabaseSync(this.uidRegistry);try{chmodSync(this.uidRegistry,0o600);registry.exec('PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS identities(uid INTEGER PRIMARY KEY AUTOINCREMENT);INSERT OR IGNORE INTO identities(uid) VALUES(999999)');return Number(registry.prepare('INSERT INTO identities DEFAULT VALUES').run().lastInsertRowid)}finally{registry.close()}}
  account(userId) { return publicAccount(this.db.prepare('SELECT * FROM accounts WHERE id=?').get(userId)) }
  accounts() { return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all().map(publicAccount) }
  login(username, password) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE username=?').get(username)
    // 不向调用方泄露账号是否存在。
    if (!row || row.disabled || !verifyPassword(password, row.password)) throw new Problem(401, '账号或密码错误')
    const token = randomBytes(32).toString('base64url'); const expires = Date.now() + 8 * 3600000
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(tokenHash(token), row.id, row.epoch, expires)
    return { token, expires, account: publicAccount(row) }
  }
  authenticate(token) {
    if (!token || token.length > 256) return undefined
    return publicAccount(this.db.prepare('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.user_id WHERE s.hash=? AND s.expires>? AND s.epoch=a.epoch AND a.disabled=0').get(tokenHash(token), Date.now()))
  }
  logout(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(token)) }
  revoke(userId) { this.db.prepare('UPDATE accounts SET epoch=epoch+1 WHERE id=?').run(userId); this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId) }
  password(userId, password, oldPassword) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(userId)
    if (!row) throw new Problem(404, '账号不存在')
    if (oldPassword !== undefined && !verifyPassword(oldPassword, row.password)) throw new Problem(400, '原密码不正确')
    this.db.prepare('UPDATE accounts SET password=? WHERE id=?').run(hashPassword(password), userId); this.revoke(userId)
  }
  disable(userId, disabled) {
    const account = this.account(userId); if (!account) throw new Problem(404, '账号不存在')
    if (disabled && account.role === 'admin' && this.accounts().filter(a => a.role === 'admin' && !a.disabled).length <= 1) throw new Problem(409, '不能停用最后一个管理员')
    this.db.prepare('UPDATE accounts SET disabled=? WHERE id=?').run(disabled ? 1 : 0, userId); this.revoke(userId)
  }
  encrypt(value) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv); const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64') }
  decrypt(value) { const b = Buffer.from(value, 'base64'); const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0,12)); d.setAuthTag(b.subarray(12,28)); return JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString()) }
  setCredentials(userId, value) { this.db.prepare('INSERT INTO credentials VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value').run(userId, this.encrypt(value)) }
  credentials(userId) { const row = this.db.prepare('SELECT value FROM credentials WHERE user_id=?').get(userId); return row ? this.decrypt(row.value) : {} }
  all(table, userId) { this.table(table); return this.db.prepare(`SELECT * FROM ${table}${userId ? ' WHERE user_id=?' : ''}`).all(...userId ? [userId] : []).map(r => ({ ...r, value: JSON.parse(r.value) })) }
  get(table, key, userId) { this.table(table); const r = this.db.prepare(`SELECT * FROM ${table} WHERE ${table === 'runtimes' ? 'user_id' : 'id'}=?${userId ? ' AND user_id=?' : ''}`).get(key, ...userId ? [userId] : []); return r ? JSON.parse(r.value) : undefined }
  put(table, key, value, userId) {
    this.table(table)
    if (table === 'runtimes') this.db.prepare('INSERT INTO runtimes VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))
    else if (table === 'repositories') this.db.prepare('INSERT INTO repositories VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value))
    else this.db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE ${table}.user_id=excluded.user_id`).run(key,userId,JSON.stringify(value))
  }
  table(table) { if (!['runtimes','projects','repositories','executions'].includes(table)) throw new Error('未知存储表') }
  audit(actor, action, subject, result = 'ok') { this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?)').run(id(), new Date().toISOString(), actor, action, subject, result) }
  close() { this.db.close() }
}

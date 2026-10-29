import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Artifact, Delivery, Job, Memory, RuntimeEvent, Subscription, Task, Timer } from './types.js';
import { NotFoundError } from './types.js';

interface Entities {
  tasks: Task; jobs: Job; artifacts: Artifact; memory: Memory;
  deliveries: Delivery; subscriptions: Subscription; timers: Timer;
}
type Table = keyof Entities;
const tables: Table[] = ['tasks', 'jobs', 'artifacts', 'memory', 'deliveries', 'subscriptions', 'timers'];
export const uid = () => randomUUID();

/** One runtime process owns a database. Changes and their events commit together. */
export class Store {
  private db: DatabaseSync;
  private ownerDb: DatabaseSync | undefined;
  private path: string;
  private owned = false;
  private emitter = new EventEmitter();
  private pending: RuntimeEvent[] | null = null;
  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();
    if (version && version.value !== '1') throw new Error(`Unsupported database schema: ${version.value}`);
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL,
        data TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO metadata VALUES ('schema_version','1');
    `);
  }
  transaction<T>(fn: () => T): T {
    if (this.pending) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.pending = [];
    let value: T; let events: RuntimeEvent[];
    try {
      value = fn(); events = this.pending;
      this.db.exec('COMMIT'); this.pending = null;
    } catch (error) {
      this.db.exec('ROLLBACK'); this.pending = null; throw error;
    }
    for (const event of events) this.emitEvent(event);
    return value;
  }
  put<K extends Table>(table: K, item: Entities[K]): void {
    this.db.prepare(`INSERT INTO ${table} (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`)
      .run(item.id, JSON.stringify(item));
  }
  get<K extends Table>(table: K, id: string): Entities[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    return row ? JSON.parse(row.data as string) as Entities[K] : undefined;
  }
  require<K extends Table>(table: K, id: string): Entities[K] {
    const item = this.get(table, id);
    if (!item) throw new NotFoundError(`${table}: ${id} not found`);
    return item;
  }
  all<K extends Table>(table: K): Entities[K][] {
    return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all()
      .map(row => JSON.parse(row.data as string) as Entities[K]);
  }
  remove(table: Table, id: string): void { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  receipt(id: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO receipts VALUES (?)').run(id).changes > 0;
  }
  append(taskId: string | null, kind: string, data: unknown): RuntimeEvent {
    const createdAt = Date.now();
    const row = this.db.prepare('INSERT INTO events(task_id,kind,data,created_at) VALUES (?,?,?,?)')
      .run(taskId, kind, JSON.stringify(data ?? null), createdAt);
    const event: RuntimeEvent = { seq: Number(row.lastInsertRowid), taskId, kind, data, createdAt };
    if (this.pending) this.pending.push(event); else this.emitEvent(event);
    return event;
  }
  events(after = 0, taskId?: string, limit = 1000): RuntimeEvent[] {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM events WHERE seq>? AND task_id=? ORDER BY seq LIMIT ?').all(after, taskId, limit)
      : this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    return rows.map(row => ({ seq: Number(row.seq), taskId: row.task_id as string | null,
      kind: row.kind as string, data: JSON.parse(row.data as string), createdAt: Number(row.created_at) }));
  }
  cursor(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM events').get()!.cursor);
  }
  history(taskId?: string, before = Number.MAX_SAFE_INTEGER, limit = 300): RuntimeEvent[] {
    const rows = taskId
      ? this.db.prepare('SELECT * FROM events WHERE seq<? AND task_id=? ORDER BY seq DESC LIMIT ?').all(before, taskId, limit)
      : this.db.prepare('SELECT * FROM events WHERE seq<? ORDER BY seq DESC LIMIT ?').all(before, limit);
    return rows.reverse().map(row => ({ seq: Number(row.seq), taskId: row.task_id as string | null,
      kind: row.kind as string, data: JSON.parse(row.data as string), createdAt: Number(row.created_at) }));
  }
  private emitEvent(event: RuntimeEvent): void {
    for (const listener of this.emitter.listeners('event')) {
      try { (listener as (event: RuntimeEvent) => void)(event); }
      catch { process.emitWarning('Runtime event observer failed', { type: 'ObserverWarning' }); }
    }
  }
  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.emitter.on('event', listener); return () => this.emitter.off('event', listener);
  }
  acquireOwner(): void {
    if (this.owned) throw new Error('This store already has a runtime owner');
    if (this.path !== ':memory:') {
      const owner = new DatabaseSync(this.path + '.owner.sqlite');
      try {
        owner.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;');
        this.ownerDb = owner;
      } catch {
        owner.close(); throw new Error('Another runtime already owns this database. Use its HTTP API.');
      }
    }
    this.owned = true;
  }
  releaseOwner(): void {
    if (this.ownerDb) { this.ownerDb.exec('ROLLBACK'); this.ownerDb.close(); this.ownerDb = undefined; }
    this.owned = false;
  }
  close(): void { this.releaseOwner(); this.db.close(); this.emitter.removeAllListeners(); }
}

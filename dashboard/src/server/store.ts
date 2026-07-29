import Database from 'better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Job } from './types.js';

export class Store {
  private db: Database.Database;
  constructor(dbPath: string, private logDir: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    mkdirSync(logDir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, host TEXT NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL,
        state TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, exitCode INTEGER
      );
      CREATE TABLE IF NOT EXISTS health (
        host TEXT PRIMARY KEY, report TEXT NOT NULL, at INTEGER NOT NULL
      );
    `);
  }
  createJob(j: Omit<Job, 'state' | 'finishedAt' | 'exitCode'>): Job {
    const job: Job = { ...j, state: 'starting', finishedAt: null, exitCode: null };
    this.db.prepare('INSERT INTO jobs VALUES (@id,@host,@action,@source,@state,@startedAt,@finishedAt,@exitCode)').run(job);
    return job;
  }
  updateJob(id: string, patch: Partial<Pick<Job, 'state' | 'finishedAt' | 'exitCode'>>): void {
    const cur = this.getJob(id);
    if (!cur) throw new Error(`no such job: ${id}`);
    const next = { ...cur, ...patch };
    this.db.prepare('UPDATE jobs SET state=@state, finishedAt=@finishedAt, exitCode=@exitCode WHERE id=@id').run(next);
  }
  getJob(id: string): Job | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Job | undefined;
  }
  jobsForHost(host: string, limit = 50): Job[] {
    return this.db.prepare('SELECT * FROM jobs WHERE host=? ORDER BY startedAt DESC LIMIT ?').all(host, limit) as Job[];
  }
  runningJobs(): Job[] {
    return this.db.prepare("SELECT * FROM jobs WHERE state IN ('starting','running','stalled')").all() as Job[];
  }
  logPath(id: string): string { return join(this.logDir, `${id}.log`); }
  appendLog(id: string, line: string): void { appendFileSync(this.logPath(id), line + '\n'); }
  saveHealth(host: string, report: string, at: number): void {
    this.db.prepare('INSERT INTO health VALUES (?,?,?) ON CONFLICT(host) DO UPDATE SET report=excluded.report, at=excluded.at').run(host, report, at);
  }
  latestHealth(host: string): { report: string; at: number } | undefined {
    return this.db.prepare('SELECT report, at FROM health WHERE host=?').get(host) as { report: string; at: number } | undefined;
  }
}

const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");

// Ensure data directory exists
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "queue.db");

class Database {
  constructor() {
    this.db = new sqlite3.Database(dbPath);
    this.init();
  }

  init() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Jobs table
        this.db.run(
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 3,
            next_retry_at TEXT,
            locked_by TEXT,
            locked_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT
          )`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
          }
        );

        // DLQ table
        this.db.run(
          `CREATE TABLE IF NOT EXISTS dlq (
            id TEXT PRIMARY KEY,
            command TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            max_retries INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            failed_at TEXT NOT NULL,
            original_job_id TEXT
          )`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
          }
        );

        // Config table
        this.db.run(
          `CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
          }
        );

        // Worker processes table
        this.db.run(
          `CREATE TABLE IF NOT EXISTS workers (
            id TEXT PRIMARY KEY,
            pid INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'running'
          )`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
          }
        );

        // Create indexes for better performance
        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state)`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
          }
        );

        this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_jobs_next_retry ON jobs(next_retry_at)`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
          }
        );

        // Initialize default config
        this.db.run(
          `INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('max-retries', '3', datetime('now'))`,
          (err) => {
            if (err) {
              reject(err);
              return;
            }
            this.db.run(
              `INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('backoff-base', '2', datetime('now'))`,
              (err) => {
                if (err) {
                  reject(err);
                  return;
                }
                resolve();
              }
            );
          }
        );
      });
    });
  }

  // Generic run method
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  // Generic get method
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  // Generic all method
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  // Lock a job for processing (prevents duplicate processing)
  lockJob(jobId, workerId) {
    return new Promise((resolve, reject) => {
      const now = new Date().toISOString();
      this.db.run(
        `UPDATE jobs 
         SET state = 'processing', 
             locked_by = ?, 
             locked_at = ?,
             updated_at = ?
         WHERE id = ? 
           AND state = 'pending' 
           AND (next_retry_at IS NULL OR next_retry_at <= ?)`,
        [workerId, now, now, jobId, now],
        function (err) {
          if (err) {
            reject(err);
          } else {
            // Check if we actually locked the job
            if (this.changes > 0) {
              resolve(true);
            } else {
              resolve(false);
            }
          }
        }
      );
    });
  }

  // Release a job lock (on completion or failure)
  releaseLock(jobId) {
    return this.run(
      `UPDATE jobs SET locked_by = NULL, locked_at = NULL WHERE id = ?`,
      [jobId]
    );
  }

  // Clean up stale locks (older than 5 minutes)
  cleanupStaleLocks() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    return this.run(
      `UPDATE jobs 
       SET state = 'pending', 
           locked_by = NULL, 
           locked_at = NULL,
           updated_at = ?
       WHERE state = 'processing' 
         AND locked_at < ?`,
      [new Date().toISOString(), fiveMinutesAgo]
    );
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// Singleton instance
let dbInstance = null;
let initPromise = null;

function getDatabase() {
  if (!dbInstance) {
    dbInstance = new Database();
    initPromise = dbInstance.init();
  }
  return dbInstance;
}

// Ensure database is initialized before use
async function ensureInitialized() {
  if (initPromise) {
    await initPromise;
  }
}

// Export both the getDatabase function and ensureInitialized
const dbModule = getDatabase;
dbModule.ensureInitialized = ensureInitialized;

module.exports = dbModule;

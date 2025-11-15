const getDatabase = require("../db/database");
const getConfig = require("../config/config");
const { v4: uuidv4 } = require("uuid");

class JobService {
  constructor() {
    this.db = getDatabase();
    this.config = getConfig();
  }

  async enqueueJob(jobData) {
    // Parse job data - can be JSON string or object
    let job;
    if (typeof jobData === "string") {
      try {
        job = JSON.parse(jobData);
      } catch (err) {
        throw new Error(`Invalid JSON: ${err.message}`);
      }
    } else {
      job = jobData;
    }

    // Validate required fields
    if (!job.command) {
      throw new Error("Job must have a 'command' field");
    }

    // Set defaults
    const id = job.id || uuidv4();
    const maxRetries =
      job.max_retries !== undefined
        ? job.max_retries
        : await this.config.get("max-retries", 3);
    const now = new Date().toISOString();

    // Insert job
    await this.db.run(
      `INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
      [id, job.command, maxRetries, now, now]
    );

    return {
      id,
      command: job.command,
      state: "pending",
      attempts: 0,
      max_retries: maxRetries,
      created_at: now,
      updated_at: now,
    };
  }

  async getNextPendingJob(workerId) {
    // Clean up stale locks first
    await this.db.cleanupStaleLocks();

    const now = new Date().toISOString();

    // Get a pending job that's ready for retry (if applicable)
    const job = await this.db.get(
      `SELECT * FROM jobs 
       WHERE state = 'pending' 
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC 
       LIMIT 1`,
      [now]
    );

    if (!job) {
      return null;
    }

    // Try to lock the job
    const locked = await this.db.lockJob(job.id, workerId);
    if (!locked) {
      // Job was locked by another worker, try again
      return null;
    }

    // Return the locked job
    return await this.getJobById(job.id);
  }

  async getJobById(id) {
    return await this.db.get("SELECT * FROM jobs WHERE id = ?", [id]);
  }

  async updateJobState(id, state, attempts = null) {
    const now = new Date().toISOString();
    const updates = ["state = ?", "updated_at = ?"];
    const params = [state, now];

    if (attempts !== null) {
      updates.push("attempts = ?");
      params.push(attempts);
    }

    if (state === "completed") {
      updates.push("completed_at = ?");
      params.push(now);
    }

    params.push(id);

    await this.db.run(
      `UPDATE jobs SET ${updates.join(", ")} WHERE id = ?`,
      params
    );

    // Release lock
    await this.db.releaseLock(id);
  }

  async handleJobFailure(job) {
    const attempts = job.attempts + 1;
    const maxRetries = job.max_retries;

    if (attempts >= maxRetries) {
      // Move to DLQ
      await this.moveToDLQ(job);
      await this.updateJobState(job.id, "dead", attempts);
      return { shouldRetry: false, movedToDLQ: true };
    }

    // Calculate exponential backoff
    const backoffBase = await this.config.get("backoff-base", 2);
    const delaySeconds = Math.pow(backoffBase, attempts);
    const nextRetryAt = new Date(
      Date.now() + delaySeconds * 1000
    ).toISOString();

    // Update job for retry
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE jobs 
       SET state = 'pending', 
           attempts = ?, 
           next_retry_at = ?,
           updated_at = ?,
           locked_by = NULL,
           locked_at = NULL
       WHERE id = ?`,
      [attempts, nextRetryAt, now, job.id]
    );

    return {
      shouldRetry: true,
      attempts,
      delaySeconds,
      nextRetryAt,
    };
  }

  async moveToDLQ(job) {
    const now = new Date().toISOString();

    // Check if already in DLQ
    const existing = await this.db.get("SELECT id FROM dlq WHERE id = ?", [
      job.id,
    ]);

    if (!existing) {
      await this.db.run(
        `INSERT INTO dlq (id, command, attempts, max_retries, created_at, failed_at, original_job_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.command,
          job.attempts,
          job.max_retries,
          job.created_at,
          now,
          job.id,
        ]
      );
    }
  }

  async getDLQJobs() {
    return await this.db.all("SELECT * FROM dlq ORDER BY failed_at DESC");
  }

  async getDLQJobById(id) {
    return await this.db.get("SELECT * FROM dlq WHERE id = ?", [id]);
  }

  async retryDLQJob(id) {
    const dlqJob = await this.getDLQJobById(id);
    if (!dlqJob) {
      throw new Error(`Job ${id} not found in DLQ`);
    }

    // Remove from DLQ
    await this.db.run("DELETE FROM dlq WHERE id = ?", [id]);

    // Re-enqueue as a new job
    const now = new Date().toISOString();
    const newId = uuidv4();

    await this.db.run(
      `INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, ?, ?, ?)`,
      [newId, dlqJob.command, dlqJob.max_retries, now, now]
    );

    return newId;
  }

  async getJobsByState(state) {
    return await this.db.all("SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC", [
      state,
    ]);
  }

  async getAllJobs() {
    return await this.db.all("SELECT * FROM jobs ORDER BY created_at DESC");
  }

  async getJobStats() {
    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead: 0,
      total: 0,
    };

    const jobs = await this.db.all(
      "SELECT state, COUNT(*) as count FROM jobs GROUP BY state"
    );

    for (const row of jobs) {
      stats[row.state] = row.count;
      stats.total += row.count;
    }

    const dlqCount = await this.db.get(
      "SELECT COUNT(*) as count FROM dlq"
    );
    stats.dlq = dlqCount ? dlqCount.count : 0;

    return stats;
  }
}

// Singleton instance
let jobServiceInstance = null;

function getJobService() {
  if (!jobServiceInstance) {
    jobServiceInstance = new JobService();
  }
  return jobServiceInstance;
}

module.exports = getJobService;

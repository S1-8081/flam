#!/usr/bin/env node

const getJobService = require("../jobs/jobService");
const getDatabase = require("../db/database");
const { spawn } = require("child_process");

// Get worker ID from command line arguments
const workerId = process.argv[2];
const jobService = getJobService();
const db = getDatabase();

let running = true;
let currentJob = null;
let currentProcess = null;
let shutdownRequested = false;

async function start() {
  // Ensure database is initialized
  await getDatabase.ensureInitialized();

  // Register worker
  const pid = process.pid;
  const now = new Date().toISOString();

  await db.run(
    `INSERT OR REPLACE INTO workers (id, pid, started_at, status)
     VALUES (?, ?, ?, 'running')`,
    [workerId, pid, now]
  );

  console.log(`[Worker ${workerId}] Started (PID: ${pid})`);

  // Start polling for jobs
  poll();

  // Setup graceful shutdown
  setupGracefulShutdown();
}

async function poll() {
  if (!running || shutdownRequested) {
    return;
  }

  try {
    // Only process if we don't have a current job
    if (!currentJob) {
      const job = await jobService.getNextPendingJob(workerId);

      if (job) {
        currentJob = job;
        await processJob(job);
      }
    }
  } catch (error) {
    console.error(`[Worker ${workerId}] Error:`, error.message);
  }

  // Schedule next poll
  if (running && !shutdownRequested) {
    setTimeout(() => poll(), 1000);
  }
}

async function processJob(job) {
  console.log(
    `[Worker ${workerId}] Processing job ${job.id}: ${job.command}`
  );

  try {
    // Execute the command
    const success = await executeCommand(job.command);

    if (success) {
      // Job completed successfully
      await jobService.updateJobState(job.id, "completed", job.attempts);
      console.log(`[Worker ${workerId}] Job ${job.id} completed`);
    } else {
      // Job failed - handle retry
      const result = await jobService.handleJobFailure(job);

      if (result.movedToDLQ) {
        console.log(
          `[Worker ${workerId}] Job ${job.id} moved to DLQ after ${job.attempts + 1} attempts`
        );
      } else {
        console.log(
          `[Worker ${workerId}] Job ${job.id} failed (attempt ${result.attempts}/${job.max_retries}). Will retry after ${result.delaySeconds}s`
        );
      }
    }
  } catch (error) {
    console.error(`[Worker ${workerId}] Error processing job:`, error);
    // Treat as failure
    const result = await jobService.handleJobFailure(job);
    if (result.movedToDLQ) {
      console.log(
        `[Worker ${workerId}] Job ${job.id} moved to DLQ due to error`
      );
    }
  } finally {
    // Clear current job
    currentJob = null;
    currentProcess = null;

    // Release lock
    await db.releaseLock(job.id);

    // Check if shutdown was requested
    if (shutdownRequested && !currentJob) {
      await stop();
    }
  }
}

function executeCommand(command) {
  return new Promise((resolve) => {
    // Determine shell based on platform
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellFlag = isWindows ? "/c" : "-c";

    // Spawn the process
    const childProcess = spawn(shell, [shellFlag, command], {
      stdio: "inherit",
      env: process.env,
    });

    currentProcess = childProcess;

    childProcess.on("error", (error) => {
      console.error(`[Worker ${workerId}] Command error:`, error.message);
      currentProcess = null;
      resolve(false);
    });

    childProcess.on("exit", (code) => {
      currentProcess = null;
      // Exit code 0 means success
      resolve(code === 0);
    });

    // Handle graceful shutdown - kill the process if requested
    if (shutdownRequested && currentProcess) {
      currentProcess.kill("SIGTERM");
    }
  });
}

function setupGracefulShutdown() {
  const shutdown = async (signal) => {
    if (shutdownRequested) {
      return;
    }

    console.log(
      `[Worker ${workerId}] Received ${signal}, shutting down gracefully...`
    );

    shutdownRequested = true;

    // If we have a current job, wait for it to complete
    if (currentJob) {
      console.log(
        `[Worker ${workerId}] Waiting for current job to complete...`
      );
      // Kill the current process if running
      if (currentProcess) {
        currentProcess.kill("SIGTERM");
      }
      // Set up a timeout to force shutdown if it takes too long
      setTimeout(async () => {
        if (currentJob) {
          console.log(
            `[Worker ${workerId}] Forcing shutdown after timeout`
          );
          if (currentProcess) {
            currentProcess.kill("SIGKILL");
          }
          await stop();
        }
      }, 30000); // 30 second timeout
    } else {
      await stop();
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function stop() {
  running = false;

  // Unregister worker
  await db.run(
    `UPDATE workers SET status = 'stopped' WHERE id = ?`,
    [workerId]
  );

  console.log(`[Worker ${workerId}] Stopped`);
  process.exit(0);
}

// Start the worker
start().catch((error) => {
  console.error(`Worker ${workerId} failed to start:`, error);
  process.exit(1);
});

#!/usr/bin/env node

const { program, Command } = require("commander");
const getJobService = require("./jobs/jobService");
const { WorkerManager } = require("./workers/worker");
const getConfig = require("./config/config");
const getDatabase = require("./db/database");
const { v4: uuidv4 } = require("uuid");

const jobService = getJobService();
const workerManager = new WorkerManager();
const config = getConfig();

program
  .name("queuectl")
  .description("CLI-based background job queue system")
  .version("1.0.0");

// Enqueue command
program
  .command("enqueue")
  .description("Add a new job to the queue")
  .argument("<jobData>", "Job data as JSON string")
  .action(async (jobData) => {
    try {
      const job = await jobService.enqueueJob(jobData);
      console.log(`Job enqueued successfully!`);
      console.log(`ID: ${job.id}`);
      console.log(`Command: ${job.command}`);
      console.log(`State: ${job.state}`);
      console.log(`Max Retries: ${job.max_retries}`);
    } catch (error) {
      console.error(`Error enqueuing job: ${error.message}`);
      process.exit(1);
    }
  });

// Worker start command
const workerCommand = new Command("worker")
  .description("Manage workers");

workerCommand
  .command("start")
  .description("Start one or more workers")
  .option("-c, --count <number>", "Number of workers to start", "1")
  .action(async (options) => {
    try {
      const count = parseInt(options.count, 10);
      if (isNaN(count) || count < 1) {
        console.error("Count must be a positive number");
        process.exit(1);
      }
      await workerManager.startWorkers(count);
      // Keep the process alive
      process.on("SIGINT", async () => {
        await workerManager.stopWorkers();
        process.exit(0);
      });
      process.on("SIGTERM", async () => {
        await workerManager.stopWorkers();
        process.exit(0);
      });
    } catch (error) {
      console.error(`Error starting workers: ${error.message}`);
      process.exit(1);
    }
  });

workerCommand
  .command("stop")
  .description("Stop all running workers gracefully")
  .action(async () => {
    try {
      await workerManager.stopWorkers();
      process.exit(0);
    } catch (error) {
      console.error(`Error stopping workers: ${error.message}`);
      process.exit(1);
    }
  });

program.addCommand(workerCommand);

// Status command
program
  .command("status")
  .description("Show summary of all job states and active workers")
  .action(async () => {
    try {
      const stats = await jobService.getJobStats();
      const workers = await workerManager.getWorkerStatus();

      console.log("\n=== Job Queue Status ===\n");
      console.log(`Total Jobs: ${stats.total}`);
      console.log(`Pending: ${stats.pending}`);
      console.log(`Processing: ${stats.processing}`);
      console.log(`Completed: ${stats.completed}`);
      console.log(`Failed: ${stats.failed}`);
      console.log(`Dead: ${stats.dead}`);
      console.log(`DLQ: ${stats.dlq || 0}`);

      console.log("\n=== Active Workers ===\n");
      if (workers.length === 0) {
        console.log("No active workers");
      } else {
        for (const worker of workers) {
          console.log(`Worker ${worker.id.substring(0, 8)}... (PID: ${worker.pid}) - Started: ${worker.started_at}`);
        }
      }
      console.log();
    } catch (error) {
      console.error(`Error getting status: ${error.message}`);
      process.exit(1);
    }
  });

// List command
program
  .command("list")
  .description("List jobs by state")
  .option("-s, --state <state>", "Filter by job state (pending, processing, completed, failed, dead)", "all")
  .action(async (options) => {
    try {
      let jobs;
      if (options.state === "all") {
        jobs = await jobService.getAllJobs();
      } else {
        jobs = await jobService.getJobsByState(options.state);
      }

      if (jobs.length === 0) {
        console.log(`No jobs found${options.state !== "all" ? ` with state: ${options.state}` : ""}`);
        return;
      }

      console.log(`\n=== Jobs (${jobs.length}) ===\n`);
      for (const job of jobs) {
        console.log(`ID: ${job.id}`);
        console.log(`Command: ${job.command}`);
        console.log(`State: ${job.state}`);
        console.log(`Attempts: ${job.attempts}/${job.max_retries}`);
        console.log(`Created: ${job.created_at}`);
        console.log(`Updated: ${job.updated_at}`);
        if (job.next_retry_at) {
          console.log(`Next Retry: ${job.next_retry_at}`);
        }
        if (job.completed_at) {
          console.log(`Completed: ${job.completed_at}`);
        }
        console.log();
      }
    } catch (error) {
      console.error(`Error listing jobs: ${error.message}`);
      process.exit(1);
    }
  });

// DLQ commands
const dlqCommand = new Command("dlq")
  .description("Manage Dead Letter Queue");

dlqCommand
  .command("list")
  .description("List all jobs in DLQ")
  .action(async () => {
    try {
      const dlqJobs = await jobService.getDLQJobs();

      if (dlqJobs.length === 0) {
        console.log("DLQ is empty");
        return;
      }

      console.log(`\n=== Dead Letter Queue (${dlqJobs.length} jobs) ===\n`);
      for (const job of dlqJobs) {
        console.log(`ID: ${job.id}`);
        console.log(`Command: ${job.command}`);
        console.log(`Attempts: ${job.attempts}/${job.max_retries}`);
        console.log(`Created: ${job.created_at}`);
        console.log(`Failed: ${job.failed_at}`);
        console.log();
      }
    } catch (error) {
      console.error(`Error listing DLQ: ${error.message}`);
      process.exit(1);
    }
  });

dlqCommand
  .command("retry")
  .description("Retry a job from DLQ")
  .argument("<jobId>", "Job ID to retry")
  .action(async (jobId) => {
    try {
      const newJobId = await jobService.retryDLQJob(jobId);
      console.log(`Job ${jobId} has been re-enqueued with new ID: ${newJobId}`);
    } catch (error) {
      console.error(`Error retrying DLQ job: ${error.message}`);
      process.exit(1);
    }
  });

program.addCommand(dlqCommand);

// Config commands
const configCommand = new Command("config")
  .description("Manage configuration");

configCommand
  .command("set")
  .description("Set a configuration value")
  .argument("<key>", "Configuration key")
  .argument("<value>", "Configuration value")
  .action(async (key, value) => {
    try {
      // Parse value
      let parsedValue = value;
      if (!isNaN(value) && value !== "") {
        parsedValue = Number(value);
      } else if (value === "true") {
        parsedValue = true;
      } else if (value === "false") {
        parsedValue = false;
      }

      await config.set(key, parsedValue);
      console.log(`Configuration ${key} set to ${parsedValue}`);
    } catch (error) {
      console.error(`Error setting config: ${error.message}`);
      process.exit(1);
    }
  });

configCommand
  .command("get")
  .description("Get a configuration value")
  .argument("<key>", "Configuration key")
  .action(async (key) => {
    try {
      const value = await config.get(key);
      if (value === null) {
        console.log(`Configuration ${key} not found`);
      } else {
        console.log(`${key} = ${value}`);
      }
    } catch (error) {
      console.error(`Error getting config: ${error.message}`);
      process.exit(1);
    }
  });

configCommand
  .command("list")
  .description("List all configuration values")
  .action(async () => {
    try {
      const allConfig = await config.getAll();
      console.log("\n=== Configuration ===\n");
      for (const [key, value] of Object.entries(allConfig)) {
        console.log(`${key} = ${value}`);
      }
      console.log();
    } catch (error) {
      console.error(`Error listing config: ${error.message}`);
      process.exit(1);
    }
  });

program.addCommand(configCommand);

// Parse command line arguments
program.parse(process.argv);

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

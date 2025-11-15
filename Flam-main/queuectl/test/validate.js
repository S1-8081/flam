#!/usr/bin/env node

/**
 * Validation script for QueueCTL
 * Tests core functionality: enqueue, workers, retries, DLQ
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const CLI_PATH = path.join(__dirname, "..", "cli.js");
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "queue.db");

// Colors for output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

function log(message, color = "reset") {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [CLI_PATH, ...command.split(" "), ...args], {
      cwd: path.join(__dirname, ".."),
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (error) => {
      reject(error);
    });
  });
}

async function cleanup() {
  log("\n=== Cleaning up ===", "blue");
  try {
    // Stop any running workers
    await runCommand("worker stop");
    await sleep(1000);

    // Remove database
    if (fs.existsSync(DB_PATH)) {
      fs.unlinkSync(DB_PATH);
    }

    // Remove worker PIDs file
    const pidsFile = path.join(DATA_DIR, "worker-pids.json");
    if (fs.existsSync(pidsFile)) {
      fs.unlinkSync(pidsFile);
    }

    log("Cleanup complete", "green");
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function test(name, testFn) {
  log(`\n=== Test: ${name} ===`, "blue");
  try {
    await testFn();
    log(`✅ Test passed: ${name}`, "green");
    return true;
  } catch (error) {
    log(`❌ Test failed: ${name}`, "red");
    log(`Error: ${error.message}`, "red");
    return false;
  }
}

async function main() {
  log("====================================", "blue");
  log("QueueCTL Validation Script", "blue");
  log("====================================", "blue");

  // Cleanup first
  await cleanup();
  await sleep(500);

  const results = [];

  // Test 1: Basic job enqueue
  results.push(
    await test("Enqueue a job", async () => {
      const result = await runCommand(
        'enqueue \'{"id":"test-job-1","command":"echo hello world"}\''
      );
      if (result.code !== 0) {
        throw new Error(`Command failed: ${result.stderr}`);
      }
      if (!result.stdout.includes("Job enqueued")) {
        throw new Error("Job not enqueued successfully");
      }
    })
  );

  await sleep(500);

  // Test 2: Check status
  results.push(
    await test("Check status", async () => {
      const result = await runCommand("status");
      if (result.code !== 0) {
        throw new Error(`Command failed: ${result.stderr}`);
      }
      if (!result.stdout.includes("Pending: 1")) {
        throw new Error("Status not showing pending job");
      }
    })
  );

  await sleep(500);

  // Test 3: List jobs
  results.push(
    await test("List jobs", async () => {
      const result = await runCommand("list --state pending");
      if (result.code !== 0) {
        throw new Error(`Command failed: ${result.stderr}`);
      }
      if (!result.stdout.includes("test-job-1")) {
        throw new Error("Job not found in list");
      }
    })
  );

  await sleep(500);

  // Test 4: Start worker and process job
  results.push(
    await test("Start worker and process job", async () => {
      // Start worker in background (simulated)
      const workerProc = spawn("node", [CLI_PATH, "worker", "start", "--count", "1"], {
        cwd: path.join(__dirname, ".."),
        stdio: "pipe",
      });

      // Wait for worker to process the job
      await sleep(3000);

      // Check status - job should be completed
      const statusResult = await runCommand("status");
      if (!statusResult.stdout.includes("Completed: 1")) {
        // Job might still be processing
        await sleep(2000);
        const statusResult2 = await runCommand("status");
        if (!statusResult2.stdout.includes("Completed: 1")) {
          throw new Error("Job not completed");
        }
      }

      // Stop worker
      workerProc.kill("SIGTERM");
      await sleep(1000);
      await runCommand("worker stop");
    })
  );

  await sleep(1000);

  // Test 5: Failed job retry
  results.push(
    await test("Failed job retry and DLQ", async () => {
      // Set max retries to 2 for faster testing
      await runCommand("config set max-retries 2");
      await runCommand("config set backoff-base 2");

      // Enqueue a failing job
      await runCommand(
        'enqueue \'{"id":"test-job-fail","command":"invalid-command-that-does-not-exist"}\''
      );

      // Start worker
      const workerProc = spawn("node", [CLI_PATH, "worker", "start", "--count", "1"], {
        cwd: path.join(__dirname, ".."),
        stdio: "pipe",
      });

      // Wait for retries and DLQ (with backoff: 2s, 4s = ~6s + processing time)
      await sleep(10000);

      // Check DLQ
      const dlqResult = await runCommand("dlq list");
      if (!dlqResult.stdout.includes("test-job-fail")) {
        // Might still be retrying
        await sleep(5000);
        const dlqResult2 = await runCommand("dlq list");
        if (!dlqResult2.stdout.includes("test-job-fail")) {
          throw new Error("Job not moved to DLQ");
        }
      }

      // Stop worker
      workerProc.kill("SIGTERM");
      await sleep(1000);
      await runCommand("worker stop");
    })
  );

  await sleep(1000);

  // Test 6: DLQ retry
  results.push(
    await test("DLQ retry", async () => {
      const result = await runCommand("dlq retry test-job-fail");
      if (result.code !== 0) {
        throw new Error(`Command failed: ${result.stderr}`);
      }
      if (!result.stdout.includes("re-enqueued")) {
        throw new Error("Job not re-enqueued from DLQ");
      }
    })
  );

  await sleep(500);

  // Test 7: Configuration
  results.push(
    await test("Configuration management", async () => {
      await runCommand("config set max-retries 5");
      const getResult = await runCommand("config get max-retries");
      if (!getResult.stdout.includes("5")) {
        throw new Error("Configuration not set correctly");
      }

      const listResult = await runCommand("config list");
      if (!listResult.stdout.includes("max-retries")) {
        throw new Error("Configuration list not working");
      }
    })
  );

  await sleep(500);

  // Test 8: Multiple workers
  results.push(
    await test("Multiple workers", async () => {
      // Enqueue multiple jobs
      await runCommand('enqueue \'{"command":"echo job1"}\'');
      await runCommand('enqueue \'{"command":"echo job2"}\'');
      await runCommand('enqueue \'{"command":"echo job3"}\'');

      // Start 3 workers
      const workerProc = spawn("node", [CLI_PATH, "worker", "start", "--count", "3"], {
        cwd: path.join(__dirname, ".."),
        stdio: "pipe",
      });

      // Wait for jobs to be processed
      await sleep(3000);

      // Check status
      const statusResult = await runCommand("status");
      const workerCount = (statusResult.stdout.match(/Worker/g) || []).length;
      if (workerCount < 3) {
        throw new Error(`Expected 3 workers, found ${workerCount}`);
      }

      // Stop workers
      workerProc.kill("SIGTERM");
      await sleep(1000);
      await runCommand("worker stop");
    })
  );

  // Summary
  log("\n====================================", "blue");
  log("Test Summary", "blue");
  log("====================================", "blue");

  const passed = results.filter((r) => r).length;
  const total = results.length;

  log(`Passed: ${passed}/${total}`, passed === total ? "green" : "yellow");

  if (passed === total) {
    log("\n✅ All tests passed!", "green");
    process.exit(0);
  } else {
    log("\n❌ Some tests failed", "red");
    process.exit(1);
  }
}

// Run tests
main().catch((error) => {
  log(`\nFatal error: ${error.message}`, "red");
  process.exit(1);
});


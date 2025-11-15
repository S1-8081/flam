const { spawn } = require("child_process");
const getDatabase = require("../db/database");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

class WorkerManager {
  constructor() {
    this.workerProcesses = [];
    this.workerPidsFile = path.join(__dirname, "..", "data", "worker-pids.json");
  }

  async startWorkers(count) {
    console.log(`Starting ${count} worker(s)...`);

    const workerScript = path.join(__dirname, "worker-process.js");
    const workers = [];

    // Ensure data directory exists
    const dataDir = path.dirname(this.workerPidsFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    for (let i = 0; i < count; i++) {
      const workerId = uuidv4();
      const workerProcess = spawn("node", [workerScript, workerId], {
        stdio: "inherit",
        detached: false,
      });

      workers.push({
        id: workerId,
        pid: workerProcess.pid,
        process: workerProcess,
      });

      workerProcess.on("error", (error) => {
        console.error(`Failed to start worker ${workerId}:`, error);
      });

      workerProcess.on("exit", (code) => {
        console.log(`Worker ${workerId} (PID: ${workerProcess.pid}) exited with code ${code}`);
      });
    }

    this.workerProcesses = workers;

    // Save worker PIDs to a file for stop command
    await this.saveWorkerPids();

    console.log(`Started ${count} worker(s)`);
    console.log("Workers are running. Press Ctrl+C to stop.");
  }

  async saveWorkerPids() {
    const pids = this.workerProcesses.map((w) => w.pid);
    fs.writeFileSync(this.workerPidsFile, JSON.stringify(pids, null, 2));
  }

  async stopWorkers() {
    const db = getDatabase();

    // Get all running workers from database
    const workers = await db.all(
      "SELECT id, pid FROM workers WHERE status = 'running'"
    );

    if (workers.length === 0) {
      console.log("No running workers found");
      return;
    }

    console.log(`Stopping ${workers.length} worker(s)...`);

    for (const worker of workers) {
      try {
        // Send SIGTERM for graceful shutdown
        process.kill(worker.pid, "SIGTERM");
        console.log(`Sent stop signal to worker ${worker.id} (PID: ${worker.pid})`);
      } catch (error) {
        // Process might not exist
        console.log(`Worker ${worker.id} (PID: ${worker.pid}) not found or already stopped`);
      }
    }

    // Clean up PIDs file
    if (fs.existsSync(this.workerPidsFile)) {
      fs.unlinkSync(this.workerPidsFile);
    }

    console.log("All workers stopped");
  }

  async getWorkerStatus() {
    const db = getDatabase();
    const workers = await db.all(
      "SELECT * FROM workers WHERE status = 'running' ORDER BY started_at"
    );
    return workers;
  }
}

module.exports = { WorkerManager };

# QueueCTL - CLI-based Background Job Queue System

A production-grade, CLI-based background job queue system with worker processes, exponential backoff retries, and Dead Letter Queue (DLQ) support.

## 📋 Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Testing](#testing)
- [Assumptions & Trade-offs](#assumptions--trade-offs)
- [Project Structure](#project-structure)

## ✨ Features

- ✅ **Job Queue Management**: Enqueue, list, and manage background jobs
- ✅ **Multiple Workers**: Run multiple worker processes in parallel
- ✅ **Automatic Retries**: Exponential backoff retry mechanism with configurable base
- ✅ **Dead Letter Queue**: Permanently failed jobs moved to DLQ
- ✅ **Persistent Storage**: SQLite database for job persistence across restarts
- ✅ **Job Locking**: Prevents duplicate job processing across workers
- ✅ **Graceful Shutdown**: Workers finish current jobs before shutting down
- ✅ **Configuration Management**: Configure retry count and backoff base
- ✅ **CLI Interface**: Clean, intuitive command-line interface

## 📦 Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

## 🚀 Installation

1. **Clone the repository** (or navigate to the project directory):
   ```bash
   cd queuectl
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Make the CLI executable** (on Unix/Linux/Mac):
   ```bash
   chmod +x cli.js
   ```

4. **Install globally** (optional):
   ```bash
   npm link
   ```

   This will make `queuectl` available globally in your terminal.

## 💻 Usage

### Enqueue a Job

Add a new job to the queue:

**On Unix/Linux/Mac (bash/zsh):**
```bash
queuectl enqueue '{"id":"job1","command":"echo hello world"}'
```

**On Windows (PowerShell):**
```powershell
queuectl enqueue '{\"id\":\"job1\",\"command\":\"echo hello world\"}'
```

Or with minimal JSON:

```bash
queuectl enqueue '{"command":"sleep 2"}'
```

The system will auto-generate an ID if not provided.

**Note**: On Windows PowerShell, you may need to escape quotes or use a JSON file. Alternatively, use Command Prompt (cmd.exe) or Git Bash for better compatibility.

### Start Workers

Start one or more workers:

```bash
queuectl worker start --count 3
```

This starts 3 worker processes that will poll for and process jobs.

### Stop Workers

Stop all running workers gracefully:

```bash
queuectl worker stop
```

Workers will finish their current jobs before shutting down.

### Check Status

View summary of job states and active workers:

```bash
queuectl status
```

Example output:
```
=== Job Queue Status ===

Total Jobs: 10
Pending: 2
Processing: 1
Completed: 5
Failed: 1
Dead: 1
DLQ: 1

=== Active Workers ===

Worker a1b2c3d4... (PID: 12345) - Started: 2025-11-04T10:30:00Z
Worker e5f6g7h8... (PID: 12346) - Started: 2025-11-04T10:30:01Z
```

### List Jobs

List all jobs or filter by state:

```bash
# List all jobs
queuectl list

# List jobs by state
queuectl list --state pending
queuectl list --state completed
queuectl list --state failed
```

### Dead Letter Queue (DLQ)

View jobs in DLQ:

```bash
queuectl dlq list
```

Retry a job from DLQ:

```bash
queuectl dlq retry job1
```

This creates a new job with the same command, resetting retry attempts.

### Configuration

Set configuration values:

```bash
# Set max retries
queuectl config set max-retries 5

# Set backoff base (for exponential backoff: delay = base ^ attempts)
queuectl config set backoff-base 3
```

Get configuration value:

```bash
queuectl config get max-retries
```

List all configuration:

```bash
queuectl config list
```

### Help

Get help for any command:

```bash
queuectl --help
queuectl enqueue --help
queuectl worker --help
queuectl config --help
```

## 🏗️ Architecture

### Job Lifecycle

Jobs go through the following states:

1. **pending**: Job is waiting to be picked up by a worker
2. **processing**: Job is currently being executed by a worker
3. **completed**: Job executed successfully
4. **failed**: Job failed but is retryable (will retry with exponential backoff)
5. **dead**: Job permanently failed and moved to DLQ

### System Components

#### 1. **Database Layer** (`db/database.js`)
- SQLite database for persistent storage
- Job locking mechanism to prevent duplicate processing
- Stale lock cleanup (locks older than 5 minutes are released)

#### 2. **Job Service** (`jobs/jobService.js`)
- Job CRUD operations
- Retry logic with exponential backoff
- DLQ management
- Job statistics

#### 3. **Worker System** (`workers/worker.js`, `workers/worker-process.js`)
- Multiple worker processes running in parallel
- Job polling and execution
- Graceful shutdown handling
- Process management

#### 4. **Configuration** (`config/config.js`)
- Persistent configuration storage
- Configurable retry count and backoff base
- Configuration caching

#### 5. **CLI Interface** (`cli.js`)
- Commander.js-based CLI
- All required commands implemented
- User-friendly error messages

### Data Persistence

- **Database**: SQLite (`data/queue.db`)
- **Jobs**: Stored in `jobs` table with all metadata
- **DLQ**: Separate `dlq` table for failed jobs
- **Config**: `config` table for configuration
- **Workers**: `workers` table tracks active worker processes

### Retry Mechanism

Failed jobs are retried with exponential backoff:

```
delay = base ^ attempts
```

Where:
- `base` is configurable (default: 2)
- `attempts` is the current attempt number (0-indexed, but retry uses attempts + 1)

Example with base=2:
- Attempt 1: 2^1 = 2 seconds
- Attempt 2: 2^2 = 4 seconds
- Attempt 3: 2^3 = 8 seconds

### Job Locking

To prevent duplicate processing:
- Jobs are locked when picked up by a worker
- Lock includes `worker_id` and `locked_at` timestamp
- Stale locks (older than 5 minutes) are automatically released
- Lock is released when job completes or fails

## ⚙️ Configuration

### Default Configuration

- `max-retries`: 3
- `backoff-base`: 2

### Configuration Options

- **max-retries**: Maximum number of retry attempts before moving to DLQ
- **backoff-base**: Base for exponential backoff calculation

## 🧪 Testing

### Manual Testing

1. **Basic job completion**:
   ```bash
   queuectl enqueue '{"command":"echo hello"}'
   queuectl worker start --count 1
   # Wait a moment, then check status
   queuectl status
   ```

2. **Failed job retry**:
   ```bash
   queuectl enqueue '{"command":"invalid-command-that-fails"}'
   queuectl config set max-retries 2
   queuectl worker start --count 1
   # Watch the retries happen
   ```

3. **Multiple workers**:
   ```bash
   queuectl enqueue '{"command":"sleep 2"}'
   queuectl enqueue '{"command":"sleep 2"}'
   queuectl enqueue '{"command":"sleep 2"}'
   queuectl worker start --count 3
   # Three jobs should be processed in parallel
   ```

4. **DLQ**:
   ```bash
   queuectl enqueue '{"command":"invalid-command"}'
   queuectl config set max-retries 1
   queuectl worker start --count 1
   # Wait for job to fail and move to DLQ
   queuectl dlq list
   queuectl dlq retry <job-id>
   ```

### Automated Test Script

Run the validation script:

```bash
npm test
```

Or directly:

```bash
node test/validate.js
```

This script tests:
- Job enqueueing
- Job completion
- Job failure and retry
- DLQ functionality
- Multiple workers
- Configuration management

## 📊 Assumptions & Trade-offs

### Assumptions

1. **Command Execution**: Commands are executed in the system shell (bash/sh on Unix, cmd.exe on Windows)
2. **Exit Codes**: Exit code 0 = success, non-zero = failure
3. **Job Locking**: Stale locks are cleaned up after 5 minutes (configurable in code)
4. **Worker Processes**: Each worker runs in a separate Node.js process
5. **Database**: SQLite is sufficient for this use case (can be swapped for PostgreSQL/MySQL if needed)

### Trade-offs

1. **SQLite vs Other Databases**: 
   - ✅ Simple, no external dependencies
   - ✅ Perfect for single-server deployments
   - ❌ Not ideal for distributed systems (multiple servers)
   - **Decision**: SQLite chosen for simplicity and ease of setup

2. **File-based Worker PIDs**:
   - ✅ Simple process management
   - ❌ Not ideal for distributed systems
   - **Decision**: File-based approach chosen for single-server deployments

3. **Polling vs Event-driven**:
   - ✅ Simple to implement
   - ✅ Works across all platforms
   - ❌ Less efficient than event-driven
   - **Decision**: Polling chosen for simplicity and reliability

4. **Exponential Backoff**:
   - ✅ Standard retry pattern
   - ✅ Prevents overwhelming the system
   - ❌ Can cause long delays for high attempt counts
   - **Decision**: Exponential backoff with configurable base

5. **Job Locking**:
   - ✅ Prevents duplicate processing
   - ✅ Simple database-level locking
   - ❌ Stale locks need cleanup
   - **Decision**: Database locking with automatic cleanup

### Limitations

1. **No Job Priority**: All jobs are processed in FIFO order
2. **No Job Timeout**: Jobs run until completion (can be added)
3. **No Job Scheduling**: No support for scheduled/delayed jobs (can be added)
4. **No Job Output Storage**: Command output is not stored (can be added)
5. **Single Server**: Not designed for distributed deployments (can be extended)

## 📁 Project Structure

```
queuectl/
├── cli.js                 # Main CLI entry point
├── package.json           # Dependencies and scripts
├── README.md             # This file
├── config/
│   └── config.js         # Configuration management
├── db/
│   └── database.js       # Database layer and locking
├── jobs/
│   └── jobService.js     # Job operations and retry logic
├── workers/
│   ├── worker.js         # Worker manager
│   └── worker-process.js # Individual worker process
├── data/                 # Data directory (created at runtime)
│   ├── queue.db          # SQLite database
│   └── worker-pids.json  # Worker process IDs
└── test/
    └── validate.js       # Test/validation script
```

## 🔧 Troubleshooting

### Workers not processing jobs

1. Check if workers are running: `queuectl status`
2. Check job states: `queuectl list`
3. Verify database is accessible: Check `data/queue.db` exists
4. Check for stale locks: Restart workers to clean up locks

### Jobs stuck in processing state

1. Check for stale locks (older than 5 minutes are auto-cleaned)
2. Restart workers: `queuectl worker stop` then `queuectl worker start`
3. Manually update job state in database if needed

### Database locked errors

1. Ensure only one instance of workers is running
2. Check for stale database connections
3. Restart the application

## 📝 License

ISC

## 🤝 Contributing

This is an internship assignment project. For questions or issues, please contact the project maintainer.

## 📚 Additional Resources

- [SQLite Documentation](https://www.sqlite.org/docs.html)
- [Commander.js Documentation](https://github.com/tj/commander.js)
- [Node.js Child Process](https://nodejs.org/api/child_process.html)

---

**Note**: This project is designed as a demonstration of a production-grade job queue system. For production use, consider adding:
- Job timeout handling
- Job priority queues
- Scheduled/delayed jobs
- Job output logging
- Metrics and monitoring
- Web dashboard for monitoring
- Distributed deployment support


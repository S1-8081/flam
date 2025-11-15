const getDatabase = require("../db/database");

class Config {
  constructor() {
    this.db = getDatabase();
    this.cache = {};
  }

  async get(key, defaultValue = null) {
    // Check cache first
    if (this.cache[key] !== undefined) {
      return this.cache[key];
    }

    const row = await this.db.get("SELECT value FROM config WHERE key = ?", [
      key,
    ]);

    if (row) {
      const value = this.parseValue(row.value);
      this.cache[key] = value;
      return value;
    }

    return defaultValue;
  }

  async set(key, value) {
    const stringValue = this.stringifyValue(value);
    const now = new Date().toISOString();

    await this.db.run(
      `INSERT INTO config (key, value, updated_at) 
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
      [key, stringValue, now, stringValue, now]
    );

    // Update cache
    this.cache[key] = value;
  }

  async getAll() {
    const rows = await this.db.all("SELECT key, value FROM config");
    const config = {};
    for (const row of rows) {
      config[row.key] = this.parseValue(row.value);
    }
    return config;
  }

  parseValue(value) {
    // Try to parse as number
    if (!isNaN(value) && value !== "") {
      const num = Number(value);
      if (!isNaN(num)) {
        return num;
      }
    }

    // Try to parse as boolean
    if (value === "true") return true;
    if (value === "false") return false;

    // Return as string
    return value;
  }

  stringifyValue(value) {
    if (typeof value === "boolean" || typeof value === "number") {
      return String(value);
    }
    return value;
  }

  clearCache() {
    this.cache = {};
  }
}

// Singleton instance
let configInstance = null;

function getConfig() {
  if (!configInstance) {
    configInstance = new Config();
  }
  return configInstance;
}

module.exports = getConfig;


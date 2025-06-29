const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
require("dotenv").config();

const config = require("../config");

/**
 * Initialize the SQLite database with the required schema
 */
function initializeDatabase() {
  try {
    const dbPath =
      config.SQLITE_DB_PATH || process.env.SQLITE_DB_PATH || "./db.sqlite";

    console.log(`🔧 Initializing database at: ${dbPath}`);

    // Create database connection
    const db = new Database(dbPath);

    // Read schema file
    const schemaPath = path.join(__dirname, "schema.sql");

    if (!fs.existsSync(schemaPath)) {
      console.error(`❌ Schema file not found at: ${schemaPath}`);
      console.log("Creating basic schema...");

      // Basic schema if schema.sql doesn't exist
      const basicSchema = `
                -- Files table to track discovered files
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_path TEXT UNIQUE NOT NULL,
                    content_hash TEXT,
                    last_modified INTEGER,
                    status TEXT DEFAULT 'discovered',
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
                );

                -- Points of Interest extracted from files
                CREATE TABLE IF NOT EXISTS pois (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id INTEGER,
                    poi_id TEXT UNIQUE NOT NULL,
                    type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    start_line INTEGER,
                    end_line INTEGER,
                    metadata TEXT, -- JSON string
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE CASCADE
                );

                -- Validated relationships with confidence scores
                CREATE TABLE IF NOT EXISTS relationships (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_poi_id TEXT NOT NULL,
                    to_poi_id TEXT NOT NULL,
                    relationship_type TEXT NOT NULL,
                    confidence_score REAL NOT NULL,
                    metadata TEXT, -- JSON string
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    UNIQUE(from_poi_id, to_poi_id, relationship_type)
                );

                -- Evidence for relationships before reconciliation
                CREATE TABLE IF NOT EXISTS relationship_evidence (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_poi_id TEXT NOT NULL,
                    to_poi_id TEXT NOT NULL,
                    relationship_type TEXT NOT NULL,
                    evidence_source TEXT NOT NULL, -- 'deterministic', 'intra_file', 'intra_directory', 'global'
                    confidence REAL NOT NULL,
                    metadata TEXT, -- JSON string
                    created_at INTEGER DEFAULT (strftime('%s', 'now'))
                );

                -- Directory summaries
                CREATE TABLE IF NOT EXISTS directory_summaries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    directory_path TEXT UNIQUE NOT NULL,
                    summary TEXT NOT NULL,
                    metadata TEXT, -- JSON string
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
                );

                -- Transactional outbox for reliable event publishing
                CREATE TABLE IF NOT EXISTS outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_type TEXT NOT NULL,
                    queue_name TEXT NOT NULL,
                    payload TEXT NOT NULL, -- JSON string
                    status TEXT DEFAULT 'pending', -- 'pending', 'published', 'failed'
                    created_at INTEGER DEFAULT (strftime('%s', 'now')),
                    processed_at INTEGER
                );

                -- Indexes for performance
                CREATE INDEX IF NOT EXISTS idx_files_path ON files(file_path);
                CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
                CREATE INDEX IF NOT EXISTS idx_pois_file_id ON pois(file_id);
                CREATE INDEX IF NOT EXISTS idx_pois_poi_id ON pois(poi_id);
                CREATE INDEX IF NOT EXISTS idx_pois_type ON pois(type);
                CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_poi_id);
                CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_poi_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_from_to ON relationship_evidence(from_poi_id, to_poi_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_source ON relationship_evidence(evidence_source);
                CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
                CREATE INDEX IF NOT EXISTS idx_outbox_queue ON outbox(queue_name);
            `;

      db.exec(basicSchema);
    } else {
      console.log(`📄 Reading schema from: ${schemaPath}`);
      const schema = fs.readFileSync(schemaPath, "utf8");
      db.exec(schema);
    }

    // Test the database
    const result = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all();
    const tableNames = result.map((row) => row.name);

    console.log("✅ Database initialized successfully!");
    console.log(`📊 Created tables: ${tableNames.join(", ")}`);

    // Close the database connection
    db.close();

    console.log("🎉 Database setup complete!");
  } catch (error) {
    console.error("❌ Failed to initialize database:", error.message);
    process.exit(1);
  }
}

// Run the initialization
initializeDatabase();

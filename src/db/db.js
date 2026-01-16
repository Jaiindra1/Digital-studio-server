const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath =
  process.env.SQLITE_DB || path.join(__dirname, 'data', 'studio.db');

// ensure data folder exists
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

// connect to sqlite
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Failed to connect SQLite:', err.message);
    process.exit(1);
  }
  console.log('SQLite connected at', dbPath);
});

// important pragmas
db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA journal_mode = WAL');
});

// load schema
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

db.exec(schema, (err) => {
  if (err) {
    console.error('Failed to initialize DB schema:', err.message);
    process.exit(1);
  }
  console.log('Database schema loaded');
});

// Add this wrapper to support async/await and the .query() syntax
db.query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    // Check if it's a SELECT or an UPDATE/INSERT
    const method = sql.trim().toUpperCase().startsWith('SELECT') ? 'all' : 'run';
    
    db[method](sql, params, function (err, rows) {
      if (err) return reject(err);
      
      // Return an object that mimics the PostgreSQL/Node-postgres result format
      // so your controller code (result.rows[0]) doesn't break
      resolve({
        rows: rows || [],
        lastID: this.lastID,
        changes: this.changes
      });
    });
  });
};

module.exports = db;

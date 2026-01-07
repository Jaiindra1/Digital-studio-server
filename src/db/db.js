const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = process.env.SQLITE_DB;

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
});

// load schema
const schemaPath = path.join(__dirname, 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

db.exec(schema, (err) => {
  if (err) {
    console.error('Failed to initialize DB schema:', err.message);
    process.exit(1);
  }
});

module.exports = db;

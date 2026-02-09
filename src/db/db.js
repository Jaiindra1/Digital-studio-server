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

  // Add paid_amount column to events if not exists
  db.run(`ALTER TABLE events ADD COLUMN paid_amount REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add paid_amount column:', err.message);
    } else {
      console.log('paid_amount column ensured');
    }
  });

  // Add total_amount column to events if not exists
  db.run(`ALTER TABLE events ADD COLUMN total_amount REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add total_amount column:', err.message);
    } else {
      console.log('total_amount column ensured');
      // Set default amount for existing events
      db.run(`UPDATE events SET total_amount = 1000 WHERE total_amount = 0 OR total_amount IS NULL`, (err) => {
        if (err) {
          console.error('Failed to set default total_amount:', err.message);
        } else {
          console.log('Default total_amount set for existing events');
        }
      });
    }
  });

  // Add amount column as alias for total_amount if not exists
  db.run(`ALTER TABLE events ADD COLUMN amount REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add amount column:', err.message);
    } else {
      console.log('amount column ensured');
      db.run(`UPDATE events SET amount = total_amount WHERE amount = 0 OR amount IS NULL`, (err) => {
        if (err) {
          console.error('Failed to sync amount:', err.message);
        }
      });
    }
  });

  // Add amount_status column if not exists
  db.run(`ALTER TABLE events ADD COLUMN amount_status INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add amount_status column:', err.message);
    } else {
      console.log('amount_status column ensured');
    }
  });

  // Add Stage column if not exists
  db.run(`ALTER TABLE events ADD COLUMN Stage TEXT DEFAULT 'ENQUIRY'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add Stage column:', err.message);
    } else {
      console.log('Stage column ensured');
    }
  });

  // Add venue column if not exists
  db.run(`ALTER TABLE events ADD COLUMN venue TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add venue column:', err.message);
    } else {
      console.log('venue column ensured');
    }
  });

  // Add guest_count column if not exists
  db.run(`ALTER TABLE events ADD COLUMN guest_count INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add guest_count column:', err.message);
    } else {
      console.log('guest_count column ensured');
    }
  });

  // Add enquiry_message column if not exists
  db.run(`ALTER TABLE events ADD COLUMN enquiry_message TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add enquiry_message column:', err.message);
    } else {
      console.log('enquiry_message column ensured');
    }
  });

  // Add source column if not exists
  db.run(`ALTER TABLE events ADD COLUMN source TEXT DEFAULT 'WEBSITE'`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add source column:', err.message);
    } else {
      console.log('source column ensured');
    }
  });

  // Add password_hash and is_account_active columns to clients if not exists
  db.run(`ALTER TABLE clients ADD COLUMN password_hash TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add password_hash column to clients:', err.message);
    } else {
      console.log('password_hash column to clients ensured');
    }
  });

  db.run(`ALTER TABLE clients ADD COLUMN is_account_active INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add is_account_active column to clients:', err.message);
    } else {
      console.log('is_account_active column to clients ensured');
    }
  });

  // Add advance column to events if not exists
  db.run(`ALTER TABLE events ADD COLUMN advance REAL DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Failed to add advance column:', err.message);
    } else {
      console.log('advance column ensured');
    }
  });
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

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

  // Seed default email templates if table exists and is empty
  db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='email_templates'`, (err, table) => {
    if (err) {
      console.error('Failed to check email_templates table:', err.message);
      return;
    }
    if (!table) return;

    db.get(`SELECT COUNT(*) AS count FROM email_templates`, (countErr, row) => {
      if (countErr) {
        console.error('Failed to count email_templates rows:', countErr.message);
        return;
      }
      if (row && row.count === 0) {
        const stmt = db.prepare(
          `INSERT INTO email_templates (template_key, name, subject, html_body, hero_image_url, enabled)
           VALUES (?, ?, ?, ?, ?, 1)`
        );

        stmt.run(
          'BOOKING_CONFIRMATION',
          'Booking Confirmation',
          'Your session is confirmed!',
          '<p>Hi {{clientName}},</p><p>Your {{eventType}} session on {{eventDate}} is confirmed.</p><p>You can set up your account using this link: <a href=\"{{link}}\">Access your session</a>.</p>',
          null
        );

        stmt.run(
          'PRE_SHOOT_REMINDER',
          'Pre-Shoot Reminder',
          'Getting ready for your shoot?',
          '<p>Hi {{clientName}},</p><p>This is a friendly reminder about your upcoming {{eventType}} session on {{eventDate}}.</p>',
          null
        );

        stmt.run(
          'GALLERY_READY',
          'Gallery Ready',
          'Your photos are here!',
          '<p>Hi {{clientName}},</p><p>Your gallery is now ready. You can view your photos using the link we sent earlier.</p>',
          null
        );

        stmt.finalize((finalizeErr) => {
          if (finalizeErr) {
            console.error('Failed to seed email_templates:', finalizeErr.message);
          } else {
            console.log('Default email_templates seeded');
          }
        });
      }
    });
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

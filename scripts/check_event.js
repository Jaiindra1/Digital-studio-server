const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/studio.sqlite', (err) => {
  if (err) { console.error('DB error:', err); process.exit(1); }
  db.get("SELECT id, Stage, event_type, client_id FROM events WHERE id = 1", [], (err, row) => {
    if (err) console.error('Query error:', err);
    console.log('Event:', JSON.stringify(row, null, 2));
    db.close();
    process.exit(0);
  });
});

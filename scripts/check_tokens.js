const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data/studio.sqlite', (err) => {
  if (err) { console.error('DB error:', err); process.exit(1); }
  db.all("SELECT client_id, token, expires_at, used FROM password_tokens ORDER BY created_at DESC LIMIT 3", [], (err, rows) => {
    if (err) console.error('Query error:', err);
    console.log(JSON.stringify(rows || [], null, 2));
    db.close();
    process.exit(0);
  });
});

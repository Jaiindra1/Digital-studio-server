const db = require('../src/db/db');

db.run("INSERT INTO clients (name, phone, email) VALUES (?, ?, ?)", ['Test Client', '9999999999', 'testclient@example.com'], function(err) {
  if (err) { console.error('client insert err', err); process.exit(1); }
  const clientId = this.lastID;
  db.run("INSERT INTO events (client_id, event_type, event_date, Stage) VALUES (?, ?, date('now'), 'ENQUIRY')", [clientId, 'WEDDING'], function(err) {
    if (err) { console.error('event insert err', err); process.exit(1); }
    console.log(JSON.stringify({ clientId, eventId: this.lastID }));
    process.exit(0);
  });
});

const db = require('../db/db');

// GET /api/clients
exports.getAll = (req, res) => {
  db.all(
    `SELECT * FROM clients ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
};

// POST /api/clients
exports.create = (req, res) => {
  const { name, phone, email, address, notes } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }

  const sql = `
    INSERT INTO clients (name, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(sql, [name, phone, email, address, notes], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    const clientId = this.lastID;
    const payload = JSON.stringify({ clientId, name, phone, email });

    db.run(`INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`, ['NEW_CLIENT', payload, null], function (nErr) {
      if (nErr) console.warn('Failed to persist new client notification:', nErr.message);

      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('newClient', JSON.parse(payload));
      }

      res.status(201).json({ id: clientId, name, phone, email });
    });
  });
};

// PUT /api/clients/:id
exports.update = (req, res) => {
  const { id } = req.params;
  const { name, phone, email, address, notes } = req.body;

  const sql = `
    UPDATE clients
    SET name = ?, phone = ?, email = ?, address = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(sql, [name, phone, email, address, notes, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: 'Client not found' });

    res.json({ message: 'Client updated' });
  });
};

const db = require('../db/db');

// GET /api/staff
exports.getAll = (req, res) => {
  db.all(`SELECT * FROM staff ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
};

// POST /api/staff
exports.create = (req, res) => {
  const { name, email, role, skills } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const sql = `
    INSERT INTO staff (name, email, role, skills)
    VALUES (?, ?, ?, ?)
  `;

  db.run(sql, [name, email, role, skills], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, name, email, role, skills });
  });
};

// PUT /api/staff/:id
exports.update = (req, res) => {
  const { id } = req.params;
  
  if (!req.body) {
    return res.status(400).json({ error: 'Request body missing' });
  }

  const { name, email, role, skills, status, reason } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  console.log('Updating staff with ID:', id, 'Data:', req.body);
  const sql = `
    UPDATE staff
    SET name = ?, email = ?, role = ?, skills = ? , updated_at = CURRENT_TIMESTAMP,
    status = ?, inactive_reason = ?
    WHERE id = ?
  `;

  db.run(sql, [name, email, role, skills, status, reason, id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({ message: 'Staff updated successfully' });
  });
};

// PATCH /api/staff/:id/status
exports.toggleStatus = (req, res) => {
  const { id } = req.params;

  if (!req.body) {
    return res.status(400).json({ error: 'Request body missing' });
  }

  const { active } = req.body;

  const sql = `UPDATE staff SET active = ? WHERE id = ?`;

  db.run(sql, [active ? 1 : 0, id], function (err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    res.json({ message: 'Status updated' });
  });
};

// PATCH /api/staff/:id/status
exports.changeStatus = (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'];

  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status. Allowed: ACTIVE, INACTIVE, ON_LEAVE'
    });
  }

  const sql = `UPDATE staff SET status = ? WHERE id = ?`;

  db.run(sql, [status, id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({
      message: 'Staff status updated',
      staffId: id,
      status
    });
  });
};

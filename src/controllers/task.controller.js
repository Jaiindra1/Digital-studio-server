const db = require('../config/db');

// POST /api/tasks
exports.createTask = (req, res) => {
  const { title, description, staff_id, due_date } = req.body;
  const { id: userId, role } = req.user;

  if (!title || !staff_id) {
    return res.status(400).json({ error: 'Title and staff_id are required' });
  }

  let created_by = null;
  let created_by_staff_id = null;

  if (role === 'Admin') {
    created_by = userId;
  } else if (role === 'Staff') {
    created_by_staff_id = userId;
  }

  const sql = `
    INSERT INTO tasks (title, description, staff_id, created_by, created_by_staff_id, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.run(sql, [title, description, staff_id, created_by, created_by_staff_id, due_date], function(err) {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ error: err.message });
    }
    res.status(201).json({ id: this.lastID, ...req.body });
  });
};

// GET /api/staff/:staffId/tasks
exports.getTasksByStaff = (req, res) => {
  const { staffId } = req.params;

  const sql = `SELECT * FROM tasks WHERE staff_id = ? ORDER BY created_at DESC`;

  db.all(sql, [staffId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
};

// PATCH /api/tasks/:id/status
exports.updateTaskStatus = (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status || !['PENDING', 'COMPLETED'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Allowed: PENDING, COMPLETED' });
  }

  const completed_at = status === 'COMPLETED' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;

  const sql = `UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?`;

  db.run(sql, [status, completed_at, id], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ message: 'Task status updated successfully' });
  });
};

// GET /api/staff/:staffId/tasks
exports.getTasksBycreatedStaff = (req, res) => {
  const { staffId } = req.params;

  const sql = `SELECT t.id as Task_id, t.title as title,
t.created_at as created_at, t.created_by_staff_id,
s.name as staff, t.due_date as due_date, t.status as status
 FROM tasks t JOIN staff s ON s.id = t.staff_id  WHERE created_by_staff_id = ? ORDER BY created_at DESC;`;

  db.all(sql, [staffId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
};
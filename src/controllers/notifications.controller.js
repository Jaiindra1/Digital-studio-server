const db = require('../db/db');

// GET /api/notifications
exports.list = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`, [limit], (err, rows) => (err ? reject(err) : resolve(rows)) );
    });

    // parse payload JSON
    const result = rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
    res.json(result);
  } catch (err) {
    console.error('Notifications list error:', err);
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/notifications/:id/read
exports.markRead = async (req, res) => {
  try {
    const { id } = req.params;
    await new Promise((resolve, reject) => db.run(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [id], (err) => (err ? reject(err) : resolve())));
    // Emit to admins room to sync badge
    const io = req.app.get('io');
    io.to('admins').emit('notificationRead');
    res.json({ message: 'Marked read' });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: err.message });
  }
};

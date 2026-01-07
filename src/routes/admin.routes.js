const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const db = require('../db/db');

const router = express.Router();

/**
 * GET /api/admin/me
 * Returns logged-in admin profile (DB-backed)
 */
router.get('/me', authenticate, (req, res) => {
  const adminId = req.user.sub;

  const sql = `
    SELECT id, email, role, created_at
    FROM users
    WHERE id = ? AND role = 'Admin'
  `;

  db.get(sql, [adminId], (err, admin) => {
    if (err) {
      console.error('DB error:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.json({
      id: admin.id,
      email: admin.email,
      role: admin.role,
      createdAt: admin.created_at
    });
  });
});

module.exports = router;

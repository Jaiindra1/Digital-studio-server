const express = require('express');
const router = express.Router();
const db = require('../db/db');

// controller inline (or import it)
router.get('/media', (req, res) => {
  const sql = `
    SELECT id, title, type, category, s3_url
    FROM media
    WHERE is_public = 1
    ORDER BY created_at DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

module.exports = router;

const db = require('../db/db');

exports.uploadMedia = (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'File required' });
  }

  const { title, type, category } = req.body;
  const s3_url = req.file.location;

  const sql = `
    INSERT INTO media (title, type, category, s3_url)
    VALUES (?, ?, ?, ?)
  `;

  db.run(sql, [title, type, category, s3_url], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    res.status(201).json({
      id: this.lastID,
      title,
      type,
      category,
      url: s3_url
    });
  });
};

exports.getMediaByAlbum = (req, res) => {
  const { albumId } = req.params;

  const sql = `SELECT * FROM gallery_media WHERE album_id = ?`;

  db.all(sql, [albumId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
};

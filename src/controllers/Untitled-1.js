require("dotenv").config();
const fs = require("fs");
const { PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const s3Client = require("../config/s3");
const db = require("../db/db");



/**
 * HELPER: Fetch Gallery Media with Signed URLs
 */
async function fetchMediaWithSignedUrls(galleryId = null) {
  const bucket = process.env.S3_BUCKET_NAME;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME is not configured in .env");
  }
  // Base Query
  let sql = `SELECT m.*, g.name as subcategory_name, g.category as main_category FROM gallery_media m JOIN gallery g ON m.gallery_id = g.id`;
  let params = [];
  if (galleryId) {
    sql += ` WHERE m.gallery_id = ?`;
    params.push(galleryId);
  }
  sql += ` ORDER BY m.created_at DESC`;

  // Fetch from DB
  const rows = await new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  // Generate Signed URLs for each row
  return await Promise.all(
    rows.map(async (row) => {
      let signedUrl = null;
      if (row.s3_url && bucket) {
        // In your new schema, s3_url is the S3 Key
        try {
          const cmd = new GetObjectCommand({
            Bucket: bucket,
            Key: row.s3_url,
          });
          signedUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 }); // 1 hour
        } catch (err) {
          console.error(`Error signing URL for ${row.s3_url}:`, err.message);
        }
      }
      return { ...row, display_url: signedUrl };
    })
  );
}

/**
 * UPLOAD MEDIA (Bulk)
 */
exports.uploadAndCreateMedia = async (req, res) => {
  try {
    const files = req.files;
    const { gallery_id, album_name } = req.body;
    const bucket = process.env.S3_BUCKET_NAME;

    if (!gallery_id || !album_name || !files || files.length === 0) {
      return res.status(400).json({ error: "Subcategory ID, Album Name, and Files are required" });
    }

    // --- 1. Create the Album in the 'albums' table ---
    // We link it to 'gallery_id' which corresponds to your existing gallery table
    const albumId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO albums (name, label_id) VALUES (?, ?)`,
        [album_name, gallery_id],
        function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    const uploadedImages = [];

    // --- 2. Process Files ---
    for (const file of files) {
      const fileBuffer = file.buffer ? file.buffer : fs.readFileSync(file.path);
      const key = `gallery/${gallery_id}/albums/${albumId}/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;

      // Upload to S3
      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: fileBuffer,
        ContentType: file.mimetype,
      }));

      // --- 3. Save to 'gallery_media' ---
      const mediaId = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO gallery_media (gallery_id, album_id, title, s3_url) VALUES (?, ?, ?, ?)`,
          [gallery_id, albumId, file.originalname, key],
          function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
          }
        );
      });

      uploadedImages.push({ id: mediaId, s3_key: key });
      if (file.path) fs.unlink(file.path, () => {});
    }

    res.status(201).json({ message: "Album created and images uploaded", albumId });
  } catch (err) {
    console.error("[Upload Error]", err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET MEDIA (With Signed URLs)
 */
exports.getAllMedia = async (req, res) => {
  try {
    const result = await fetchMediaWithSignedUrls();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};


/* ========================= GALLERY MEDIA (Photos) Table: gallery_media ========================= */

// Save media metadata after S3 upload
exports.createMedia = (req, res) => {
  const { gallery_id, title, s3_url } = req.body || {};
  if (!gallery_id || !s3_url) {
    return res.status(400).json({ error: 'gallery_id and s3_url are required' });
  }
  const sql = `INSERT INTO gallery_media (gallery_id, title, s3_url) VALUES (?, ?, ?)`;
  db.run(sql, [gallery_id, title || null, s3_url], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, gallery_id, title, s3_url });
  });
};

// Get media by a specific label (e.g., just "Muslim" weddings)
exports.getMediaByGalleryId = (req, res) => {
  const { galleryId } = req.params;
  const sql = `SELECT id, title, s3_url, created_at FROM gallery_media WHERE gallery_id = ? AND is_public = 1 ORDER BY created_at DESC`;
  db.all(sql, [galleryId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
};

// Delete a specific media item
exports.deleteMedia = (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM gallery_media WHERE id = ?`, [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Media not found' });
    res.json({ message: 'Media deleted successfully' });
  });
};

exports.getAlbums = async (req, res) => {
  try {
    // This joins albums with their labels to show Category names
    const albums = await new Promise((resolve, reject) => {
      db.all(
        `SELECT a.*, g.name as subcategory_name, g.category as main_category FROM albums a JOIN gallery g ON a.label_id = g.id ORDER BY a.created_at DESC`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });
    res.json(albums);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET LABELS BY CATEGORY
 */
exports.getLabelsByCategory = (req, res) => {
  const { category } = req.params;

  db.all(
    `SELECT id, name FROM gallery WHERE category = ? ORDER BY name`,
    [category],
    (err, rows) => {
      if (err) return res.status(500).json({ message: "Failed to fetch labels" });
      res.json(rows);
    }
  );
};

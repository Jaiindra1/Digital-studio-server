require("dotenv").config();
const fs = require("fs");
const db = require("../db/db");
const s3Client = require("../config/s3");
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const BUCKET = process.env.S3_BUCKET_NAME;

/* =====================================================
   INTERNAL: Fetch media with signed URLs
===================================================== */
async function fetchMediaWithSignedUrls({ galleryId = null, albumId = null } = {}) {
  if (!BUCKET) throw new Error("S3_BUCKET_NAME missing");

  let sql = `
    SELECT 
      m.*,
      g.name AS subcategory_name,
      g.category AS main_category
    FROM gallery_media m
    JOIN gallery g ON m.gallery_id = g.id
  `;

  const params = [];
  const conditions = [];

  if (galleryId) {
    conditions.push("m.gallery_id = ?");
    params.push(galleryId);
  }

  if (albumId) {
    conditions.push("m.album_id = ?");
    params.push(albumId);
  }

  if (conditions.length) {
    sql += ` WHERE ${conditions.join(" AND ")}`;
  }

  sql += ` ORDER BY m.created_at DESC`;

  const rows = await new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

  return Promise.all(
    rows.map(async row => {
      let signedUrl = null;
      try {
        if (row.s3_url) {
          const cmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: row.s3_url
          });
          signedUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
        }
      } catch (err) {
        console.error("Signed URL error:", err.message);
      }

      return {
        ...row,
        display_url: signedUrl
      };
    })
  );
}

/* =====================================================
   CREATE ALBUM (Album-first, UI uses this)
===================================================== */
exports.createAlbum = (req, res) => {
  const { name, label_id } = req.body;

  if (!name || !label_id) {
    return res.status(400).json({ message: "Album name and label_id required" });
  }

  db.run(
    `INSERT INTO albums (name, label_id) VALUES (?, ?)`,
    [name, label_id],
    function (err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Album creation failed" });
      }

      res.status(201).json({
        id: this.lastID,
        name,
        label_id
      });
    }
  );
};

/* =====================================================
   UPLOAD MEDIA TO EXISTING ALBUM (UI uses this)
===================================================== */
exports.uploadMediaToAlbum = async (req, res) => {
  try {
    const { gallery_id, album_id } = req.body;
    const files = req.files;

    if (!gallery_id || !album_id || !files?.length) {
      return res.status(400).json({ message: "Invalid upload payload" });
    }

    const uploaded = [];

    for (const file of files) {
      const buffer = file.buffer ?? fs.readFileSync(file.path);

      const key = `gallery/${gallery_id}/albums/${album_id}/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: buffer,
          ContentType: file.mimetype
        })
      );

      const mediaId = await new Promise((resolve, reject) => {
        db.run(
          `
          INSERT INTO gallery_media (gallery_id, album_id, title, s3_url)
          VALUES (?, ?, ?, ?)
        `,
          [gallery_id, album_id, file.originalname, key],
          function (err) {
            err ? reject(err) : resolve(this.lastID);
          }
        );
      });

      uploaded.push({ id: mediaId, key });

      if (file.path) fs.unlink(file.path, () => {});
    }

    res.status(201).json({
      message: "Media uploaded successfully",
      count: uploaded.length
    });
  } catch (err) {
    console.error("[UPLOAD ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   GET MEDIA (ADMIN / PUBLIC)
===================================================== */
exports.getAllMedia = async (req, res) => {
  try {
    const data = await fetchMediaWithSignedUrls();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getMediaByAlbum = async (req, res) => {
  try {
    const { albumId } = req.params;
    const data = await fetchMediaWithSignedUrls({ albumId });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/* =====================================================
   GET ALBUMS BY GALLERY (WITH COVER SIGNED URL)
===================================================== */
exports.getAlbumsByGallery = async (req, res) => {
  const { galleryId } = req.params;

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          a.id As ALbum_id,
          a.name As event_name,
          a.created_at,
          COUNT(m.id) AS media_count,
          (
            SELECT s3_url
            FROM gallery_media
            WHERE s3_url= a.cover_key 
            ORDER BY created_at ASC
            LIMIT 1
          ) AS cover_key
        FROM albums a
        LEFT JOIN gallery_media m ON m.album_id = a.id
        WHERE a.id = ?
        GROUP BY a.id
        ORDER BY a.created_at DESC
      `,
        [galleryId],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    const result = await Promise.all(
      rows.map(async row => {
        let coverUrl = null;
        if (row.cover_key) {
          const cmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: row.cover_key
          });
          coverUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
        }

        return {
          ...row,
          cover_image: coverUrl
        };
      })
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch albums" });
  }
};

exports.getRecentAlbums = async (req, res) => {
  try {
    const bucket = process.env.S3_BUCKET_NAME;

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          a.id,
          a.name,
          a.created_at,
          g.name AS label_name,
          g.category AS category,
          COUNT(m.id) AS media_count,
          (
            SELECT s3_url
            FROM gallery_media
            WHERE s3_url= a.cover_key 
            ORDER BY created_at ASC
            LIMIT 1
          ) AS cover_image
        FROM albums a
        JOIN gallery g ON g.id = a.label_id
        LEFT JOIN gallery_media m ON m.album_id = a.id
        GROUP BY a.id
        ORDER BY a.created_at DESC
        LIMIT 6
        `,
        [],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    // 🔥 SIGN COVER IMAGE URLs
    const signedAlbums = await Promise.all(
      rows.map(async (album) => {
        let signedCover = null;

        if (album.cover_image) {
          try {
            const command = new GetObjectCommand({
              Bucket: bucket,
              Key: album.cover_image,
            });

            signedCover = await getSignedUrl(s3Client, command, {
              expiresIn: 3600,
            });
          } catch (err) {
            console.error("Cover signing failed:", err.message);
          }
        }

        return {
          ...album,
          cover_image: signedCover, // ✅ overwrite with signed URL
        };
      })
    );

    res.json(signedAlbums);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

/* update Album */


exports.updateAlbumFull = async (req, res) => {
  try {
    const { 
      album_id, 
      album_name, 
      gallery_id, 
      cover_key, // We now expect the actual S3 string
      deleted_media_ids 
    } = req.body;
    
    const newFiles = req.files || [];
    const BUCKET = process.env.S3_BUCKET_NAME;

    // 1. Update Album basic info
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE albums SET name = ?, label_id = ? WHERE id = ?`,
        [album_name, gallery_id, album_id],
        (err) => (err ? reject(err) : resolve())
      );
    });

    // 2. Handle Deletions
    if (deleted_media_ids) {
      const idsToDelete = JSON.parse(deleted_media_ids);
      for (const id of idsToDelete) {
        const row = await new Promise((res) => 
          db.get(`SELECT s3_url FROM gallery_media WHERE id = ?`, [id], (err, r) => res(r))
        );
        
        if (row?.s3_url) {
          try {
            await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: row.s3_url }));
          } catch (e) { console.error("S3 Delete Warning:", e.message); }
          
          await new Promise((res) => db.run(`DELETE FROM gallery_media WHERE id = ?`, [id], res));
        }
      }
    }

    // 3. Upload New Files
    let lastUploadedKey = null;
    for (const file of newFiles) {
      const key = `gallery/${gallery_id}/albums/${album_id}/${Date.now()}-${file.originalname.replace(/\s+/g, "_")}`;
      
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype
      }));

      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO gallery_media (gallery_id, album_id, title, s3_url) VALUES (?, ?, ?, ?)`,
          [gallery_id, album_id, file.originalname, key],
          (err) => (err ? reject(err) : resolve())
        );
      });
      lastUploadedKey = key; 
    }

    // 4. Sync Cover Key
    // If user selected an existing image as cover, use cover_key.
    // If they uploaded NEW images and didn't pick an old one, use the last uploaded.
    // Otherwise, fallback to the first available image in the DB.
    let finalCoverKey = cover_key;

    if (!finalCoverKey || finalCoverKey === "undefined") {
      const fallback = await new Promise((resolve) => {
        db.get(`SELECT s3_url FROM gallery_media WHERE album_id = ? ORDER BY id DESC LIMIT 1`, [album_id], (err, row) => resolve(row));
      });
      finalCoverKey = fallback?.s3_url;
    }

    if (finalCoverKey) {
      await new Promise((res) => 
        db.run(`UPDATE albums SET cover_key = ? WHERE id = ?`, [finalCoverKey, album_id], res)
      );
    }

    res.json({ message: "Album updated successfully", cover_updated_to: finalCoverKey });
  } catch (err) {
    console.error("Update Error:", err);
    res.status(500).json({ error: err.message });
  }
};
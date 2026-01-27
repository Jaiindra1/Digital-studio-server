require("dotenv").config();
const db = require("../db/db");
const s3Client = require("../config/s3");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
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

exports.getMediaByAlbum = async (req, res) => {
  const { albumId } = req.params;
  if (!BUCKET) {
    return res.status(500).json({ error: "S3_BUCKET_NAME missing" });
  }
  try {
    const sql = `
      SELECT 
      m.*
      FROM gallery_media m 
      WHERE m.album_id = ?
      ORDER BY m.created_at DESC
    `;

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, [albumId], (err, rows) => (err ? reject(err) : resolve(rows)));
    });

    if (!rows || rows.length === 0) {
      return res.status(404).json({ message: "No media found for this album" });
    }
    
    const data = await Promise.all(
      rows.map(async (row) => {
        let signedUrl = null;
        if (row.s3_url) {
          try {
            const cmd = new GetObjectCommand({
              Bucket: BUCKET,
              Key: row.s3_url,
            });
            signedUrl = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
          } catch (err) {
            console.error("Signing error:", err.message);
          }
        }
        return { ...row, display_url: signedUrl };
      })
    );
    
    res.json(data);
  } catch (err) {
    console.error(err);
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

exports.getAlbumsByCategory = async (req, res) => {
  const { category } = req.params;
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT * FROM albums 
        WHERE label_id IN (
        SELECT id 
        FROM gallery 
        WHERE category = ?
        )
        `,
        [category],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    // Sign the cover image for each album folder
    const albumsWithCovers = await Promise.all(
      rows.map(async (album) => {
        let signedCover = null;
        if (album.cover_key) {
          const cmd = new GetObjectCommand({
            Bucket: BUCKET,
            Key: album.cover_key,
          });
          signedCover = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });
        }
        return { ...album, cover_url: signedCover };
      })
    );

    res.json(albumsWithCovers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
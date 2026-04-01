require("dotenv").config();
const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const multer = require("multer");
const UAParser = require('ua-parser-js');
const geoip = require('geoip-lite');
const authenticate = require("../middleware/auth.middleware");
const db = require("../config/db");

const s3Client = require("../config/s3");
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const router = express.Router();
const BUCKET = process.env.S3_BUCKET_NAME;

const hasColumn = async (tableName, columnName) => {
  const result = await db.query(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return Boolean(result.rows?.length);
};

/* -------------------- MULTER -------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/* -------------------- HELPERS -------------------- */
function generateAvatarKey(adminId, filename) {
  const ext = filename.split(".").pop();
  return `avatars/admin-${adminId}-${crypto.randomUUID()}.${ext}`;
}

/* ==================== PROFILE ==================== */

/**
 * GET /api/admin/me
 */
router.get("/me", authenticate, (req, res) => {
  db.get(
    `SELECT id, email, role, full_name, phone, avatar_url, created_at, updated_at
     FROM users`,
    
    async (err, row) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!row) return res.status(404).json({ error: "Admin not found" });
      let avatarSignedUrl = null;

      if (row.avatar_url) {
        avatarSignedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: row.avatar_url,
          }),
          { expiresIn: 3600 }
        );
      }

      res.json({
        id: row.id,
        email: row.email,
        role: row.role,
        fullName: row.full_name || "",
        phone: row.phone || "",
        avatarUrl: avatarSignedUrl,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  );
});

/**
 * PUT /api/admin/me
 */
router.put("/me", authenticate, (req, res) => {
  const adminId = req.user.id || req.user.sub;
  const { fullName, phone } = req.body;

  db.run(
    `UPDATE users
     SET full_name = ?, phone = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND role = 'Admin'`,
    [fullName, phone, adminId],
    err => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json({ success: true });
    }
  );
});

/* ==================== AVATAR (S3 CRUD) ==================== */

/**
 * POST /api/admin/avatar
 * Upload / Update avatar
 */
router.post(
  "/avatar",
  authenticate,
  upload.single("avatar"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    const adminId = req.user.id || req.user.sub;
    db.get(
      `SELECT avatar_url FROM users WHERE id = ?`,
      [adminId],
      async (err, row) => {
        if (err) return res.status(500).json({ error: "Database error" });

        // delete old avatar
        if (row?.avatar_url) {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: BUCKET,
              Key: row.avatar_url,
            })
          );
        }

        const key = generateAvatarKey(adminId, req.file.originalname);

        await s3Client.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
          })
        );

        db.run(
          `UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [key, adminId],
          () => res.json({ success: true })
        );
      }
    );
  }
);

/**
 * DELETE /api/admin/avatar
 */
router.delete("/avatar", authenticate, (req, res) => {
  const adminId = req.user.id || req.user.sub;

  db.get(
    `SELECT avatar_url FROM users WHERE id = ?`,
    [adminId],
    async (err, row) => {
      if (!row?.avatar_url) return res.json({ success: true });

      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: row.avatar_url,
        })
      );

      db.run(
        `UPDATE users SET avatar_url = NULL WHERE id = ?`,
        [adminId],
        () => res.json({ success: true })
      );
    }
  );
});

/* ==================== SECURITY ==================== */

/**
 * PUT /api/admin/change-password
 */
router.put("/change-password", authenticate, (req, res) => {
  const adminId = req.user.id || req.user.sub;
  const { currentPassword, newPassword } = req.body;

  db.get(
    `SELECT password FROM users WHERE id = ? AND role = 'Admin'`,
    [adminId],
    async (err, row) => {
      if (!row) return res.status(404).json({ error: "Admin not found" });

      const valid = await bcrypt.compare(currentPassword, row.password);
      if (!valid) {
        return res.status(400).json({ error: "Current password incorrect" });
      }

      const hash = await bcrypt.hash(newPassword, 12);

      db.run(
        `UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [hash, adminId],
        () => res.json({ success: true })
      );
    }
  );
});

/* ==================== SESSIONS ==================== */

router.get('/sessions', authenticate, async (req, res) => {
  try {
    const adminId = req.user.id || req.user.sub;
    const hasCreatedAt = await hasColumn('user_sessions', 'created_at');
    const createdAtSelect = hasCreatedAt ? 'created_at,' : 'NULL AS created_at,';

    db.all(
      `SELECT id, device_name, ip_address, user_agent, ${createdAtSelect} last_active, is_current
       FROM user_sessions
       WHERE user_id = ?
       ORDER BY last_active DESC`,
      [adminId],
      (err, rows) => {
        if (err) return res.status(500).json({ error: 'Database error' });

        const sessions = rows.map((s) => {
          // Parse browser & OS
          const parser = new UAParser(s.user_agent);
          const ua = parser.getResult();

          const browser = ua.browser.name || 'Unknown Browser';
          const os = ua.os.name || 'Unknown OS';

          // Geo lookup
          const ip =
            s.ip_address === '::1' || s.ip_address === '127.0.0.1'
              ? null
              : s.ip_address;

          const geo = ip ? geoip.lookup(ip) : null;

          const location = geo
            ? `${geo.city || 'Unknown City'}, ${geo.country}`
            : 'Localhost';

          return {
            id: s.id,
            isCurrent: s.is_current === 1,
            deviceLabel: `${browser} on ${os}`,
            ipAddress: s.ip_address,
            location,
            loginTime: s.created_at,
            lastActive: s.last_active,
          };
        });

        res.json(sessions);
      }
    );
  } catch (err) {
    console.error('Failed to load sessions:', err.message || err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

router.delete("/sessions/others", authenticate, (req, res) => {
  const adminId = req.user.id || req.user.sub;
  const currentSessionId = req.sessionId || 0;

  db.run(
    `DELETE FROM user_sessions
     WHERE user_id = ? AND id <> ?`,
    [adminId, currentSessionId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true, removed: this.changes || 0 });
    }
  );
});

router.delete("/sessions/:id", authenticate, (req, res) => {
  const adminId = req.user.id || req.user.sub;
  const currentSessionId = String(req.sessionId || '');
  const targetSessionId = String(req.params.id || '');

  if (currentSessionId && currentSessionId === targetSessionId) {
    return res.status(400).json({ error: 'Cannot revoke current session from this endpoint' });
  }

  db.run(
    `DELETE FROM user_sessions WHERE id = ? AND user_id = ?`,
    [req.params.id, adminId],
    () => res.json({ success: true })
  );
});


/**
 * PUT /api/admin/me
 * Update admin profile details (name, phone)
 */
router.put('/me', authenticate, (req, res) => {
  const adminId = req.user.id || req.user.sub;
  const { fullName, phone } = req.body;

  // basic validation
  if (!fullName) {
    return res.status(400).json({ error: 'Full name is required' });
  }

  const sql = `
    UPDATE users
    SET
      full_name = ?,
      phone = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND role = 'Admin'
  `;

  db.run(sql, [fullName, phone, adminId], function (err) {
    if (err) {
      console.error('DB error:', err.message);
      return res.status(500).json({ error: 'Database error' });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    res.json({ success: true });
  });
});


module.exports = router;

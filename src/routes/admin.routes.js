require("dotenv").config();
const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const multer = require("multer");
const UAParser = require('ua-parser-js');
const geoip = require('geoip-lite');
const authenticate = require("../middleware/auth.middleware");
const db = require("../config/db");
const { sendMail } = require("../utils/mail");

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

async function ensureUsernameColumn() {
  try {
    const exists = await hasColumn("users", "username");
    if (exists) return;

    await db.query(`ALTER TABLE users ADD COLUMN username VARCHAR(120) NULL`);
    await db.query(
      `UPDATE users
       SET username = COALESCE(NULLIF(TRIM(full_name), ''), SUBSTRING_INDEX(email, '@', 1))
       WHERE username IS NULL OR TRIM(username) = ''`
    );
  } catch (err) {
    console.error("Failed to ensure users.username column:", err.message || err);
    throw err;
  }
}

/* ==================== PROFILE ==================== */

/**
 * GET /api/admin/me
 */
router.get("/me", authenticate, async (req, res) => {
  const adminId = req.user.id || req.user.sub;
  try {
    await ensureUsernameColumn();
  } catch (e) {
    return res.status(500).json({ error: "Database migration error" });
  }

  db.get(
    `SELECT id, email, role, full_name, username, phone, avatar_url, created_at, updated_at
     FROM users
     WHERE id = ? AND role = 'Admin'`,
    [adminId],
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
        username: row.username || "",
        phone: row.phone || "",
        avatarUrl: avatarSignedUrl,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
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
  const { fullName, phone, username } = req.body;
  const normalizedUsername = String(username || "").trim();

  // basic validation
  if (!fullName) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  if (!normalizedUsername) {
    return res.status(400).json({ error: 'Username is required' });
  }

  ensureUsernameColumn()
    .then(() => {
      db.get(
        `SELECT email, username FROM users WHERE id = ? AND role = 'Admin'`,
        [adminId],
        (fetchErr, existing) => {
          if (fetchErr) {
            console.error('DB error:', fetchErr.message);
            return res.status(500).json({ error: 'Database error' });
          }
          if (!existing) {
            return res.status(404).json({ error: 'Admin not found' });
          }

          const sql = `
            UPDATE users
            SET
              full_name = ?,
              username = ?,
              phone = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND role = 'Admin'
          `;

          db.run(sql, [fullName, normalizedUsername, phone, adminId], async function (err) {
            if (err) {
              console.error('DB error:', err.message);
              return res.status(500).json({ error: 'Database error' });
            }

            if (this.changes === 0) {
              return res.status(404).json({ error: 'Admin not found' });
            }

            const changed = String(existing.username || '') !== normalizedUsername;
            if (changed && existing.email) {
              try {
                await sendMail({
                  to: existing.email,
                  subject: 'Admin Username Updated',
                  html: `
                    <p>Hello ${fullName || 'Admin'},</p>
                    <p>Your admin username was updated.</p>
                    <ul>
                      <li><strong>Previous username:</strong> ${existing.username || '(not set)'}</li>
                      <li><strong>New username:</strong> ${normalizedUsername}</li>
                      <li><strong>Updated at:</strong> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</li>
                    </ul>
                    <p>If this was not you, please change your password immediately.</p>
                  `,
                });
              } catch (mailErr) {
                console.warn('Username update email failed:', mailErr.message || mailErr);
              }
            }

            res.json({ success: true, usernameUpdated: changed });
          });
        }
      );
    })
    .catch((e) => {
      console.error('Failed to ensure username column:', e.message || e);
      return res.status(500).json({ error: 'Database error' });
    });
});


module.exports = router;

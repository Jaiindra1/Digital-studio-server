const db = require('../config/db');
const { compare } = require('../utils/password');
const { signToken } = require('../utils/jwt');

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

exports.login = async (req, res) => {
  const { email, password } = req.body;

  db.get(
    `SELECT id, email, password, role FROM users WHERE email = ? AND role = 'Admin'`,
    [email],
    async (err, user) => {
      if (err) {
        return res.status(500).json({ message: 'Database error' });
      }

      if (!user) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      let valid = false;
      try {
        valid = user?.password ? await compare(password, user.password) : false;
      } catch (cmpErr) {
        console.error('Password compare error:', cmpErr);
        return res.status(500).json({ message: 'Login processing error' });
      }
      if (!valid) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      /* ================= SESSION INSERT ================= */

      const deviceName = req.headers['x-device-name'] || 'Unknown Device';
      const userAgent = req.headers['user-agent'];
      const ipAddress =
        req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

      // mark old sessions as not current
      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE user_sessions SET is_current = 0 WHERE user_id = ?`,
          [user.id],
          function(err) {
            if (err) {
              console.error("Error updating old sessions:", err);
              reject(err);
            }
            else resolve();
          }
        );
      });

      // check if a session already exists for this exact device fingerprint
      const existing = await new Promise((resolve, reject) => {
        db.get(
          `SELECT id FROM user_sessions
           WHERE user_id = ? AND device_name = ? AND user_agent = ? AND ip_address = ?`,
          [user.id, deviceName, userAgent, ipAddress],
          (err, row) => {
            if (err) {
              console.error("Error checking existing session:", err);
              reject(err);
            } else {
              resolve(row);
            }
          }
        );
      });

      const hasCreatedAt = await hasColumn('user_sessions', 'created_at');

      if (existing) {
        const updateExistingSql = hasCreatedAt
          ? `UPDATE user_sessions
             SET is_current = 1, last_active = UTC_TIMESTAMP(), created_at = UTC_TIMESTAMP()
             WHERE id = ?`
          : `UPDATE user_sessions
             SET is_current = 1, last_active = UTC_TIMESTAMP()
             WHERE id = ?`;
        await new Promise((resolve, reject) => {
          db.run(
            updateExistingSql,
            [existing.id],
            function(err) {
              if (err) {
                console.error("Error updating existing session:", err);
                reject(err);
              }
              else resolve();
            }
          );
        });
      } else {
        const insertSessionSql = hasCreatedAt
          ? `INSERT INTO user_sessions
             (user_id, device_name, ip_address, user_agent, is_current, last_active, created_at)
             VALUES (?, ?, ?, ?, 1, UTC_TIMESTAMP(), UTC_TIMESTAMP())`
          : `INSERT INTO user_sessions
             (user_id, device_name, ip_address, user_agent, is_current, last_active)
             VALUES (?, ?, ?, ?, 1, UTC_TIMESTAMP())`;
        // insert new session only when not already present
        await new Promise((resolve, reject) => {
          db.run(
            insertSessionSql,
            [user.id, deviceName, ipAddress, userAgent],
            function(err) {
              if (err) {
                console.error("Error inserting new session:", err);
                reject(err);
              }
              else resolve();
            }
          );
        });
      }

      /* ================= JWT ================= */

      const token = signToken(
        { sub: user.id, role: user.role }
      );

      res.json({ token });
    }
  );
};

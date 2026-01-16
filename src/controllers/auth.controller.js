const db = require('../db/db');
const { compare } = require('../utils/password');
const { signToken } = require('../utils/jwt');

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

      const valid = await compare(password, user.password);
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

      // insert new session
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO user_sessions
           (user_id, device_name, ip_address, user_agent, is_current)
           VALUES (?, ?, ?, ?, 1)`,
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

      /* ================= JWT ================= */

      const token = signToken(
        { sub: user.id, role: user.role }
      );

      res.json({ token });
    }
  );
};

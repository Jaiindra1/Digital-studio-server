const jwt = require('jsonwebtoken');
const db = require('../config/db');

module.exports = function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Admin-only access
    if (decoded.role !== 'Admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Normalize user object - handle both old (id) and new (sub) formats
    const userId = decoded.id || decoded.sub;
    const deviceName = req.headers['x-device-name'] || 'Unknown Device';
    const userAgent = req.headers['user-agent'] || 'Unknown Agent';
    const ipAddress =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';

    const continueWithUser = (email) => {
      req.user = {
        id: userId,
        email: email || null,
        role: decoded.role
      };

      // Validate current request belongs to an existing login-history session.
      db.get(
        `SELECT id
         FROM user_sessions
         WHERE user_id = ? AND device_name = ? AND user_agent = ? AND ip_address = ?`,
        [userId, deviceName, userAgent, ipAddress],
        (sessionErr, sessionRow) => {
          if (sessionErr) {
            console.error('Error validating session:', sessionErr);
            return res.status(500).json({ error: 'Session validation failed' });
          }

          if (!sessionRow) {
            return res.status(401).json({ error: 'Session not found or revoked. Please log in again.' });
          }

          req.sessionId = sessionRow.id;

          db.run(
            `UPDATE user_sessions
             SET is_current = 1, last_active = UTC_TIMESTAMP()
             WHERE id = ?`,
            [sessionRow.id],
            (updateErr) => {
              if (updateErr) {
                console.error('Error updating last_active:', updateErr);
                return res.status(500).json({ error: 'Session update failed' });
              }
              next();
            }
          );
        }
      );
    };
    
    // If email is in token, use it; otherwise fetch from database
    if (decoded.email) {
      continueWithUser(decoded.email);
    } else {
      // Fetch email from database
      db.get(`SELECT email FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) {
          console.error('Error fetching user email:', err);
          continueWithUser(null);
        } else if (user) {
          continueWithUser(user.email);
        } else {
          continueWithUser(null);
        }
      });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};



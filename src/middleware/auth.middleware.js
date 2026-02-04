const jwt = require('jsonwebtoken');
const db = require('../db/db');

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
    
    // If email is in token, use it; otherwise fetch from database
    if (decoded.email) {
      req.user = {
        id: userId,
        email: decoded.email,
        role: decoded.role
      };
      next();
    } else {
      // Fetch email from database
      db.get(`SELECT email FROM users WHERE id = ?`, [userId], (err, user) => {
        if (err) {
          console.error('Error fetching user email:', err);
          req.user = { id: userId, email: null, role: decoded.role };
        } else if (user) {
          req.user = { id: userId, email: user.email, role: decoded.role };
        } else {
          req.user = { id: userId, email: null, role: decoded.role };
        }
        next();
      });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};



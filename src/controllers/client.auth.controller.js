const db = require('../db/db');
const { signToken } = require('../utils/jwt');
const { hash, compare } = require('../utils/password');
const crypto = require('crypto');

/* =========================
   FORGOT PASSWORD
========================= */
exports.forgotPassword = (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const sql = `
    SELECT id FROM clients
    WHERE email = ? AND is_account_active = 1
  `;

  db.get(sql, [email], (err, client) => {
    if (err) {
      console.error('Forgot password error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    // Do not reveal whether email exists
    if (!client) {
      return res.json({
        message: 'If an account with this email exists, a reset link has been sent.'
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    db.run(
      `INSERT INTO password_tokens (client_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [client.id, token, expiresAt],
      (err) => {
        if (err) {
          console.error('Token insert error:', err);
          return res.status(500).json({ message: 'Internal server error' });
        }

        // TODO: send email
        console.log(`Reset password link: /reset-password?token=${token}`);

        res.json({
          message: 'If an account with this email exists, a reset link has been sent.'
        });
      }
    );
  });
};

/* =========================
   CREATE PASSWORD (FIRST TIME)
========================= */
exports.createPassword = async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ message: 'Token and password are required' });
  }

  const sql = `
    SELECT * FROM password_tokens
    WHERE token = ? AND used = 0
  `;

  db.get(sql, [token], async (err, tokenRow) => {
    if (err) {
      console.error('Create password error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    if (!tokenRow) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    if (new Date() > new Date(tokenRow.expires_at)) {
      return res.status(400).json({ message: 'Token has expired' });
    }

    const passwordHash = await hash(password);

    db.run(
      `UPDATE clients
       SET password_hash = ?, is_account_active = 1
       WHERE id = ?`,
      [passwordHash, tokenRow.client_id],
      (err) => {
        if (err) return res.status(500).json({ message: 'Internal server error' });

        db.run(
          `UPDATE password_tokens SET used = 1 WHERE id = ?`,
          [tokenRow.id]
        );

        res.json({
          message: 'Password created successfully. You can now log in.'
        });
      }
    );
  });
};

/* =========================
   RESET PASSWORD
========================= */
exports.resetPassword = async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ message: 'Token and password are required' });
  }

  const sql = `
    SELECT * FROM password_tokens
    WHERE token = ? AND used = 0
  `;

  db.get(sql, [token], async (err, tokenRow) => {
    if (err) {
      console.error('Reset password error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    if (!tokenRow) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    if (new Date() > new Date(tokenRow.expires_at)) {
      return res.status(400).json({ message: 'Token has expired' });
    }

    const passwordHash = await hash(password);

    db.run(
      `UPDATE clients SET password_hash = ? WHERE id = ?`,
      [passwordHash, tokenRow.client_id],
      (err) => {
        if (err) return res.status(500).json({ message: 'Internal server error' });

        db.run(
          `UPDATE password_tokens SET used = 1 WHERE id = ?`,
          [tokenRow.id]
        );

        res.json({
          message: 'Password reset successfully. You can now log in.'
        });
      }
    );
  });
};

/* =========================
   CLIENT LOGIN
========================= */
exports.clientLogin = (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const sql = `
    SELECT id, email, password_hash, is_account_active
    FROM clients
    WHERE email = ?
  `;

  db.get(sql, [email], async (err, client) => {
    if (err) {
      console.error('Client login error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    if (!client || !client.password_hash) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!client.is_account_active) {
      return res.status(403).json({
        message: 'Account not active. Please set your password first.'
      });
    }

    const isValid = await compare(password, client.password_hash);
    if (!isValid) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = signToken({ sub: client.id, role: 'client' });

    res.json({ token });
  });
};

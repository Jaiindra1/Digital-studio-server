const db = require('../db/db');
const { signToken } = require('../utils/jwt');
const { hash, compare } = require('../utils/password');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

// Email transporter using Gmail (or other SMTP) from env
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587,
  secure: process.env.EMAIL_PORT === '465',
  auth: process.env.EMAIL_USER ? {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  } : undefined
});

// Helper to send mail; falls back to console logging when EMAIL not configured (dev mode)
function sendMailWithFallback(mailOptions, cb) {
  const usingRealEmail = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER);
  if (usingRealEmail) {
    return transporter.sendMail(mailOptions, cb);
  }

  // In dev/test, just log the email details and return success
  console.log('Dev mode: Simulated email send to', mailOptions.to);
  console.log('Subject:', mailOptions.subject);
  const linkMatch = mailOptions.html.match(/href="([^"]+)"/);
  if (linkMatch) {
    console.log('Link in email:', linkMatch[1]);
  }
  cb(null, { messageId: 'dev-' + Date.now() });
}

/* =========================
   FORGOT PASSWORD
========================= */
exports.forgotPassword = (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  const sql = `
    SELECT id, email FROM clients
    WHERE email = ? AND is_account_active = 1
  `;

  db.get(sql, [email], (err, client) => {
    if (err) {
      console.error('Forgot password error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    if (!client) {
      return res.json({
        error: "This email doesn't exist"
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

        const clientUrl = process.env.CLIENT_BASE_URL ? process.env.CLIENT_BASE_URL.replace(/\/$/, '') : '';
        const link = `${clientUrl}/reset-password?token=${token}`;

        const mailOptions = {
          from: process.env.EMAIL_FROM || 'no-reply@studio.com',
          to: client.email,
          subject: 'Password Reset Request',
          html: `<p>Hi,</p>
                 <p>You requested a password reset. Click the link below to reset your password:</p>
                 <p><a href="${link}">Reset Password</a></p>
                 <p>If the link doesn't work, paste this URL into your browser:</p>
                 <p>${link}</p>
                 <p>This link will expire in 1 hour.</p>`
        };

        sendMailWithFallback(mailOptions, (err, info) => {
          if (err) {
            console.error('Failed to send reset email:', err);
          } else {
            try {
              const preview = nodemailer.getTestMessageUrl(info);
              if (preview) console.log('Preview URL:', preview);
            } catch (e) {}
          }
          res.json({
            message: 'Reset link has been sent'
          });
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
      `UPDATE clients SET password_hash = ?, is_account_active = 1 WHERE id = ?`,
      [passwordHash, tokenRow.client_id],
      (err) => {
        if (err) return res.status(500).json({ message: 'Internal server error' });

        db.run(
          `UPDATE password_tokens SET used = 1 WHERE id = ?`,
          [tokenRow.id],
          (err) => {
            if (err) console.error('Failed to mark token used:', err);
            res.json({
              message: 'Password reset successfully. You can now log in.'
            });
          }
        );
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
    SELECT *
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

    delete client.password_hash;
    res.json({ token, client });
  });
};

// GET client details
exports.getById = (req, res) => {
  const { id } = req.params;
  
  const sql = `
    SELECT 
      e.id AS event_id,
      e.Stage as EventStatus, 
      e.advance as Advance, 
      e.amount as TotalAmount, 
      e.created_at as Event_created_on,
      e.start_time as Event_Time, 
      e.end_time as Event_end_time, 
      e.enquiry_message as Event_enquiry_message, 
      e.guest_count, 
      e.location, 
      e.venue, 
      e.status, 
      e.event_type, 
      e.event_date,
      s.id AS staff_id,
      s.name AS staff_name,
      s.role AS staff_role
    FROM events e
    LEFT JOIN event_staff es ON e.id = es.event_id
    LEFT JOIN staff s ON es.staff_id = s.id
    WHERE e.client_id = ?
    ORDER BY e.created_at DESC
  `;

  db.all(sql, [id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    // Group rows by event because LEFT JOIN creates duplicates for events with multiple staff
    const eventsMap = {};

    rows.forEach(row => {
      if (!eventsMap[row.event_id]) {
        eventsMap[row.event_id] = {
          id: row.event_id,
          EventStatus: row.EventStatus,
          Advance: row.Advance,
          TotalAmount: row.TotalAmount,
          Event_created_on: row.Event_created_on,
          Event_Time: row.Event_Time,
          Event_end_time: row.Event_end_time,
          Event_enquiry_message: row.Event_enquiry_message,
          guest_count: row.guest_count,
          location: row.location,
          venue: row.venue,
          status: row.status,
          event_type: row.event_type,
          event_date: row.event_date,
          staff: []
        };
      }

      if (row.staff_id) {
        eventsMap[row.event_id].staff.push({
          id: row.staff_id,
          name: row.staff_name,
          role: row.staff_role
        });
      }
    });

    res.json(Object.values(eventsMap));
  });
};
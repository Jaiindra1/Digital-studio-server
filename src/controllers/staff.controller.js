const db = require('../db/db');
const s3Client = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET_NAME;

// GET /api/staff
exports.getAll = (req, res) => {
  db.all(`SELECT * FROM staff ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows);
  });
};

// GET /api/staff/me
exports.getMe = (req, res) => {
  const staffId = req.user.id;
  if (!staffId) return res.status(401).json({ error: 'Unauthorized' });
  db.get('SELECT * FROM staff WHERE id = ?', [staffId], async (err, row) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (!row) return res.status(404).json({ error: 'Staff not found' });

    let avatarUrl = null;
    if (row.avatar_url && BUCKET) {
      try {
        avatarUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({ Bucket: BUCKET, Key: row.avatar_url }),
          { expiresIn: 3600 }
        );
      } catch (e) {
        console.error('Failed to sign staff avatar URL:', e);
      }
    } else if (row.avatar_url) {
      avatarUrl = row.avatar_url;
    }

    res.json({ ...row, avatarUrl });
  });
};

// POST /api/staff
const { signToken } = require('../utils/jwt');
const { sendMail } = require('../utils/mail');

exports.create = async (req, res) => {
  const { name, email, role, skills } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const sql = `
    INSERT INTO staff (name, email, role, skills)
    VALUES (?, ?, ?, ?)
  `;

  db.run(sql, [name, email, role, skills], async function (err) {
    if (err) return res.status(500).json({ error: err.message });
    const staffId = this.lastID;

    // Generate password setup token (valid for 24h)
    let token;
    try {
      token = signToken({ staffId, email, type: 'staff-password-setup' }, '24h');
    } catch (e) {
      return res.status(500).json({ error: 'Failed to generate token' });
    }

    // Construct password setup link
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const link = `${baseUrl}/staff/set-password?token=${encodeURIComponent(token)}`;

    // Send email
    if (email) {
      try {
        await sendMail({
          to: email,
          subject: 'Set up your staff account password',
          html: `<p>Hello ${name},</p>
            <p>Your staff account has been created. Please <a href="${link}">click here to set your password</a> and activate your account.</p>
            <p>If you did not expect this email, you can ignore it.</p>`
        });
      } catch (e) {
        // Log error but do not fail creation
        console.error('Failed to send staff setup email:', e);
      }
    }

    res.status(201).json({ id: staffId, name, email, role, skills });
  });
};

// POST /api/staff/:id/resend-password
exports.resendPasswordSetupEmail = (req, res) => {
  const { id } = req.params;

  db.get(`SELECT id, name, email FROM staff WHERE id = ?`, [id], async (err, staff) => {
    if (err) {
      console.error('Failed to load staff for resend:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!staff) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    if (!staff.email) {
      return res.status(400).json({ error: 'Staff email is missing' });
    }

    let token;
    try {
      token = signToken(
        { staffId: staff.id, email: staff.email, type: 'staff-password-setup' },
        '24h'
      );
    } catch (e) {
      console.error('Failed to generate staff setup token:', e);
      return res.status(500).json({ error: 'Failed to generate token' });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const link = `${baseUrl}/staff/set-password?token=${encodeURIComponent(token)}`;

    try {
      await sendMail({
        to: staff.email,
        subject: 'Set up your staff account password',
        html: `<p>Hello ${staff.name},</p>
          <p>You requested a new link to set your staff account password. Please <a href="${link}">click here to set your password</a>.</p>
          <p>If you did not request this, you can safely ignore this email.</p>`
      });
    } catch (e) {
      console.error('Failed to send staff setup email (resend):', e);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    return res.json({ message: 'Password setup email resent successfully' });
  });
};

// PUT /api/staff/:id
exports.update = (req, res) => {
  const { id } = req.params;
  
  if (!req.body) {
    return res.status(400).json({ error: 'Request body missing' });
  }

  const { name, email, role, skills, status, reason } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const sql = `
    UPDATE staff
    SET name = ?, email = ?, role = ?, skills = ? , updated_at = CURRENT_TIMESTAMP,
    status = ?, inactive_reason = ?
    WHERE id = ?
  `;

  db.run(sql, [name, email, role, skills, status, reason, id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({ message: 'Staff updated successfully' });
  });
};

// PUT /api/staff/me
exports.updateMe = (req, res) => {
  const staffId = req.user.id;
  if (!staffId) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.body) {
    return res.status(400).json({ error: 'Request body missing' });
  }
  const { name, email, phone, role, skills, status } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const sql = `
    UPDATE staff
    SET name = ?, email = ?, phone = ?, role = ?, skills = ?, status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;
  db.run(sql, [name, email, phone, role, skills, status, staffId], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Staff not found' });
    }
    res.json({ message: 'Profile updated successfully' });
  });
};

// PATCH /api/staff/:id/status
exports.toggleStatus = (req, res) => {
  const { id } = req.params;

  if (!req.body) {
    return res.status(400).json({ error: 'Request body missing' });
  }

  const { active } = req.body;

  const sql = `UPDATE staff SET active = ? WHERE id = ?`;

  db.run(sql, [active ? 1 : 0, id], function (err) {
    if (err) return res.status(500).json({ error: 'Update failed' });
    res.json({ message: 'Status updated' });
  });
};

// PATCH /api/staff/:id/status
exports.changeStatus = (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'];

  if (!status || !allowedStatuses.includes(status)) {
    return res.status(400).json({
      error: 'Invalid status. Allowed: ACTIVE, INACTIVE, ON_LEAVE'
    });
  }

  const sql = `UPDATE staff SET status = ? WHERE id = ?`;

  db.run(sql, [status, id], function (err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (this.changes === 0) {
      return res.status(404).json({ error: 'Staff not found' });
    }

    res.json({
      message: 'Staff status updated',
      staffId: id,
      status
    });
  });
};

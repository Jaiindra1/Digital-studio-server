const db = require('../db/db');
const { signToken } = require('../utils/jwt');
const { hash, compare } = require('../utils/password');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const s3Client = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');

const BUCKET = process.env.S3_BUCKET_NAME;

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

// Get media for a specific event (client-facing, verifies event ownership)
exports.getEventMediaForClient = async (req, res) => {
  const { id: clientId, eventId } = req.params;

  if (!clientId || !eventId) {
    return res.status(400).json({ message: 'client id and eventId are required' });
  }

  if (!BUCKET) {
    return res.status(500).json({ message: 'S3 bucket is not configured' });
  }

  try {
    const owned = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM events WHERE id = ? AND client_id = ?`,
        [eventId, clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!owned) {
      return res.status(404).json({ message: 'Event not found for this client' });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, event_id, staff_id, type, title, s3_key, status, created_at
         FROM event_assets
         WHERE event_id = ?
         ORDER BY created_at DESC`,
        [eventId],
        (err, data) => (err ? reject(err) : resolve(data || []))
      );
    });

    const media = await Promise.all(
      rows.map(async (row) => {
        let signedUrl = null;
        if (row.s3_key) {
          try {
            signedUrl = await getSignedUrl(
              s3Client,
              new GetObjectCommand({ Bucket: BUCKET, Key: row.s3_key }),
              { expiresIn: 3600 }
            );
          } catch (err) {
            console.warn('Failed to sign client event media URL:', err.message);
          }
        }
        return { ...row, signed_url: signedUrl };
      })
    );

    res.json(media);
  } catch (err) {
    console.error('Failed to fetch client event media:', err);
    res.status(500).json({ message: 'Failed to fetch event media' });
  }
};

// Download all media for an event as a ZIP (client-facing)
exports.downloadEventMediaZip = async (req, res) => {
  const { id: clientId, eventId } = req.params;

  if (!clientId || !eventId) {
    return res.status(400).json({ message: 'client id and eventId are required' });
  }

  if (!BUCKET) {
    return res.status(500).json({ message: 'S3 bucket is not configured' });
  }

  try {
    const owned = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM events WHERE id = ? AND client_id = ?`,
        [eventId, clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!owned) {
      return res.status(404).json({ message: 'Event not found for this client' });
    }

    const assets = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, s3_key, title, type FROM event_assets WHERE event_id = ? ORDER BY created_at DESC`,
        [eventId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    if (!assets.length) {
      return res.status(404).json({ message: 'No media available for this event' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=event-${eventId}-media.zip`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('Zip error:', err);
      if (!res.headersSent) {
        res.status(500).end('Failed to create archive');
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    for (const asset of assets) {
      if (!asset.s3_key) continue;
      try {
        const obj = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: asset.s3_key }));
        const safeName = `${asset.title || asset.id}.${asset.type === 'VIDEO' ? 'mp4' : 'jpg'}`;
        archive.append(obj.Body, { name: safeName });
      } catch (err) {
        console.warn('Skipping asset (fetch failed):', asset.id, err.message);
      }
    }

    archive.finalize();
  } catch (err) {
    console.error('Failed to download client event media zip:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Failed to prepare download' });
    }
  }
};

// Submit client feedback for an event, then notify admin and assigned staff via email
exports.submitFeedback = async (req, res) => {
  const { id: clientId } = req.params;
  const { eventId, rating, comments } = req.body || {};

  const numericRating = Number(rating);

  if (!clientId || !eventId) {
    return res.status(400).json({ message: 'Client id and event id are required' });
  }

  if (!Number.isFinite(numericRating) || numericRating < 1 || numericRating > 5) {
    return res.status(400).json({ message: 'Rating must be between 1 and 5' });
  }

  try {
    // Verify the event belongs to the client and fetch basic details for the email
    const eventRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT e.id, e.event_type, e.event_date, c.name AS client_name, c.email AS client_email
         FROM events e
         JOIN clients c ON c.id = e.client_id
         WHERE e.id = ? AND e.client_id = ?`,
        [eventId, clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!eventRow) {
      return res.status(404).json({ message: 'Event not found for this client' });
    }

    // Persist the feedback
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO feedback (client_id, event_id, rating, comments)
         VALUES (?, ?, ?, ?)`,
        [clientId, eventId, numericRating, comments || null],
        (err) => (err ? reject(err) : resolve())
      );
    });

    // Gather recipients: admin + assigned staff
    const [adminEmails, staffRows] = await Promise.all([
      new Promise((resolve) => {
        db.all(
          `SELECT email FROM users WHERE LOWER(role) = 'admin' AND email IS NOT NULL AND TRIM(email) <> ''`,
          [],
          (err, rows) => {
            if (err) {
              console.warn('Failed to load admin emails:', err.message);
              return resolve([]);
            }
            resolve(rows || []);
          }
        );
      }),
      new Promise((resolve) => {
        db.all(
          `SELECT DISTINCT s.email, s.name
           FROM event_staff es
           JOIN staff s ON s.id = es.staff_id
           WHERE es.event_id = ? AND s.email IS NOT NULL AND TRIM(s.email) <> ''`,
          [eventId],
          (err, rows) => {
            if (err) {
              console.warn('event_staff lookup failed, falling back to event_assets:', err.message);
              db.all(
                `SELECT DISTINCT s.email, s.name
                 FROM event_assets ea
                 JOIN staff s ON s.id = ea.staff_id
                 WHERE ea.event_id = ? AND s.email IS NOT NULL AND TRIM(s.email) <> ''`,
                [eventId],
                (fallbackErr, fallbackRows) => {
                  if (fallbackErr) {
                    console.warn('event_assets lookup failed:', fallbackErr.message);
                    return resolve([]);
                  }
                  return resolve(fallbackRows || []);
                }
              );
              return;
            }
            resolve(rows || []);
          }
        );
      })
    ]);

    const envAdminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_FROM || process.env.EMAIL_USER;
    const emailSet = new Set();

    if (envAdminEmail) emailSet.add(envAdminEmail);
    adminEmails.forEach((row) => {
      if (row?.email) emailSet.add(row.email);
    });
    staffRows.forEach((row) => {
      if (row?.email) emailSet.add(row.email);
    });

    const recipients = Array.from(emailSet).filter(Boolean);

    if (recipients.length) {
      const mailOptions = {
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@studio.com',
        to: recipients.join(','),
        subject: `New client feedback for event ${eventRow.event_type || eventRow.id}`,
        html: `
          <p>Hello,</p>
          <p>${eventRow.client_name || 'A client'} shared new feedback for the event <strong>${eventRow.event_type || eventRow.id}</strong>.</p>
          <p><strong>Rating:</strong> ${numericRating}/5</p>
          <p><strong>Comments:</strong><br/>${comments ? comments.replace(/\n/g, '<br/>') : 'No additional comments provided.'}</p>
          <p><strong>Event Date:</strong> ${eventRow.event_date || 'N/A'}</p>
          <p><strong>Client Email:</strong> ${eventRow.client_email || 'Not provided'}</p>
        `
      };

      await new Promise((resolve) => {
        sendMailWithFallback(mailOptions, (err) => {
          if (err) console.error('Failed to send feedback email:', err);
          resolve();
        });
      });
    }

    res.json({ message: 'Feedback submitted successfully' });
  } catch (err) {
    console.error('Failed to submit feedback:', err);
    res.status(500).json({ message: 'Failed to submit feedback' });
  }
};
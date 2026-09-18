const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { hash, compare } = require('../utils/password');
const s3Client = require('../config/s3');
const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { sendMail } = require('../utils/mail');

const BUCKET = process.env.S3_BUCKET_NAME;

exports.forgotPassword = (req, res) => {
  const normalizedEmail = String(req.body?.email || '').trim().toLowerCase();
  if (!normalizedEmail) return res.status(400).json({ message: 'Email is required' });

  db.get(
    `SELECT id, name, email, is_account_active FROM staff WHERE LOWER(TRIM(email)) = ? LIMIT 1`,
    [normalizedEmail],
    async (err, staff) => {
      if (err) {
        console.error('Staff forgot password DB error:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }
      if (!staff) return res.status(404).json({ message: 'No staff account was found for this email.' });
      if (!staff.is_account_active) return res.status(400).json({ message: 'This staff account is not active. Please use the original password setup email or contact an administrator.' });

      let token;
      try {
        token = jwt.sign({ staffId: staff.id, email: staff.email, type: 'staff-password-reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
      } catch (tokenError) {
        console.error('Staff reset token error:', tokenError);
        return res.status(500).json({ message: 'Could not create a reset link' });
      }

      const baseUrl = (process.env.FRONTEND_URL || process.env.CLIENT_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
      const link = `${baseUrl}/staff/reset-password?token=${encodeURIComponent(token)}`;
      try {
        await sendMail({
          to: staff.email,
          subject: 'Reset your staff portal password',
          text: `Hello ${staff.name || 'Staff'},\n\nReset your password using this link: ${link}\n\nThe link expires in one hour.`,
          html: `<p>Hello ${staff.name || 'Staff'},</p><p>You requested a password reset for your staff portal account.</p><p><a href="${link}">Reset staff password</a></p><p>This link expires in one hour. If you did not request it, you can ignore this email.</p>`,
        });
        return res.json({ message: 'A staff password reset link has been sent to your email.' });
      } catch (mailError) {
        console.error('Staff reset email failed:', mailError);
        return res.status(502).json({ message: 'Could not send the reset email. Please try again.' });
      }
    }
  );
};

exports.resetPassword = async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ message: 'Token and password are required' });
  if (String(password).length < 8) return res.status(400).json({ message: 'Password must contain at least 8 characters' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (_error) {
    return res.status(400).json({ message: 'This reset link is invalid or has expired.' });
  }
  if (decoded.type !== 'staff-password-reset' || !decoded.staffId) return res.status(400).json({ message: 'This reset link is invalid or has expired.' });

  try {
    const passwordHash = await hash(password);
    db.run(
      `UPDATE staff SET password_hash = ?, is_account_active = 1, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND LOWER(TRIM(email)) = ?`,
      [passwordHash, decoded.staffId, String(decoded.email || '').trim().toLowerCase()],
      function (err) {
        if (err) return res.status(500).json({ message: 'Internal server error' });
        if (!this.changes) return res.status(400).json({ message: 'This reset link is invalid or has expired.' });
        return res.json({ message: 'Your staff password has been reset successfully.' });
      }
    );
  } catch (error) {
    console.error('Staff reset password error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

async function recordGalleryActivity(req, payload) {
  try {
    await new Promise((resolve, reject) =>
      db.run(
        `INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`,
        ['GALLERY_UPLOAD', JSON.stringify(payload), null],
        (err) => (err ? reject(err) : resolve())
      )
    );

    const io = req.app.get('io');
    if (io) io.to('admins').emit('galleryUpload', payload);
  } catch (err) {
    console.warn('Failed to record gallery activity:', err.message);
  }
}

function getStaffIdFromAuthHeader(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return { error: { status: 401, message: 'Authorization token missing' } };
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || decoded.role !== 'Staff' || !decoded.sub) {
      return { error: { status: 403, message: 'Access denied' } };
    }
    return { staffId: decoded.sub };
  } catch (err) {
    return { error: { status: 401, message: 'Invalid or expired token' } };
  }
}

/**
 * POST /api/staff-auth/create-password
 * Body: { token, password }
 *
 * Token is a JWT created in staff.controller.create with payload:
 * { staffId, email, type: 'staff-password-setup' }
 */
exports.createPassword = async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res
      .status(400)
      .json({ message: 'Token and password are required' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(400).json({ message: 'Invalid or expired token' });
  }

  if (!decoded || decoded.type !== 'staff-password-setup' || !decoded.staffId) {
    return res.status(400).json({ message: 'Invalid or expired token' });
  }

  const staffId = decoded.staffId;

  db.get(
    `SELECT id, name, email, password_hash, is_account_active FROM staff WHERE id = ?`,
    [staffId],
    async (err, staff) => {
      if (err) {
        console.error('Staff createPassword DB error:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }

      if (!staff) {
        return res.status(400).json({ message: 'Invalid or expired token' });
      }

      // Prevent setting password twice
      if (staff.password_hash || staff.is_account_active === 1) {
        return res
          .status(400)
          .json({ message: 'Password already set. Please log in via the staff portal.' });
      }

      try {
        const passwordHash = await hash(password);

        db.run(
          `UPDATE staff
           SET password_hash = ?, is_account_active = 1, status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [passwordHash, staffId],
          (updateErr) => {
            if (updateErr) {
              console.error(
                'Failed to set staff password:',
                updateErr.message
              );
              return res
                .status(500)
                .json({ message: 'Internal server error' });
            }

            return res.json({
              message:
                'Password created successfully. You can now access the staff portal.',
            });
          }
        );
      } catch (hashErr) {
        console.error('Hashing error in staff createPassword:', hashErr);
        return res.status(500).json({ message: 'Internal server error' });
      }
    }
  );
};

/**
 * POST /api/staff-auth/login
 * Body: { email, password }
 */
exports.login = (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedEmail || !password) {
    return res
      .status(400)
      .json({ message: 'Email and password are required' });
  }

  db.get(
    `SELECT id, name, email, role, password_hash, is_account_active
     FROM staff
     WHERE LOWER(TRIM(email)) = ?`,
    [normalizedEmail],
    async (err, staff) => {
      if (err) {
        console.error('Staff login DB error:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }

      if (!staff) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      if (!staff.is_account_active || !staff.password_hash) {
        return res.status(403).json({
          message:
            'Account not active. Please use the password setup link from your email.',
        });
      }

      const isValid = await compare(password, staff.password_hash);
      if (!isValid) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      /* ================= STAFF SESSION ================= */

      const deviceName = req.headers['x-device-name'] || 'Unknown Device';
      const userAgent = req.headers['user-agent'];
      const ipAddress =
        req.headers['x-forwarded-for']?.split(',')[0] ||
        req.socket.remoteAddress;

      try {
        // mark all existing sessions for this staff as not current
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE staff_sessions
             SET is_current = 0
             WHERE staff_id = ?`,
            [staff.id],
            function (err) {
              if (err) {
                console.error('Error updating old staff sessions:', err);
                reject(err);
              } else {
                resolve();
              }
            }
          );
        });

        // check if a session already exists for this device
        const existing = await new Promise((resolve, reject) => {
          db.get(
            `SELECT id FROM staff_sessions
             WHERE staff_id = ? AND device_name = ? AND user_agent = ? AND ip_address = ?`,
            [staff.id, deviceName, userAgent, ipAddress],
            (err, row) => {
              if (err) {
                console.error('Error fetching staff session:', err);
                reject(err);
              } else {
                resolve(row);
              }
            }
          );
        });

        if (existing) {
          // update existing session for this device
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE staff_sessions
               SET is_current = 1, last_active = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [existing.id],
              function (err) {
                if (err) {
                  console.error('Error updating staff session:', err);
                  reject(err);
                } else {
                  resolve();
                }
              }
            );
          });
        } else {
          // insert new session
          await new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO staff_sessions
               (staff_id, device_name, ip_address, user_agent, is_current)
               VALUES (?, ?, ?, ?, 1)`,
              [staff.id, deviceName, ipAddress, userAgent],
              function (err) {
                if (err) {
                  console.error('Error inserting staff session:', err);
                  reject(err);
                } else {
                  resolve();
                }
              }
            );
          });
        }
      } catch (sessionErr) {
        // Don't block login if session tracking fails
        console.error('Staff session tracking error:', sessionErr);
      }

      /* ================= JWT ================= */

      const { signToken } = require('../utils/jwt');
      const token = signToken({
        sub: staff.id,
        role: 'Staff',
      });

      // Do not expose password_hash
      delete staff.password_hash;

      return res.json({ token, staff });
    }
  );
};

/**
 * GET /api/staff-auth/me/events
 * Header: Authorization: Bearer <staff JWT>
 */
exports.getMyEvents = (req, res) => {
  const auth = getStaffIdFromAuthHeader(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });
  const { staffId } = auth;

  const sql = `
    SELECT
      e.id AS event_id,
      e.event_type,
      e.event_date,
      e.start_time,
      e.end_time,
      e.location,
      e.status,
      COALESCE(e.delivery_method, 'ONLINE') AS delivery_method,
      e.delivery_note,
      e.delivered_at,
      e.gallery_removed_at,
      e.Stage,
      e.venue,
      c.name AS client_name
    FROM events e
    JOIN event_staff es ON es.event_id = e.id
    JOIN clients c ON c.id = e.client_id
    WHERE es.staff_id = ?
    ORDER BY e.event_date ASC, e.start_time ASC, e.created_at ASC
  `;

  db.all(sql, [staffId], (err, rows) => {
    if (err) {
      console.error('Error fetching staff events:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }

    return res.json(rows || []);
  });
};

/**
 * GET /api/staff-auth/me/events/:eventId/media
 * Returns media uploaded by current staff for the given assigned event
 */
exports.getEventMedia = async (req, res) => {
  const auth = getStaffIdFromAuthHeader(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });

  const { staffId } = auth;
  const { eventId } = req.params;

  if (!eventId) return res.status(400).json({ message: 'eventId is required' });
  if (!BUCKET) return res.status(500).json({ message: 'S3 bucket is not configured' });

  try {
    const assigned = await new Promise((resolve, reject) => {
      db.get(
        `SELECT 1 AS ok FROM event_staff WHERE event_id = ? AND staff_id = ?`,
        [eventId, staffId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!assigned) {
      return res.status(403).json({ message: 'This event is not assigned to you' });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, event_id, staff_id, type, title, s3_key, status, created_at
         FROM event_assets
         WHERE event_id = ? AND staff_id = ?
         ORDER BY created_at DESC`,
        [eventId, staffId],
        (err, data) => (err ? reject(err) : resolve(data || []))
      );
    });

    const media = await Promise.all(
      rows.map(async (row) => {
        let signedUrl = null;
        try {
          if (row.s3_key) {
            signedUrl = await getSignedUrl(
              s3Client,
              new GetObjectCommand({ Bucket: BUCKET, Key: row.s3_key }),
              { expiresIn: 3600 }
            );
          }
        } catch (err) {
          console.warn('Failed to sign event media URL:', err.message);
        }

        return {
          ...row,
          signed_url: signedUrl,
        };
      })
    );

    const eventMeta = await new Promise((resolve, reject) => {
      db.get(
        `SELECT e.event_type, c.name AS client_name, s.name AS staff_name
         FROM events e
         LEFT JOIN clients c ON c.id = e.client_id
         LEFT JOIN staff s ON s.id = ?
         WHERE e.id = ?`,
        [staffId, eventId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    await recordGalleryActivity(req, {
      eventId: Number(eventId),
      albumId: `EVENT-${eventId}`,
      action: 'VIEW',
      count: media.length,
      eventType: eventMeta?.event_type || 'Event',
      clientName: eventMeta?.client_name || 'Client',
      staffName: eventMeta?.staff_name || `Staff #${staffId}`,
    });

    return res.json(media);
  } catch (err) {
    console.error('Failed to fetch staff event media:', err);
    return res.status(500).json({ message: 'Failed to fetch event media' });
  }
};

/**
 * POST /api/staff-auth/me/events/:eventId/media
 * Multipart body: media[]
 */
exports.uploadEventMedia = async (req, res) => {
  const auth = getStaffIdFromAuthHeader(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });

  const { staffId } = auth;
  const { eventId } = req.params;
  const files = req.files || [];

  if (!eventId) return res.status(400).json({ message: 'eventId is required' });
  if (!files.length) return res.status(400).json({ message: 'Please upload at least one file' });
  if (!BUCKET) return res.status(500).json({ message: 'S3 bucket is not configured' });

  try {
    const assigned = await new Promise((resolve, reject) => {
      db.get(
        `SELECT 1 AS ok FROM event_staff WHERE event_id = ? AND staff_id = ?`,
        [eventId, staffId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!assigned) {
      return res.status(403).json({ message: 'This event is not assigned to you' });
    }

    const eventMeta = await new Promise((resolve, reject) => {
      db.get(
        `SELECT e.event_type, c.name AS client_name, s.name AS staff_name
         FROM events e
         LEFT JOIN clients c ON c.id = e.client_id
         LEFT JOIN staff s ON s.id = ?
         WHERE e.id = ?`,
        [staffId, eventId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    const uploaded = [];

    for (const file of files) {
      const safeName = String(file.originalname || 'file').replace(/\s+/g, '_');
      const key = `event-assets/event-${eventId}/staff-${staffId}/${Date.now()}-${safeName}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
      );

      const mediaType = (file.mimetype || '').startsWith('video/') ? 'VIDEO' : 'IMAGE';

      const assetId = await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO event_assets (event_id, staff_id, type, title, s3_key, status)
           VALUES (?, ?, ?, ?, ?, 'SUBMITTED')`,
          [eventId, staffId, mediaType, file.originalname, key],
          function (err) {
            err ? reject(err) : resolve(this.lastID);
          }
        );
      });

      uploaded.push({ id: assetId, key, type: mediaType, title: file.originalname });
    }

    await recordGalleryActivity(req, {
      eventId: Number(eventId),
      albumId: `EVENT-${eventId}`,
      action: 'UPLOAD',
      count: uploaded.length,
      eventType: eventMeta?.event_type || 'Event',
      clientName: eventMeta?.client_name || 'Client',
      staffName: eventMeta?.staff_name || `Staff #${staffId}`,
      uploaded,
    });

    return res.status(201).json({
      message: 'Media uploaded successfully',
      count: uploaded.length,
      uploaded,
    });
  } catch (err) {
    console.error('Staff media upload failed:', err);
    return res.status(500).json({ message: 'Failed to upload media' });
  }
};

/**
 * DELETE /api/staff-auth/me/events/:eventId/media/:assetId
 */
exports.deleteEventMedia = async (req, res) => {
  const auth = getStaffIdFromAuthHeader(req);
  if (auth.error) return res.status(auth.error.status).json({ message: auth.error.message });

  const { staffId } = auth;
  const { eventId, assetId } = req.params;

  if (!eventId || !assetId) {
    return res.status(400).json({ message: 'eventId and assetId are required' });
  }

  try {
    const assigned = await new Promise((resolve, reject) => {
      db.get(
        `SELECT 1 AS ok FROM event_staff WHERE event_id = ? AND staff_id = ?`,
        [eventId, staffId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!assigned) {
      return res.status(403).json({ message: 'This event is not assigned to you' });
    }

    const asset = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, event_id, staff_id, s3_key, title
         FROM event_assets
         WHERE id = ? AND event_id = ? AND staff_id = ?`,
        [assetId, eventId, staffId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!asset) {
      return res.status(404).json({ message: 'Media not found' });
    }

    if (asset.s3_key && BUCKET) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: asset.s3_key,
        })
      );
    }

    await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM event_assets WHERE id = ? AND event_id = ? AND staff_id = ?`,
        [assetId, eventId, staffId],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const eventMeta = await new Promise((resolve, reject) => {
      db.get(
        `SELECT e.event_type, c.name AS client_name, s.name AS staff_name
         FROM events e
         LEFT JOIN clients c ON c.id = e.client_id
         LEFT JOIN staff s ON s.id = ?
         WHERE e.id = ?`,
        [staffId, eventId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    await recordGalleryActivity(req, {
      eventId: Number(eventId),
      albumId: `EVENT-${eventId}`,
      action: 'DELETE',
      count: 1,
      title: asset.title || 'Media',
      eventType: eventMeta?.event_type || 'Event',
      clientName: eventMeta?.client_name || 'Client',
      staffName: eventMeta?.staff_name || `Staff #${staffId}`,
    });

    return res.json({ message: 'Media deleted successfully', id: Number(assetId) });
  } catch (err) {
    console.error('Failed to delete staff event media:', err);
    return res.status(500).json({ message: 'Failed to delete media' });
  }
};

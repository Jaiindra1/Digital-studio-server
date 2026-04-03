const db = require('../config/db');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const emailTemplates = require('./emailTemplates.controller');
const { getNotificationSettings } = require('./notifications.controller');
const s3Client = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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

  // 1. staff
exports.assignStaff = (req, res) => {
  const { eventId } = req.params;
  const { staffIds, roles = {} } = req.body;

  if (!Array.isArray(staffIds) || staffIds.length === 0) {
    return res.status(400).json({ error: 'staffIds must be a non-empty array' });
  }

  // 1. Check event exists
db.get(
    `SELECT id, status FROM events WHERE id = ?`,
    [eventId],
    (err, event) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!event) return res.status(404).json({ error: 'Event not found' });

      // Optional: prevent assignment after shoot done
      if (event.status === 'SHOOT_DONE' || event.status === 'DELIVERED') {
        return res.status(400).json({
          error: 'Cannot assign staff to a completed event'
        });
      }

      // 2. Validate staff (ACTIVE only)
      const placeholders = staffIds.map(() => '?').join(',');
      const staffSql = `
        SELECT id FROM staff
        WHERE id IN (${placeholders})
          AND status = 'ACTIVE'
      `;

      db.all(staffSql, staffIds, (err, validStaff) => {
        if (err) return res.status(500).json({ error: err.message });

        if (validStaff.length !== staffIds.length) {
          return res.status(400).json({
            error: 'One or more staff are not ACTIVE or do not exist'
          });
        }

        // 3. Insert into event_staff (ignore duplicates)
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO event_staff (event_id, staff_id, role)
          VALUES (?, ?, ?)
        `);

        staffIds.forEach((staffId) => {
          stmt.run(
            eventId,
            staffId,
            roles[staffId] || null
          );
        });

        stmt.finalize((err) => {
          if (err) return res.status(500).json({ error: err.message });

          res.json({
            message: 'Staff assigned successfully',
            eventId,
            staffIds
          });
        });
      });
    }
);
};

  // 2. Get all events
exports.getAllEvents = (req, res) => {
  const sql = `
  SELECT
    e.id AS event_id,
    e.event_type,
    e.event_date,
    e.start_time,
    e.end_time,
    e.location,
    e.status,
    e.created_at,
    e.amount,
    e.Stage,
    e.venue,
    e.guest_count,
    e.enquiry_message,
    e.amount_status,
    e.advance_amount AS advance,
    COALESCE(pay.paid_from_payments, 0) AS paid_from_payments,
    COALESCE(pay.advance_from_payments, 0) AS advance_from_payments,
    (
      CASE
        WHEN COALESCE(e.advance_amount, 0) > COALESCE(pay.advance_from_payments, 0)
          THEN COALESCE(e.advance_amount, 0)
        ELSE COALESCE(pay.advance_from_payments, 0)
      END
      + (COALESCE(pay.paid_from_payments, 0) - COALESCE(pay.advance_from_payments, 0))
    ) AS paid_amount,
    GREATEST(
      COALESCE(e.amount, 0) - (
        CASE
          WHEN COALESCE(e.advance_amount, 0) > COALESCE(pay.advance_from_payments, 0)
            THEN COALESCE(e.advance_amount, 0)
          ELSE COALESCE(pay.advance_from_payments, 0)
        END
        + (COALESCE(pay.paid_from_payments, 0) - COALESCE(pay.advance_from_payments, 0))
      ),
      0
    ) AS remaining_amount,

    c.id AS client_id,
    c.name AS client_name,
    c.email AS client_email,
    c.phone AS client_phone,
    c.address AS client_address,
    c.created_at AS client_created_at,

    s.id AS staff_id,
    s.name AS staff_name,
    s.role AS staff_role,

    ec.reason AS cancellation_reason

  FROM events e
  JOIN clients c ON c.id = e.client_id
  LEFT JOIN (
    SELECT
      event_id,
      COALESCE(SUM(amount), 0) AS paid_from_payments,
      COALESCE(SUM(
        CASE
          WHEN UPPER(REPLACE(COALESCE(payment_type, ''), ' ', '_')) = 'ADVANCE' THEN amount
          ELSE 0
        END
      ), 0) AS advance_from_payments
    FROM payments
    GROUP BY event_id
  ) pay ON pay.event_id = e.id
  LEFT JOIN event_staff es ON es.event_id = e.id
  LEFT JOIN staff s ON s.id = es.staff_id
  LEFT JOIN event_cancellations ec ON ec.event_id = e.id
  ORDER BY e.event_date DESC, e.created_at DESC
`;


  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    // Group rows by event
    const eventsMap = {};

      rows.forEach(row => {
        if (!eventsMap[row.event_id]) {
          eventsMap[row.event_id] = {
            event_id: row.event_id,
            eventStage: row.Stage,
            venue: row.venue,
            guestCount: row.guest_count,
            enquiryMessage: row.enquiry_message,
            eventType: row.event_type,
            eventDate: row.event_date,
            startTime: row.start_time,
            endTime: row.end_time,
            location: row.location,
            status: row.status,
            createdAt: row.created_at,
            amount: row.amount,
            advance: row.advance,
            paid_from_payments: row.paid_from_payments,
            advance_from_payments: row.advance_from_payments,
            paid_amount: row.paid_amount,
            remaining_amount: row.remaining_amount,
            amount_status: row.amount_status,
            cancellationReason: row.cancellation_reason || null,

            client: {
              id: row.client_id,
              name: row.client_name,
              phone: row.client_phone,
              email: row.client_email,
              address: row.client_address,
              createdAt: row.client_created_at
            },
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

// Admin: fetch all event assets with signed URLs
exports.getEventMediaAdmin = async (req, res) => {
  const { eventId } = req.params;

  if (!eventId) {
    return res.status(400).json({ message: 'eventId is required' });
  }

  if (!BUCKET) {
    return res.status(500).json({ message: 'S3 bucket is not configured' });
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT ea.id, ea.event_id, ea.staff_id, ea.type, ea.title, ea.s3_key, ea.status, ea.created_at, s.name AS staff_name
         FROM event_assets ea
         LEFT JOIN staff s ON s.id = ea.staff_id
         WHERE ea.event_id = ?
         ORDER BY ea.created_at DESC`,
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
            console.warn('Failed to sign event media URL:', err.message);
          }
        }

        return { ...row, signed_url: signedUrl };
      })
    );

    res.json(media);
  } catch (err) {
    console.error('Failed to fetch event media (admin):', err);
    res.status(500).json({ message: 'Failed to fetch event media' });
  }
};

  // 3. Update event amount and set amount_status to 1 (paid)
exports.updateAmount = (req, res) => {
  const { eventId } = req.params;
  const { amount } = req.body;

  if (amount === undefined || amount < 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const sql = `
    UPDATE events
    SET amount = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(sql, [amount, eventId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: 'Event not found' });

    res.json({
      message: 'Amount updated successfully',
      eventId,
      amount
    });
  });
};

  // 4. Create Event (Admin – Offline / Manual)
exports.createEvent = (req, res) => {
  const {
    client_name,
    client_phone,
    client_email,
    event_type,
    event_date,
    start_time,
    end_time,
    location
  } = req.body;

  // Basic validation
  if (!client_name || !client_phone || !event_type || !event_date) {
    return res.status(400).json({
      error: 'client_name, client_phone, event_type, event_date are required'
    });
  }

  // 1. Check if client already exists (by phone)
  const findClientSql = `
    SELECT id FROM clients
    WHERE phone = ?
    LIMIT 1
  `;

  db.get(findClientSql, [client_phone], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });

    const createEventWithClient = (clientId) => {
      const insertEventSql = `
        INSERT INTO events
        (client_id, event_type, event_date, start_time, end_time, location, status, amount, amount_status)
        VALUES (?, ?, ?, ?, ?, ?, 'NEW', 0, 0)
      `;

      db.run(
        insertEventSql,
        [
          clientId,
          event_type,
          event_date,
          start_time || null,
          end_time || null,
          location || null
        ],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          res.status(201).json({
            message: 'Event created successfully',
            event: {
              id: this.lastID,
              client_id: clientId,
              event_type,
              event_date,
              start_time,
              end_time,
              location,
              status: 'NEW',
              amount: 0,
              amount_status: 0
            }
          });
        }
      );
    };

    // 2. If client exists → use it
    if (client) {
      return createEventWithClient(client.id);
    }

    // 3. Else create new client
    const insertClientSql = `
      INSERT INTO clients (name, phone, email)
      VALUES (?, ?, ?)
    `;

    db.run(
      insertClientSql,
      [client_name, client_phone, client_email || null],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });
        createEventWithClient(this.lastID);
      }
    );
  });
};

  // 5. Update Event Details
exports.updateEvent = (req, res) => {
  const { eventId } = req.params;
  const {
    event_type,
    event_date,
    start_time,
    end_time,
    location,
    status,
    stage,
    advance,
    advance_amount,
    amount
  } = req.body;

  const updates = [];
  const values = [];
  
  // Dynamically build the query based on provided fields
  if (event_type !== undefined) { updates.push('event_type = ?'); values.push(event_type); }
  if (event_date !== undefined) { updates.push('event_date = ?'); values.push(event_date); }
  if (start_time !== undefined) { updates.push('start_time = ?'); values.push(start_time); }
  if (end_time !== undefined) { updates.push('end_time = ?'); values.push(end_time); }
  if (location !== undefined) { updates.push('location = ?'); values.push(location); }
  if (status !== undefined) {
    const normalizedStatus = String(status).toUpperCase();
    // Accept friendly value "CONFIRMED" from frontend and map to allowed status
    if (normalizedStatus === 'CONFIRMED') {
      updates.push('status = ?');
      values.push('ASSIGNED');
    } else if (['NEW', 'ASSIGNED', 'SHOOT_DONE', 'DELIVERED', 'CANCELLED'].includes(normalizedStatus)) {
      updates.push('status = ?');
      values.push(normalizedStatus);
    } else {
      return res.status(400).json({ error: `Invalid status value: ${status}` });
    }
  }
  if (stage !== undefined) { updates.push('Stage = ?'); values.push(stage); }
  if (amount !== undefined) { updates.push('amount = ?'); values.push(amount); }
  const nextAdvance = advance_amount !== undefined ? advance_amount : advance;
  if (nextAdvance !== undefined) { updates.push('advance_amount = ?'); values.push(nextAdvance); }
  console.log(values);

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields provided for update' });
  }

  // Always update the timestamp
  updates.push('updated_at = CURRENT_TIMESTAMP');

  const sql = `
    UPDATE events
    SET ${updates.join(', ')}
    WHERE id = ?
  `;
  values.push(eventId);

  db.run(sql, values, function (err) {
    if (err) {
      console.error('Database Error:', err);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes === 0)
      return res.status(404).json({ error: 'Event not found' });
    // If stage was set to CONFIRMED, create a password token and email the client
    const stageValue = (stage || '').toString().toUpperCase();
    if (stage !== undefined && stageValue === 'CONFIRMED') {
      // Get client + event info
      db.get(`SELECT 
                c.id as client_id, 
                c.email as client_email,
                c.name as client_name,
                e.event_type as event_type,
                e.event_date as event_date
              FROM events e 
              JOIN clients c ON c.id = e.client_id 
              WHERE e.id = ?`, [eventId], (err, row) => {
        if (err) {
          console.error('Failed to fetch client for event:', err);
          return res.json({ message: 'Event updated successfully, but failed to notify client' , eventId, updatedFields: req.body });
        }

        if (!row || !row.client_email) {
          console.warn('No client email found for event', eventId);
          return res.json({ message: 'Event updated successfully (no client email)', eventId, updatedFields: req.body });
        }

        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

        db.run(`INSERT INTO password_tokens (client_id, token, expires_at) VALUES (?, ?, ?)`, [row.client_id, token, expiresAt], (err) => {
          if (err) {
            console.error('Failed to insert password token:', err);
            return res.json({ message: 'Event updated, but failed to create token', eventId, updatedFields: req.body });
          }

          const clientUrl = process.env.CLIENT_BASE_URL ? process.env.CLIENT_BASE_URL.replace(/\/$/, '') : '';
          const link = `${clientUrl}/create-password?token=${token}`;

          const baseSubject = 'Set your account password';
          const baseHtml = `<p>Hi ${row.client_name || ''},</p>
                   <p>Your event has been confirmed. Please set your account password using the link below:</p>
                   <p><a href="${link}">Set your password</a></p>
                   <p>If the link doesn't work, paste this URL into your browser:</p>
                   <p>${link}</p>
                   <p>This link will expire in 24 hours.</p>`;

          const vars = {
            clientName: row.client_name || '',
            eventType: row.event_type || '',
            eventDate: row.event_date || '',
            link,
          };

          const applyVars = (text) =>
            text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => (vars[key] != null ? String(vars[key]) : ''));

          emailTemplates
            .findByKey('BOOKING_CONFIRMATION')
            .then((tpl) => {
              let subject = baseSubject;
              let html = baseHtml;

              if (tpl) {
                subject = applyVars(tpl.subject || baseSubject);
                html = applyVars(tpl.html_body || baseHtml);

                if (tpl.hero_image_url) {
                  const imgTag = `<p><img src="${tpl.hero_image_url}" alt="" style="max-width:100%;border-radius:8px;" /></p>`;
                  html = imgTag + html;
                }
              }

              const mailOptions = {
                from: process.env.EMAIL_FROM || 'no-reply@studio.com',
                to: row.client_email,
                subject,
                html,
              };

              sendMailWithFallback(mailOptions, (err, info) => {
                if (err) {
                  console.error('Failed to send create-password email:', err);
                  return res.json({ message: 'Event updated, but failed to send email', eventId, updatedFields: req.body });
                }

                // If using Ethereal, include preview URL in logs
                try {
                  const preview = nodemailer.getTestMessageUrl(info);
                  if (preview) console.log('Preview URL:', preview);
                } catch (e) {}

                return res.json({ message: 'Event updated and password link sent to client', eventId, updatedFields: req.body });
              });
            })
            .catch((tplErr) => {
              console.error('Email template lookup failed, sending default mail:', tplErr);

              const mailOptions = {
                from: process.env.EMAIL_FROM || 'no-reply@studio.com',
                to: row.client_email,
                subject: baseSubject,
                html: baseHtml,
              };

              sendMailWithFallback(mailOptions, (err, info) => {
                if (err) {
                  console.error('Failed to send create-password email:', err);
                  return res.json({ message: 'Event updated, but failed to send email', eventId, updatedFields: req.body });
                }

                try {
                  const preview = nodemailer.getTestMessageUrl(info);
                  if (preview) console.log('Preview URL:', preview);
                } catch (e) {}

                return res.json({ message: 'Event updated and password link sent to client', eventId, updatedFields: req.body });
              });
            });
        });
      });
    } else {
      return res.json({
        message: 'Event updated successfully',
        eventId,
        updatedFields: req.body
      });
    }
  });
};

  // 6. Update Staff Details for an Event (Role, Attendance)
exports.updateEventStaff = (req, res) => {
  const { eventId, staffId } = req.params;
  const { role, attended } = req.body;

  if (role === undefined && attended === undefined) {
    return res.status(400).json({
      error: 'At least one field (role, attended) must be provided for update.'
    });
  }

  const updates = [];
  const values = [];

  if (role !== undefined) {
    updates.push('role = ?');
    values.push(role);
  }

  if (attended !== undefined) {
    if (![0, 1].includes(attended)) {
      return res.status(400).json({ error: 'The "attended" field must be 0 or 1.' });
    }
    updates.push('attended = ?');
    values.push(attended);
  }

  values.push(eventId, staffId);

  const sql = `UPDATE event_staff SET ${updates.join(', ')} WHERE event_id = ? AND staff_id = ?`;

  db.run(sql, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: 'Staff assignment for this event not found.' });

    res.json({
      message: 'Event staff details updated successfully.',
      eventId,
      staffId,
      updatedFields: req.body
    });
  });
};

  // 7. Remove staff assignment from an event
exports.removeEventStaff = (req, res) => {
  const { eventId, staffId } = req.params;

  const sql = `DELETE FROM event_staff WHERE event_id = ? AND staff_id = ?`;
  db.run(sql, [eventId, staffId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: 'Staff assignment not found' });
    res.json({ message: 'Staff removed from event', eventId, staffId });
  });
};

  // 8. Cancel event with reason and store who cancelled it
exports.cancelEvent = (req, res) => {
  const { eventId } = req.params;
  const { reason } = req.body;

  console.log('cancelEvent called:', { eventId, reason, user: req.user });

  // 1. Check event exists
  db.get(`SELECT id, status FROM events WHERE id = ?`, [eventId], (err, event) => {
    if (err) {
      console.error('Error checking event:', err);
      return res.status(500).json({ error: err.message });
    }
    if (!event) {
      console.error('Event not found:', eventId);
      return res.status(404).json({ error: 'Event not found' });
    }

    console.log('Event found:', event);

    // 2. Mark event cancelled
    db.run(`UPDATE events SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [eventId], function (err) {
      if (err) {
        console.error('Error updating event:', err);
        return res.status(500).json({ error: 'Failed to update event: ' + err.message });
      }

      console.log('Event updated to CANCELLED, changes:', this.changes);

      // 3. Record cancellation reason with admin/staff info who cancelled it
      const adminId = req.user && req.user.id ? req.user.id : null;
      const adminEmail = req.user && req.user.email ? req.user.email : null;

      console.log('Inserting cancellation record:', { eventId, adminId, adminEmail, reason });

      db.run(
        `INSERT INTO event_cancellations (event_id, admin_id, admin_email, reason) VALUES (?, ?, ?, ?)`,
        [eventId, adminId, adminEmail, reason || null],
        (err) => {
          if (err) {
            console.error('Failed to save cancellation reason:', err);
            return res
              .status(500)
              .json({ error: 'Failed to save cancellation reason: ' + err.message });
          }

          console.log('Cancellation record inserted successfully');

          const io = req.app.get('io');

          const finish = () =>
            res.json({ message: 'Event cancelled', eventId, cancelledBy: adminEmail });

          // Respect bookingAlerts.cancellations setting for admin notifications
          getNotificationSettings()
            .then((settings) => {
              const alerts = settings && settings.bookingAlerts ? settings.bookingAlerts : {};

              if (!alerts.cancellations) {
                return finish();
              }

              const payload = JSON.stringify({
                eventId,
                reason: reason || null,
                cancelledBy: adminEmail,
              });

              db.run(
                `INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`,
                ['EVENT_CANCELLED', payload, adminId],
                (nErr) => {
                  if (nErr) {
                    console.warn('Failed to persist EVENT_CANCELLED notification:', nErr.message);
                  }

                  if (io) {
                    io.to('admins').emit('eventCancelled', JSON.parse(payload));
                  }

                  finish();
                }
              );
            })
            .catch((settingsErr) => {
              console.warn(
                'Failed to load notification settings for EVENT_CANCELLED:',
                settingsErr.message || settingsErr
              );
              // Fallback: just respond, no extra notification
              finish();
            });
        }
      );
    });
  });
};

const db = require('../config/db');
const { signToken } = require('../utils/jwt');
const { hash, compare } = require('../utils/password');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const s3Client = require('../config/s3');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');
const { sendMail } = require('../utils/mail');

const BUCKET = process.env.S3_BUCKET_NAME;

function parseNotificationPayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(payload);
  } catch (_err) {
    return {};
  }
}

async function getFallbackEventMediaFromNotifications(eventId) {
  const notification = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, payload, created_at
       FROM notifications
       WHERE type = 'GALLERY_UPLOAD'
         AND payload LIKE ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [`%"eventId":${Number(eventId)}%`],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  if (!notification) return [];

  const payload = parseNotificationPayload(notification.payload);
  const uploaded = Array.isArray(payload.uploaded) ? payload.uploaded : [];

  return uploaded.map((asset, index) => ({
    id: asset?.id || `notification-${notification.id}-${index}`,
    event_id: Number(eventId),
    staff_id: asset?.staff_id || null,
    type: asset?.type || 'IMAGE',
    title: asset?.title || asset?.name || `Asset ${index + 1}`,
    s3_key: asset?.key || asset?.s3_key || null,
    status: asset?.status || 'SUBMITTED',
    created_at: notification.created_at || null,
  }));
}

function buildArchiveFileName(asset) {
  const rawTitle = String(asset?.title || '').trim();
  if (rawTitle) return rawTitle;

  const keyName = String(asset?.s3_key || '').split('/').pop();
  if (keyName) return keyName;

  const ext = String(asset?.type || '').toUpperCase() === 'VIDEO' ? 'mp4' : 'jpg';
  return `asset-${asset?.id || Date.now()}.${ext}`;
}

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
      e.advance_amount as Advance, 
      e.amount as TotalAmount, 
      e.created_at as Event_created_on,
      e.start_time as Event_Time, 
      e.end_time as Event_end_time, 
      e.enquiry_message as Event_enquiry_message, 
      e.guest_count, 
      e.location, 
      e.venue, 
      e.status, 
      COALESCE(e.delivery_method, 'ONLINE') AS delivery_method,
      e.delivery_note,
      e.delivered_at,
      e.gallery_removed_at,
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
          delivery_method: row.delivery_method,
          delivery_note: row.delivery_note,
          delivered_at: row.delivered_at,
          gallery_removed_at: row.gallery_removed_at,
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

exports.getClientProfile = (req, res) => {
  const { id } = req.params;

  db.get(
    `SELECT id, name, phone, email, address, notes, created_at, updated_at
     FROM clients
     WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('Get client profile error:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ message: 'Client not found' });
      }

      return res.json(row);
    }
  );
};

exports.updateClientProfile = (req, res) => {
  const { id } = req.params;
  const {
    name = '',
    phone = '',
    email = '',
    address = '',
    notes = ''
  } = req.body || {};

  const normalizedName = String(name).trim();
  const normalizedPhone = String(phone).trim();
  const normalizedEmail = email == null ? null : String(email).trim();
  const normalizedAddress = address == null ? null : String(address).trim();
  const normalizedNotes = notes == null ? null : String(notes).trim();

  if (!normalizedName) {
    return res.status(400).json({ message: 'Name is required' });
  }

  if (!normalizedPhone) {
    return res.status(400).json({ message: 'Phone is required' });
  }

  db.run(
    `UPDATE clients
     SET name = ?,
         phone = ?,
         email = ?,
         address = ?,
         notes = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      normalizedName,
      normalizedPhone,
      normalizedEmail || null,
      normalizedAddress || null,
      normalizedNotes || null,
      id
    ],
    function (err) {
      if (err) {
        console.error('Update client profile error:', err);
        return res.status(500).json({ message: 'Internal server error' });
      }

      if (!this.changes) {
        return res.status(404).json({ message: 'Client not found' });
      }

      db.get(
        `SELECT id, name, phone, email, address, notes, created_at, updated_at
         FROM clients
         WHERE id = ?`,
        [id],
        (fetchErr, row) => {
          if (fetchErr) {
            console.error('Fetch updated client profile error:', fetchErr);
            return res.status(500).json({ message: 'Profile updated but fetch failed' });
          }

          return res.json(row);
        }
      );
    }
  );
};

const getOrCreateClientCartId = (clientId) => new Promise((resolve, reject) => {
  db.get(
    `SELECT id FROM client_cart WHERE client_id = ? AND status = 'active'`,
    [clientId],
    (findErr, cartRow) => {
      if (findErr) return reject(findErr);
      if (cartRow?.id) return resolve(cartRow.id);

      db.run(
        `INSERT INTO client_cart (client_id, status) VALUES (?, 'active')`,
        [clientId],
        function (insertErr) {
          if (insertErr) return reject(insertErr);
          return resolve(this.lastID);
        }
      );
    }
  );
});

exports.addClientCartItem = async (req, res) => {
  const { id } = req.params;
  const {
    product_id,
    product_name,
    quantity,
    price,
    image_url,
    uploaded_image_data,
    frame_details
  } = req.body || {};

  const clientId = Number(id);
  const normalizedQty = Number(quantity || 0);
  const normalizedPrice = Number(price || 0);

  if (!clientId || Number.isNaN(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }

  if (!normalizedQty || normalizedQty < 1) {
    return res.status(400).json({ message: 'Quantity must be at least 1' });
  }

  if (Number.isNaN(normalizedPrice) || normalizedPrice < 0) {
    return res.status(400).json({ message: 'Invalid price' });
  }

  try {
    const client = await new Promise((resolve, reject) => {
      db.get(`SELECT id FROM clients WHERE id = ?`, [clientId], (err, row) => {
        if (err) return reject(err);
        return resolve(row);
      });
    });

    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const cartId = await getOrCreateClientCartId(clientId);
    const serializedFrameDetails =
      frame_details == null
        ? null
        : (typeof frame_details === 'string' ? frame_details : JSON.stringify(frame_details));

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO client_cart_items (
            cart_id,
            product_id,
            product_name,
            quantity,
            price,
            image_url,
            uploaded_image_data,
            frame_details
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cartId,
          product_id || null,
          product_name || null,
          normalizedQty,
          normalizedPrice,
          image_url || null,
          uploaded_image_data || null,
          serializedFrameDetails
        ],
        (insertErr) => {
          if (insertErr) return reject(insertErr);
          return resolve();
        }
      );
    });

    const countRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS count FROM client_cart_items WHERE cart_id = ?`,
        [cartId],
        (countErr, row) => {
          if (countErr) return reject(countErr);
          return resolve(row || { count: 0 });
        }
      );
    });

    res.json({
      message: 'Item added to cart',
      count: Number(countRow.count || 0)
    });
  } catch (err) {
    console.error('Add client cart item failed:', err);
    res.status(500).json({ message: 'Failed to add item to cart' });
  }
};

exports.getClientCart = async (req, res) => {
  const { id } = req.params;
  const clientId = Number(id);

  if (!clientId || Number.isNaN(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }

  try {
    const cart = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM client_cart WHERE client_id = ? AND status = 'active'`,
        [clientId],
        (err, row) => {
          if (err) return reject(err);
          return resolve(row);
        }
      );
    });

    if (!cart) {
      return res.json({ items: [], total: 0, count: 0 });
    }

    const items = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, cart_id, product_id, product_name, quantity, price, image_url, uploaded_image_data, frame_details, created_at
         FROM client_cart_items
         WHERE cart_id = ?
         ORDER BY created_at DESC`,
        [cart.id],
        (err, rows) => {
          if (err) return reject(err);
          return resolve(rows || []);
        }
      );
    });

    const total = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);
    const count = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

    res.json({ items, total, count });
  } catch (err) {
    console.error('Get client cart failed:', err);
    res.status(500).json({ message: 'Failed to fetch cart' });
  }
};

exports.getClientCartCount = async (req, res) => {
  const { id } = req.params;
  const clientId = Number(id);

  if (!clientId || Number.isNaN(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }

  try {
    const cart = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM client_cart WHERE client_id = ? AND status = 'active'`,
        [clientId],
        (err, row) => {
          if (err) return reject(err);
          return resolve(row);
        }
      );
    });

    if (!cart) {
      return res.json({ count: 0 });
    }

    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS count FROM client_cart_items WHERE cart_id = ?`,
        [cart.id],
        (err, result) => {
          if (err) return reject(err);
          return resolve(result || { count: 0 });
        }
      );
    });

    res.json({ count: Number(row.count || 0) });
  } catch (err) {
    console.error('Get client cart count failed:', err);
    res.status(500).json({ message: 'Failed to fetch cart count' });
  }
};

exports.removeClientCartItem = async (req, res) => {
  const { id, itemId } = req.params;
  const clientId = Number(id);
  const cartItemId = Number(itemId);

  if (!clientId || Number.isNaN(clientId) || !cartItemId || Number.isNaN(cartItemId)) {
    return res.status(400).json({ message: 'Invalid client id or item id' });
  }

  try {
    const cart = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM client_cart WHERE client_id = ? AND status = 'active'`,
        [clientId],
        (err, row) => {
          if (err) return reject(err);
          return resolve(row);
        }
      );
    });

    if (!cart) {
      return res.status(404).json({ message: 'Active cart not found' });
    }

    await new Promise((resolve, reject) => {
      db.run(
        `DELETE FROM client_cart_items WHERE id = ? AND cart_id = ?`,
        [cartItemId, cart.id],
        function (err) {
          if (err) return reject(err);
          if (!this.changes) return reject(new Error('NOT_FOUND'));
          return resolve();
        }
      );
    });

    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS count FROM client_cart_items WHERE cart_id = ?`,
        [cart.id],
        (err, result) => {
          if (err) return reject(err);
          return resolve(result || { count: 0 });
        }
      );
    });

    res.json({ message: 'Item removed', count: Number(row.count || 0) });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Cart item not found' });
    }
    console.error('Remove client cart item failed:', err);
    res.status(500).json({ message: 'Failed to remove cart item' });
  }
};

exports.updateClientCartItemQuantity = async (req, res) => {
  const { id, itemId } = req.params;
  const { quantity } = req.body || {};
  const clientId = Number(id);
  const cartItemId = Number(itemId);
  const normalizedQty = Number(quantity || 0);

  if (!clientId || Number.isNaN(clientId) || !cartItemId || Number.isNaN(cartItemId)) {
    return res.status(400).json({ message: 'Invalid client id or item id' });
  }

  if (!normalizedQty || normalizedQty < 1) {
    return res.status(400).json({ message: 'Quantity must be at least 1' });
  }

  try {
    const cart = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM client_cart WHERE client_id = ? AND status = 'active'`,
        [clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!cart) {
      return res.status(404).json({ message: 'Active cart not found' });
    }

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE client_cart_items
         SET quantity = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND cart_id = ?`,
        [normalizedQty, cartItemId, cart.id],
        function (err) {
          if (err) return reject(err);
          if (!this.changes) return reject(new Error('NOT_FOUND'));
          return resolve();
        }
      );
    });

    const row = await new Promise((resolve, reject) => {
      db.get(
        `SELECT COALESCE(SUM(quantity), 0) AS count FROM client_cart_items WHERE cart_id = ?`,
        [cart.id],
        (err, result) => (err ? reject(err) : resolve(result || { count: 0 }))
      );
    });

    res.json({ message: 'Quantity updated', count: Number(row.count || 0) });
  } catch (err) {
    if (err.message === 'NOT_FOUND') {
      return res.status(404).json({ message: 'Cart item not found' });
    }
    console.error('Update client cart item quantity failed:', err);
    return res.status(500).json({ message: 'Failed to update quantity' });
  }
};

exports.checkoutClientCart = async (req, res) => {
  const { id } = req.params;
  const clientId = Number(id);

  if (!clientId || Number.isNaN(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }

  try {
    const client = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, name, email, phone FROM clients WHERE id = ?`,
        [clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!client) {
      return res.status(404).json({ message: 'Client not found' });
    }

    const cart = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM client_cart WHERE client_id = ? AND status = 'active'`,
        [clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!cart) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    const items = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, product_id, product_name, quantity, price, image_url, uploaded_image_data, frame_details
         FROM client_cart_items
         WHERE cart_id = ?`,
        [cart.id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    if (!items.length) {
      return res.status(400).json({ message: 'Cart is empty' });
    }

    const total = items.reduce(
      (sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0),
      0
    );

    const orderId = await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO client_orders (client_id, cart_id, total, status, payment_status)
         VALUES (?, ?, ?, 'new', 'unpaid')`,
        [clientId, cart.id, total],
        function (err) {
          if (err) return reject(err);
          return resolve(this.lastID);
        }
      );
    });

    await new Promise((resolve, reject) => {
      const stmt = db.prepare(
        `INSERT INTO client_order_items (
           order_id, product_id, product_name, quantity, price, image_url, uploaded_image_data, frame_details
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const item of items) {
        stmt.run(
          orderId,
          item.product_id || null,
          item.product_name || null,
          Number(item.quantity || 0),
          Number(item.price || 0),
          item.image_url || null,
          item.uploaded_image_data || null,
          item.frame_details || null
        );
      }

      stmt.finalize((err) => (err ? reject(err) : resolve()));
    });

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE client_cart
         SET status = 'checked_out', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cart.id],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const notificationPayload = {
      orderId,
      clientId,
      clientName: client.name || 'Client',
      clientEmail: client.email || null,
      clientPhone: client.phone || null,
      itemCount: items.length,
      total,
      placedAt: new Date().toISOString()
    };

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`,
        ['CLIENT_ORDER_PLACED', JSON.stringify(notificationPayload), null],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('clientOrderPlaced', notificationPayload);
    }

    const adminRows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL AND TRIM(email) <> ''`,
        [],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const adminEmails = [...new Set((adminRows || []).map((row) => row.email).filter(Boolean))];
    if (process.env.ADMIN_EMAIL && !adminEmails.includes(process.env.ADMIN_EMAIL)) {
      adminEmails.push(process.env.ADMIN_EMAIL);
    }

    if (adminEmails.length) {
      const subject = `New Client Order #${orderId}`;
      const html = `
        <p>A new client order has been placed.</p>
        <p><strong>Order ID:</strong> ${orderId}</p>
        <p><strong>Client:</strong> ${client.name || '-'} (ID: ${clientId})</p>
        <p><strong>Email:</strong> ${client.email || '-'}</p>
        <p><strong>Phone:</strong> ${client.phone || '-'}</p>
        <p><strong>Items:</strong> ${items.length}</p>
        <p><strong>Total:</strong> ₹${Number(total).toFixed(2)}</p>
      `;

      await Promise.all(
        adminEmails.map((to) =>
          sendMail({ to, subject, html }).catch((mailErr) => {
            console.warn(`Failed to send order email to ${to}:`, mailErr.message || mailErr);
          })
        )
      );
    }

    return res.json({
      message: 'Order placed successfully',
      orderId,
      total,
      itemCount: items.length
    });
  } catch (err) {
    console.error('Checkout client cart failed:', err);
    return res.status(500).json({ message: 'Failed to checkout cart' });
  }
};

// Get client order history (self-service)
exports.getClientOrders = async (req, res) => {
  const { id } = req.params;
  const clientId = Number(id);

  if (!clientId || Number.isNaN(clientId)) {
    return res.status(400).json({ message: 'Invalid client id' });
  }

  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `
        SELECT
          o.id AS order_id,
          o.total,
          o.status,
          o.payment_status,
          o.created_at,
          o.updated_at,
          i.id AS item_id,
          i.product_id,
          i.product_name,
          i.quantity,
          i.price,
          i.image_url,
          i.uploaded_image_data,
          i.frame_details,
          i.created_at AS item_created_at
        FROM client_orders o
        LEFT JOIN client_order_items i ON i.order_id = o.id
        WHERE o.client_id = ?
        ORDER BY o.created_at DESC, i.created_at DESC
        `,
        [clientId],
        (err, data) => (err ? reject(err) : resolve(data || []))
      );
    });

    const ordersMap = {};

    rows.forEach((row) => {
      const orderId = row.order_id;
      if (!ordersMap[orderId]) {
        ordersMap[orderId] = {
          id: orderId,
          total: Number(row.total || 0),
          status: row.status || 'placed',
          payment_status: row.payment_status || 'unpaid',
          created_at: row.created_at,
          updated_at: row.updated_at,
          items: []
        };
      }

      if (row.item_id) {
        ordersMap[orderId].items.push({
          id: row.item_id,
          product_id: row.product_id,
          product_name: row.product_name,
          quantity: Number(row.quantity || 0),
          price: Number(row.price || 0),
          image_url: row.image_url,
          uploaded_image_data: row.uploaded_image_data,
          frame_details: row.frame_details,
          created_at: row.item_created_at
        });
      }
    });

    res.json({ orders: Object.values(ordersMap) });
  } catch (err) {
    console.error('Failed to fetch client orders:', err);
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
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

    let rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, event_id, staff_id, type, title, s3_key, status, created_at
         FROM event_assets
         WHERE event_id = ?
         ORDER BY created_at DESC`,
        [eventId],
        (err, data) => (err ? reject(err) : resolve(data || []))
      );
    });

    if (!rows.length) {
      rows = await getFallbackEventMediaFromNotifications(eventId);
    }

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

    let assets = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, s3_key, title, type FROM event_assets WHERE event_id = ? ORDER BY created_at DESC`,
        [eventId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    if (!assets.length) {
      assets = await getFallbackEventMediaFromNotifications(eventId);
    }

    if (!assets.length) {
      return res.status(404).json({ message: 'No media available for this event' });
    }

    await new Promise((resolve, reject) => db.run(
      `UPDATE events SET client_downloaded_at = COALESCE(client_downloaded_at, CURRENT_TIMESTAMP) WHERE id = ?`,
      [eventId], (err) => err ? reject(err) : resolve()
    ));

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
          const safeName = buildArchiveFileName(asset);
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

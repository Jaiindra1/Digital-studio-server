const db = require('../db/db');

// GET /api/clients
exports.getAll = (req, res) => {
  db.all(
    `SELECT * FROM clients ORDER BY created_at DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
};

// POST /api/clients
exports.create = (req, res) => {
  const { name, phone, email, address, notes } = req.body;

  if (!name || !phone) {
    return res.status(400).json({ error: 'Name and phone are required' });
  }

  const sql = `
    INSERT INTO clients (name, phone, email, address, notes)
    VALUES (?, ?, ?, ?, ?)
  `;

  db.run(sql, [name, phone, email, address, notes], function (err) {
    if (err) return res.status(500).json({ error: err.message });

    const clientId = this.lastID;
    const payload = JSON.stringify({ clientId, name, phone, email });

    db.run(`INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`, ['NEW_CLIENT', payload, null], function (nErr) {
      if (nErr) console.warn('Failed to persist new client notification:', nErr.message);

      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('newClient', JSON.parse(payload));
      }

      res.status(201).json({ id: clientId, name, phone, email });
    });
  });
};

// PUT /api/clients/:id
exports.update = (req, res) => {
  const { id } = req.params;
  const { name, phone, email, address, notes } = req.body;

  const sql = `
    UPDATE clients
    SET name = ?, phone = ?, email = ?, address = ?, notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(sql, [name, phone, email, address, notes, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: 'Client not found' });

    res.json({ message: 'Client updated' });
  });
};

// GET /api/clients/:id/orders
exports.getOrdersForClient = async (req, res) => {
  const clientId = Number(req.params.id);

  if (!clientId || Number.isNaN(clientId)) {
    return res.status(400).json({ error: 'Invalid client id' });
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
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
};

// PATCH /api/clients/:id/orders/:orderId
exports.updateOrderForClient = async (req, res) => {
  const clientId = Number(req.params.id);
  const orderId = Number(req.params.orderId);
  const { status, payment_status, total } = req.body || {};

  const allowedStatus = ['placed', 'processing', 'completed', 'cancelled'];
  const allowedPayment = ['unpaid', 'partial', 'paid'];

  if (!clientId || Number.isNaN(clientId) || !orderId || Number.isNaN(orderId)) {
    return res.status(400).json({ error: 'Invalid client or order id' });
  }

  if (status && !allowedStatus.includes(String(status))) {
    return res.status(400).json({ error: 'Invalid status value' });
  }

  if (payment_status && !allowedPayment.includes(String(payment_status))) {
    return res.status(400).json({ error: 'Invalid payment status value' });
  }

  try {
    const exists = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM client_orders WHERE id = ? AND client_id = ?`,
        [orderId, clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!exists) {
      return res.status(404).json({ error: 'Order not found for this client' });
    }

    const updates = [];
    const params = [];

    if (status) {
      updates.push('status = ?');
      params.push(status);
    }

    if (payment_status) {
      updates.push('payment_status = ?');
      params.push(payment_status);
    }

    if (total !== undefined) {
      const numericTotal = Number(total);
      if (Number.isNaN(numericTotal) || numericTotal < 0) {
        return res.status(400).json({ error: 'Invalid total value' });
      }
      updates.push('total = ?');
      params.push(numericTotal);
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const sql = `UPDATE client_orders SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id = ?`;
    params.push(orderId, clientId);

    await new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        if (!this.changes) return reject(new Error('NOT_UPDATED'));
        resolve();
      });
    });

    const orderRow = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, total, status, payment_status, created_at, updated_at FROM client_orders WHERE id = ?`,
        [orderId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    const items = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, product_id, product_name, quantity, price, image_url, uploaded_image_data, frame_details, created_at
         FROM client_order_items WHERE order_id = ? ORDER BY created_at DESC`,
        [orderId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    res.json({
      order: {
        ...orderRow,
        items
      }
    });
  } catch (err) {
    if (err.message === 'NOT_UPDATED') {
      return res.status(400).json({ error: 'Order not updated' });
    }
    console.error('Failed to update client order:', err);
    res.status(500).json({ error: 'Failed to update order' });
  }
};


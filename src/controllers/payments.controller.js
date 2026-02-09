const db = require('../db/db');

// POST /api/payments/notify
exports.notify = async (req, res) => {
  const { invoiceId, amount, clientId, clientName, method, reference } = req.body;

  if (!invoiceId || !amount) {
    return res.status(400).json({ error: 'invoiceId and amount are required' });
  }

  try {
    const payload = JSON.stringify({ invoiceId, amount, clientId: clientId || null, clientName: clientName || null, method: method || null, reference: reference || null, timestamp: new Date().toISOString() });

    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`, ['PAYMENT_RECEIVED', payload, null], (err) => (err ? reject(err) : resolve()));
    });

    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('paymentReceived', JSON.parse(payload));
    }

    res.json({ message: 'Notification persisted and emitted' });
  } catch (err) {
    console.error('Payment notify error:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/payments/record
exports.record = async (req, res) => {
  const { eventId, amount, method, reference, type } = req.body;
  const recordedBy = req.user?.id;

  if (!eventId || !amount || !type) {
    return res.status(400).json({ error: 'eventId, amount, and payment type are required' });
  }

  try {
    // 1. Check if payment of this type already exists for the event
    const existingPayment = await new Promise((resolve, reject) => {
      db.get(
        `SELECT p.id, p.recorded_by
         FROM payments p
         WHERE p.event_id = ? AND p.payment_type = ?`,
        [eventId, type],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (existingPayment) {
      return res.status(401).json({
        error: `Payment"${type}" already recorded`,
        recordedBy: existingPayment.recordedByName || existingPayment.recorded_by
      });
    }

    // 2. Insert payment
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO payments (event_id, amount, method, reference, recorded_by, payment_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, amount, method || null, reference || null, recordedBy, type],
        (err) => (err ? reject(err) : resolve())
      );
    });

    // 3. Get event details for notification
    const event = await new Promise((resolve, reject) => {
      db.get(
        `SELECT e.*, c.name AS clientName
         FROM events e
         JOIN clients c ON e.client_id = c.id
         WHERE e.id = ?`,
        [eventId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // 4. Create notification payload
    const payload = JSON.stringify({
      invoiceId: `BK-${eventId}`,
      amount,
      clientId: event.client_id,
      clientName: event.clientName,
      method: method || 'Manual',
      reference: reference || null,
      paymentType: type,
      recordedBy,
      timestamp: new Date().toISOString()
    });

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO notifications (type, payload, user_id)
         VALUES (?, ?, ?)`,
        ['PAYMENT_RECEIVED', payload, null],
        (err) => (err ? reject(err) : resolve())
      );
    });

    // 5. Emit to admins
    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('paymentReceived', JSON.parse(payload));
    }

    res.json({ message: 'Payment recorded successfully' });

  } catch (err) {
    console.error('Payment record error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getPayments = async (req, res) => {
  const { eventId } = req.params;

  if (!eventId) {
    return res.status(400).json({ error: 'eventId is required' });
  }

  try {
    const payments = await new Promise((resolve, reject) => {
      let query = `
        SELECT 
          p.id,
          p.event_id,
          p.amount,
          p.method,
          p.reference,
          p.payment_type,
          p.recorded_by,
          p.created_at
        FROM payments p
        WHERE p.event_id = ?
      `;

      const params = [eventId];

      query += ` ORDER BY p.created_at DESC`;

      db.all(query, params, (err, rows) =>
        err ? reject(err) : resolve(rows)
      );
    });

    if (!payments.length) {
      return res.status(404).json({ message: 'No payments found' });
    }

    res.json({
      eventId,
      count: payments.length,
      payments
    });

  } catch (err) {
    console.error('Get payment details error:', err);
    res.status(500).json({ error: err.message });
  }
};

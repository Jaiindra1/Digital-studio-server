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
  const { eventId, amount, method, reference } = req.body;
  const recordedBy = req.user?.id; // from auth middleware

  if (!eventId || !amount) {
    return res.status(400).json({ error: 'eventId and amount are required' });
  }

  try {
    // Insert payment
    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO payments (event_id, amount, method, reference, recorded_by) VALUES (?, ?, ?, ?, ?)`, [eventId, amount, method || null, reference || null, recordedBy], (err) => (err ? reject(err) : resolve()));
    });

    // Get event details for notification
    const event = await new Promise((resolve, reject) => {
      db.get(`SELECT e.*, c.name as clientName FROM events e JOIN clients c ON e.client_id = c.id WHERE e.id = ?`, [eventId], (err, row) => (err ? reject(err) : resolve(row)));
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Create notification payload
    const payload = JSON.stringify({
      invoiceId: `BK-${eventId}`,
      amount,
      clientId: event.client_id,
      clientName: event.clientName,
      method: method || 'Manual',
      reference: reference || null,
      timestamp: new Date().toISOString()
    });

    await new Promise((resolve, reject) => {
      db.run(`INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`, ['PAYMENT_RECEIVED', payload, null], (err) => (err ? reject(err) : resolve()));
    });

    // Emit to admins
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

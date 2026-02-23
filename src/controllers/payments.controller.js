const db = require('../db/db');
const { getNotificationSettings } = require('./notifications.controller');

// POST /api/payments/notify
exports.notify = async (req, res) => {
  const { invoiceId, amount, clientId, clientName, method, reference } = req.body;

  if (!invoiceId || !amount) {
    return res.status(400).json({ error: 'invoiceId and amount are required' });
  }

  try {
    const settings = await getNotificationSettings().catch((e) => {
      console.warn('Failed to load notification settings for payments.notify:', e.message || e);
      return null;
    });

    const alerts = settings && settings.bookingAlerts ? settings.bookingAlerts : null;
    const notificationsEnabled = !alerts || alerts.depositReceived !== false;

    const payload = JSON.stringify({
      invoiceId,
      amount,
      clientId: clientId || null,
      clientName: clientName || null,
      method: method || null,
      reference: reference || null,
      timestamp: new Date().toISOString(),
    });

    if (notificationsEnabled) {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`,
          ['PAYMENT_RECEIVED', payload, null],
          (err) => (err ? reject(err) : resolve())
        );
      });

      const io = req.app.get('io');
      if (io) {
        io.to('admins').emit('paymentReceived', JSON.parse(payload));
      }

      res.json({ message: 'Notification persisted and emitted' });
    } else {
      res.json({ message: 'Payment notification suppressed by settings' });
    }
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

    // 4. Create notification payload (respect bookingAlerts.depositReceived setting)
    const settings = await getNotificationSettings().catch((e) => {
      console.warn('Failed to load notification settings for payments.record:', e.message || e);
      return null;
    });

    const alerts = settings && settings.bookingAlerts ? settings.bookingAlerts : null;
    const notificationsEnabled = !alerts || alerts.depositReceived !== false;

    if (notificationsEnabled) {
      const payload = JSON.stringify({
        invoiceId: `BK-${eventId}`,
        amount,
        clientId: event.client_id,
        clientName: event.clientName,
        method: method || 'Manual',
        reference: reference || null,
        paymentType: type,
        recordedBy,
        timestamp: new Date().toISOString(),
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
    }

    res.json({
      message: notificationsEnabled
        ? 'Payment recorded successfully'
        : 'Payment recorded successfully (payment alerts disabled)',
    });

  } catch (err) {
    console.error('Payment record error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getPaymentsOverview = async (req, res) => {
  try {
    const { range } = req.query;

    let dateFilter = "";
    let params = [];

    if (range === "30d") {
      dateFilter = "AND e.event_date >= date('now','-30 day')";
    }
    else if (range === "quarter") {
      dateFilter = `
        AND strftime('%Y', e.event_date) = strftime('%Y', 'now')
        AND ((cast(strftime('%m','now') as int)-1)/3) =
            ((cast(strftime('%m',e.event_date) as int)-1)/3)
      `;
    }
    else if (range === "ytd") {
      dateFilter = "AND e.event_date >= date(strftime('%Y-01-01','now'))";
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT
          e.id as event_id,
          e.amount as total_amount,
          e.advance as advance_amount,
          (SELECT SUM(p.amount) FROM payments p WHERE p.event_id = e.id) as other_payments
        FROM events e
        WHERE e.status != 'CANCELLED'
        ${dateFilter}`,
        params,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    let totalRevenue = 0;
    let totalPaid = 0;
    let pendingEvents = 0;
    let paidEvents = 0;

    rows.forEach(row => {
      const total = parseFloat(row.total_amount) || 0;
      const advance = parseFloat(row.advance_amount) || 0;
      const other = parseFloat(row.other_payments) || 0;
      const paid = advance + other;

      totalRevenue += total;
      totalPaid += paid;

      if (total > paid) pendingEvents++;
      else if (total > 0 && total <= paid) paidEvents++;
    });

    res.json({
      summary: {
        total_revenue: totalRevenue,
        total_paid: totalPaid,
        total_pending: totalRevenue - totalPaid,
        pending_events_count: pendingEvents,
        fully_paid_events_count: paidEvents,
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};


exports.getPayments = async (req, res) => {
  const { eventId } = req.params;

  try {
      // Fetch all payments for the event
      const payments = await new Promise((resolve, reject) => {
        db.all(
          'SELECT id, amount, method, payment_type as status, created_at as date FROM payments WHERE event_id = ? ORDER BY created_at ASC',
          [eventId],
          (err, rows) => (err ? reject(err) : resolve(rows))
        );
      });

      // Fetch event total amount and advance from events table
      const event = await new Promise((resolve, reject) => {
        db.get('SELECT amount, advance FROM events WHERE id = ?', [eventId], (err, row) => (err ? reject(err) : resolve(row)));
      });

      const total = event ? parseFloat(event.amount) : 0;
      const advance = event && event.advance ? parseFloat(event.advance) : 0;
      // Sum of all payments made (excluding advance field)
      const paidPayments = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      // Total paid = advance (from event) + sum of payments
      const paid = advance + paidPayments;
      res.json({
        payments,
        summary: {
          total_amount: total,
          advance_amount: advance,
          paid_amount: paid,
          remaining_amount: total - paid
        }
      });
    } catch (err) {
      console.error('Error fetching payments:', err);
      res.status(500).json({ error: 'Failed to fetch payment details' });
    }
};

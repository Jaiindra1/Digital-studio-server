const db = require('../config/db');
const { getNotificationSettings } = require('./notifications.controller');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587,
  secure: process.env.EMAIL_PORT === '465',
  auth: process.env.EMAIL_USER
    ? {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      }
    : undefined,
});

function getRazorpayClient() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();

  if (!keyId || !keySecret) {
    return { client: null, error: 'Razorpay key ID/secret is missing on the server.' };
  }

  return {
    client: new Razorpay({
      key_id: keyId,
      key_secret: keySecret,
    }),
    error: null,
  };
}

function sendMailWithFallback(mailOptions) {
  return new Promise((resolve, reject) => {
    const usingRealEmail = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER);

    if (!usingRealEmail) {
      console.log('Dev mode: Simulated payment reminder email');
      console.log('To:', mailOptions.to);
      console.log('Subject:', mailOptions.subject);
      return resolve({ simulated: true });
    }

    transporter.sendMail(mailOptions, (err, info) => {
      if (err) return reject(err);
      resolve(info);
    });
  });
}

async function getEventPaymentSnapshot(eventId) {
  const event = await new Promise((resolve, reject) => {
    db.get(
      `SELECT e.*, c.name AS clientName, c.email AS clientEmail, c.phone AS clientPhone
       FROM events e
       JOIN clients c ON e.client_id = c.id
       WHERE e.id = ?`,
      [eventId],
      (err, row) => (err ? reject(err) : resolve(row))
    );
  });

  if (!event) return null;

  const payments = await new Promise((resolve, reject) => {
    db.all(
      `SELECT id, amount, method, reference, payment_type, created_at
       FROM payments
       WHERE event_id = ?
       ORDER BY created_at ASC`,
      [eventId],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });

  const total = parseFloat(event.amount) || 0;
  const advance = parseFloat(event.advance_amount) || 0;
  const paidFromPayments = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const advancePaid = payments
    .filter((p) => String(p.payment_type || '').toUpperCase().replace(/\s+/g, '_') === 'ADVANCE')
    .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const advanceDue = Math.max(advance - advancePaid, 0);
  const paid = paidFromPayments;
  const remaining = Math.max(total - paid, 0);

  return {
    event,
    payments,
    summary: {
      total_amount: total,
      advance_amount: advance,
      advance_paid: advancePaid,
      advance_due: advanceDue,
      paid_amount: paid,
      remaining_amount: remaining,
    },
  };
}

async function emitPaymentRecorded(req, { eventId, amount, method, reference, type, recordedBy = null }) {
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
    throw new Error('Event not found');
  }

  const settings = await getNotificationSettings().catch((e) => {
    console.warn('Failed to load notification settings for payment emit:', e.message || e);
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
      method: method || 'Online',
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

    const io = req.app.get('io');
    if (io) {
      io.to('admins').emit('paymentReceived', JSON.parse(payload));
    }
  }

  return event;
}

exports.createRazorpayOrder = async (req, res) => {
  const { eventId, clientId, paymentType = 'Total Amount', amount } = req.body || {};
  const { client: razorpay, error: razorpayConfigError } = getRazorpayClient();

  if (!razorpay) {
    return res.status(500).json({ error: razorpayConfigError || 'Razorpay is not configured on the server' });
  }

  if (!eventId || !clientId) {
    return res.status(400).json({ error: 'eventId and clientId are required' });
  }

  try {
    const snapshot = await getEventPaymentSnapshot(eventId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (Number(snapshot.event.client_id) !== Number(clientId)) {
      return res.status(403).json({ error: 'This event does not belong to the client' });
    }

    // Calculate advance due (advance amount minus any advance payments already made)
    const advancePayments = snapshot.payments
      .filter(p => (p.payment_type || '').toUpperCase().includes('ADVANCE'))
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const advanceDue = Math.max(0, (parseFloat(snapshot.event.advance_amount) || 0) - advancePayments);

    // Determine payment amount based on type
    let paymentAmount = 0;
    if (paymentType && paymentType.toUpperCase().includes('ADVANCE')) {
      if (advanceDue <= 0) {
        return res.status(400).json({ error: 'Advance is already fully paid' });
      }
      paymentAmount = advanceDue;
    } else {
      // Full payment or balance
      if (snapshot.summary.remaining_amount <= 0) {
        return res.status(400).json({ error: 'This event is already fully paid' });
      }
      paymentAmount = amount || snapshot.summary.remaining_amount;
    }

    const amountPaise = Math.round(paymentAmount * 100);
    const receipt = `event_${eventId}_${Date.now()}`;

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        eventId: String(eventId),
        clientId: String(clientId),
        paymentType: paymentType || 'Total Amount',
      },
    });

    return res.json({
      order,
      key: process.env.RAZORPAY_KEY_ID,
      amount: paymentAmount,
      paymentType: paymentType || 'Total Amount',
      summary: {
        ...snapshot.summary,
        advance_due: advanceDue,
      },
      client: {
        name: snapshot.event.clientName || 'Client',
        email: snapshot.event.clientEmail || '',
        contact: snapshot.event.clientPhone || '',
      },
      event: {
        id: snapshot.event.id,
        type: snapshot.event.event_type,
      },
    });
  } catch (err) {
    console.error('Create Razorpay order error:', err);
    return res.status(500).json({
      error: 'Failed to create Razorpay order',
      details: err?.error?.description || err?.message || 'Unknown Razorpay error',
    });
  }
};

exports.verifyRazorpayPayment = async (req, res) => {
  const {
    eventId,
    clientId,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    paymentType = 'Total Amount',
  } = req.body || {};

  const { error: razorpayConfigError } = getRazorpayClient();

  if (!process.env.RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: razorpayConfigError || 'Razorpay is not configured on the server' });
  }

  if (!eventId || !clientId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing Razorpay payment verification fields' });
  }

  try {
    const snapshot = await getEventPaymentSnapshot(eventId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Event not found' });
    }

    if (Number(snapshot.event.client_id) !== Number(clientId)) {
      return res.status(403).json({ error: 'This event does not belong to the client' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid Razorpay signature' });
    }

    const existingPayment = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id FROM payments WHERE reference = ?`,
        [razorpay_payment_id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (existingPayment) {
      return res.json({ message: 'Payment already verified', duplicate: true });
    }

    // Calculate advance due for this payment
    const advancePayments = snapshot.payments
      .filter(p => (p.payment_type || '').toUpperCase().includes('ADVANCE'))
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const advanceDue = Math.max(0, (parseFloat(snapshot.event.advance_amount) || 0) - advancePayments);

    // Determine amount to record based on payment type
    let amountToRecord = 0;
    let paymentTypeToRecord = paymentType || 'Total Amount';
    
    if (paymentTypeToRecord.toUpperCase().includes('ADVANCE')) {
      amountToRecord = advanceDue;
      paymentTypeToRecord = 'Advance';
    } else {
      amountToRecord = snapshot.summary.remaining_amount;
      paymentTypeToRecord = 'Total Amount';
    }

    if (amountToRecord <= 0) {
      return res.status(400).json({ error: 'No pending amount to record for this event' });
    }

    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO payments (event_id, amount, method, reference, recorded_by, payment_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, amountToRecord, 'Razorpay', razorpay_payment_id, null, paymentTypeToRecord],
        (err) => (err ? reject(err) : resolve())
      );
    });

    await emitPaymentRecorded(req, {
      eventId,
      amount: amountToRecord,
      method: 'Razorpay',
      reference: razorpay_payment_id,
      type: paymentTypeToRecord,
      recordedBy: null,
    });

    return res.json({
      message: 'Payment verified and recorded successfully',
      paymentId: razorpay_payment_id,
    });
  } catch (err) {
    console.error('Verify Razorpay payment error:', err);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
};

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
    const snapshot = await getEventPaymentSnapshot(eventId);
    if (!snapshot) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const requestedAmount = Number(amount) || 0;
    const normalizedType = String(type || '').toUpperCase().replace(/\s+/g, '_');
    const advanceDue = Number(snapshot.summary.advance_due) || 0;
    const remainingAmount = Number(snapshot.summary.remaining_amount) || 0;

    if (normalizedType === 'ADVANCE') {
      if (advanceDue <= 0) {
        return res.status(400).json({ error: 'Advance is already fully paid' });
      }

      if (requestedAmount > advanceDue) {
        return res.status(400).json({
          error: `Advance payment cannot exceed the remaining advance due of ${advanceDue}`,
        });
      }
    } else {
      if (remainingAmount <= 0) {
        return res.status(400).json({ error: 'This event is already fully paid' });
      }

      if (requestedAmount > remainingAmount) {
        return res.status(400).json({
          error: `Payment cannot exceed the remaining balance of ${remainingAmount}`,
        });
      }
    }

    // 1. Check if payment of this type already exists for the event
    const existingPayment = await new Promise((resolve, reject) => {
      db.get(
        `SELECT p.id, p.amount, p.recorded_by
         FROM payments p
         WHERE p.event_id = ? AND p.payment_type = ?`,
        [eventId, type],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (existingPayment) {
      const updatedAmount = (Number(existingPayment.amount) || 0) + requestedAmount;

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE payments
           SET amount = ?, method = ?, reference = ?, recorded_by = ?
           WHERE id = ?`,
          [updatedAmount, method || null, reference || null, recordedBy, existingPayment.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      await emitPaymentRecorded(req, {
        eventId,
        amount: requestedAmount,
        method: method || 'Manual',
        reference: reference || null,
        type,
        recordedBy,
      });

      return res.json({
        message: 'Payment updated successfully',
        updated: true,
      });
    }

    // 2. Insert payment
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO payments (event_id, amount, method, reference, recorded_by, payment_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [eventId, requestedAmount, method || null, reference || null, recordedBy, type],
        (err) => (err ? reject(err) : resolve())
      );
    });

    await emitPaymentRecorded(req, {
      eventId,
      amount: requestedAmount,
      method: method || 'Manual',
      reference: reference || null,
      type,
      recordedBy,
    });

    res.json({
      message: 'Payment recorded successfully',
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
          e.advance_amount as advance_amount,
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

exports.getPendingPayments = async (_req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT
           e.id AS event_id,
           e.event_type,
           e.event_date,
           e.amount AS total_amount,
           e.advance_amount AS advance_amount,
           c.id AS client_id,
           c.name AS client_name,
           c.email AS client_email,
           c.phone AS client_phone
         FROM events e
         JOIN clients c ON c.id = e.client_id
         WHERE e.status != 'CANCELLED'
         ORDER BY e.event_date ASC`,
        [],
        (err, data) => (err ? reject(err) : resolve(data || []))
      );
    });

    const pending = [];

    for (const row of rows) {
      const paymentRows = await new Promise((resolve, reject) => {
        db.all(
          `SELECT amount FROM payments WHERE event_id = ?`,
          [row.event_id],
          (err, data) => (err ? reject(err) : resolve(data || []))
        );
      });

      const total = parseFloat(row.total_amount) || 0;
      const advance = parseFloat(row.advance_amount) || 0;
      const paidFromPayments = paymentRows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      const paid = advance + paidFromPayments;
      const remaining = Math.max(total - paid, 0);

      if (remaining <= 0) continue;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const eventDate = row.event_date ? new Date(row.event_date) : null;
      let dueLabel = 'Upcoming';

      if (eventDate && !Number.isNaN(eventDate.getTime())) {
        eventDate.setHours(0, 0, 0, 0);
        if (eventDate < today) dueLabel = 'Overdue';
        else if (eventDate.getTime() === today.getTime()) dueLabel = 'Due Today';
      }

      pending.push({
        eventId: row.event_id,
        clientId: row.client_id,
        clientName: row.client_name,
        clientEmail: row.client_email,
        clientPhone: row.client_phone,
        eventType: row.event_type,
        eventDate: row.event_date,
        totalAmount: total,
        paidAmount: paid,
        remainingAmount: remaining,
        dueLabel,
      });
    }

    pending.sort((a, b) => b.remainingAmount - a.remainingAmount);

    res.json({
      pending,
      count: pending.length,
    });
  } catch (err) {
    console.error('Error fetching pending payments:', err);
    res.status(500).json({ error: 'Failed to fetch pending payments' });
  }
};

exports.sendPendingPaymentReminder = async (req, res) => {
  const { eventId } = req.params;

  try {
    const event = await new Promise((resolve, reject) => {
      db.get(
        `SELECT
           e.id AS event_id,
           e.event_type,
           e.event_date,
           e.amount AS total_amount,
           e.advance_amount AS advance_amount,
           c.name AS client_name,
           c.email AS client_email
         FROM events e
         JOIN clients c ON c.id = e.client_id
         WHERE e.id = ?`,
        [eventId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.client_email) return res.status(400).json({ error: 'Client email is missing' });

    const payments = await new Promise((resolve, reject) => {
      db.all(
        `SELECT amount FROM payments WHERE event_id = ?`,
        [eventId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const total = parseFloat(event.total_amount) || 0;
    const advance = parseFloat(event.advance_amount) || 0;
    const paidFromPayments = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const paid = advance + paidFromPayments;
    const remaining = Math.max(total - paid, 0);

    if (remaining <= 0) {
      return res.status(400).json({ error: 'No pending amount for this event' });
    }

    const subject = `Payment Reminder: ${event.event_type || 'Booking'} (Event #${eventId})`;
    const html = `
      <p>Hi ${event.client_name || 'Client'},</p>
      <p>This is a reminder that a payment is pending for your booking.</p>
      <p><strong>Event:</strong> ${event.event_type || 'Photography Session'}<br/>
      <strong>Event Date:</strong> ${event.event_date || '-'}<br/>
      <strong>Total Amount:</strong> ${total.toFixed(2)}<br/>
      <strong>Paid:</strong> ${paid.toFixed(2)}<br/>
      <strong>Remaining:</strong> ${remaining.toFixed(2)}</p>
      <p>Please contact us to complete the payment.</p>
      <p>Thank you.</p>
    `;

    await sendMailWithFallback({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@studio.com',
      to: event.client_email,
      subject,
      html,
    });

    res.json({ message: 'Payment reminder sent successfully' });
  } catch (err) {
    console.error('Error sending payment reminder:', err);
    res.status(500).json({ error: 'Failed to send payment reminder' });
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
        db.get('SELECT amount, advance_amount FROM events WHERE id = ?', [eventId], (err, row) => (err ? reject(err) : resolve(row)));
      });

      const total = event ? parseFloat(event.amount) : 0;
      const advance = event && event.advance_amount ? parseFloat(event.advance_amount) : 0;
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

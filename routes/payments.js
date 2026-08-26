// backend/routes/payments.js
const express = require('express');
const router = express.Router();
const db = require('../data/db'); // adjust path as needed

// GET /api/events/:id/payments
router.get('/events/:id/payments', async (req, res) => {
  const eventId = req.params.id;
  try {
    // Fetch all payments for the event
    const payments = await db.all(
      'SELECT id, amount, method, status, date FROM payments WHERE event_id = ? ORDER BY date ASC',
      [eventId]
    );
    // Fetch event total amount and advance from events table
    const event = await db.get('SELECT amount, advance FROM events WHERE id = ?', [eventId]);
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
        paid_amount: paid,
        remaining_amount: total - paid
      }
    });
  } catch (err) {
    console.error('Error fetching payments:', err);
    res.status(500).json({ error: 'Failed to fetch payment details' });
  }
});

module.exports = router;

const db = require('../config/db');

const toDateString = (date) => date.toISOString().slice(0, 10);

exports.getAdminSummary = async (_req, res) => {
  try {
    const now = new Date();
    const today = toDateString(now);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const startOfWeek = new Date(now);
    const day = startOfWeek.getDay();
    const mondayOffset = day === 0 ? -6 : 1 - day; // Week starts on Monday
    startOfWeek.setDate(startOfWeek.getDate() + mondayOffset);

    const bookingsRow = (await db.query(
      `SELECT
         SUM(CASE WHEN date(event_date) = date(?) THEN 1 ELSE 0 END) AS bookings_today,
         SUM(CASE WHEN date(event_date) BETWEEN date(?) AND date(?) THEN 1 ELSE 0 END) AS bookings_this_month,
         SUM(CASE WHEN date(event_date) BETWEEN date(?) AND date(?) THEN 1 ELSE 0 END) AS bookings_last_month
       FROM events
       WHERE status != 'CANCELLED'`,
      [
        today,
        toDateString(startOfMonth),
        toDateString(endOfMonth),
        toDateString(startOfLastMonth),
        toDateString(endOfLastMonth),
      ]
    )).rows[0] || {};

    const clientsRow = (await db.query(
      `SELECT
         COUNT(*) AS total_clients,
         SUM(CASE WHEN date(created_at) >= date(?) THEN 1 ELSE 0 END) AS new_clients_week
       FROM clients`,
      [toDateString(startOfWeek)]
    )).rows[0] || {};

    const paymentRows = (await db.query(
      `SELECT
         e.id,
         COALESCE(e.amount, e.total_amount, 0) AS total_amount,
         COALESCE(e.advance, 0) AS advance_amount,
         COALESCE(SUM(p.amount), 0) AS paid_payments,
         e.event_date
       FROM events e
       LEFT JOIN payments p ON p.event_id = e.id
       WHERE e.status != 'CANCELLED'
       GROUP BY e.id, e.amount, e.total_amount, e.advance, e.event_date`
    )).rows;

    let pendingAmount = 0;
    let overdueInvoices = 0;
    const todayDate = new Date(today);

    paymentRows.forEach((row) => {
      const total = Number(row.total_amount) || 0;
      const advance = Number(row.advance_amount) || 0;
      const paid = Number(row.paid_payments) || 0;
      const remaining = Math.max(total - (advance + paid), 0);

      pendingAmount += remaining;

      if (remaining > 0 && row.event_date) {
        const eventDate = new Date(row.event_date);
        if (!Number.isNaN(eventDate.getTime()) && eventDate < todayDate) {
          overdueInvoices += 1;
        }
      }
    });

    const bookingsToday = Number(bookingsRow.bookings_today) || 0;
    const bookingsThisMonth = Number(bookingsRow.bookings_this_month) || 0;
    const bookingsLastMonth = Number(bookingsRow.bookings_last_month) || 0;

    let bookingsGrowth = null;
    if (bookingsLastMonth > 0) {
      bookingsGrowth = ((bookingsThisMonth - bookingsLastMonth) / bookingsLastMonth) * 100;
    } else if (bookingsThisMonth > 0) {
      bookingsGrowth = 100;
    }

    res.json({
      bookings: {
        today: bookingsToday,
        thisMonth: bookingsThisMonth,
        lastMonth: bookingsLastMonth,
        growthPct: bookingsGrowth !== null ? Number(bookingsGrowth.toFixed(1)) : null,
      },
      clients: {
        total: Number(clientsRow.total_clients) || 0,
        newThisWeek: Number(clientsRow.new_clients_week) || 0,
      },
      payments: {
        pendingAmount: Number(pendingAmount.toFixed(2)),
        overdueCount: overdueInvoices,
      },
    });
  } catch (err) {
    console.error('Failed to load dashboard summary:', err.message || err);
    res.status(500).json({ error: 'Failed to load dashboard summary' });
  }
};

exports.getStaffFeedback = async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT
         es.staff_id AS staffId,
         s.name,
         s.role,
         s.status,
         AVG(f.rating) AS avg_rating,
         COUNT(f.id) AS feedback_count,
         COUNT(DISTINCT es.event_id) AS events_with_feedback
       FROM feedback f
       JOIN event_staff es ON es.event_id = f.event_id
       JOIN staff s ON s.id = es.staff_id
       GROUP BY es.staff_id, s.name, s.role, s.status`
    );

    const data = rows.rows.map((r) => ({
      staffId: r.staffId,
      name: r.name,
      role: r.role,
      status: r.status,
      avgRating: r.avg_rating !== null && r.avg_rating !== undefined ? Number(r.avg_rating) : null,
      feedbackCount: Number(r.feedback_count) || 0,
      eventsWithFeedback: Number(r.events_with_feedback) || 0,
    }));

    res.json({ staff: data });
  } catch (err) {
    console.error('Failed to load staff feedback summary:', err.message || err);
    res.status(500).json({ error: 'Failed to load staff feedback summary' });
  }
};

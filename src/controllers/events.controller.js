const db = require('../db/db');
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
      e.amount_status,
      c.id AS client_id,
      c.name AS client_name,
      c.phone AS client_phone,
      s.id AS staff_id,
      s.name AS staff_name,
      s.role AS staff_role
    FROM events e
    JOIN clients c ON c.id = e.client_id
    LEFT JOIN event_staff es ON es.event_id = e.id
    LEFT JOIN staff s ON s.id = es.staff_id
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
          id: row.event_id,
          eventType: row.event_type,
          eventDate: row.event_date,
          startTime: row.start_time,
          endTime: row.end_time,
          location: row.location,
          status: row.status,
          createdAt: row.created_at,
          amount: row.amount,
          amount_status: row.amount_status,
          client: {
            id: row.client_id,
            name: row.client_name,
            phone: row.client_phone
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

 // 3. Update event amount and set amount_status to 1 (paid)
exports.updateAmount = (req, res) => {
  const { eventId } = req.params;
  const { amount } = req.body;

  if (amount === undefined || amount < 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const sql = `
    UPDATE events
    SET amount = ?, amount_status = 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `;

  db.run(sql, [amount, eventId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: 'Event not found' });

    res.json({
      message: 'Amount updated successfully',
      eventId,
      amount,
      amount_status: 1
    });
  });
};

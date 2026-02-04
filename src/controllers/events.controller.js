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
    e.Stage,
    e.venue,
    e.guest_count,
    e.enquiry_message,
    e.amount_status,

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
  if (status !== undefined) { updates.push('status = ?'); values.push(status); }
  if (stage !== undefined) { updates.push('stage = ?'); values.push(stage); }
  if (amount !== undefined) { updates.push('amount = ?'); values.push(amount); }


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
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: 'Event not found' });

    res.json({
      message: 'Event updated successfully',
      eventId,
      updatedFields: req.body
    });
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

      db.run(`INSERT INTO event_cancellations (event_id, admin_id, admin_email, reason) VALUES (?, ?, ?, ?)`, [eventId, adminId, adminEmail, reason || null], (err) => {
        if (err) {
          console.error('Failed to save cancellation reason:', err);
          return res.status(500).json({ error: 'Failed to save cancellation reason: ' + err.message });
        }

        console.log('Cancellation record inserted successfully');
        res.json({ message: 'Event cancelled', eventId, cancelledBy: adminEmail });
      });
    });
  });
};

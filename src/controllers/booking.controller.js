const db = require('../db/db');

// POST /api/booking
exports.createBooking = (req, res) => {
  const {
    name,
    phone,
    email,
    city,
    event_type,
    event_date,
    time,
    location,
    venue,
    guest_count,
    message
  } = req.body;

  // Validation
  if (!name || !phone || !event_type || !event_date) {
    return res.status(400).json({
      error: 'Name, phone, event_type and event_date are required'
    });
  }

  // 1. Check if client already exists (by phone)
  const findClientSql = `SELECT id FROM clients WHERE phone = ? LIMIT 1`;

  db.get(findClientSql, [phone], (err, client) => {
    if (err) return res.status(500).json({ error: err.message });

    const createEvent = (clientId) => {
      const insertEventSql = `
        INSERT INTO events
        (client_id, event_type, event_date, start_time, location, venue, guest_count, enquiry_message, source, status, Stage)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WEBSITE', 'NEW', 'ENQUIRY')
      `;  

      db.run(
        insertEventSql,
        [
          clientId,
          event_type,
          event_date,
          time || null,
          location || null,
          venue || null,
          guest_count || null,
          message || null
        ],
        function (err) {
          if (err) return res.status(500).json({ error: err.message });

          // Persist notification and emit to admins/staff (only to 'admins' room)
          const eventId = this.lastID;
          const payload = JSON.stringify({ eventId, clientName: name, eventType: event_type, eventDate: event_date, phone });

          db.run(`INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`, ['NEW_BOOKING', payload, null], function (nErr) {
            if (nErr) console.warn('Failed to persist notification:', nErr.message);

            const io = req.app.get('io');
            if (io) {
              io.to('admins').emit('newBooking', JSON.parse(payload));
            }

            res.status(201).json({
              message: 'Booking enquiry submitted successfully',
              eventId
            });
          });
        }
      );
    };

    // If client exists
    if (client) {
      return createEvent(client.id);
    }

    // Else create new client
    const insertClientSql = `
      INSERT INTO clients (name, phone, email, address)
      VALUES (?, ?, ?, ?)
    `;

    db.run(insertClientSql, [name, phone, email || null, city || null], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      createEvent(this.lastID);
    });
  });
};

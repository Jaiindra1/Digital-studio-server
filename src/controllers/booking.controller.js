const db = require('../config/db');
const { getNotificationSettings } = require('./notifications.controller');
const { sendMail } = require('../utils/mail');

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const sendBookingEmails = async (booking, eventId) => {
  const studioEmail = process.env.CONTACT_EMAIL || process.env.EMAIL_USER;
  const jobs = [];

  if (studioEmail) {
    jobs.push(sendMail({
      to: studioEmail,
      replyTo: booking.email || undefined,
      subject: `New booking enquiry: ${booking.event_type} — ${booking.name}`,
      text: `New booking #${eventId}\nName: ${booking.name}\nEmail: ${booking.email || 'Not provided'}\nPhone: ${booking.phone}\nEvent: ${booking.event_type}\nDate: ${booking.event_date}\nCity: ${booking.city || 'Not provided'}\nVenue: ${booking.venue || 'Not provided'}\nMessage: ${booking.message || 'None'}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#0f172a"><h2 style="color:#0284c7">New booking enquiry #${eventId}</h2><table cellpadding="8" style="width:100%;border-collapse:collapse"><tr><td><strong>Client</strong></td><td>${escapeHtml(booking.name)}</td></tr><tr><td><strong>Email</strong></td><td>${escapeHtml(booking.email || 'Not provided')}</td></tr><tr><td><strong>Phone</strong></td><td>${escapeHtml(booking.phone)}</td></tr><tr><td><strong>Event</strong></td><td>${escapeHtml(booking.event_type)}</td></tr><tr><td><strong>Date</strong></td><td>${escapeHtml(booking.event_date)}</td></tr><tr><td><strong>City / venue</strong></td><td>${escapeHtml(booking.city || booking.location || 'Not provided')} / ${escapeHtml(booking.venue || 'Not provided')}</td></tr></table><p style="padding:16px;background:#f8fafc;border-radius:12px">${escapeHtml(booking.message || 'No additional message')}</p></div>`,
    }));
  }

  if (booking.email) {
    jobs.push(sendMail({
      to: booking.email,
      subject: 'Your booking enquiry is received — Rafia Digital Studio',
      text: `Hi ${booking.name},\n\nWe received your ${booking.event_type} enquiry for ${booking.event_date}. Our team will contact you shortly.\n\nBooking reference: ${eventId}\n\nRafia Digital Studio`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#0f172a"><h2>We have received your enquiry.</h2><p>Hi ${escapeHtml(booking.name)},</p><p style="line-height:1.7">Thank you for considering Rafia Digital Studio for your <strong>${escapeHtml(booking.event_type)}</strong> on <strong>${escapeHtml(booking.event_date)}</strong>. Our team will review the details and contact you shortly.</p><p style="padding:14px;background:#f0f9ff;border-radius:10px"><strong>Booking reference:</strong> ${eventId}</p><p style="color:#64748b">Rafia Digital Studio<br>Andhra Pradesh, India</p></div>`,
    }));
  }

  const results = await Promise.allSettled(jobs);
  results.filter((result) => result.status === 'rejected').forEach((result) => {
    console.warn('Booking email failed:', result.reason?.message || result.reason);
  });
};

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
  const normalizedEmail = String(email || '').trim().toLowerCase();

  // Validation
  if (!name || !phone || !event_type || !event_date) {
    return res.status(400).json({
      error: 'Name, phone, event_type and event_date are required'
    });
  }

  // 1. Check if client already exists (by phone or email)
  const findClientSql = `
    SELECT id FROM clients
    WHERE phone = ?
       OR ( ? <> '' AND LOWER(email) = ? )
    LIMIT 1
  `;

  db.get(findClientSql, [phone, normalizedEmail, normalizedEmail], (err, client) => {
    if (err) return res.status(500).json({ error: err.message } );

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

          const eventId = this.lastID;

          // Email is intentionally non-blocking: the enquiry remains saved if SMTP is unavailable.
          sendBookingEmails({ name, phone, email, city, event_type, event_date, time, location, venue, guest_count, message }, eventId);

          // Check notification settings before creating NEW_BOOKING notification
          getNotificationSettings()
            .then((settings) => {
              const alerts = settings && settings.bookingAlerts ? settings.bookingAlerts : {};

              if (!alerts.newBookingRequest) {
                return res.status(201).json({
                  message: 'Booking enquiry submitted successfully (alerts disabled)',
                  eventId,
                });
              }

              const payload = JSON.stringify({
                eventId,
                clientName: name,
                eventType: event_type,
                eventDate: event_date,
                phone,
              });

              db.run(
                `INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`,
                ['NEW_BOOKING', payload, null],
                function (nErr) {
                  if (nErr) console.warn('Failed to persist notification:', nErr.message);

                  const io = req.app.get('io');
                  if (io) {
                    io.to('admins').emit('newBooking', JSON.parse(payload));
                  }

                  res.status(201).json({
                    message: 'Booking enquiry submitted successfully',
                    eventId,
                  });
                }
              );
            })
            .catch((settingsErr) => {
              console.warn(
                'Failed to load notification settings for NEW_BOOKING:',
                settingsErr.message || settingsErr
              );

              // Fallback: behave as before and send the notification
              const payload = JSON.stringify({
                eventId,
                clientName: name,
                eventType: event_type,
                eventDate: event_date,
                phone,
              });

              db.run(
                `INSERT INTO notifications (type, payload, user_id) VALUES (?, ?, ?)`,
                ['NEW_BOOKING', payload, null],
                function (nErr) {
                  if (nErr) console.warn('Failed to persist notification:', nErr.message);

                  const io = req.app.get('io');
                  if (io) {
                    io.to('admins').emit('newBooking', JSON.parse(payload));
                  }

                  res.status(201).json({
                    message: 'Booking enquiry submitted successfully',
                    eventId,
                  });
                }
              );
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

    db.run(insertClientSql, [name, phone, normalizedEmail || null, city || null], function (err) {
      if (err) {
        // If email already exists due to race/duplicate, create event under existing profile.
        if (normalizedEmail) {
          return db.get(
            `SELECT id FROM clients WHERE LOWER(email) = ? LIMIT 1`,
            [normalizedEmail],
            (findErr, existingClient) => {
              if (findErr) return res.status(500).json({ error: findErr.message });
              if (existingClient?.id) {
                return createEvent(existingClient.id);
              }
              return res.status(500).json({ error: err.message });
            }
          );
        }
        return res.status(500).json({ error: err.message });
      }
      createEvent(this.lastID);
    });
  });
};

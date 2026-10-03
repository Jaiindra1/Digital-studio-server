const db = require('../config/db');
const nodemailer = require('nodemailer');

// Email transporter using SMTP config from environment
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
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 10000,
});

let reminderSchemaEnsured = false;

// Helper to send mail; falls back to console logging when EMAIL not configured (dev mode)
function sendMailWithFallback(mailOptions, cb) {
  const usingRealEmail = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER);
  if (usingRealEmail) {
    return transporter.sendMail(mailOptions, cb);
  }

  // In dev/test, just log the email details and return success
  console.log('Dev mode: Simulated email send to', mailOptions.to);
  console.log('Subject:', mailOptions.subject);
  const linkMatch = mailOptions.html && mailOptions.html.match(/href="([^"]+)"/);
  if (linkMatch) {
    console.log('Link in email:', linkMatch[1]);
  }
  cb(null, { messageId: 'dev-' + Date.now() });
}

function applyVars(text, vars) {
  return (text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
    vars[key] != null ? String(vars[key]) : ''
  );
}

function eventDateTimeFromRow(row) {
  let datePart = null;
  if (row.event_date instanceof Date) {
    const y = row.event_date.getFullYear();
    const m = String(row.event_date.getMonth() + 1).padStart(2, '0');
    const d = String(row.event_date.getDate()).padStart(2, '0');
    datePart = `${y}-${m}-${d}`;
  } else if (row.event_date) {
    datePart = String(row.event_date).slice(0, 10);
  }
  const timePart = row.start_time ? String(row.start_time).slice(0, 8) : '10:00:00';
  if (!datePart) return null;
  return new Date(`${datePart}T${timePart}`);
}

function formatEventDate(row) {
  if (row.event_date instanceof Date) {
    return row.event_date.toLocaleDateString();
  }
  if (!row.event_date) return '';
  const parsed = new Date(String(row.event_date));
  if (Number.isNaN(parsed.getTime())) return String(row.event_date).slice(0, 10);
  return parsed.toLocaleDateString();
}

function sendMailAsync(mailOptions) {
  return new Promise((resolve, reject) => {
    sendMailWithFallback(mailOptions, (err, info) => {
      if (err) return reject(err);
      resolve(info);
    });
  });
}

async function ensureReminderSchema() {
  if (reminderSchemaEnsured) return;
  try {
    await new Promise((resolve, reject) => {
      db.run(
        `ALTER TABLE events ADD COLUMN reminder_sent_at DATETIME NULL`,
        [],
        (err) => {
          if (!err) return resolve();
          const msg = String(err.message || '').toLowerCase();
          if (
            msg.includes('duplicate column') ||
            msg.includes('already exists')
          ) {
            return resolve();
          }
          return reject(err);
        }
      );
    });
    reminderSchemaEnsured = true;
  } catch (err) {
    console.error('Failed to ensure reminder schema:', err.message || err);
    throw err;
  }
}

async function loadReminderTemplate() {
  const tpl = await new Promise((resolve, reject) => {
    db.get(
      `SELECT id, template_key, name, subject, html_body, hero_image_url, enabled
       FROM email_templates
       WHERE template_key = 'PRE_SHOOT_REMINDER' AND enabled = 1
       LIMIT 1`,
      [],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });

  if (tpl) return tpl;
  return {
    subject: 'Pre-shoot reminder: {{eventType}} on {{eventDate}}',
    html_body:
      '<p>Hi {{clientName}},</p><p>This is a reminder for your {{eventType}} session on {{eventDate}} at {{eventTime}}.</p><p>Location: {{location}}</p>',
    hero_image_url: null,
  };
}

async function getDueReminderEvents() {
  const rows = await new Promise((resolve, reject) => {
    db.all(
      `SELECT
         e.id,
         e.event_type,
         e.event_date,
         e.start_time,
         e.location,
         e.venue,
         e.status,
         e.Stage,
         e.reminder_sent_at,
         c.id AS client_id,
         c.name AS client_name,
         c.email AS client_email
       FROM events e
       JOIN clients c ON c.id = e.client_id
       WHERE c.email IS NOT NULL
         AND TRIM(c.email) <> ''
         AND e.reminder_sent_at IS NULL
         AND e.status NOT IN ('CANCELLED', 'DELIVERED')
         AND (e.Stage IS NULL OR UPPER(e.Stage) <> 'ENQUIRY')`,
      [],
      (err, result) => (err ? reject(err) : resolve(result || []))
    );
  });

  const now = new Date();
  const horizon = new Date(now.getTime() + 48 * 60 * 60 * 1000);

  return rows.filter((row) => {
    const eventDateTime = eventDateTimeFromRow(row);
    if (!eventDateTime || Number.isNaN(eventDateTime.getTime())) return false;
    return eventDateTime > now && eventDateTime <= horizon;
  });
}

async function runRemindersJob() {
  await ensureReminderSchema();

  const [template, dueEvents] = await Promise.all([
    loadReminderTemplate(),
    getDueReminderEvents(),
  ]);

  const summary = {
    scanned: dueEvents.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  for (const event of dueEvents) {
    const eventDate = formatEventDate(event);
    const eventTime = event.start_time
      ? String(event.start_time).slice(0, 5)
      : '10:00';
    const vars = {
      clientName: event.client_name || 'Client',
      clientEmail: event.client_email || '',
      eventType: event.event_type || 'Session',
      eventDate,
      eventTime,
      location: event.venue || event.location || 'To be shared by studio',
      link: process.env.CLIENT_BASE_URL || '',
    };

    let subject = applyVars(template.subject, vars);
    let html = applyVars(template.html_body, vars);

    if (template.hero_image_url) {
      const imgTag = `<p><img src="${template.hero_image_url}" alt="" style="max-width:100%;border-radius:8px;" /></p>`;
      html = imgTag + html;
    }

    try {
      await sendMailAsync({
        from: process.env.EMAIL_FROM || 'no-reply@studio.com',
        to: event.client_email,
        subject,
        html,
      });

      await new Promise((resolve, reject) => {
        db.run(
          `UPDATE events
           SET reminder_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [event.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      summary.sent += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({
        eventId: event.id,
        email: event.client_email,
        message: err.message || String(err),
      });
    }
  }

  return summary;
}

// GET /api/email-templates/status
exports.status = async (req, res) => {
  try {
    const configured = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER);

    if (!configured) {
      return res.json({
        configured: false,
        healthy: false,
        service: 'Not configured',
        host: null,
        port: null,
        quotaUsed: null,
        quotaLimit: null,
        reputation: null,
        error: null,
      });
    }

    let healthy = false;
    let error = null;

    try {
      await transporter.verify();
      healthy = true;
    } catch (e) {
      healthy = false;
      error = e.message || String(e);
    }

    const serviceLabel =
      process.env.EMAIL_SERVICE ||
      (process.env.EMAIL_HOST || 'SMTP');

    res.json({
      configured: true,
      healthy,
      service: serviceLabel,
      host: process.env.EMAIL_HOST || null,
      port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587,
      quotaUsed: null,
      quotaLimit: null,
      reputation: healthy ? 'Healthy' : 'Degraded',
      error,
    });
  } catch (err) {
    console.error('Email status error:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/email-templates
exports.list = (req, res) => {
  db.all(
    `SELECT id, template_key, name, subject, html_body, hero_image_url, enabled, created_at, updated_at
     FROM email_templates
     ORDER BY name ASC`,
    [],
    (err, rows) => {
      if (err) {
        console.error('Email templates list error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.json(rows);
    }
  );
};

// GET /api/email-templates/:id
exports.getById = (req, res) => {
  const { id } = req.params;
  db.get(
    `SELECT id, template_key, name, subject, html_body, hero_image_url, enabled, created_at, updated_at
     FROM email_templates
     WHERE id = ?`,
    [id],
    (err, row) => {
      if (err) {
        console.error('Email template fetch error:', err);
        return res.status(500).json({ error: err.message });
      }
      if (!row) return res.status(404).json({ error: 'Template not found' });
      res.json(row);
    }
  );
};

// POST /api/email-templates
exports.create = (req, res) => {
  const { template_key, name, subject, html_body, hero_image_url, enabled } = req.body || {};

  if (!template_key || !name || !subject || !html_body) {
    return res.status(400).json({ error: 'template_key, name, subject and html_body are required' });
  }

  db.run(
    `INSERT INTO email_templates (template_key, name, subject, html_body, hero_image_url, enabled)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, 1))`,
    [template_key, name, subject, html_body, hero_image_url || null, enabled],
    function (err) {
      if (err) {
        console.error('Email template create error:', err);
        return res.status(500).json({ error: err.message });
      }
      res.status(201).json({
        id: this.lastID,
        template_key,
        name,
        subject,
        html_body,
        hero_image_url: hero_image_url || null,
        enabled: enabled ?? 1,
      });
    }
  );
};

// PUT /api/email-templates/:id
exports.update = (req, res) => {
  const { id } = req.params;
  const { template_key, name, subject, html_body, hero_image_url, enabled } = req.body || {};

  if (!template_key || !name || !subject || !html_body) {
    return res.status(400).json({ error: 'template_key, name, subject and html_body are required' });
  }

  db.run(
    `UPDATE email_templates
     SET template_key = ?, name = ?, subject = ?, html_body = ?, hero_image_url = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [template_key, name, subject, html_body, hero_image_url || null, enabled ? 1 : 0, id],
    function (err) {
      if (err) {
        console.error('Email template update error:', err);
        return res.status(500).json({ error: err.message });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Template not found' });
      }
      res.json({ message: 'Template updated' });
    }
  );
};

// Helper for other controllers (not an endpoint)
exports.findByKey = (templateKey) =>
  new Promise((resolve, reject) => {
    db.get(
      `SELECT id, template_key, name, subject, html_body, hero_image_url, enabled
       FROM email_templates
       WHERE template_key = ? AND enabled = 1`,
      [templateKey],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });

// POST /api/email-templates/:id/send
// Body: { clientId }
exports.sendToClient = async (req, res) => {
  const { id } = req.params;
  const { clientId } = req.body || {};

  if (!clientId) {
    return res.status(400).json({ error: 'clientId is required' });
  }

  try {
    const template = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, template_key, name, subject, html_body, hero_image_url, enabled
         FROM email_templates
         WHERE id = ? AND enabled = 1`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!template) {
      return res.status(404).json({ error: 'Template not found or disabled' });
    }

    const client = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, name, email
         FROM clients
         WHERE id = ?`,
        [clientId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!client || !client.email) {
      return res.status(404).json({ error: 'Client not found or has no email' });
    }

    const vars = {
      clientName: client.name || '',
      clientEmail: client.email || '',
      eventType: '',
      eventDate: '',
      link: '',
    };

    const applyVars = (text) =>
      (text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
        vars[key] != null ? String(vars[key]) : ''
      );

    let subject = applyVars(template.subject || '');
    let html = applyVars(template.html_body || '');

    if (template.hero_image_url) {
      const imgTag = `<p><img src="${template.hero_image_url}" alt="" style="max-width:100%;border-radius:8px;" /></p>`;
      html = imgTag + html;
    }

    const mailOptions = {
      from: process.env.EMAIL_FROM || 'no-reply@studio.com',
      to: client.email,
      subject,
      html,
    };

    sendMailWithFallback(mailOptions, async (err, info) => {
      if (err) {
        console.error('Email template send error:', err);
        return res.status(500).json({ error: 'Failed to send email' });
      }

      try {
        const preview = nodemailer.getTestMessageUrl(info);
        if (preview) console.log('Preview URL:', preview);
      } catch (e) {}

      let updatedEventIds = [];
      // When "Gallery Ready" is sent, mark current active client event(s) as delivered.
      if (String(template.template_key || '').toUpperCase() === 'GALLERY_READY') {
        try {
          const candidateEvents = await new Promise((resolve, reject) => {
            db.all(
              `SELECT id
               FROM events
               WHERE client_id = ?
                 AND status IN ('NEW', 'ASSIGNED', 'SHOOT_DONE')
               ORDER BY event_date DESC, created_at DESC`,
              [clientId],
              (qErr, rows) => (qErr ? reject(qErr) : resolve(rows || []))
            );
          });

          if (candidateEvents.length > 0) {
            updatedEventIds = candidateEvents.map((row) => row.id);
            const placeholders = updatedEventIds.map(() => '?').join(', ');

            await new Promise((resolve, reject) => {
              db.run(
                `UPDATE events
                 SET status = 'DELIVERED',
                     Stage = 'DELIVERED',
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id IN (${placeholders})`,
                updatedEventIds,
                (uErr) => (uErr ? reject(uErr) : resolve())
              );
            });
          }
        } catch (statusErr) {
          console.warn('Failed to auto-mark event as DELIVERED after gallery email:', statusErr.message || statusErr);
        }
      }

      return res.json({
        message:
          updatedEventIds.length > 0
            ? 'Email sent successfully and event marked as DELIVERED'
            : 'Email sent successfully',
        clientId,
        templateId: id,
        updatedEventIds,
      });
    });
  } catch (err) {
    console.error('Email template sendToClient error:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/email-templates/reminders/status
exports.reminderStatus = async (_req, res) => {
  try {
    await ensureReminderSchema();
    const dueEvents = await getDueReminderEvents();
    const dueSoon = dueEvents
      .sort((a, b) => {
        const aDate = eventDateTimeFromRow(a)?.getTime() || 0;
        const bDate = eventDateTimeFromRow(b)?.getTime() || 0;
        return aDate - bDate;
      })
      .slice(0, 5)
      .map((row) => ({
        eventId: row.id,
        clientName: row.client_name,
        eventType: row.event_type,
        eventDate: row.event_date,
        startTime: row.start_time,
      }));

    res.json({
      dueCount: dueEvents.length,
      dueSoon,
      timing: '48 Hours Before',
    });
  } catch (err) {
    console.error('Reminder status error:', err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/email-templates/reminders/run
exports.runReminders = async (_req, res) => {
  try {
    const summary = await runRemindersJob();
    res.json({
      message: 'Reminder job completed',
      ...summary,
    });
  } catch (err) {
    console.error('Reminder run error:', err);
    res.status(500).json({ error: err.message });
  }
};

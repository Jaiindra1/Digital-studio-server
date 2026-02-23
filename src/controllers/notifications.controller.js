const db = require('../db/db');

// GET /api/notifications
exports.list = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM notifications
         WHERE DATE(created_at) = ?
           AND is_read = 0
         ORDER BY created_at DESC
         LIMIT ?`,
        [today, limit],
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });

    const parsed = rows.map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload) : null,
    }));

    const enquiries = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, status FROM events WHERE Stage = 'ENQUIRY'`,
        [],
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });

    res.json({ notifications: parsed, enquiries });
  } catch (err) {
    console.error('Notifications list error:', err);
    res.status(500).json({ error: err.message });
  }
};

// PUT /api/notifications/:id/read
exports.markRead = async (req, res) => {
  try {
    const { id } = req.params;
    await new Promise((resolve, reject) =>
      db.run(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [id], (err) =>
        err ? reject(err) : resolve()
      )
    );
    const io = req.app.get('io');
    io.to('admins').emit('notificationRead');
    res.json({ message: 'Marked read' });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: err.message });
  }
};

// ===== Notification settings (for Booking Flow / Alerts) =====

const DEFAULT_SETTINGS = {
  globalSettings: {
    email: true,
    sms: true,
    adminCC: false,
  },
  bookingAlerts: {
    newBookingRequest: true,
    depositReceived: true,
    cancellations: false,
    reminderTiming: '48 Hours Before',
  },
};

const SETTINGS_KEYS = {
  GLOBAL: 'globalSettings',
  ALERTS: 'bookingAlerts',
};

function readSettingsFromRows(rows) {
  const map = {};
  rows.forEach((r) => {
    try {
      map[r.key] = JSON.parse(r.value);
    } catch (e) {
      map[r.key] = r.value;
    }
  });

  return {
    globalSettings: map[SETTINGS_KEYS.GLOBAL] || DEFAULT_SETTINGS.globalSettings,
    bookingAlerts: map[SETTINGS_KEYS.ALERTS] || DEFAULT_SETTINGS.bookingAlerts,
  };
}

// Helper that other controllers can use to read notification settings
async function getNotificationSettings() {
  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT key, value FROM notification_settings`, [], (err, result) =>
      err ? reject(err) : resolve(result)
    );
  });

  return readSettingsFromRows(rows);
}

exports.getNotificationSettings = getNotificationSettings;

exports.getSettings = async (req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all(`SELECT key, value FROM notification_settings`, [], (err, result) =>
        err ? reject(err) : resolve(result)
      );
    });

    const settings = readSettingsFromRows(rows);
    res.json(settings);
  } catch (err) {
    console.error('Notifications getSettings error:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { globalSettings, bookingAlerts } = req.body || {};

    const toSave = {
      [SETTINGS_KEYS.GLOBAL]:
        typeof globalSettings === 'object' && globalSettings !== null
          ? globalSettings
          : DEFAULT_SETTINGS.globalSettings,
      [SETTINGS_KEYS.ALERTS]:
        typeof bookingAlerts === 'object' && bookingAlerts !== null
          ? bookingAlerts
          : DEFAULT_SETTINGS.bookingAlerts,
    };

    await new Promise((resolve, reject) => {
      const stmt = db.prepare(
        `INSERT INTO notification_settings (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );

      db.serialize(() => {
        try {
          Object.entries(toSave).forEach(([key, value]) => {
            stmt.run(key, JSON.stringify(value));
          });
          stmt.finalize((err) => (err ? reject(err) : resolve()));
        } catch (e) {
          reject(e);
        }
      });
    });

    res.json({ message: 'Settings updated', settings: toSave });
  } catch (err) {
    console.error('Notifications updateSettings error:', err);
    res.status(500).json({ error: err.message });
  }
};

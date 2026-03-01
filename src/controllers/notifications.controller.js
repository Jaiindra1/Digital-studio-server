const db = require('../db/db');
const s3Client = require('../config/s3');
const { GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const BUCKET = process.env.S3_BUCKET_NAME;

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(payload);
  } catch (_e) {
    return {};
  }
}

// GET /api/notifications
exports.list = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const todayOnly = String(req.query.today || '0') === '1';

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM notifications
         WHERE is_read = 0
           ${todayOnly ? `AND DATE(created_at) = DATE('now')` : ''}
         ORDER BY created_at DESC
         LIMIT ?`,
        [limit],
        (err, result) => (err ? reject(err) : resolve(result))
      );
    });

    const parsed = rows.map((row) => ({
      ...row,
      payload: parsePayload(row.payload),
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

// PATCH /api/notifications/gallery-upload/:id/review
// Body: { action: 'approve' | 'reject' }
exports.reviewGalleryUpload = async (req, res) => {
  try {
    const { id } = req.params;
    const normalizedAction = String(req.body?.action || '').toLowerCase();

    if (!['approve', 'reject'].includes(normalizedAction)) {
      return res.status(400).json({ message: "Invalid action. Allowed: 'approve' or 'reject'." });
    }

    const notification = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, type, payload, is_read FROM notifications WHERE id = ?`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found.' });
    }

    if (notification.type !== 'GALLERY_UPLOAD') {
      return res.status(400).json({ message: 'Only gallery upload notifications can be reviewed.' });
    }

    const payload = parsePayload(notification.payload);

    if ((payload.action || 'UPLOAD') !== 'UPLOAD') {
      return res.status(400).json({ message: 'Only upload notifications can be reviewed.' });
    }

    const uploaded = Array.isArray(payload.uploaded) ? payload.uploaded : [];
    const assetIds = uploaded
      .map((item) => Number(item && item.id))
      .filter((value) => Number.isInteger(value) && value > 0);

    if (!assetIds.length) {
      return res.status(400).json({ message: 'No uploaded media ids found in this notification.' });
    }

    const nextStatus = normalizedAction === 'approve' ? 'APPROVED' : 'REJECTED';
    const eventId = Number(payload.eventId);
    const hasEventId = Number.isInteger(eventId) && eventId > 0;
    const placeholders = assetIds.map(() => '?').join(', ');

    const sql = `
      UPDATE event_assets
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'SUBMITTED'
        AND id IN (${placeholders})
        ${hasEventId ? 'AND event_id = ?' : ''}
    `;

    const params = hasEventId
      ? [nextStatus, ...assetIds, eventId]
      : [nextStatus, ...assetIds];

    const updateResult = await new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes || 0 });
      });
    });

    await new Promise((resolve, reject) => {
      db.run(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [id], (err) =>
        err ? reject(err) : resolve()
      );
    });

    const io = req.app.get('io');
    if (io) io.to('admins').emit('notificationRead');

    return res.json({
      message: normalizedAction === 'approve' ? 'Upload approved.' : 'Upload rejected.',
      status: nextStatus,
      reviewedNotificationId: Number(id),
      updatedAssets: updateResult.changes,
      requestedAssets: assetIds.length,
    });
  } catch (err) {
    console.error('Review gallery upload error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/notifications/gallery-upload/:id/assets
exports.getGalleryUploadAssets = async (req, res) => {
  try {
    if (!BUCKET) return res.status(500).json({ message: 'S3 bucket is not configured.' });
    const { id } = req.params;

    const notification = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, type, payload FROM notifications WHERE id = ?`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!notification) return res.status(404).json({ message: 'Notification not found.' });
    if (notification.type !== 'GALLERY_UPLOAD') {
      return res.status(400).json({ message: 'Only gallery upload notifications are supported.' });
    }

    const payload = parsePayload(notification.payload);
    if ((payload.action || 'UPLOAD') !== 'UPLOAD') {
      return res.status(400).json({ message: 'Only upload notifications are supported.' });
    }

    const uploaded = Array.isArray(payload.uploaded) ? payload.uploaded : [];
    const assetIds = uploaded
      .map((item) => Number(item && item.id))
      .filter((value) => Number.isInteger(value) && value > 0);

    if (!assetIds.length) return res.json({ assets: [] });

    const placeholders = assetIds.map(() => '?').join(', ');
    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, event_id, staff_id, type, title, s3_key, status, created_at, updated_at
         FROM event_assets
         WHERE id IN (${placeholders})
         ORDER BY created_at DESC`,
        assetIds,
        (err, result) => (err ? reject(err) : resolve(result || []))
      );
    });

    const assets = await Promise.all(
      rows.map(async (row) => {
        let signed_url = null;
        if (row.s3_key) {
          try {
            signed_url = await getSignedUrl(
              s3Client,
              new GetObjectCommand({ Bucket: BUCKET, Key: row.s3_key }),
              { expiresIn: 3600 }
            );
          } catch (err) {
            console.warn('Failed to sign event asset URL:', err.message);
          }
        }
        return { ...row, signed_url };
      })
    );

    res.json({ assets });
  } catch (err) {
    console.error('Get gallery upload assets error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// DELETE /api/notifications/gallery-upload/:id/assets/:assetId
exports.deleteGalleryUploadAsset = async (req, res) => {
  try {
    const { id, assetId } = req.params;
    const parsedAssetId = Number(assetId);
    if (!Number.isInteger(parsedAssetId) || parsedAssetId <= 0) {
      return res.status(400).json({ message: 'Invalid assetId.' });
    }

    const notification = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, type, payload FROM notifications WHERE id = ?`,
        [id],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!notification) return res.status(404).json({ message: 'Notification not found.' });
    if (notification.type !== 'GALLERY_UPLOAD') {
      return res.status(400).json({ message: 'Only gallery upload notifications are supported.' });
    }

    const payload = parsePayload(notification.payload);
    if ((payload.action || 'UPLOAD') !== 'UPLOAD') {
      return res.status(400).json({ message: 'Only upload notifications are supported.' });
    }

    const uploaded = Array.isArray(payload.uploaded) ? payload.uploaded : [];
    const existsInNotification = uploaded.some((item) => Number(item && item.id) === parsedAssetId);
    if (!existsInNotification) {
      return res.status(404).json({ message: 'Asset is not part of this upload notification.' });
    }

    const asset = await new Promise((resolve, reject) => {
      db.get(
        `SELECT id, s3_key, status FROM event_assets WHERE id = ?`,
        [parsedAssetId],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });

    if (!asset) return res.status(404).json({ message: 'Asset not found.' });
    if (asset.status !== 'SUBMITTED') {
      return res.status(400).json({ message: 'Only SUBMITTED assets can be removed before review.' });
    }

    if (asset.s3_key && BUCKET) {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: asset.s3_key,
        })
      );
    }

    await new Promise((resolve, reject) => {
      db.run(`DELETE FROM event_assets WHERE id = ?`, [parsedAssetId], (err) =>
        err ? reject(err) : resolve()
      );
    });

    const nextUploaded = uploaded.filter((item) => Number(item && item.id) !== parsedAssetId);
    const nextPayload = {
      ...payload,
      uploaded: nextUploaded,
      count: nextUploaded.length,
    };

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE notifications SET payload = ? WHERE id = ?`,
        [JSON.stringify(nextPayload), id],
        (err) => (err ? reject(err) : resolve())
      );
    });

    return res.json({
      message: 'Asset removed from upload.',
      notificationId: Number(id),
      deletedAssetId: parsedAssetId,
      remainingAssets: nextUploaded.length,
    });
  } catch (err) {
    console.error('Delete gallery upload asset error:', err);
    return res.status(500).json({ error: err.message });
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

const db = require('../config/db');

let deliverySchemaPromise;

// Keeps existing local/RDS databases compatible with the delivery workflow.
// Each column is checked first, so restarts are safe after deployment.
async function ensureDeliverySchema() {
  if (deliverySchemaPromise) return deliverySchemaPromise;

  deliverySchemaPromise = (async () => {
    const result = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events'`
    );
    const existing = new Set((result.rows || []).map((row) => String(row.COLUMN_NAME).toLowerCase()));
    const required = {
      delivery_method: "VARCHAR(16) NOT NULL DEFAULT 'ONLINE'",
      delivery_note: 'TEXT NULL',
      delivered_at: 'DATETIME NULL',
      client_downloaded_at: 'DATETIME NULL',
      gallery_removed_at: 'DATETIME NULL',
    };

    for (const [column, definition] of Object.entries(required)) {
      if (!existing.has(column)) {
        await db.query(`ALTER TABLE events ADD COLUMN ${column} ${definition}`);
      }
    }
  })().catch((error) => {
    deliverySchemaPromise = undefined;
    throw error;
  });

  return deliverySchemaPromise;
}

module.exports = { ensureDeliverySchema };

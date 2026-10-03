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
      advance_amount: 'DECIMAL(10,2) NOT NULL DEFAULT 0',
      delivery_method: "VARCHAR(16) NOT NULL DEFAULT 'ONLINE'",
      delivery_note: 'TEXT NULL',
      delivered_at: 'DATETIME NULL',
      client_downloaded_at: 'DATETIME NULL',
      gallery_removed_at: 'DATETIME NULL',
    };

    for (const [column, definition] of Object.entries(required)) {
      if (!existing.has(column)) {
        await db.query(`ALTER TABLE events ADD COLUMN ${column} ${definition}`);

        // Older database exports stored this value in `advance`. Copy it only
        // when the replacement column is introduced so future edits remain safe.
        if (column === 'advance_amount' && existing.has('advance')) {
          await db.query('UPDATE events SET advance_amount = COALESCE(`advance`, 0)');
        }
      }
    }

    const clientResult = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clients'`
    );
    const clientColumns = new Set(
      (clientResult.rows || []).map((row) => String(row.COLUMN_NAME).toLowerCase())
    );
    if (!clientColumns.has('name')) {
      await db.query('ALTER TABLE clients ADD COLUMN name VARCHAR(255) NULL');
      if (clientColumns.has('full_name')) {
        await db.query("UPDATE clients SET name = NULLIF(TRIM(full_name), '') WHERE name IS NULL");
      }
    }
  })().catch((error) => {
    deliverySchemaPromise = undefined;
    throw error;
  });

  return deliverySchemaPromise;
}

module.exports = { ensureDeliverySchema };

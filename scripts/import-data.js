const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

async function main() {
  let sql = fs.readFileSync(path.join(__dirname, '..', 'data', 'studio_mysql.sql'), 'utf8');
  sql = sql
    .replace(/^\uFEFF/, '')
    .replace(/AUTO_INCREMENT\s+AUTO_INCREMENT/gi, 'AUTO_INCREMENT')
    .replace(/CREATE TABLE(?!\s+IF\s+NOT\s+EXISTS)/gi, 'CREATE TABLE IF NOT EXISTS')
    .replace(/CREATE TABLE IF NOT EXISTS\s+"([A-Za-z0-9_]+)"/gi, 'CREATE TABLE IF NOT EXISTS $1')
    .replace(/([A-Za-z0-9_`]+)\s+TEXT\s+NOT\s+NULL\s+UNIQUE/gi, '$1 VARCHAR(255) NOT NULL UNIQUE')
    .replace(/([A-Za-z0-9_`]+)\s+TEXT\s+UNIQUE/gi, '$1 VARCHAR(255) UNIQUE')
    .replace(/([A-Za-z0-9_`]+)\s+TEXT(\s+NOT\s+NULL)?\s+DEFAULT/gi, '$1 VARCHAR(255)$2 DEFAULT')
    .replace(/INSERT INTO/gi, 'INSERT IGNORE INTO')
    .replace(/CREATE TABLE IF NOT EXISTS notification_settings([\s\S]*?)\n\s*key VARCHAR/gi,
      'CREATE TABLE IF NOT EXISTS notification_settings$1\n  `key` VARCHAR')
    .replace(/INSERT IGNORE INTO clients VALUES/gi,
      'INSERT IGNORE INTO clients (id, full_name, phone, email, address, notes, created_at, updated_at, password_hash, is_account_active) VALUES')
    .replace(/unistr\('((?:''|[^'])*)'\)/gi, (_match, value) => {
      const decoded = value.replace(/\\u([0-9a-f]{4})/gi, (_escape, hex) => String.fromCharCode(parseInt(hex, 16)));
      return `'${decoded}'`;
    });

  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter((statement) => !/sqlite_sequence/i.test(statement));

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 20000,
    ssl: { rejectUnauthorized: false },
  });

  const [clientColumns] = await connection.query('SHOW COLUMNS FROM clients');
  const existingClientColumns = new Set(clientColumns.map((column) => column.Field));
  const clientColumnDefinitions = {
    notes: 'TEXT NULL',
    updated_at: 'DATETIME NULL',
    password_hash: 'TEXT NULL',
    is_account_active: 'INTEGER DEFAULT 0',
  };
  for (const [column, definition] of Object.entries(clientColumnDefinitions)) {
    if (!existingClientColumns.has(column)) {
      await connection.query(`ALTER TABLE clients ADD COLUMN ${column} ${definition}`);
    }
  }

  await connection.query('SET FOREIGN_KEY_CHECKS=0');
  const failures = [];
  let applied = 0;

  for (let index = 0; index < statements.length; index += 1) {
    try {
      await connection.query(statements[index]);
      applied += 1;
    } catch (error) {
      failures.push({
        statement: index + 1,
        code: error.code,
        message: error.message.slice(0, 180),
        sql: statements[index].slice(0, 100),
      });
    }
  }

  await connection.query('SET FOREIGN_KEY_CHECKS=1');
  const [tables] = await connection.query('SHOW TABLES');
  await connection.end();

  console.log(JSON.stringify({
    statements: statements.length,
    applied,
    failed: failures.length,
    tables: tables.length,
    firstFailures: failures.slice(0, 12),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exit(1);
});

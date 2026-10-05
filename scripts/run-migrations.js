const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

async function main() {
  const migrationDir = path.join(__dirname, '..', 'db');
  const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql')).sort();
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 20000,
    ssl: { rejectUnauthorized: false },
    multipleStatements: true,
  });

  for (const file of files) {
    try {
      await connection.query(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
      console.log(`${file}: applied`);
    } catch (error) {
      if (['ER_TABLE_EXISTS_ERROR', 'ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME'].includes(error.code)) {
        console.log(`${file}: already applied`);
      } else {
        console.log(`${file}: ${error.code || error.message}`);
      }
    }
  }

  await connection.end();
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exit(1);
});

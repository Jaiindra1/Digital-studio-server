require('dotenv').config();
const db = require('../src/db/db');
const { hash } = require('../src/utils/password');

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.log('❌ Usage: node scripts/createAdmin.js <email> <password>');
  process.exit(1);
}

(async () => {
  try {
    const hashedPassword = await hash(password);

    db.run(
      `INSERT INTO users (email, password, role) VALUES (?, ?, 'Admin')`,
      [email, hashedPassword],
      function (err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            console.error('❌ Admin already exists');
          } else {
            console.error('❌ DB Error:', err.message);
          }
        } else {
          console.log('✅ Admin created successfully');
          console.log('   Email:', email);
        }
        process.exit();
      }
    );
  } catch (error) {
    console.error('❌ Error creating admin:', error.message);
    process.exit(1);
  }
})();

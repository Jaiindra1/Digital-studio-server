const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

exports.hash = (plainPassword) => {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
};

exports.compare = (plainPassword, hash) => {
  return bcrypt.compare(plainPassword, hash);
};

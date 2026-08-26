const jwt = require('jsonwebtoken');

const EXPIRES_IN = '1h';

exports.signToken = (payload, expiresIn = EXPIRES_IN) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn
  });
};

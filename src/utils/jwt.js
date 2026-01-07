const jwt = require('jsonwebtoken');

const EXPIRES_IN = '1h';

exports.signToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: EXPIRES_IN
  });
};

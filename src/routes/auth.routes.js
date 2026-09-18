const express = require('express');
const router = express.Router();
const controller = require('../controllers/auth.controller');
const rateLimit = require('../middleware/rateLimit');

router.post('/login', rateLimit({ max: 10, windowMs: 15 * 60 * 1000 }), controller.login);

module.exports = router;

const express = require('express');
const router = express.Router();
const controller = require('../controllers/client.auth.controller');

router.post('/login', controller.clientLogin);
router.post('/create-password', controller.createPassword);
router.post('/forgot-password', controller.forgotPassword);
router.post('/reset-password', controller.resetPassword);

module.exports = router;

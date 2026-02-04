const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/payments.controller');

// Endpoint for payment providers or internal callers to notify the app
router.post('/notify', paymentsController.notify);

// Record a payment manually by admin
router.post('/record', paymentsController.record);

module.exports = router;

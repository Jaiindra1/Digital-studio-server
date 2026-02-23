const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/payments.controller');

// Endpoint for payment providers or internal callers to notify the app
router.post('/notify', paymentsController.notify);

// Record a payment manually by admin
router.post('/record', paymentsController.record);

//Get payment details
router.get('/details/:eventId', paymentsController.getPayments);

// Get payments overview
router.get('/overview', paymentsController.getPaymentsOverview);

module.exports = router;

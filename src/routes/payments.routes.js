const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/payments.controller');

// Endpoint for payment providers or internal callers to notify the app
router.post('/notify', paymentsController.notify);
router.post('/create-order', paymentsController.createRazorpayOrder);
router.post('/verify', paymentsController.verifyRazorpayPayment);

// Record a payment manually by admin
router.post('/record', paymentsController.record);

//Get payment details
router.get('/details/:eventId', paymentsController.getPayments);

// Get payments overview
router.get('/overview', paymentsController.getPaymentsOverview);
router.get('/pending', paymentsController.getPendingPayments);
router.post('/pending/:eventId/remind', paymentsController.sendPendingPaymentReminder);

module.exports = router;

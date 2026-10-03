const express = require('express');
const router = express.Router();
const paymentsController = require('../controllers/payments.controller');
const { ensureDeliverySchema } = require('../utils/deliverySchema');

router.use((req, res, next) => ensureDeliverySchema().then(() => next()).catch(next));

// Endpoint for payment providers or internal callers to notify the app
router.post('/notify', paymentsController.notify);
router.post('/create-order', paymentsController.createRazorpayOrder);
router.post('/verify', paymentsController.verifyRazorpayPayment);
router.post('/client-orders/create-order', paymentsController.createClientOrderRazorpayOrder);
router.post('/client-orders/verify', paymentsController.verifyClientOrderRazorpayPayment);

// Record a payment manually by admin
router.post('/record', paymentsController.record);

//Get payment details
router.get('/details/:eventId', paymentsController.getPayments);

// Get payments overview
router.get('/overview', paymentsController.getPaymentsOverview);
router.get('/pending', paymentsController.getPendingPayments);
router.post('/pending/:eventId/remind', paymentsController.sendPendingPaymentReminder);

module.exports = router;

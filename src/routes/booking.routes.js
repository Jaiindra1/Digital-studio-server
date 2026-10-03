const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const { ensureDeliverySchema } = require('../utils/deliverySchema');

router.use((req, res, next) => ensureDeliverySchema().then(() => next()).catch(next));

router.post('/', bookingController.createBooking);

module.exports = router;

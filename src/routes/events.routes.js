const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const controller = require('../controllers/events.controller');
const { ensureDeliverySchema } = require('../utils/deliverySchema');

const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => ensureDeliverySchema().then(() => next()).catch(next));

// Assign staff to event
router.get('/', controller.getAllEvents);
router.get('/:eventId/media', controller.getEventMediaAdmin);
router.patch('/:eventId/delivery', controller.updateDelivery);
router.delete('/:eventId/media', controller.deleteDeliveredMedia);
router.post('/:eventId/assign-staff', controller.assignStaff);
router.post('/:eventId/cancel', controller.cancelEvent);
router.delete('/:eventId/staff/:staffId', controller.removeEventStaff);
router.patch('/:eventId/staff/:staffId', controller.updateEventStaff);
router.post('/',  controller.createEvent);
router.put('/:eventId', controller.updateEvent);
router.patch('/:eventId/amount', controller.updateAmount);

module.exports = router;

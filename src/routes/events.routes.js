const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const controller = require('../controllers/events.controller');

const router = express.Router();

router.use(authenticate);

// Assign staff to event
router.get('/', controller.getAllEvents);
router.post('/:eventId/assign-staff', controller.assignStaff);

module.exports = router;

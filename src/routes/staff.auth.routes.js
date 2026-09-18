const express = require('express');
const router = express.Router();
const controller = require('../controllers/staff.auth.controller');
const upload = require('../middleware/upload.middleware');
const { ensureDeliverySchema } = require('../utils/deliverySchema');

router.use((req, res, next) => ensureDeliverySchema().then(() => next()).catch(next));

// Public endpoint used from email link for staff password setup
router.post('/create-password', controller.createPassword);
router.post('/forgot-password', controller.forgotPassword);
router.post('/reset-password', controller.resetPassword);
router.post('/login', controller.login);
router.get('/me/events', controller.getMyEvents);
router.get('/me/events/:eventId/media', controller.getEventMedia);
router.post('/me/events/:eventId/media', upload.array('media', 50), controller.uploadEventMedia);
router.delete('/me/events/:eventId/media/:assetId', controller.deleteEventMedia);

module.exports = router;

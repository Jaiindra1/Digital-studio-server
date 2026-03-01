const express = require('express');
const router = express.Router();
const controller = require('../controllers/client.auth.controller');

router.post('/login', controller.clientLogin);
router.post('/create-password', controller.createPassword);
router.post('/forgot-password', controller.forgotPassword);
router.post('/reset-password', controller.resetPassword);
router.post('/user/:id/feedback', controller.submitFeedback);
router.get('/user/:id', controller.getById);
router.get('/user/:id/events/:eventId/media', controller.getEventMediaForClient);
router.get('/user/:id/events/:eventId/media/download', controller.downloadEventMediaZip);

module.exports = router;

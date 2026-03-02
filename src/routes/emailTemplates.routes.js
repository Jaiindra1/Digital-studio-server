const express = require('express');
const router = express.Router();
const emailTemplatesController = require('../controllers/emailTemplates.controller');

// Basic CRUD for admin email templates
router.get('/status', emailTemplatesController.status);
router.get('/reminders/status', emailTemplatesController.reminderStatus);
router.post('/reminders/run', emailTemplatesController.runReminders);
router.get('/', emailTemplatesController.list);
router.get('/:id', emailTemplatesController.getById);
router.post('/', emailTemplatesController.create);
router.put('/:id', emailTemplatesController.update);
router.post('/:id/send', emailTemplatesController.sendToClient);

module.exports = router;

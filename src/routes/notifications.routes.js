const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notifications.controller');

router.get('/', notificationsController.list);
router.put('/:id/read', notificationsController.markRead);

module.exports = router;

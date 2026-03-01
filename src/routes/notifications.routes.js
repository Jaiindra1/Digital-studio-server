const express = require('express');
const router = express.Router();
const notificationsController = require('../controllers/notifications.controller');
const authenticate = require('../middleware/auth.middleware');

router.get('/', notificationsController.list);
router.put('/:id/read', notificationsController.markRead);
router.get('/gallery-upload/:id/assets', authenticate, notificationsController.getGalleryUploadAssets);
router.delete('/gallery-upload/:id/assets/:assetId', authenticate, notificationsController.deleteGalleryUploadAsset);
router.patch('/gallery-upload/:id/review', authenticate, notificationsController.reviewGalleryUpload);
router.get('/settings', notificationsController.getSettings);
router.put('/settings', notificationsController.updateSettings);

module.exports = router;

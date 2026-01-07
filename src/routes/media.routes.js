const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const upload = require('../middleware/upload');
const controller = require('../controllers/media.controller');

const router = express.Router();

router.post(
  '/upload',
  authenticate,
  upload.single('file'),
  controller.uploadMedia
);

module.exports = router;

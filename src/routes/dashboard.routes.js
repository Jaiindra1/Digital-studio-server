const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const dashboardController = require('../controllers/dashboard.controller');

const router = express.Router();

router.use(authenticate);
router.get('/summary', dashboardController.getAdminSummary);
router.get('/staff-feedback', dashboardController.getStaffFeedback);

module.exports = router;

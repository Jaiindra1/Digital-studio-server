const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const authenticateStaff = require('../middleware/staff.auth.middleware');
const controller = require('../controllers/staff.controller');

const router = express.Router();

router.get('/', authenticateStaff, controller.getAll);

// Get current staff profile
router.get('/me', authenticateStaff, controller.getMe);

// Allow staff to update their own profile
router.put('/me', authenticateStaff, controller.updateMe);

router.use(authenticate); // Admin-only

router.post('/', controller.create);
router.put('/:id', controller.update);
router.post('/:id/resend-password', controller.resendPasswordSetupEmail);
router.patch('/:id/status', controller.toggleStatus);
router.patch('/:id/status', controller.changeStatus);

module.exports = router;

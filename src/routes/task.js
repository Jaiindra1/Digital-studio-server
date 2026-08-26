const express = require('express');
const router = express.Router();
const controller = require('../controllers/task.controller');
const authenticateStaff = require('../middleware/staff.auth.middleware');

router.post('/', authenticateStaff, controller.createTask);
router.get('/staff/:staffId', authenticateStaff, controller.getTasksByStaff);
router.patch('/:id/status', authenticateStaff, controller.updateTaskStatus);
router.get('/staff/:staffId/tasks', authenticateStaff, controller.getTasksBycreatedStaff)

module.exports = router;

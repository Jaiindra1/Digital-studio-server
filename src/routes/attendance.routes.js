const express = require('express');
const router = express.Router();
const {
  markAttendance,
  getAttendance,
  getLeaveRequests,
  reviewLeaveRequest,
} = require('../controllers/attendance.controller');
const staffAuthMiddleware = require('../middleware/staff.auth.middleware');

// Mark attendance
router.post('/', staffAuthMiddleware, markAttendance);

// Get leave requests for admin dashboard
router.get('/leave-requests', staffAuthMiddleware, getLeaveRequests);

// Review leave request (approve/cancel)
router.patch('/leave-requests/:attendanceId', staffAuthMiddleware, reviewLeaveRequest);

// Get attendance for a staff member
router.get('/staff/:staffId', staffAuthMiddleware, getAttendance);

module.exports = router;

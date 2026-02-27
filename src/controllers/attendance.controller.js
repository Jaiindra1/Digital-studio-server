const db = require('../db/db');
const { sendMail } = require('../utils/mail');

const ALLOWED_ATTENDANCE_STATUSES = ['present', 'absent', 'leave'];
const ALLOWED_LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'cancelled'];

const normalizeDateOnly = (input) => {
  if (!input) return null;

  if (typeof input === 'string') {
    const match = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const sendLeaveRequestEmailToAdmins = async ({ staffId, leaveDate, notes }) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.log('Leave request email skipped: EMAIL_USER/EMAIL_PASS are not configured.');
      return;
    }

    const { rows: staffRows } = await db.query(
      'SELECT id, name, email FROM staff WHERE id = ?',
      [staffId]
    );
    const staff = staffRows[0];

    if (!staff) {
      return;
    }

    const { rows: adminRows } = await db.query(
      "SELECT email FROM users WHERE role = 'Admin' AND email IS NOT NULL AND TRIM(email) <> ''"
    );

    const adminEmails = [...new Set(adminRows.map((row) => (row.email || '').trim()).filter(Boolean))];
    if (adminEmails.length === 0) {
      console.warn('Leave request email skipped: no admin email addresses found.');
      return;
    }

    const staffName = staff.name || `Staff #${staffId}`;
    const escapedNotes = (notes || '').trim() || 'No reason provided.';

    const subject = `Leave request from ${staffName} for ${leaveDate}`;
    const html = `
      <p>Hello Admin,</p>
      <p>A staff member submitted a leave request.</p>
      <ul>
        <li><strong>Name:</strong> ${staffName}</li>
        <li><strong>Email:</strong> ${staff.email || 'N/A'}</li>
        <li><strong>Date:</strong> ${leaveDate}</li>
        <li><strong>Reason:</strong> ${escapedNotes}</li>
      </ul>
      <p>Please review it in the admin dashboard.</p>
    `;

    await Promise.all(
      adminEmails.map(async (email) => {
        try {
          await sendMail({ to: email, subject, html });
        } catch (mailError) {
          console.error(`Failed to send leave request email to ${email}:`, mailError.message);
        }
      })
    );
  } catch (error) {
    console.error('Failed to notify admins about leave request:', error.message);
  }
};

const markAttendance = async (req, res) => {
  const { staff_id, status, notes = '', date: rawDate } = req.body || {};

  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }

  if (!staff_id || !status) {
    return res.status(400).json({ message: 'staff_id and status are required.' });
  }

  if (!ALLOWED_ATTENDANCE_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Invalid status. Allowed: present, absent, leave.' });
  }

  const staffId = Number(staff_id);
  if (!Number.isInteger(staffId) || staffId <= 0) {
    return res.status(400).json({ message: 'Invalid staff_id.' });
  }

  const requesterId = Number(req.user && req.user.id);
  const requesterRole = req.user && req.user.role;
  const isAdmin = requesterRole === 'Admin';

  if (!isAdmin && requesterId && requesterId !== staffId) {
    return res.status(403).json({ message: 'You can only mark your own attendance.' });
  }

  const attendanceDate =
    status === 'leave'
      ? normalizeDateOnly(rawDate)
      : normalizeDateOnly(rawDate || new Date());

  if (!attendanceDate) {
    return res.status(400).json({ message: 'Valid date is required in YYYY-MM-DD format.' });
  }

  const requestStatus = status === 'leave' ? (isAdmin ? 'approved' : 'pending') : 'approved';
  const reviewedBy = requestStatus === 'pending' ? null : isAdmin ? requesterId : null;
  const reviewedAtSql = requestStatus === 'pending' ? 'NULL' : 'CURRENT_TIMESTAMP';

  try {
    const existingAttendance = await db.query(
      'SELECT id FROM attendance WHERE staff_id = ? AND date = ?',
      [staffId, attendanceDate]
    );

    let attendanceId;

    if (existingAttendance.rows.length > 0) {
      attendanceId = existingAttendance.rows[0].id;
      await db.query(
        `UPDATE attendance
         SET status = ?,
             notes = ?,
             request_status = ?,
             reviewed_by = ?,
             reviewed_at = ${reviewedAtSql},
             review_notes = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, notes, requestStatus, reviewedBy, attendanceId]
      );
    } else {
      const insertResult = await db.query(
        `INSERT INTO attendance (staff_id, date, status, notes, request_status, reviewed_by, reviewed_at, review_notes)
         VALUES (?, ?, ?, ?, ?, ?, ${reviewedAtSql}, NULL)`,
        [staffId, attendanceDate, status, notes, requestStatus, reviewedBy]
      );
      attendanceId = insertResult.lastID;
    }

    if (status === 'leave' && requestStatus === 'pending') {
      void sendLeaveRequestEmailToAdmins({
        staffId,
        leaveDate: attendanceDate,
        notes,
      });
    }

    const { rows } = await db.query('SELECT * FROM attendance WHERE id = ?', [attendanceId]);
    return res.status(200).json(rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error marking attendance.' });
  }
};

const getAttendance = async (req, res) => {
  const { staffId } = req.params;
  const { month, year, request_status: requestStatus } = req.query;

  if (!req.user) {
    return res.status(401).json({ message: 'Unauthorized.' });
  }

  if (req.user.role !== 'Admin' && Number(req.user.id) !== Number(staffId)) {
    return res.status(403).json({ message: 'You can only view your own attendance.' });
  }

  try {
    let query = 'SELECT * FROM attendance WHERE staff_id = ?';
    const params = [staffId];

    if (month && year) {
      query += " AND strftime('%Y-%m', date) = ?";
      params.push(`${year}-${month.toString().padStart(2, '0')}`);
    }

    if (requestStatus) {
      if (!ALLOWED_LEAVE_REQUEST_STATUSES.includes(requestStatus)) {
        return res.status(400).json({
          message: 'Invalid request_status. Allowed: pending, approved, cancelled.',
        });
      }
      query += ' AND request_status = ?';
      params.push(requestStatus);
    }

    query += ' ORDER BY date ASC';

    const { rows } = await db.query(query, params);
    return res.status(200).json(rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error getting attendance.' });
  }
};

const getLeaveRequests = async (req, res) => {
  if (!req.user || req.user.role !== 'Admin') {
    return res.status(403).json({ message: 'Only admins can view leave requests.' });
  }

  const { status = 'pending' } = req.query;

  if (status && !ALLOWED_LEAVE_REQUEST_STATUSES.includes(status)) {
    return res.status(400).json({
      message: 'Invalid status. Allowed: pending, approved, cancelled.',
    });
  }

  try {
    let query = `
      SELECT
        a.id,
        a.staff_id,
        a.date,
        a.status,
        a.notes,
        a.request_status,
        a.created_at,
        a.updated_at,
        a.reviewed_by,
        a.reviewed_at,
        a.review_notes,
        s.name AS staff_name,
        s.email AS staff_email,
        s.role AS staff_role
      FROM attendance a
      JOIN staff s ON s.id = a.staff_id
      WHERE a.status = 'leave'
    `;

    const params = [];
    if (status) {
      query += ' AND a.request_status = ?';
      params.push(status);
    }

    query += ' ORDER BY a.date ASC, a.created_at ASC';

    const { rows } = await db.query(query, params);
    return res.status(200).json(rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error getting leave requests.' });
  }
};

const reviewLeaveRequest = async (req, res) => {
  if (!req.user || req.user.role !== 'Admin') {
    return res.status(403).json({ message: 'Only admins can review leave requests.' });
  }

  const { attendanceId } = req.params;
  const { action, review_notes: reviewNotes } = req.body || {};

  const normalizedAction = String(action || '').toLowerCase();
  if (!['approve', 'cancel'].includes(normalizedAction)) {
    return res.status(400).json({ message: "Invalid action. Allowed: 'approve' or 'cancel'." });
  }

  const parsedAttendanceId = Number(attendanceId);
  if (!Number.isInteger(parsedAttendanceId) || parsedAttendanceId <= 0) {
    return res.status(400).json({ message: 'Invalid attendanceId.' });
  }

  const nextRequestStatus = normalizedAction === 'approve' ? 'approved' : 'cancelled';

  try {
    const existing = await db.query(
      'SELECT * FROM attendance WHERE id = ?',
      [parsedAttendanceId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found.' });
    }

    if (existing.rows[0].status !== 'leave') {
      return res.status(400).json({ message: 'Only leave entries can be reviewed.' });
    }

    await db.query(
      `UPDATE attendance
       SET request_status = ?,
           reviewed_by = ?,
           reviewed_at = CURRENT_TIMESTAMP,
           review_notes = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextRequestStatus, Number(req.user.id) || null, reviewNotes || null, parsedAttendanceId]
    );

    const { rows } = await db.query('SELECT * FROM attendance WHERE id = ?', [parsedAttendanceId]);
    return res.status(200).json(rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Error reviewing leave request.' });
  }
};

module.exports = {
  markAttendance,
  getAttendance,
  getLeaveRequests,
  reviewLeaveRequest,
};

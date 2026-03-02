const express = require('express');
const multer = require('multer');
const authenticate = require('../middleware/auth.middleware');
const authenticateStaff = require('../middleware/staff.auth.middleware');
const controller = require('../controllers/staff.controller');
const db = require('../config/db');
const s3Client = require('../config/s3');
const { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const router = express.Router();
const BUCKET = process.env.S3_BUCKET_NAME;
const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 5 * 1024 * 1024 },
});

const generateAvatarKey = (staffId, filename) => {
	const ext = filename.split('.').pop();
	return `avatars/staff-${staffId}-${Date.now()}.${ext}`;
};

router.get('/', authenticateStaff, controller.getAll);

// Get current staff profile
router.get('/me', authenticateStaff, controller.getMe);

// Allow staff to update their own profile
router.put('/me', authenticateStaff, controller.updateMe);

// Upload / update staff avatar
router.post('/avatar', authenticateStaff, upload.single('avatar'), async (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: 'No file uploaded' });
	}

	if (!BUCKET) {
		return res.status(500).json({ error: 'S3 bucket is not configured' });
	}

	const staffId = req.user.id;

	db.get(`SELECT avatar_url FROM staff WHERE id = ?`, [staffId], async (err, row) => {
		if (err) return res.status(500).json({ error: 'Database error' });

		try {
			if (row?.avatar_url) {
				await s3Client.send(
					new DeleteObjectCommand({ Bucket: BUCKET, Key: row.avatar_url })
				);
			}

			const key = generateAvatarKey(staffId, req.file.originalname);

			await s3Client.send(
				new PutObjectCommand({
					Bucket: BUCKET,
					Key: key,
					Body: req.file.buffer,
					ContentType: req.file.mimetype,
				})
			);

			db.run(
				`UPDATE staff SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
				[key, staffId],
				async (updateErr) => {
					if (updateErr) return res.status(500).json({ error: 'Database error' });

					let avatarUrl = null;
					try {
						avatarUrl = await getSignedUrl(
							s3Client,
							new GetObjectCommand({ Bucket: BUCKET, Key: key }),
							{ expiresIn: 3600 }
						);
					} catch (signErr) {
						console.error('Failed to sign staff avatar URL:', signErr);
					}

					return res.json({ success: true, avatarUrl });
				}
			);
		} catch (uploadErr) {
			console.error('Staff avatar upload failed:', uploadErr);
			return res.status(500).json({ error: 'Failed to upload avatar' });
		}
	});
});

// Delete staff avatar
router.delete('/avatar', authenticateStaff, async (req, res) => {
	const staffId = req.user.id;

	if (!BUCKET) {
		return res.status(500).json({ error: 'S3 bucket is not configured' });
	}

	db.get(`SELECT avatar_url FROM staff WHERE id = ?`, [staffId], async (err, row) => {
		if (err) return res.status(500).json({ error: 'Database error' });
		if (!row?.avatar_url) return res.json({ success: true });

		try {
			await s3Client.send(
				new DeleteObjectCommand({ Bucket: BUCKET, Key: row.avatar_url })
			);

			db.run(
				`UPDATE staff SET avatar_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
				[staffId],
				() => res.json({ success: true })
			);
		} catch (deleteErr) {
			console.error('Failed to delete staff avatar:', deleteErr);
			return res.status(500).json({ error: 'Failed to delete avatar' });
		}
	});
});

router.use(authenticate); // Admin-only

router.post('/', controller.create);
router.put('/:id', controller.update);
router.post('/:id/resend-password', controller.resendPasswordSetupEmail);
router.patch('/:id/status', controller.toggleStatus);
router.patch('/:id/status', controller.changeStatus);

module.exports = router;

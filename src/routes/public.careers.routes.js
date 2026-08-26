const express = require('express');
const multer = require('multer');
const careersController = require('../controllers/careers.controller');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only PDF/DOC/DOCX files are allowed'));
    }
    cb(null, true);
  },
});

router.get('/openings', careersController.getPublicOpenings);
router.post('/openings/:id/apply', upload.single('resume'), careersController.applyToOpening);

module.exports = router;


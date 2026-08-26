const multer = require('multer');
const multerS3 = require('multer-s3');
const s3 = require('../config/s3');

const upload = multer({
  storage: multerS3({
    s3,
    bucket: process.env.AWS_S3_BUCKET,
    acl: 'public-read',
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const folder = req.body.category || 'general';
      const filename = `${Date.now()}-${file.originalname}`;
      cb(null, `${folder}/${filename}`);
    }
  })
});

module.exports = upload;

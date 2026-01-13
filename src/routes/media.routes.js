const router = require("express").Router();
const controller = require("../controllers/media.controller");
const auth = require("../middleware/auth.middleware");
const upload = require("../middleware/upload.middleware");

router.post(
  "/upload",
  auth,
  upload.array("images", 50),
  controller.uploadMedia
);

router.get("/album/:albumId", controller.getMediaByAlbum);

module.exports = router;

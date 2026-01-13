const router = require("express").Router();
const controller = require("../controllers/album.controller");
const upload = require("../middleware/upload.middleware");
const auth = require("../middleware/auth.middleware");

// CREATE ALBUM
router.post("/", auth, controller.createAlbum);

// GET ALBUMS BY GALLERY
router.get("/gallery/:galleryId", controller.getAlbumsByGallery);

// UPLOAD MEDIA TO ALBUM
router.post(
  "/upload",
  auth,
  upload.array("images", 50),
  controller.uploadMediaToAlbum
);

// GET MEDIA
router.get("/media", controller.getAllMedia);
router.get("/media/album/:albumId", controller.getMediaByAlbum);
router.get("/recent", auth, controller.getRecentAlbums);


module.exports = router;
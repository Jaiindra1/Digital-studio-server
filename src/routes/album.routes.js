const router = require("express").Router();
const controller = require("../controllers/album.controller");
const upload = require("../middleware/upload.middleware");
const auth = require("../middleware/auth.middleware");

// CREATE ALBUM
router.post("/", auth, controller.createAlbum);

// GET ALBUMS BY GALLERY
router.get("/gallery/:galleryId", controller.getAlbumsByGallery);

// GET SINGLE ALBUM BY ID
router.get("/album/:albumId", controller.getAlbumById);

// UPLOAD MEDIA TO ALBUM
router.post("/upload",
  auth,
  upload.array("images", 50),
  controller.uploadMediaToAlbum
);

// Route for full update
router.put('/update-full', upload.array('images', 50), controller.updateAlbumFull);

// GET MEDIA
router.get("/media", controller.getAllMedia);
router.get("/media/album/:albumId", controller.getMediaByAlbum);
router.get("/recent", auth, controller.getRecentAlbums);
router.delete("/:albumId", auth, controller.deleteAlbum);

module.exports = router;
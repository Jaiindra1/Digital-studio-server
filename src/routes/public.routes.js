const router = require("express").Router();
const controller = require("../controllers/Public.controller");
const controller2 = require("../controllers/gallery.controller");


// GET ALBUMS BY GALLERY
router.get("/gallery/:galleryId", controller.getAlbumsByGallery);

router.get("/media/album/:albumId", controller.getMediaByAlbum);
router.get("/recent",  controller.getRecentAlbums);
router.get("/categories",  controller2.getCategories);
router.get("/labels/:category",  controller2.getLabelsByCategory);
router.get('/album/:category', require("../controllers/Public.controller").getAlbumsByCategory);

module.exports = router;
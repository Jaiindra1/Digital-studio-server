const router = require("express").Router();
const controller = require("../controllers/Public.controller");
const controller2 = require("../controllers/gallery.controller");
const albumController = require("../controllers/album.controller");


// GET ALBUMS BY GALLERY
router.get("/gallery/:galleryId", controller.getAlbumsByGallery);

router.get("/media/album/:albumId", controller.getMediaByAlbum);
router.get("/recent",  controller.getRecentAlbums);
router.get("/main-albums", controller.getMainPageAlbums);
router.get("/categories",  controller2.getCategories);
router.get("/labels/:category",  controller2.getLabelsByCategory);
router.get('/album/:category', require("../controllers/Public.controller").getAlbumsByCategory);
router.get("/media", albumController.getAllMedia);


module.exports = router;

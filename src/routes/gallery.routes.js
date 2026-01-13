const router = require("express").Router();
const controller = require("../controllers/gallery.controller");
const auth = require("../middleware/auth.middleware");

router.get("/categories", auth, controller.getCategories);
router.get("/labels/:category", auth, controller.getLabelsByCategory);

module.exports = router;

const express = require("express");
const router = express.Router();
const multer = require("multer");
const { createStudioProfile, getStudioProfileById, updateStudioProfile } = require("../controllers/studioController");

const upload = multer({ storage: multer.memoryStorage() });

router.post("/studio-profile", upload.single("image"), createStudioProfile);
router.get("/studio-details", getStudioProfileById);
router.put(
  "/studio-update",
  upload.single("image"),
  updateStudioProfile
);

module.exports = router;
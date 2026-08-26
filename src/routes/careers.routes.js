const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const careersController = require('../controllers/careers.controller');

const router = express.Router();

router.get('/', authenticate, careersController.getAdminOpenings);
router.post('/', authenticate, careersController.createOpening);
router.put('/:id', authenticate, careersController.updateOpening);
router.delete('/:id', authenticate, careersController.deleteOpening);

module.exports = router;


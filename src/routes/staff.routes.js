const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const controller = require('../controllers/staff.controller');

const router = express.Router();

router.use(authenticate); // Admin-only

router.get('/', controller.getAll);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.patch('/:id/status', controller.toggleStatus);
router.patch('/:id/status', controller.changeStatus);

module.exports = router;

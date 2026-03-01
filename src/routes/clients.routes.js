const express = require('express');
const authenticate = require('../middleware/auth.middleware');
const controller = require('../controllers/clients.controller');

const router = express.Router();

router.use(authenticate);

router.get('/', controller.getAll);
router.post('/', controller.create);
router.put('/:id', controller.update);
router.get('/:id/orders', controller.getOrdersForClient);
router.patch('/:id/orders/:orderId', controller.updateOrderForClient);

module.exports = router;

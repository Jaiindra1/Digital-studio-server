const express = require('express');
const router = express.Router();
const controller = require('../controllers/client.auth.controller');

router.post('/login', controller.clientLogin);
router.post('/create-password', controller.createPassword);
router.post('/forgot-password', controller.forgotPassword);
router.post('/reset-password', controller.resetPassword);
router.post('/user/:id/feedback', controller.submitFeedback);
router.get('/user/:id', controller.getById);
router.get('/user/:id/profile', controller.getClientProfile);
router.put('/user/:id/profile', controller.updateClientProfile);
router.post('/user/:id/cart/items', controller.addClientCartItem);
router.get('/user/:id/cart', controller.getClientCart);
router.get('/user/:id/cart/count', controller.getClientCartCount);
router.patch('/user/:id/cart/items/:itemId', controller.updateClientCartItemQuantity);
router.delete('/user/:id/cart/items/:itemId', controller.removeClientCartItem);
router.post('/user/:id/cart/checkout', controller.checkoutClientCart);
router.get('/user/:id/events/:eventId/media', controller.getEventMediaForClient);
router.get('/user/:id/events/:eventId/media/download', controller.downloadEventMediaZip);
router.get('/user/:id/orders', controller.getClientOrders);

module.exports = router;

const express = require('express');
const router = express.Router();
const cartController = require('../controllers/cart.controller');

// Add item to cart
router.post('/cart/items', cartController.addToCart);

// Get cart with items
router.get('/cart', cartController.getCart);

// Cart badge count
router.get('/cart/count', cartController.getCartCount);

// Checkout -> Create order
router.post('/orders', cartController.checkout);

module.exports = router;
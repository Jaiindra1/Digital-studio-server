const express = require('express');
const router = express.Router();
const productController = require('../controllers/products.controller');
const upload = require('../middlewares/uploadProductImage');

////////////////////////////////////////////////////
// PUBLIC ROUTES
////////////////////////////////////////////////////
router.get('/', productController.getAllProducts);
router.get('/:id', productController.getProductById);

////////////////////////////////////////////////////
// ADMIN ROUTES
////////////////////////////////////////////////////

// Create product (with image upload)
router.post('/', upload.single('image'), productController.createProduct);

// Update product (image optional replace)
router.put('/:id', upload.single('image'), productController.updateProduct);

// Soft delete
router.delete('/:id', productController.deleteProduct);

// Restore
router.patch('/:id/restore', productController.restoreProduct);

module.exports = router;
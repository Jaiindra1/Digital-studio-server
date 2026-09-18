const router = require('express').Router();
const controller = require('../controllers/serviceOptions.controller');
const authenticate = require('../middleware/auth.middleware');
const upload = require('../middlewares/uploadProductImage');

router.get('/', controller.listPublic);
router.get('/admin', authenticate, controller.listAdmin);
router.post('/', authenticate, upload.single('image'), controller.create);
router.put('/:id', authenticate, upload.single('image'), controller.update);
router.delete('/:id', authenticate, controller.remove);

module.exports = router;

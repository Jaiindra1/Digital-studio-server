const router = require('express').Router();
const { submitContact } = require('../controllers/contact.controller');

router.post('/', submitContact);

module.exports = router;

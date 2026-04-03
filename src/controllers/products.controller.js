const db = require('../config/db');
const { uploadProductImage } = require('../services/s3Upload');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3Client = require('../config/s3');

const BUCKET = process.env.S3_BUCKET_NAME;

////////////////////////////////////////////////////
// Helpers: normalize/parse specs payload safely
////////////////////////////////////////////////////
function parseKeyValueSpecs(text = '') {
  const obj = {};
  String(text)
    .split('\n')
    .forEach((line) => {
      const [k, v] = String(line).split(':');
      if (k && v) obj[k.trim()] = v.trim();
    });
  return obj;
}

function normalizeSpecifications(input) {
  if (!input) return {};

  if (typeof input === 'object' && !Array.isArray(input)) {
    return input;
  }

  const asString = String(input);

  try {
    const parsed = JSON.parse(asString);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_e) {
    // Fallback to key:value parsing below.
  }

  return parseKeyValueSpecs(asString);
}

////////////////////////////////////////////////////
// Helper: attach signed S3 URL
////////////////////////////////////////////////////
async function attachSignedUrl(product) {
  const normalizedSpecs = normalizeSpecifications(product.specs);

  if (!product.image_url) {
    return {
      ...product,
      specs: normalizedSpecs,
    };
  }

  try {
    const cmd = new GetObjectCommand({
      Bucket: BUCKET,
      Key: product.image_url,
    });

    const signed = await getSignedUrl(s3Client, cmd, { expiresIn: 3600 });

    return {
      ...product,
      specs: normalizedSpecs,
      display_url: signed,
    };
  } catch (err) {
    console.error('Signed URL error:', err.message);
    return {
      ...product,
      specs: normalizedSpecs,
      display_url: null,
    };
  }
}

////////////////////////////////////////////////////
// GET ALL PRODUCTS (Public)
////////////////////////////////////////////////////
exports.getAllProducts = async (req, res) => {
  const { category, orientation } = req.query;

  let query = 'SELECT * FROM products WHERE 1=1';
  const params = [];

  if (category) {
    query += ' AND category=?';
    params.push(category);
  }

  if (orientation) {
    query += ' AND orientation=?';
    params.push(orientation);
  }

  db.all(query, params, async (err, rows) => {
    if (err) return res.status(500).json(err);

    const products = await Promise.all((rows || []).map(attachSignedUrl));
    res.json(products);
  });
};

////////////////////////////////////////////////////
// GET SINGLE PRODUCT
////////////////////////////////////////////////////
exports.getProductById = (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM products WHERE id=? AND status=\'active\'', [id], async (err, product) => {
    if (err) return res.status(500).json(err);
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const result = await attachSignedUrl(product);
    res.json(result);
  });
};

////////////////////////////////////////////////////
// CREATE PRODUCT (ADMIN)
////////////////////////////////////////////////////
exports.createProduct = async (req, res) => {
  try {
    const { name, category, orientation, price, specifications } = req.body;

    if (!name || !category || !price) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Image required' });
    }

    const imageKey = await uploadProductImage(req.file);
    const specsObject = normalizeSpecifications(specifications);

    db.run(
      'INSERT INTO products (name, category, orientation, price, image_url, specs) VALUES (?, ?, ?, ?, ?, ?)',
      [name, category, orientation, price, imageKey, JSON.stringify(specsObject)],
      function (err) {
        if (err) return res.status(500).json(err);

        res.status(201).json({
          message: 'Product created successfully',
          product_id: this.lastID,
        });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Upload failed' });
  }
};

////////////////////////////////////////////////////
// UPDATE PRODUCT (ADMIN) (supports image replace)
////////////////////////////////////////////////////
exports.updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, orientation, price, specifications, status } = req.body;

    let imageKey = null;
    if (req.file) {
      imageKey = await uploadProductImage(req.file);
    }

    const specsObject = normalizeSpecifications(specifications);

    db.run(
      `UPDATE products
       SET name=?, category=?, orientation=?, price=?,
           image_url=COALESCE(?, image_url),
           specs=?, status=?
       WHERE id=?`,
      [
        name,
        category,
        orientation,
        price,
        imageKey,
        JSON.stringify(specsObject),
        status || 'active',
        id,
      ],
      function (err) {
        if (err) return res.status(500).json(err);
        if (this.changes === 0) {
          return res.status(404).json({ message: 'Product not found' });
        }

        res.json({ message: 'Product updated successfully' });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Update failed' });
  }
};

////////////////////////////////////////////////////
// DELETE PRODUCT (ADMIN) (SOFT DELETE)
////////////////////////////////////////////////////
exports.deleteProduct = (req, res) => {
  const { id } = req.params;

  db.run('UPDATE products SET status=\'inactive\' WHERE id=?', [id], function (err) {
    if (err) return res.status(500).json(err);
    if (this.changes === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  });
};

////////////////////////////////////////////////////
// Restore Product
////////////////////////////////////////////////////
exports.restoreProduct = (req, res) => {
  const { id } = req.params;

  db.run('UPDATE products SET status=\'active\' WHERE id=?', [id], function (err) {
    if (err) return res.status(500).json(err);
    if (this.changes === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Product restored successfully' });
  });
};

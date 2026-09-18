const db = require('../config/db');
const { uploadProductImage } = require('../services/s3Upload');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3Client = require('../config/s3');

const BUCKET = process.env.S3_BUCKET_NAME;

const DEFAULT_FRAME_PRICES = {
  'walnut-classic': 1299,
  'ivory-gallery-mount': 1899,
  'midnight-black-portrait': 1499,
  'oak-floating-canvas': 2499,
  'champagne-gold-keepsake': 1699,
  'minimal-white-square': 1099,
  'rosewood-heritage': 2199,
  'double-photo-table': 899,
};

async function ensureFramePrices() {
  await db.query(`CREATE TABLE IF NOT EXISTS shop_frame_prices (
    frame_key VARCHAR(80) PRIMARY KEY,
    price DECIMAL(10,2) NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await Promise.all(Object.entries(DEFAULT_FRAME_PRICES).map(([key, price]) =>
    db.query('INSERT IGNORE INTO shop_frame_prices (frame_key, price) VALUES (?, ?)', [key, price])
  ));
}

exports.getFramePrices = async (_req, res) => {
  try {
    await ensureFramePrices();
    const result = await db.query('SELECT frame_key, price FROM shop_frame_prices ORDER BY frame_key');
    const prices = Object.fromEntries((result.rows || []).map((row) => [row.frame_key, Number(row.price)]));
    return res.json(prices);
  } catch (error) {
    console.error('Frame price load failed:', error.message);
    return res.status(500).json({ message: 'Failed to load frame prices' });
  }
};

exports.updateFramePrices = async (req, res) => {
  const prices = req.body?.prices;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    return res.status(400).json({ message: 'A prices object is required' });
  }

  const updates = Object.entries(prices);
  if (!updates.length || updates.some(([key, price]) => !(key in DEFAULT_FRAME_PRICES) || !Number.isFinite(Number(price)) || Number(price) < 0 || Number(price) > 10000000)) {
    return res.status(400).json({ message: 'One or more frame prices are invalid' });
  }

  try {
    await ensureFramePrices();
    await Promise.all(updates.map(([key, price]) =>
      db.query('UPDATE shop_frame_prices SET price=? WHERE frame_key=?', [Number(price), key])
    ));
    return res.json({ message: 'Shop frame prices updated successfully' });
  } catch (error) {
    console.error('Frame price update failed:', error.message);
    return res.status(500).json({ message: 'Failed to update frame prices' });
  }
};

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

  let query = "SELECT * FROM products WHERE status='active'";
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

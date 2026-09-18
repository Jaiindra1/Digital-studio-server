const db = require('../config/db');
const { uploadProductImage } = require('../services/s3Upload');
const { GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const s3Client = require('../config/s3');

const BUCKET = process.env.S3_BUCKET_NAME;

async function ensureTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS service_options (
    id INT PRIMARY KEY AUTO_INCREMENT,
    service_name VARCHAR(160) NOT NULL,
    title VARCHAR(160) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL DEFAULT 0,
    image_url TEXT NULL,
    display_order INT NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_service_options_public (service_name, status, display_order)
  )`);
}

async function withDisplayUrl(option) {
  if (!option?.image_url) return option;
  try {
    const display_url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET, Key: option.image_url }), { expiresIn: 3600 });
    return { ...option, display_url };
  } catch (error) {
    console.error('Service option image URL failed:', error.message);
    return { ...option, display_url: null };
  }
}

const valid = ({ service_name, title, price }) => String(service_name || '').trim() && String(title || '').trim() && Number.isFinite(Number(price)) && Number(price) >= 0;

exports.listPublic = async (req, res) => {
  const service = String(req.query.service || '').trim();
  if (!service) return res.status(400).json({ message: 'service is required' });
  try {
    await ensureTable();
    const result = await db.query("SELECT * FROM service_options WHERE service_name=? AND status='active' ORDER BY display_order, id", [service]);
    return res.json(await Promise.all(result.rows.map(withDisplayUrl)));
  } catch (error) {
    console.error('Service option load failed:', error.message);
    return res.status(500).json({ message: 'Failed to load service options' });
  }
};

exports.listAdmin = async (_req, res) => {
  try {
    await ensureTable();
    const result = await db.query('SELECT * FROM service_options ORDER BY service_name, display_order, id');
    return res.json(await Promise.all(result.rows.map(withDisplayUrl)));
  } catch (error) { return res.status(500).json({ message: 'Failed to load service options' }); }
};

exports.create = async (req, res) => {
  const payload = req.body;
  if (!valid(payload)) return res.status(400).json({ message: 'Service, title, and a valid price are required' });
  try {
    await ensureTable();
    const imageKey = req.file ? await uploadProductImage(req.file) : null;
    const nextOrder = Number.isFinite(Number(payload.display_order)) ? Number(payload.display_order) : 0;
    const result = await db.query('INSERT INTO service_options (service_name,title,description,price,image_url,display_order,status) VALUES (?,?,?,?,?,?,?)', [payload.service_name.trim(), payload.title.trim(), payload.description || '', Number(payload.price), imageKey, nextOrder, payload.status === 'inactive' ? 'inactive' : 'active']);
    return res.status(201).json({ message: 'Service option created', id: result.lastID });
  } catch (error) { console.error('Service option create failed:', error.message); return res.status(500).json({ message: 'Failed to create service option' }); }
};

exports.update = async (req, res) => {
  const payload = req.body;
  if (!valid(payload)) return res.status(400).json({ message: 'Service, title, and a valid price are required' });
  try {
    await ensureTable();
    const imageKey = req.file ? await uploadProductImage(req.file) : null;
    const result = await db.query('UPDATE service_options SET service_name=?,title=?,description=?,price=?,image_url=COALESCE(?,image_url),display_order=?,status=? WHERE id=?', [payload.service_name.trim(), payload.title.trim(), payload.description || '', Number(payload.price), imageKey, Number(payload.display_order || 0), payload.status === 'inactive' ? 'inactive' : 'active', req.params.id]);
    if (!result.changes) return res.status(404).json({ message: 'Service option not found' });
    return res.json({ message: 'Service option updated' });
  } catch (error) { console.error('Service option update failed:', error.message); return res.status(500).json({ message: 'Failed to update service option' }); }
};

exports.remove = async (req, res) => {
  try {
    await ensureTable();
    const result = await db.query('DELETE FROM service_options WHERE id=?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ message: 'Service option not found' });
    return res.json({ message: 'Service option deleted' });
  } catch (error) { return res.status(500).json({ message: 'Failed to delete service option' }); }
};

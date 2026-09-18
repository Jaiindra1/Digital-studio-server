const db = require('../config/db');
const { uploadProductImage } = require('../services/s3Upload');
const { sendMail } = require('../utils/mail');

const emailOk = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
exports.create = async (req, res) => {
  const { name, email, phone, product_type, requested_size, material, quantity, budget, notes } = req.body || {};
  if (!String(name || '').trim() || !emailOk(String(email || '')) || !String(product_type || '').trim() || !String(notes || '').trim()) return res.status(400).json({ message: 'Name, valid email, product type, and design notes are required.' });
  if (String(notes).length > 5000 || Number(quantity || 0) < 1 || Number(quantity || 0) > 10000 || (budget && (!Number.isFinite(Number(budget)) || Number(budget) < 0))) return res.status(400).json({ message: 'Please check the request details.' });
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS custom_design_requests (id INT PRIMARY KEY AUTO_INCREMENT,name VARCHAR(120) NOT NULL,email VARCHAR(160) NOT NULL,phone VARCHAR(30),product_type VARCHAR(120) NOT NULL,requested_size VARCHAR(100),material VARCHAR(120),quantity INT NOT NULL DEFAULT 1,budget DECIMAL(10,2),notes TEXT NOT NULL,reference_image_url TEXT,status VARCHAR(32) NOT NULL DEFAULT 'new',created_at DATETIME DEFAULT CURRENT_TIMESTAMP,updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    const imageKey = req.file ? await uploadProductImage(req.file) : null;
    const result = await db.query('INSERT INTO custom_design_requests (name,email,phone,product_type,requested_size,material,quantity,budget,notes,reference_image_url) VALUES (?,?,?,?,?,?,?,?,?,?)', [name.trim(), email.trim().toLowerCase(), phone || null, product_type.trim(), requested_size || null, material || null, Number(quantity), budget === '' || budget == null ? null : Number(budget), notes.trim(), imageKey]);
    const studioEmail = process.env.CONTACT_EMAIL || process.env.EMAIL_USER;
    if (studioEmail) await sendMail({ to: studioEmail, subject: `Custom design request #${result.lastID}`, text: `${name} requested ${product_type}. Quantity: ${quantity}. Notes: ${notes}` }).catch((error) => console.warn('Custom request email failed:', error.message));
    return res.status(201).json({ message: 'Your custom design request was sent.', requestId: result.lastID });
  } catch (error) { console.error('Custom design request failed:', error.message); return res.status(500).json({ message: 'Could not send the design request.' }); }
};

exports.listAdmin = async (_req, res) => {
  try { const result = await db.query('SELECT * FROM custom_design_requests ORDER BY created_at DESC'); return res.json(result.rows); } catch { return res.status(500).json({ message: 'Could not load design requests.' }); }
};

exports.listForStaff = async (_req, res) => {
  try {
    const result = await db.query('SELECT * FROM custom_design_requests ORDER BY created_at DESC');
    return res.json(result.rows);
  } catch (error) {
    console.error('Could not load service requests for staff:', error.message);
    return res.status(500).json({ message: 'Could not load service requests.' });
  }
};

exports.updateStatusForStaff = async (req, res) => {
  const status = String(req.body?.status || '').trim().toLowerCase();
  const allowedStatuses = new Set(['new', 'in_progress', 'ready', 'completed', 'cancelled']);

  if (!allowedStatuses.has(status)) {
    return res.status(400).json({ message: 'Invalid request status.' });
  }

  try {
    const result = await db.query(
      'UPDATE custom_design_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      [status, req.params.id]
    );
    if (!result.changes) return res.status(404).json({ message: 'Service request not found.' });
    const updated = await db.query('SELECT * FROM custom_design_requests WHERE id=?', [req.params.id]);
    return res.json({ message: 'Request status updated.', request: updated.rows[0] });
  } catch (error) {
    console.error('Could not update service request:', error.message);
    return res.status(500).json({ message: 'Could not update service request.' });
  }
};

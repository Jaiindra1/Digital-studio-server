const db = require('../config/db');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT ? Number(process.env.EMAIL_PORT) : 587,
  secure: process.env.EMAIL_PORT === '465',
  auth: process.env.EMAIL_USER
    ? {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      }
    : undefined,
});

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });

const toJsonString = (value) => {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') {
    const list = value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return JSON.stringify(list);
  }
  return JSON.stringify([]);
};

const parseJsonArray = (value) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const resolveHrRecipient = async () => {
  if (process.env.ADMIN_HR_EMAIL) return process.env.ADMIN_HR_EMAIL;
  if (process.env.HR_EMAIL) return process.env.HR_EMAIL;
  if (process.env.EMAIL_USER) return process.env.EMAIL_USER;

  const admin = await dbGet(
    `SELECT email FROM users WHERE role = 'Admin' AND email IS NOT NULL ORDER BY id ASC LIMIT 1`
  );
  return admin?.email || null;
};

const sendMailWithFallback = async (mailOptions) => {
  const usingRealEmail = !!(process.env.EMAIL_HOST && process.env.EMAIL_USER);
  if (!usingRealEmail) {
    console.log('Dev mode: Simulated career application email');
    console.log('To:', mailOptions.to);
    console.log('Subject:', mailOptions.subject);
    return { simulated: true };
  }
  return transporter.sendMail(mailOptions);
};

exports.getPublicOpenings = async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, title, tags, location, description, requirements, status, created_at
       FROM career_openings
       WHERE status = 'OPEN'
       ORDER BY created_at DESC`
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        tags: row.tags || '',
        subtitle: row.location || '',
        description: parseJsonArray(row.description),
        requirements: parseJsonArray(row.requirements),
        status: row.status,
        createdAt: row.created_at,
      }))
    );
  } catch (err) {
    console.error('Failed to fetch public openings:', err);
    res.status(500).json({ error: 'Failed to fetch openings' });
  }
};

exports.getAdminOpenings = async (_req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, title, tags, location, description, requirements, status, created_by, created_at, updated_at
       FROM career_openings
       ORDER BY created_at DESC`
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        title: row.title,
        tags: row.tags || '',
        location: row.location || '',
        description: parseJsonArray(row.description),
        requirements: parseJsonArray(row.requirements),
        status: row.status,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }))
    );
  } catch (err) {
    console.error('Failed to fetch admin openings:', err);
    res.status(500).json({ error: 'Failed to fetch openings' });
  }
};

exports.createOpening = async (req, res) => {
  try {
    const { title, tags, location, description, requirements, status } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const adminId = req.user?.id || req.user?.sub || null;
    const result = await dbRun(
      `INSERT INTO career_openings
       (title, tags, location, description, requirements, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(title).trim(),
        tags || null,
        location || null,
        toJsonString(description),
        toJsonString(requirements),
        status === 'CLOSED' ? 'CLOSED' : 'OPEN',
        adminId,
      ]
    );

    const created = await dbGet(`SELECT * FROM career_openings WHERE id = ?`, [result.lastID]);
    res.status(201).json({
      id: created.id,
      title: created.title,
      tags: created.tags || '',
      location: created.location || '',
      description: parseJsonArray(created.description),
      requirements: parseJsonArray(created.requirements),
      status: created.status,
      createdAt: created.created_at,
      updatedAt: created.updated_at,
    });
  } catch (err) {
    console.error('Failed to create opening:', err);
    res.status(500).json({ error: 'Failed to create opening' });
  }
};

exports.updateOpening = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, tags, location, description, requirements, status } = req.body || {};

    const updates = [];
    const values = [];

    if (title !== undefined) {
      updates.push('title = ?');
      values.push(String(title).trim());
    }
    if (tags !== undefined) {
      updates.push('tags = ?');
      values.push(tags || null);
    }
    if (location !== undefined) {
      updates.push('location = ?');
      values.push(location || null);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(toJsonString(description));
    }
    if (requirements !== undefined) {
      updates.push('requirements = ?');
      values.push(toJsonString(requirements));
    }
    if (status !== undefined) {
      updates.push('status = ?');
      values.push(status === 'CLOSED' ? 'CLOSED' : 'OPEN');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    await dbRun(`UPDATE career_openings SET ${updates.join(', ')} WHERE id = ?`, values);
    const updated = await dbGet(`SELECT * FROM career_openings WHERE id = ?`, [id]);
    if (!updated) return res.status(404).json({ error: 'Opening not found' });

    res.json({
      id: updated.id,
      title: updated.title,
      tags: updated.tags || '',
      location: updated.location || '',
      description: parseJsonArray(updated.description),
      requirements: parseJsonArray(updated.requirements),
      status: updated.status,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
    });
  } catch (err) {
    console.error('Failed to update opening:', err);
    res.status(500).json({ error: 'Failed to update opening' });
  }
};

exports.deleteOpening = async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun(`DELETE FROM career_openings WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete opening:', err);
    res.status(500).json({ error: 'Failed to delete opening' });
  }
};

exports.applyToOpening = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, message } = req.body || {};

    if (!full_name || !String(full_name).trim() || !phone || !String(phone).trim()) {
      return res.status(400).json({ error: 'full_name and phone are required' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'resume is required' });
    }

    const opening = await dbGet(
      `SELECT id, title, status FROM career_openings WHERE id = ?`,
      [id]
    );

    if (!opening || opening.status !== 'OPEN') {
      return res.status(404).json({ error: 'Opening not available' });
    }

    await dbRun(
      `INSERT INTO career_applications
       (opening_id, full_name, email, phone, message, resume_file_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        opening.id,
        String(full_name).trim(),
        email || null,
        String(phone).trim(),
        message || null,
        req.file.originalname || null,
      ]
    );

    const recipient = await resolveHrRecipient();
    if (!recipient) {
      return res.status(500).json({ error: 'Admin HR email is not configured' });
    }

    await sendMailWithFallback({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@studio.com',
      to: recipient,
      subject: `New Job Application - ${opening.title}`,
      html: `
        <h3>New Career Application</h3>
        <p><strong>Position:</strong> ${opening.title}</p>
        <p><strong>Name:</strong> ${String(full_name).trim()}</p>
        <p><strong>Phone:</strong> ${String(phone).trim()}</p>
        <p><strong>Email:</strong> ${email || 'N/A'}</p>
        <p><strong>Message:</strong> ${message || 'N/A'}</p>
      `,
      attachments: [
        {
          filename: req.file.originalname,
          content: req.file.buffer,
          contentType: req.file.mimetype,
        },
      ],
    });

    res.status(201).json({ message: 'Application submitted successfully' });
  } catch (err) {
    console.error('Failed to submit application:', err);
    res.status(500).json({ error: 'Failed to submit application' });
  }
};

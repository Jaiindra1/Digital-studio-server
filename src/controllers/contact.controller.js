const { sendMail } = require('../utils/mail');

const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

exports.submitContact = async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const subject = String(req.body.subject || 'General enquiry').trim();
  const message = String(req.body.message || '').trim();

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }
  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (name.length > 100 || email.length > 160 || phone.length > 30 || subject.length > 160 || message.length > 5000) {
    return res.status(400).json({ error: 'One or more fields exceed the allowed length.' });
  }

  const studioEmail = process.env.CONTACT_EMAIL || process.env.EMAIL_USER;
  if (!studioEmail) {
    return res.status(503).json({ error: 'Contact email is not configured. Please call the studio instead.' });
  }

  try {
    await sendMail({
      to: studioEmail,
      replyTo: email,
      subject: `Website enquiry: ${subject}`,
      text: `New website enquiry\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone || 'Not provided'}\nSubject: ${subject}\n\n${message}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#0f172a"><h2 style="color:#0284c7">New website enquiry</h2><p><strong>Name:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><p><strong>Phone:</strong> ${escapeHtml(phone || 'Not provided')}</p><p><strong>Subject:</strong> ${escapeHtml(subject)}</p><div style="margin-top:20px;padding:18px;background:#f8fafc;border-radius:12px;line-height:1.6">${escapeHtml(message).replaceAll('\n', '<br>')}</div></div>`,
    });

    await sendMail({
      to: email,
      subject: 'We received your message — Rafia Digital Studio',
      text: `Hi ${name},\n\nThank you for contacting Rafia Digital Studio. We received your message and will get back to you shortly.\n\nRegards,\nRafia Digital Studio`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#0f172a"><h2>Thank you, ${escapeHtml(name)}.</h2><p style="line-height:1.7">We received your message and a member of Rafia Digital Studio will get back to you shortly.</p><p style="margin-top:24px;color:#64748b">Rafia Digital Studio<br>Andhra Pradesh, India</p></div>`,
    });

    return res.status(201).json({ message: 'Your message has been sent successfully.' });
  } catch (error) {
    console.error('Contact email failed:', error.message);
    return res.status(502).json({ error: 'We could not send your message right now. Please try again shortly.' });
  }
};

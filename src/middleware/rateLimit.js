const buckets = new Map();

module.exports = ({ windowMs = 15 * 60 * 1000, max = 30 } = {}) => (req, res, next) => {
  const key = `${req.ip || req.socket.remoteAddress}:${req.baseUrl}`;
  const now = Date.now(); const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) { buckets.set(key, { count: 1, resetAt: now + windowMs }); return next(); }
  bucket.count += 1;
  if (bucket.count > max) return res.status(429).json({ message: 'Too many requests. Please wait and try again.' });
  return next();
};

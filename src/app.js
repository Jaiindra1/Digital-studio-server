require('dotenv').config();
require('./config/db');
const cors = require('cors');
const express = require('express');
const app = express();
const albumRoutes = require("./routes/album.routes");
const mediaRoutes = require("./routes/media.routes");
const bookingRoutes = require("./routes/booking.routes");

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://192.168.29.49:3000',
  'https://www.rafiyadigitalstudio.in/',
  'http://192.168.29.49:5173',
  'https://digital-studio-chi.vercel.app'
]);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser clients (Postman, curl, server-to-server)
    if (!origin) return callback(null, true);

    // Exact known origins
    if (allowedOrigins.has(origin)) return callback(null, true);

    // Allow LAN dev hosts on common Vite/React ports
    if (/^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:(3000|3001|5173)$/.test(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Name']
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'studio-backend', timestamp: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/client-auth', require('./routes/client.auth.routes'));
app.use('/api/staff-auth', require('./routes/staff.auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/staff', require('./routes/staff.routes'));
app.use('/api/clients', require('./routes/clients.routes'));
app.use('/api/events', require('./routes/events.routes'));
app.use('/api/payments', require('./routes/payments.routes'));
app.use('/api/public', require('./routes/public.routes'));
app.use("/api/albums", albumRoutes);
app.use("/api/media", mediaRoutes);
app.use('/api/cat', require('./routes/gallery.routes'));
app.use('/api/studio', require('./routes/studio.routes.js'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/attendance', require('./routes/attendance.routes'));
app.use('/api/tasks', require('./routes/task'));
app.use('/api/notifications', require('./routes/notifications.routes'));
app.use('/api/email-templates', require('./routes/emailTemplates.routes'));
app.use('/api/careers', require('./routes/careers.routes'));
app.use('/api/public/careers', require('./routes/public.careers.routes'));
app.use('/api/products', require('./routes/products.routes'));
app.use('/api/service-options', require('./routes/serviceOptions.routes'));
app.use('/api/contact', require('./routes/contact.routes'));
app.use('/api/custom-design-requests', require('./routes/customDesign.routes'));

// Add booking route
app.use('/api/booking', bookingRoutes);

module.exports = app;

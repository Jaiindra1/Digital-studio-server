require('dotenv').config();
require('./db/db');
const cors = require('cors');
const express = require('express');
const app = express();
const albumRoutes = require("./routes/album.routes");
const mediaRoutes = require("./routes/media.routes");
const bookingRoutes = require("./routes/booking.routes");

app.use(cors({
  origin: ['http://localhost:3000','http://localhost:3001', 'http://localhost:5173', 'https://digital-studio-chi.vercel.app'],
  credentials: true
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

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

// Add booking route
app.use('/api/booking', bookingRoutes);

module.exports = app;

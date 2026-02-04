require('dotenv').config();
require('./db/db');
const cors = require('cors');
const express = require('express');
const app = express();
const albumRoutes = require("./routes/album.routes");
const mediaRoutes = require("./routes/media.routes");

app.use(cors({
  origin: ['http://localhost:3000','http://localhost:3001','https://digital-studio-chi.vercel.app'],
  credentials: true
}));
app.use(express.json());

app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/client-auth', require('./routes/client.auth.routes'));
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/staff', require('./routes/staff.routes'));
app.use('/api/clients', require('./routes/clients.routes'));
app.use('/api/events', require('./routes/events.routes'));
app.use('/api/public', require('./routes/public.routes'));
app.use("/api/albums", albumRoutes);
app.use("/api/media", mediaRoutes);
app.use('/api/cat', require('./routes/gallery.routes'));
app.use('/api/studio', require('./routes/studio.routes'));
app.use('/api/public', require('./routes/public.routes'));
app.use('/api/booking', require('./routes/booking.routes'));
app.use('/api/payments', require('./routes/payments.routes'));
app.use('/api/notifications', require('./routes/notifications.routes'));


module.exports = app;

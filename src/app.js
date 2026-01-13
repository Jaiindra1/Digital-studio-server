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
app.use('/api/admin', require('./routes/admin.routes'));
app.use('/api/staff', require('./routes/staff.routes'));
app.use('/api/clients', require('./routes/clients.routes'));
app.use('/api/events', require('./routes/events.routes'));
app.use('/api/public', require('./routes/public.routes'));
app.use("/api/albums", albumRoutes);
app.use("/api/media", mediaRoutes);
app.use('/api/cat', require('./routes/gallery.routes'));


module.exports = app;

const app = require('./app');
const http = require('http');
const socketIo = require('socket.io');

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:3001', 'https://digital-studio-chi.vercel.app'],
    credentials: true
  }
});

const jwt = require('jsonwebtoken');

// Socket authentication middleware (expects handshake.auth.token)
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(); // allow anonymous connections (frontend can ignore)

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.user = decoded;
    return next();
  } catch (err) {
    console.warn('Socket auth failed:', err.message);
    return next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  if (user && (user.role === 'Admin' || user.role === 'Staff')) {
    socket.join('admins');
    console.log(`Socket ${socket.id} joined 'admins' room`);
  }

  socket.on('disconnect', () => {
    // Optionally handle disconnect cleanup
  });
});

// Make io available in routes/controllers
app.set('io', io);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

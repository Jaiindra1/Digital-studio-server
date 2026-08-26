const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

const secret = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET';
const token = jwt.sign({ sub: 1, role: 'Admin', email: 'dev@local' }, secret);

const eventId = process.argv[2] || '1';

fetch(`http://localhost:4000/api/events/${eventId}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ stage: 'CONFIRMED' })
})
  .then(async res => {
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text);
  })
  .catch(err => console.error('Fetch error:', err));

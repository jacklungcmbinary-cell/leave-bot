const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
console.log('Using HTTP - proxy will handle HTTPS');

// Performance: Enable compression
const compression = require('compression');
app.use(compression());

// Performance: Set cache headers for static files
app.use((req, res, next) => {
  if (req.url.match(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/)) {
    res.set('Cache-Control', 'public, max-age=31536000'); // 1 year
  } else {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// Data storage
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading data:', err);
  }
  return { leaveRecords: [] };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving data:', err);
  }
}

let data = loadData();

// Serve static files with compression
app.use(express.static(path.join(__dirname), {
  maxAge: '1d',
  etag: false
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoints
app.get('/api/data', (req, res) => {
  res.json(data);
});

app.post('/api/leave', (req, res) => {
  const { colleague, type, date, halfDay } = req.body;
  
  if (!colleague || !type || !date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const id = `${colleague}-${type}-${date}-${Date.now()}`;
  const record = {
    id,
    colleague,
    type,
    date,
    halfDay: halfDay || null,
    createdAt: new Date().toISOString()
  };

  data.leaveRecords.push(record);
  saveData(data);

  // Broadcast to all connected clients
  broadcastUpdate({
    type: 'add',
    record
  });

  res.json(record);
});

app.get('/api/event', (req, res) => {
  if (!data.events) {
    data.events = [];
  }
  res.json(data.events);
});

app.post('/api/event', (req, res) => {
  const { date, name } = req.body;
  
  if (!date || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const id = `event-${Date.now()}`;
  const event = {
    id,
    date,
    name
  };

  if (!data.events) {
    data.events = [];
  }
  data.events.push(event);
  saveData(data);

  // Broadcast to all connected clients
  broadcastUpdate({
    type: 'addEvent',
    event
  });

  res.json(event);
});

app.put('/api/event/:id', (req, res) => {
  const { id } = req.params;
  const { date, name } = req.body;
  
  if (!date || !name) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!data.events) {
    data.events = [];
  }

  const event = data.events.find(e => e.id === id);
  if (!event) {
    return res.status(404).json({ error: 'Event not found' });
  }

  event.date = date;
  event.name = name;
  saveData(data);

  // Broadcast to all connected clients
  broadcastUpdate({
    type: 'updateEvent',
    event
  });

  res.json(event);
});


app.delete('/api/event/:id', (req, res) => {
  const { id } = req.params;
  
  if (!data.events) {
    data.events = [];
  }
  
  const index = data.events.findIndex(e => e.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Event not found' });
  }

  const removed = data.events.splice(index, 1)[0];
  saveData(data);

  // Broadcast to all connected clients
  broadcastUpdate({
    type: 'removeEvent',
    id
  });

  res.json(removed);
});

app.delete('/api/leave/:id', (req, res) => {
  const { id } = req.params;
  
  const index = data.leaveRecords.findIndex(r => r.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const removed = data.leaveRecords.splice(index, 1)[0];
  saveData(data);

  // Broadcast to all connected clients
  broadcastUpdate({
    type: 'remove',
    id
  });

  res.json(removed);
});

// WebSocket connections
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  // Send current data to new client
  ws.send(JSON.stringify({
    type: 'init',
    data
  }));

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

function broadcastUpdate(update) {
  const message = JSON.stringify(update);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Add version query parameter support
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '-1');
  res.sendFile(path.join(__dirname, 'index.html'));
});

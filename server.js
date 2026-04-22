const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();

// Monday.com Configuration
const MONDAY_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0ODcxMjcxMSwiYWFpIjoxMSwidWlkIjo1MDg0OTQ5MiwiaWFkIjoiMjAyNi0wNC0yMlQwODo0NjoyMS4yMDVaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTkzOTcyODgsInJnbiI6ImFwc2UyIn0.N_jtFty6oCii738vTDwXGNNs5dQXfVtXAZZpspn9sQg";
const MONDAY_BOARD_ID = "5027993274";

async function syncToMonday(record) {
  const url = "https://api.monday.com/v2";
  const itemName = `${record.colleague} - ${record.type}${record.halfDay ? ' (' + record.halfDay.toUpperCase() + ')' : ''}`;
  
  // Prepare column values
  const columnValues = {
    "date4": { "date": record.date },
    "status": { "label": record.type === 'AL' ? 'Working' : 'Done' } // Mapping AL/EL to status if needed
  };

  const query = `
    mutation ($itemName: String!, $boardId: ID!, $columnValues: JSON!) {
      create_item (
        board_id: $boardId,
        item_name: $itemName,
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  try {
    const response = await axios.post(url, {
      query: query,
      variables: {
        itemName: itemName,
        boardId: MONDAY_BOARD_ID,
        columnValues: JSON.stringify(columnValues)
      }
    }, {
      headers: {
        'Authorization': MONDAY_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.errors) {
      console.error('Monday API Errors:', response.data.errors);
    } else {
      console.log('Successfully synced to Monday:', response.data.data.create_item.id);
      return response.data.data.create_item.id;
    }
  } catch (error) {
    console.error('Error syncing to Monday:', error.message);
  }
  return null;
}
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
console.log('Using HTTP - proxy will handle HTTPS');

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

// Serve static files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// API endpoints
app.get('/api/data', (req, res) => {
  res.json(data);
});

app.post('/api/sync-monday', async (req, res) => {
  const results = [];
  for (const record of data.leaveRecords) {
    if (!record.mondayId) {
      const mondayId = await syncToMonday(record);
      if (mondayId) {
        record.mondayId = mondayId;
        results.push({ id: record.id, mondayId });
      }
    }
  }
  if (results.length > 0) {
    saveData(data);
  }
  res.json({ message: `Synced ${results.length} items to Monday`, details: results });
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

  // Sync to Monday.com
  syncToMonday(record).then(mondayId => {
    if (mondayId) {
      record.mondayId = mondayId;
      saveData(data);
    }
  });

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

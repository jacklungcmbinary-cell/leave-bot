const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();

// Monday.com Configuration
const MONDAY_API_KEY = process.env.MONDAY_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0ODcxMjcxMSwiYWFpIjoxMSwidWlkIjo1MDg0OTQ5MiwiaWFkIjoiMjAyNi0wNC0yMlQwODo0NjoyMS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTkzOTcyODgsInJnbiI6ImFwc2UyIn0.tmxNC_r13mrtzrQ4mI6lDdMCtgdlphejzM1p_-rhGVI';
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || '5027993274';

// Monday.com Group Mapping
const GROUP_MAPPING = {
  'Jenny': 'group_mkya843p',
  'Holly': 'new_group__1',
  'Aaron': 'group_mkwhgk46',
  'Varina': 'new_group65085__1',
  'Rita': 'new_group84931__1',
  'Jack': 'new_group39905__1',
  'Holiday': 'new_group3699__1',
  'Event': 'group_mm2nrf5g'
};

async function syncToMonday(record, type = 'leave') {
  const url = "https://api.monday.com/v2";
  let itemName = '';
  let groupId = '';
  let dateVal = '';

  if (type === 'leave') {
    itemName = `${record.colleague} - ${record.type}${record.halfDay ? ' (' + record.halfDay.toUpperCase() + ')' : ''}`;
    groupId = GROUP_MAPPING[record.colleague] || '';
    dateVal = record.date;
  } else if (type === 'event') {
    itemName = record.name;
    groupId = GROUP_MAPPING['Event'];
    dateVal = record.date;
  } else if (type === 'holiday') {
    itemName = record.name;
    groupId = GROUP_MAPPING['Holiday'];
    dateVal = record.date;
  }

  if (!groupId) {
    console.error(`Group ID not found for ${type}: ${record.colleague || 'Holiday/Event'}`);
    return null;
  }

  const columnValues = {
    "date4": { "date": dateVal }
  };

  const query = `
    mutation ($itemName: String!, $boardId: ID!, $groupId: String!, $columnValues: JSON!) {
      create_item (
        board_id: $boardId,
        group_id: $groupId,
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
        groupId: groupId,
        columnValues: JSON.stringify(columnValues)
      }
    }, {
      headers: {
        'Authorization': MONDAY_API_KEY,
        'Content-Type': 'application/json',
        'API-Version': '2023-10'
      }
    });

    if (response.data.errors) {
      console.error('Monday API Errors:', response.data.errors);
    } else {
      console.log(`Successfully synced ${type} to Monday:`, response.data.data.create_item.id);
      return response.data.data.create_item.id;
    }
  } catch (error) {
    console.error(`Error syncing ${type} to Monday:`, error.message);
  }
  return null;
}

async function updateMondayItem(record, type = 'leave') {
  if (!record.mondayId) return null;

  const url = "https://api.monday.com/v2";
  let itemName = '';
  let dateVal = '';

  if (type === 'leave') {
    itemName = `${record.colleague} - ${record.type}${record.halfDay ? ' (' + record.halfDay.toUpperCase() + ')' : ''}`;
    dateVal = record.date;
  } else if (type === 'event') {
    itemName = record.name;
    dateVal = record.date;
  }

  const columnValues = {
    "date4": { "date": dateVal }
  };

  const query = `
    mutation ($itemId: ID!, $boardId: ID!, $columnValues: JSON!) {
      change_multiple_column_values (
        item_id: $itemId,
        board_id: $boardId,
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
        itemId: record.mondayId,
        boardId: MONDAY_BOARD_ID,
        columnValues: JSON.stringify(columnValues)
      }
    }, {
      headers: {
        'Authorization': MONDAY_API_KEY,
        'Content-Type': 'application/json',
        'API-Version': '2023-10'
      }
    });

    if (response.data.errors) {
      console.error('Monday API Errors (update):', response.data.errors);
    } else {
      console.log('Successfully updated Monday item:', record.mondayId);
      return record.mondayId;
    }
  } catch (error) {
    console.error('Error updating Monday item:', error.message);
  }
  return null;
}

async function deleteMondayItem(mondayId) {
  if (!mondayId) return false;
  const url = "https://api.monday.com/v2";
  const query = `mutation ($itemId: ID!) { delete_item (item_id: $itemId) { id } }`;
  try {
    const response = await axios.post(url, { 
      query, 
      variables: { itemId: mondayId } 
    }, {
      headers: { 
        'Authorization': MONDAY_API_KEY, 
        'Content-Type': 'application/json',
        'API-Version': '2023-10'
      }
    });
    if (response.data.errors) {
        console.error('Monday API Errors (delete):', response.data.errors);
        return false;
    }
    console.log('Successfully deleted Monday item:', mondayId);
    return true;
  } catch (error) {
    console.error('Error deleting Monday item:', error.message);
    return false;
  }
}

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) { console.error('Error loading data:', err); }
  return { leaveRecords: [], events: [] };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('Error saving data:', err); }
}

let data = loadData();

app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/data', (req, res) => res.json(data));

app.post('/api/sync-monday-all', async (req, res) => {
  const results = { leaves: [], events: [] };
  for (const record of data.leaveRecords) {
    if (!record.mondayId) {
      const mId = await syncToMonday(record, 'leave');
      if (mId) { record.mondayId = mId; results.leaves.push(record.id); }
    }
  }
  for (const event of (data.events || [])) {
    if (!event.mondayId) {
      const mId = await syncToMonday(event, 'event');
      if (mId) { event.mondayId = mId; results.events.push(event.id); }
    }
  }
  saveData(data);
  res.json({ message: `Synced ${results.leaves.length} leaves and ${results.events.length} events`, details: results });
});

app.post('/api/leave', (req, res) => {
  const { colleague, type, date, halfDay } = req.body;
  if (!colleague || !type || !date) return res.status(400).json({ error: 'Missing fields' });
  const record = { id: `${colleague}-${type}-${date}-${Date.now()}`, colleague, type, date, halfDay: halfDay || null, createdAt: new Date().toISOString() };
  data.leaveRecords.push(record);
  saveData(data);
  syncToMonday(record, 'leave').then(mondayId => { if (mondayId) { record.mondayId = mondayId; saveData(data); } });
  broadcastUpdate({ type: 'add', record });
  res.json(record);
});

app.put('/api/leave/:id', async (req, res) => {
  const { id } = req.params;
  const { colleague, type, date, halfDay } = req.body;
  const index = data.leaveRecords.findIndex(r => r.id === id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const record = data.leaveRecords[index];
  Object.assign(record, { colleague, type, date, halfDay: halfDay || null });
  saveData(data);
  if (record.mondayId) await updateMondayItem(record, 'leave');
  broadcastUpdate({ type: 'update', record });
  res.json(record);
});

app.delete('/api/leave/:id', async (req, res) => {
  const index = data.leaveRecords.findIndex(r => r.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const removed = data.leaveRecords.splice(index, 1)[0];
  saveData(data);
  if (removed.mondayId) await deleteMondayItem(removed.mondayId);
  broadcastUpdate({ type: 'remove', id: req.params.id });
  res.json(removed);
});

app.get('/api/event', (req, res) => res.json(data.events || []));

app.post('/api/event', (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'Missing fields' });
  const event = { id: `event-${Date.now()}`, date, name };
  if (!data.events) data.events = [];
  data.events.push(event);
  saveData(data);
  syncToMonday(event, 'event').then(mondayId => { if (mondayId) { event.mondayId = mondayId; saveData(data); } });
  broadcastUpdate({ type: 'addEvent', event });
  res.json(event);
});

app.put('/api/event/:id', async (req, res) => {
  const event = (data.events || []).find(e => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Not found' });
  Object.assign(event, req.body);
  saveData(data);
  if (event.mondayId) await updateMondayItem(event, 'event');
  broadcastUpdate({ type: 'updateEvent', event });
  res.json(event);
});

app.delete('/api/event/:id', async (req, res) => {
  const index = (data.events || []).findIndex(e => e.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });
  const removed = data.events.splice(index, 1)[0];
  saveData(data);
  if (removed.mondayId) await deleteMondayItem(removed.mondayId);
  broadcastUpdate({ type: 'removeEvent', id: req.params.id });
  res.json(removed);
});

app.post('/api/sync-holiday', async (req, res) => {
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'Missing fields' });
  const holidayRecord = { date, name };
  const mondayId = await syncToMonday(holidayRecord, 'holiday');
  if (mondayId) {
    res.json({ success: true, mondayId });
  } else {
    res.status(500).json({ error: 'Failed to sync holiday' });
  }
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', data }));
  ws.on('close', () => clients.delete(ws));
});

const clients = new Set();
function broadcastUpdate(update) {
  const msg = JSON.stringify(update);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

server.listen(3000, () => console.log('Server running on port 3000'));

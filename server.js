const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const { MongoClient } = require('mongodb');

const app = express();

// --- Configuration ---
const MONDAY_API_KEY = process.env.MONDAY_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0ODcxMjcxMSwiYWFpIjoxMSwidWlkIjo1MDg0OTQ5MiwiaWFkIjoiMjAyNi0wNC0yMlQwODo0NjoyMS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTkzOTcyODgsInJnbiI6ImFwc2UyIn0.tmxNC_r13mrtzrQ4mI6lDdMCtgdlphejzM1p_-rhGVI';
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || '5027993274';
const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://jacklungcmbinary_db_user:FsZNjFirzQRT8LNR@cluster0.p7xge.mongodb.net/leave_bot_db?retryWrites=true&w=majority";

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

const DATA_FILE = path.join(__dirname, 'data.json');

// --- Database Connection ---
let db, leaveCollection, eventCollection;
const client = new MongoClient(MONGO_URI);

async function connectDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    // Explicitly use leave_bot_db as requested
    db = client.db("leave_bot_db");
    // Explicitly use leaveRecords (case-sensitive) as requested
    leaveCollection = db.collection("leaveRecords");
    eventCollection = db.collection("events");
    
    await forceSyncFromMonday();
    await refreshLocalData();
  } catch (err) {
    console.error("MongoDB Connection Error:", err.message);
    data = loadLocalData();
  }
}

// --- Data Management ---
let data = { leaveRecords: [], events: [] };

function loadLocalData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) { console.error('Error loading local data:', err); }
  return { leaveRecords: [], events: [] };
}

async function refreshLocalData() {
  try {
    const leaves = await leaveCollection.find({}).toArray();
    const events = await eventCollection.find({}).toArray();
    data = { leaveRecords: leaves, events: events };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`Data refreshed from MongoDB: ${leaves.length} leaves, ${events.length} events`);
  } catch (err) {
    console.error("Error refreshing data from MongoDB:", err);
  }
}

async function forceSyncFromMonday() {
  console.log("Starting force sync from Monday.com...");
  const url = "https://api.monday.com/v2";
  const query = `query { boards (ids: ${MONDAY_BOARD_ID}) { items_page (limit: 500) { items { id name group { id } column_values (ids: ["date4"]) { text value } } } } }`;
  
  try {
    const response = await axios.post(url, { query }, {
      headers: { 'Authorization': MONDAY_API_KEY, 'API-Version': '2023-10' }
    });
    
    if (!response.data.data || !response.data.data.boards[0]) return;

    const items = response.data.data.boards[0].items_page.items;
    const reverseGroupMapping = Object.fromEntries(Object.entries(GROUP_MAPPING).map(([k, v]) => [v, k]));
    const mondayIds = items.map(i => i.id);
    
    for (const item of items) {
      const colleague = reverseGroupMapping[item.group.id];
      if (!colleague) continue;
      
      const dateVal = item.column_values[0].text;
      if (!dateVal) continue;

      if (colleague === 'Event') {
        await eventCollection.updateOne(
          { mondayId: item.id },
          { $set: { name: item.name, date: dateVal, mondayId: item.id } },
          { upsert: true }
        );
      } else {
        const typeMatch = item.name.match(/ - ([A-Z]+)/);
        const type = typeMatch ? typeMatch[1] : 'AL';
        const halfDayMatch = item.name.match(/\((AM|PM)\)/i);
        const halfDay = halfDayMatch ? halfDayMatch[1].toLowerCase() : null;

        await leaveCollection.updateOne(
          { mondayId: item.id },
          { $set: { colleague, type, date: dateVal, halfDay, mondayId: item.id, id: item.id }},
          { upsert: true }
        );
      }
    }
    // Clean up records that no longer exist on Monday.com
    await leaveCollection.deleteMany({ mondayId: { $nin: mondayIds } });
    await eventCollection.deleteMany({ mondayId: { $nin: mondayIds } });
    console.log("Force sync completed.");
  } catch (err) {
    console.error("Error during force sync:", err.message);
  }
}

function backupToGit() {
  const commitMsg = `data: auto-sync at ${new Date().toISOString()}`;
  exec(`git add data.json && git commit -m "${commitMsg}" && git push origin main`, (error) => {
    if (error) console.error(`Git push error: ${error.message}`);
  });
}

// --- Monday.com Integration ---
async function syncToMonday(record, type = 'leave') {
  const url = "https://api.monday.com/v2";
  let itemName = '', groupId = '', dateVal = '';

  if (type === 'leave') {
    itemName = `${record.colleague} - ${record.type}${record.halfDay ? ' (' + record.halfDay.toUpperCase() + ')' : ''}`;
    groupId = GROUP_MAPPING[record.colleague] || '';
    dateVal = record.date;
  } else if (type === 'event') {
    itemName = record.name;
    groupId = GROUP_MAPPING['Event'];
    dateVal = record.date;
  }

  if (!groupId) return null;

  const query = `mutation ($itemName: String!, $boardId: ID!, $groupId: String!, $columnValues: JSON!) { create_item (board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $columnValues) { id } }`;

  try {
    const response = await axios.post(url, {
      query,
      variables: { itemName, boardId: MONDAY_BOARD_ID, groupId, columnValues: JSON.stringify({ "date4": { "date": dateVal } }) }
    }, {
      headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' }
    });
    return response.data.data?.create_item?.id || null;
  } catch (error) {
    console.error(`Error syncing to Monday:`, error.message);
    return null;
  }
}

async function deleteMondayItem(mondayId) {
  if (!mondayId) return;
  const url = "https://api.monday.com/v2";
  const query = `mutation ($itemId: ID!) { delete_item (item_id: $itemId) { id } }`;
  try {
    await axios.post(url, { query, variables: { itemId: mondayId } }, {
      headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' }
    });
  } catch (err) { console.error('Error deleting from Monday:', err.message); }
}

// --- Express App ---
app.use(express.static(path.join(__dirname)));
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/data', (req, res) => res.json(data));
app.get('/api/event', (req, res) => res.json(data.events));

// --- Monday Webhook for Backward Sync ---
app.post('/api/monday-webhook', async (req, res) => {
  if (req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (!event) return res.sendStatus(200);

  console.log(`Received Monday Webhook: ${event.type}`);

  try {
    if (event.type === 'update_column_value' || event.type === 'change_column_value') {
      if (event.column_id === 'date4') {
        const newDate = event.value.date;
        await leaveCollection.updateOne({ mondayId: event.pulseId.toString() }, { $set: { date: newDate } });
        await refreshLocalData();
        broadcastUpdate({ type: 'init', data });
      }
    } else if (event.type === 'delete_item') {
      await leaveCollection.deleteOne({ mondayId: event.pulseId.toString() });
      await refreshLocalData();
      broadcastUpdate({ type: 'init', data });
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }

  res.sendStatus(200);
});

app.post('/api/leave', async (req, res) => {
  const { colleague, type, date, halfDay } = req.body;
  const record = { 
    id: `${colleague}-${type}-${date}-${Date.now()}`, 
    colleague, type, date, 
    halfDay: halfDay || null, 
    createdAt: new Date().toISOString() 
  };
  await leaveCollection.insertOne(record);
  const mondayId = await syncToMonday(record, 'leave');
  if (mondayId) {
    record.mondayId = mondayId;
    await leaveCollection.updateOne({ id: record.id }, { $set: { mondayId, id: mondayId } });
    record.id = mondayId;
  }
  await refreshLocalData();
  backupToGit();
  broadcastUpdate({ type: 'add', record });
  res.json(record);
});

app.delete('/api/leave/:id', async (req, res) => {
  const record = await leaveCollection.findOne({ id: req.params.id });
  if (!record) return res.status(404).json({ error: 'Not found' });
  await leaveCollection.deleteOne({ id: req.params.id });
  if (record.mondayId) await deleteMondayItem(record.mondayId);
  await refreshLocalData();
  backupToGit();
  broadcastUpdate({ type: 'remove', id: req.params.id });
  res.json(record);
});

// --- WebSocket ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', data }));
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'moveLeave') {
        const { leaveId, newDate } = msg;
        const record = await leaveCollection.findOne({ id: leaveId });
        if (record) {
          await leaveCollection.updateOne({ id: leaveId }, { $set: { date: newDate } });
          if (record.mondayId) {
            const url = "https://api.monday.com/v2";
            const query = `mutation ($itemId: ID!, $columnValues: JSON!) { change_column_value (board_id: ${MONDAY_BOARD_ID}, item_id: $itemId, column_id: "date4", value: $columnValues) { id } }`;
            await axios.post(url, { query, variables: { itemId: record.mondayId, columnValues: JSON.stringify({ "date": newDate }) } }, {
              headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' }
            });
          }
          await refreshLocalData();
          broadcastUpdate({ type: 'update', record: { ...record, date: newDate } });
        }
      }
    } catch (err) { console.error('WS error:', err); }
  });
  ws.on('close', () => clients.delete(ws));
});

function broadcastUpdate(update) {
  const msg = JSON.stringify(update);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

connectDB().then(() => {
  server.listen(3000, () => console.log('Server running with Bi-directional Sync and leave_bot_db priority'));
});

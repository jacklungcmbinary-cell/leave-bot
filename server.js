const express = require('express');
const http = require('http');
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
// Updated with provided credentials
const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://jacklungcmbinary_db_user:FsZNjFirzQRT8LNR@cluster0.p7xge.mongodb.net/leave_bot?retryWrites=true&w=majority";

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
let db, leaveCollection, eventCollection, balanceCollection;
const client = new MongoClient(MONGO_URI);

async function connectDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    db = client.db("leave_bot");
    leaveCollection = db.collection("leaverecords");
    eventCollection = db.collection("events");
    balanceCollection = db.collection("balances");
    
    await forceSyncFromMonday();
    await refreshLocalData();
  } catch (err) {
    console.error("MongoDB Connection Error:", err.message);
    data = loadLocalData();
  }
}

// --- Data Management ---
let data = { leaveRecords: [], events: [], balances: {} };

function loadLocalData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (err) { console.error('Error loading local data:', err); }
  return { leaveRecords: [], events: [], balances: {} };
}

async function refreshLocalData() {
  try {
    const leaves = await leaveCollection.find({}).toArray();
    const events = await eventCollection.find({}).toArray();
    const balancesArr = await balanceCollection.find({}).toArray();
    
    const balances = {};
    balancesArr.forEach(b => { balances[b.colleague] = b.balance; });
    
    data = { leaveRecords: leaves, events: events, balances: balances };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`Data refreshed: ${leaves.length} leaves, ${events.length} events`);
  } catch (err) {
    console.error("Error refreshing data:", err);
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
          { $set: { name: item.name, date: dateVal, mondayId: item.id, id: item.id } },
          { upsert: true }
        );
      } else {
        const typeMatch = item.name.match(/ - ([A-Z\s]+)/);
        const type = typeMatch ? typeMatch[1].trim() : 'AL';
        const halfDayMatch = item.name.match(/\((AM|PM)\)/i);
        const halfDay = halfDayMatch ? halfDayMatch[1].toLowerCase() : null;

        await leaveCollection.updateOne(
          { mondayId: item.id },
          { $set: { colleague, type, date: dateVal, halfDay, mondayId: item.id, id: item.id }},
          { upsert: true }
        );
      }
    }
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
app.get('/api/leave', (req, res) => res.json(data.leaveRecords));
app.get('/api/event', (req, res) => res.json(data.events));
app.get('/api/balance', (req, res) => res.json(data.balances));

// --- Monday Webhook ---
app.post('/api/monday-webhook', async (req, res) => {
  if (req.body.challenge) return res.json({ challenge: req.body.challenge });
  const event = req.body.event;
  if (!event) return res.sendStatus(200);

  try {
    if (event.type === 'update_column_value' || event.type === 'change_column_value') {
      if (event.column_id === 'date4') {
        const newDate = event.value.date;
        await leaveCollection.updateOne({ mondayId: event.pulseId.toString() }, { $set: { date: newDate } });
        await eventCollection.updateOne({ mondayId: event.pulseId.toString() }, { $set: { date: newDate } });
        await refreshLocalData();
        broadcastUpdate({ type: 'init', data });
      }
    } else if (event.type === 'delete_item') {
      await leaveCollection.deleteOne({ mondayId: event.pulseId.toString() });
      await eventCollection.deleteOne({ mondayId: event.pulseId.toString() });
      await refreshLocalData();
      broadcastUpdate({ type: 'init', data });
    }
  } catch (err) { console.error('Webhook error:', err.message); }
  res.sendStatus(200);
});

app.post('/api/leave', async (req, res) => {
  const { colleague, type, date, halfDay } = req.body;
  const record = { colleague, type, date, halfDay: halfDay || null, createdAt: new Date().toISOString() };
  const mondayId = await syncToMonday(record, 'leave');
  if (mondayId) {
    record.mondayId = mondayId;
    record.id = mondayId;
    await leaveCollection.updateOne({ mondayId: record.mondayId }, { $set: record }, { upsert: true });
  }
  await refreshLocalData();
  backupToGit();
  broadcastUpdate({ type: 'add', record });
  res.json(record);
});

app.delete('/api/leave/:id', async (req, res) => {
  const record = await leaveCollection.findOne({ id: req.params.id });
  if (record) {
    await leaveCollection.deleteOne({ id: req.params.id });
    if (record.mondayId) await deleteMondayItem(record.mondayId);
    await refreshLocalData();
    backupToGit();
    broadcastUpdate({ type: 'remove', id: req.params.id });
  }
  res.json({ success: true });
});

app.post('/api/event', async (req, res) => {
  const { name, date } = req.body;
  const record = { name, date };
  const mondayId = await syncToMonday(record, 'event');
  if (mondayId) {
    record.mondayId = mondayId;
    record.id = mondayId;
    await eventCollection.updateOne({ mondayId: record.mondayId }, { $set: record }, { upsert: true });
  }
  await refreshLocalData();
  broadcastUpdate({ type: 'init', data });
  res.json(record);
});

app.delete('/api/event/:id', async (req, res) => {
  const record = await eventCollection.findOne({ id: req.params.id });
  if (record) {
    await eventCollection.deleteOne({ id: req.params.id });
    if (record.mondayId) await deleteMondayItem(record.mondayId);
    await refreshLocalData();
    broadcastUpdate({ type: 'init', data });
  }
  res.json({ success: true });
});

app.post('/api/sync-monday-all', async (req, res) => {
  await forceSyncFromMonday();
  await refreshLocalData();
  broadcastUpdate({ type: 'init', data });
  res.json({ success: true });
});

// --- WebSocket ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'init', data }));
  ws.on('close', () => clients.delete(ws));
});

function broadcastUpdate(update) {
  const msg = JSON.stringify(update);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

connectDB().then(() => {
  server.listen(3000, () => console.log('Server running on port 3000'));
});

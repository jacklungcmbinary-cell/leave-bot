const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { exec } = require('child_process');
const { MongoClient, ObjectId } = require('mongodb');
const cron = require('node-cron');

const app = express();

// --- Configuration ---
const MONDAY_API_KEY = process.env.MONDAY_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0ODcxMjcxMSwiYWFpIjoxMSwidWlkIjo1MDg0OTQ5MiwiaWFkIjoiMjAyNi0wNC0yMlQwODo0NjoyMS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTkzOTcyODgsInJnbiI6ImFwc2UyIn0.tmxNC_r13mrtzrQ4mI6lDdMCtgdlphejzM1p_-rhGVI';
const MONDAY_BOARD_ID = process.env.MONDAY_BOARD_ID || '5027993274';
const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://jacklungcmbinary_db_user:FsZNjFirzQRT8LNR@cluster0.p7xge.mongodb.net/leave_bot?retryWrites=true&w=majority";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

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
    
    const formattedLeaves = leaves.map(l => ({ ...l, id: l.id || l.mondayId || l._id.toString() }));
    const formattedEvents = events.map(e => ({ ...e, id: e.id || e.mondayId || e._id.toString() }));
    
    const balances = {};
    balancesArr.forEach(b => { balances[b.colleague] = b.balance; });
    
    data = { leaveRecords: formattedLeaves, events: formattedEvents, balances: balances };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`Data refreshed: ${formattedLeaves.length} leaves, ${formattedEvents.length} events`);
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
      headers: { 'Authorization': MONDAY_API_KEY, 'API-Version': '2023-10' },
      timeout: 10000
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
    await leaveCollection.deleteMany({ mondayId: { $exists: true, $nin: mondayIds } });
    await eventCollection.deleteMany({ mondayId: { $exists: true, $nin: mondayIds } });
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

// --- Slack Notification Logic ---
async function sendSlackMessage(text) {
  if (!SLACK_WEBHOOK_URL) {
    console.warn('SLACK_WEBHOOK_URL not set, skipping notification.');
    return;
  }
  try {
    await axios.post(SLACK_WEBHOOK_URL, {
      text: text,
      link_names: 1
    });
    console.log('Slack notification sent successfully');
  } catch (err) {
    console.error('Error sending Slack notification:', err.message);
  }
}

// Schedule: Today's Leaves at 10:00 AM HK Time
cron.schedule('0 10 * * *', async () => {
  console.log('Running 10AM Slack Notification...');
  const leaves = await leaveCollection.find({}).toArray();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
  
  const todaysLeaves = leaves.filter(r => r.date === today);
  if (todaysLeaves.length > 0) {
    let msg = `📢 *今日團隊出勤狀況 (${today})*\n`;
    todaysLeaves.forEach(r => {
      const timeSlot = r.halfDay ? ` (${r.halfDay.toUpperCase()})` : (r.type === 'EL' ? '' : ' (FULL)');
      msg += `• *${r.colleague}*: ${r.type}${timeSlot}\n`;
    });
    msg += `\n_請大家留意相關工作交接，祝工作順利！_`;
    await sendSlackMessage(msg);
  }
}, { timezone: "Asia/Hong_Kong" });

// Schedule: Tomorrow's Leaves at 3:00 PM HK Time
cron.schedule('0 15 * * *', async () => {
  console.log('Running 3PM Slack Notification...');
  const leaves = await leaveCollection.find({}).toArray();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
  
  const tomorrowsLeaves = leaves.filter(r => r.date === tomorrow);
  if (tomorrowsLeaves.length > 0) {
    let msg = `📅 *明日請假預告 (${tomorrow})*\n`;
    tomorrowsLeaves.forEach(r => {
      const timeSlot = r.halfDay ? ` (${r.halfDay.toUpperCase()})` : (r.type === 'EL' ? '' : ' (FULL)');
      msg += `• *${r.colleague}*: ${r.type}${timeSlot}\n`;
    });
    msg += `\n_提醒大家提前處理明日的交接事項，謝謝！_`;
    await sendSlackMessage(msg);
  }
}, { timezone: "Asia/Hong_Kong" });

// --- Monday.com Integration ---
async function syncToMonday(record, type = 'leave') {
  const url = "https://api.monday.com/v2";
  let itemName = '', groupId = '', dateVal = '';

  if (type === 'leave') {
    const halfDaySuffix = record.halfDay ? ` (${record.halfDay.toUpperCase()})` : (record.type === 'EL' ? '' : ' (Full)');
    itemName = `${record.colleague} - ${record.type}${halfDaySuffix}`;
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
      headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' },
      timeout: 10000
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
      headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' },
      timeout: 10000
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
  if (req.body.challenge) {
    return res.json({ challenge: req.body.challenge });
  }

  const event = req.body.event;
  if (!event) return res.sendStatus(200);

  try {
    const pulseId = (event.pulseId || event.itemId || event.pulse_id)?.toString();
    if (!pulseId) return res.sendStatus(200);

    if (event.type === 'update_column_value' || event.type === 'change_column_value') {
      if (event.column_id === 'date4' || event.columnId === 'date4') {
        const url = "https://api.monday.com/v2";
        const queryStr = `query { items (ids: [${pulseId}]) { id name group { id } column_values (ids: ["date4"]) { text } } }`;
        
        const response = await axios.post(url, { query: queryStr }, {
          headers: { 'Authorization': MONDAY_API_KEY, 'API-Version': '2023-10' },
          timeout: 10000
        });

        const item = response.data.data?.items?.[0];
        if (item && item.column_values?.[0]?.text) {
          const newDate = item.column_values[0].text;
          const reverseGroupMapping = Object.fromEntries(Object.entries(GROUP_MAPPING).map(([k, v]) => [v, k]));
          const colleague = reverseGroupMapping[item.group.id];
          
          const dbQuery = { $or: [{ mondayId: pulseId }, { id: pulseId }] };
          
          if (colleague === 'Event') {
            await eventCollection.updateOne(dbQuery, { $set: { name: item.name, date: newDate } });
          } else {
            const typeMatch = item.name.match(/ - ([A-Z\s]+)/);
            const type = typeMatch ? typeMatch[1].trim() : 'AL';
            const halfDayMatch = item.name.match(/\((AM|PM)\)/i);
            const halfDay = halfDayMatch ? halfDayMatch[1].toLowerCase() : null;
            
            await leaveCollection.updateOne(dbQuery, { $set: { colleague, type, date: newDate, halfDay } });
          }
          
          await refreshLocalData();
          broadcastUpdate({ type: 'init', data });
        }
      }
    } 
    else if (event.type === 'delete_item' || event.type === 'item_deleted') {
      const query = { $or: [{ mondayId: pulseId }, { id: pulseId }] };
      await leaveCollection.deleteOne(query);
      await eventCollection.deleteOne(query);
      await refreshLocalData();
      broadcastUpdate({ type: 'init', data });
    }
  } catch (err) { 
    console.error('Webhook processing error:', err.message); 
  }
  res.sendStatus(200);
});

app.post('/api/leave', async (req, res) => {
  try {
    const { colleague, type, date, halfDay } = req.body;
    const record = { colleague, type, date, halfDay: halfDay || null, createdAt: new Date().toISOString() };
    
    const mondayId = await syncToMonday(record, 'leave');
    if (mondayId) {
      record.mondayId = mondayId;
      record.id = mondayId;
      await leaveCollection.updateOne({ mondayId: record.mondayId }, { $set: record }, { upsert: true });
    } else {
      const result = await leaveCollection.insertOne(record);
      record.id = result.insertedId.toString();
    }



    await refreshLocalData();
    backupToGit();
    broadcastUpdate({ type: 'init', data });
    res.json(record);
  } catch (err) {
    console.error('Error in POST /api/leave:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leave/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const record = await leaveCollection.findOne({ $or: [{ id: id }, { mondayId: id }] });
    if (record) {
      await leaveCollection.deleteOne({ _id: record._id });
      if (record.mondayId) await deleteMondayItem(record.mondayId);
      


      await refreshLocalData();
      backupToGit();
      broadcastUpdate({ type: 'init', data });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE /api/leave:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/event', async (req, res) => {
  try {
    const { name, date } = req.body;
    const record = { name, date };
    const mondayId = await syncToMonday(record, 'event');
    if (mondayId) {
      record.mondayId = mondayId;
      record.id = mondayId;
      await eventCollection.updateOne({ mondayId: record.mondayId }, { $set: record }, { upsert: true });
    } else {
      const result = await eventCollection.insertOne(record);
      record.id = result.insertedId.toString();
    }
    await refreshLocalData();
    broadcastUpdate({ type: 'init', data });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/event/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const record = await eventCollection.findOne({ $or: [{ id: id }, { mondayId: id }] });
    if (record) {
      await eventCollection.deleteOne({ _id: record._id });
      if (record.mondayId) await deleteMondayItem(record.mondayId);
      await refreshLocalData();
      broadcastUpdate({ type: 'init', data });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync-monday-all', async (req, res) => {
  try {
    await forceSyncFromMonday();
    await refreshLocalData();
    broadcastUpdate({ type: 'init', data });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
        const { id, newDate, itemType } = msg;
        if (itemType === 'event') {
          const event = await eventCollection.findOne({ $or: [{ id: id }, { mondayId: id }] });
          if (event) {
            await eventCollection.updateOne({ _id: event._id }, { $set: { date: newDate } });
            if (event.mondayId) await updateMondayDate(event.mondayId, newDate);
          }
        } else {
          const leave = await leaveCollection.findOne({ $or: [{ id: id }, { mondayId: id }] });
          if (leave) {
            await leaveCollection.updateOne({ _id: leave._id }, { $set: { date: newDate } });
            if (leave.mondayId) await updateMondayDate(leave.mondayId, newDate);
          }
        }
        await refreshLocalData();
        broadcastUpdate({ type: 'init', data });
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => clients.delete(ws));
});

async function updateMondayDate(mondayId, newDate) {
  const url = "https://api.monday.com/v2";
  const query = `mutation ($itemId: ID!, $boardId: ID!, $columnValues: JSON!) { change_multiple_column_values (item_id: $itemId, board_id: $boardId, column_values: $columnValues) { id } }`;
  try {
    await axios.post(url, {
      query,
      variables: { 
        itemId: mondayId, 
        boardId: MONDAY_BOARD_ID, 
        columnValues: JSON.stringify({ "date4": { "date": newDate } }) 
      }
    }, {
      headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' },
      timeout: 10000
    });
  } catch (err) {
    console.error('Error updating date on Monday:', err.message);
  }
}

function broadcastUpdate(update) {
  const msg = JSON.stringify(update);
  clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

connectDB().then(() => {
  server.listen(3000, () => console.log('Server running on port 3000'));
});

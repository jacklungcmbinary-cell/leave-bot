const axios = require('axios');
const fs = require('fs');
const MONDAY_API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0ODcxMjcxMSwiYWFpIjoxMSwidWlkIjo1MDg0OTQ5MiwiaWFkIjoiMjAyNi0wNC0yMlQwODo0NjoyMS4wMDBaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MTkzOTcyODgsInJnbiI6ImFwc2UyIn0.tmxNC_r13mrtzrQ4mI6lDdMCtgdlphejzM1p_-rhGVI';
const MONDAY_BOARD_ID = '5027993274';

async function cleanup() {
  const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
  const validIds = new Set();
  data.leaveRecords.forEach(r => { if (r.mondayId) validIds.add(r.mondayId); });
  (data.events || []).forEach(e => { if (e.mondayId) validIds.add(e.mondayId); });

  const url = 'https://api.monday.com/v2';
  const query = `query { boards (ids: ${MONDAY_BOARD_ID}) { items_page (limit: 100) { items { id name } } } }`;

  try {
    const response = await axios.post(url, { query }, {
      headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json' }
    });
    const items = response.data.data.boards[0].items_page.items;
    for (const item of items) {
      if (!validIds.has(item.id) && item.name !== 'Test Holiday') {
        console.log('Deleting duplicate/invalid item:', item.id, item.name);
        const delQuery = 'mutation ($itemId: ID!) { delete_item (item_id: $itemId) { id } }';
        await axios.post(url, { query: delQuery, variables: { itemId: item.id } }, {
          headers: { 'Authorization': MONDAY_API_KEY, 'Content-Type': 'application/json', 'API-Version': '2023-10' }
        });
      }
    }
    console.log('Cleanup complete.');
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}
cleanup();

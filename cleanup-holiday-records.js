/**
 * One-time cleanup script: Remove all Holiday AL records from MongoDB leaveCollection.
 * These records were incorrectly synced from Monday.com Holiday group.
 * Run once after deploying the bug fix.
 */
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI || "mongodb+srv://jacklungcmbinary_db_user:FsZNjFirzQRT8LNR@cluster0.p7xge.mongodb.net/leave_bot?retryWrites=true&w=majority";

async function cleanupHolidayRecords() {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    const db = client.db("leave_bot");
    const leaveCollection = db.collection("leaverecords");

    // Find all Holiday AL records
    const holidayRecords = await leaveCollection.find({ colleague: 'Holiday' }).toArray();
    console.log(`Found ${holidayRecords.length} Holiday AL records to remove:`);
    holidayRecords.forEach(r => console.log(`  - ${r.date} | mondayId: ${r.mondayId || 'none'}`));

    if (holidayRecords.length > 0) {
      const result = await leaveCollection.deleteMany({ colleague: 'Holiday' });
      console.log(`Deleted ${result.deletedCount} Holiday AL records from MongoDB.`);
    } else {
      console.log("No Holiday AL records found. Nothing to clean up.");
    }
  } catch (err) {
    console.error("Error during cleanup:", err.message);
  } finally {
    await client.close();
    console.log("Done.");
  }
}

cleanupHolidayRecords();

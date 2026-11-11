import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
const names = ['restaurants','branches','products','categories','customization-groups','users','orders','inventory'];
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
if (process.env.CONFIRM_IMPORT !== 'YES') { console.error('Set CONFIRM_IMPORT=YES to import local JSON. Existing nonempty MongoDB collections will not be overwritten.'); process.exit(1); }
if (!process.env.MONGODB_URI) { console.error('MONGODB_URI is required'); process.exit(1); }
const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
try {
  await client.connect();
  const collection = client.db(process.env.MONGODB_DB_NAME || 'deltakebab').collection('dk_collections');
  const sources = [];
  for (const name of names) {
    const records = JSON.parse(await fs.readFile(path.join(dir, name + '.json'), 'utf8'));
    if (!Array.isArray(records)) throw Error(name + '.json must contain an array');
    sources.push({ name, records });
  }
  // Preflight: never overwrite existing data, including collections already modified by the admin panel.
  for (const {name} of sources) {
    const doc = await collection.findOne({ _id: name });
    if (doc && (doc.records?.length || doc.version)) throw Error('Import stopped: ' + name + ' already contains data or has been modified. No import performed.');
  }
  for (const {name, records} of sources) {
    const result = await collection.updateOne(
      { _id: name, version: 0, records: { $size: 0 } },
      { $set: { records, updatedAt: new Date() }, $inc: { version: 1 } }
    );
    if (result.matchedCount === 0) {
      // An absent collection can be inserted, but never replace existing data.
      const existing = await collection.findOne({ _id: name });
      if (existing) throw Error('Import interrupted: ' + name + ' changed during import');
      await collection.insertOne({ _id: name, records, version: 1, updatedAt: new Date() });
    }
    console.log('Imported', name, records.length, 'records');
  }
  console.log('Import completed. Local JSON files remain unchanged.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await client.close(); }

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const allowed = new Set(['restaurants','branches','products','categories','customization-groups','users','orders','inventory','delivery-settings','delivery-promotions']);
const mode = process.env.STORAGE_DRIVER || 'json';
if (!['json','mongodb'].includes(mode)) throw new Error('STORAGE_DRIVER must be json or mongodb');
const cache = new Map();
const queues = new Map();
let client;
let connection;

function check(name) { if (!allowed.has(name)) throw Error('Unknown collection: ' + name); return name; }
function filename(name) { return path.join(dir, `${check(name)}.json`); }

async function mongoCollection() {
  if (mode !== 'mongodb') throw Error('MongoDB storage is not enabled');
  if (!process.env.MONGODB_URI) throw Error('MONGODB_URI is required when STORAGE_DRIVER=mongodb');
  if (!connection) {
    client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: Number(process.env.DB_POOL_MAX || 10), serverSelectionTimeoutMS: 10000 });
    connection = client.connect().then(async () => {
      const db = client.db(process.env.MONGODB_DB_NAME || 'deltakebab');
      await db.command({ ping: 1 });
      return db.collection('dk_collections');
    }).catch(async err => { connection = null; await client.close().catch(()=>{}); throw err; });
  }
  return connection;
}

export async function initStorage() {
  if (mode !== 'mongodb') return;
  const collection = await mongoCollection();
  for (const name of allowed) {
    await collection.updateOne({ _id: name }, { $setOnInsert: { records: [], version: 0, updatedAt: new Date() } }, { upsert: true });
  }
}

export async function list(name) {
  check(name);
  if (mode === 'mongodb') {
    const collection = await mongoCollection();
    const document = await collection.findOne({ _id: name });
    if (!document) throw Error('MongoDB not initialized; run npm run db:init');
    return structuredClone(document.records);
  }
  if (!cache.has(name)) cache.set(name, JSON.parse(await fs.readFile(filename(name), 'utf8')));
  return structuredClone(cache.get(name));
}

export async function mutate(name, callback) {
  check(name);
  const previous = queues.get(name) || Promise.resolve();
  const task = previous.catch(()=>{}).then(async () => {
    if (mode === 'mongodb') {
      const collection = await mongoCollection();
      for (let attempt = 0; attempt < 8; attempt++) {
        const document = await collection.findOne({ _id: name });
        if (!document) throw Error('MongoDB not initialized; run npm run db:init');
        const records = structuredClone(document.records);
        const result = await callback(records);
        const updated = await collection.updateOne(
          { _id: name, version: document.version },
          { $set: { records, updatedAt: new Date() }, $inc: { version: 1 } }
        );
        if (updated.modifiedCount === 1) return result;
      }
      throw Error('Concurrent database updates; please retry');
    }
    const records = await list(name);
    const result = await callback(records);
    const file = filename(name), temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(records, null, 2), { flag:'wx', mode:0o600 });
    try { await fs.rename(temp, file); } catch(e) { await fs.rm(temp,{force:true}); throw e; }
    cache.set(name, records);
    return result;
  });
  queues.set(name, task);
  return task;
}

export const repositories = Object.fromEntries([...allowed].map(n => [n, { list: () => list(n), mutate: fn => mutate(n, fn) }]));
export async function closeStorage() { if (client) await client.close(); }
export function storageMode() { return mode === 'mongodb' ? 'mongodb' : 'local-json'; }

// Atomic branch + first employee creation. Atlas replica sets support transactions.
export async function createBranchAndEmployee(branch, employee) {
  if (mode !== 'mongodb') throw Error('Atomic branch creation requires STORAGE_DRIVER=mongodb');
  await mongoCollection();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const col = client.db(process.env.MONGODB_DB_NAME || 'deltakebab').collection('dk_collections');
      const branches = await col.findOne({_id:'branches'}, {session});
      const users = await col.findOne({_id:'users'}, {session});
      if (!branches || !users) throw Error('Initialize MongoDB first');
      if (branches.records.some(x => x.id === branch.id)) throw Error('Branch ID already exists');
      if (users.records.some(x => x.email?.toLowerCase() === employee.email.toLowerCase() || x.username?.toLowerCase() === employee.username.toLowerCase())) throw Object.assign(new Error('Employee username or email already exists'),{status:409});
      await col.updateOne({_id:'branches'}, {$push:{records:branch},$inc:{version:1},$set:{updatedAt:new Date()}}, {session});
      await col.updateOne({_id:'users'}, {$push:{records:employee},$inc:{version:1},$set:{updatedAt:new Date()}}, {session});
    });
  } finally { await session.endSession(); }
}

// Save a product and its private customization groups in one MongoDB transaction.
// Existing group IDs may only be edited when they belong to this product and branch.
export async function saveProductWithOptions(branchId, productId, productData, optionGroups) {
  if (mode !== 'mongodb') throw Object.assign(new Error('Atomic product saving requires STORAGE_DRIVER=mongodb'), {status:400});
  await mongoCollection();
  const session = client.startSession();
  let saved;
  try {
    await session.withTransaction(async () => {
      const col = client.db(process.env.MONGODB_DB_NAME || 'deltakebab').collection('dk_collections');
      const pd = await col.findOne({_id:'products'}, {session});
      const gd = await col.findOne({_id:'customization-groups'}, {session});
      if (!pd || !gd) throw new Error('Initialize MongoDB first');
      const products = structuredClone(pd.records), groups = structuredClone(gd.records);
      let existing = productId ? products.find(p=>p.id===productId && p.branchId===branchId) : null;
      if (productId && !existing) throw Object.assign(new Error('Product not found'), {status:404});
      const previousIds = new Set(existing?.customizationGroupIds || []);
      const ids=[];
      for (const input of optionGroups) {
        let g;
        if (input.id) {
          g = groups.find(x=>x.id===input.id && x.branchId===branchId);
          if (!g || !previousIds.has(input.id)) throw Object.assign(new Error('Option group does not belong to this product'), {status:403});
          if (products.some(p=>p.id!==productId && p.customizationGroupIds?.includes(input.id))) throw Object.assign(new Error('Shared option group cannot be edited here; create a new group'), {status:409});
          Object.assign(g,{name:input.name,min:input.min,max:input.max,options:input.options});
        } else {
          g={id:crypto.randomUUID(),branchId,name:input.name,min:input.min,max:input.max,options:input.options};
          groups.push(g);
        }
        ids.push(g.id);
      }
      // Keep removed groups if another product still references them; otherwise remove.
      const detached=[...previousIds].filter(id=>!ids.includes(id));
      for(const id of detached){
        if (!products.some(p=>p.id!==productId && p.customizationGroupIds?.includes(id))) {
          const idx=groups.findIndex(g=>g.id===id && g.branchId===branchId);
          if(idx>=0) groups.splice(idx,1);
        }
      }
      if (existing) Object.assign(existing,productData,{customizationGroupIds:ids});
      else {existing={...productData,id:crypto.randomUUID(),branchId,currency:'PLN',archived:false,customizationGroupIds:ids};products.push(existing);}
      saved=structuredClone(existing);
      await col.updateOne({_id:'customization-groups'},{$set:{records:groups,updatedAt:new Date()},$inc:{version:1}},{session});
      await col.updateOne({_id:'products'},{$set:{records:products,updatedAt:new Date()},$inc:{version:1}},{session});
    });
    return saved;
  } finally {await session.endSession();}
}

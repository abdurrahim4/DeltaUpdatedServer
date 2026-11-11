import 'dotenv/config';
import { initStorage, closeStorage } from '../src/repositories/jsonStore.js';
try { await initStorage(); console.log('MongoDB connection successful; collections initialized.'); }
catch (error) { console.error('MongoDB initialization failed:', error.message); process.exitCode = 1; }
finally { await closeStorage(); }

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/agent.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db: any;

try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
} catch (e1) {
  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
  } catch (e2) {
    console.error('Failed to load SQLite adapter (both node:sqlite and better-sqlite3):', e1, e2);
    throw e2;
  }
}

let schemaPath = path.join(__dirname, 'schema.sql');
if (!fs.existsSync(schemaPath)) {
  const fallback = path.join(process.cwd(), 'server', 'db', 'schema.sql');
  if (fs.existsSync(fallback)) {
    schemaPath = fallback;
  }
}
const schema = fs.readFileSync(schemaPath, 'utf-8');
db.exec(schema);

export default db;

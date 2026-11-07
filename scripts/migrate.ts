import pg from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

export async function runMigration() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL or DATABASE_URL_UNPOOLED is missing in environment');
  }

  console.log('Connecting to Neon PostgreSQL...');
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to Neon successfully!');

  const schemaPath = path.resolve('src/db/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  console.log('Applying schema.sql to Neon...');
  await client.query(sql);
  console.log('Schema applied successfully.');

  const res = await client.query('SELECT count(*) as count FROM doctors');
  console.log(`Verified doctors in database: ${res.rows[0].count} doctors loaded.`);

  await client.end();
  return res.rows[0].count;
}

if (process.argv[1] && process.argv[1].includes('migrate.ts')) {
  runMigration()
    .then(() => {
      console.log('Migration script finished with success.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

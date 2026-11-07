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

  console.log('Connecting to Neon PostgreSQL for migration...');
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected to Neon successfully!');

  // Look for migration SQL in apps/api/src/db/migrations/
  const migrationPath = path.resolve('apps/api/src/db/migrations/0001_phase2_booking_core.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  console.log('Applying 0001_phase2_booking_core.sql to Neon...');
  await client.query(sql);
  console.log('Migration applied successfully.');

  // Verify tables
  const tableCheck = await client.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name;
  `);

  const tables = tableCheck.rows.map((r) => r.table_name);
  console.log('Public tables in Neon DB:', tables.join(', '));

  await client.end();
  return tables;
}

if (process.argv[1] && process.argv[1].includes('migrate.ts')) {
  runMigration()
    .then((tables) => {
      console.log(`Migration completed. Total tables verified: ${tables.length}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

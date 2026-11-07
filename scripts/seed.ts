import pg from 'pg';
import dotenv from 'dotenv';
import { SEEDED_DOCTORS, SEEDED_APPOINTMENT_TYPES } from '@appointly/shared';

dotenv.config();

export async function runSeed() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL or DATABASE_URL_UNPOOLED is missing in environment');
  }

  console.log('Connecting to Neon PostgreSQL for database seeding...');
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  console.log('Seeding doctors...');
  for (const doc of SEEDED_DOCTORS) {
    await client.query(
      `
      INSERT INTO doctors (id, name, specialty, working_hours_start, working_hours_end, active_days, duration_minutes, fee, available_slots)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        specialty = EXCLUDED.specialty,
        working_hours_start = EXCLUDED.working_hours_start,
        working_hours_end = EXCLUDED.working_hours_end,
        active_days = EXCLUDED.active_days,
        duration_minutes = EXCLUDED.duration_minutes,
        fee = EXCLUDED.fee;
      `,
      [
        doc.id,
        doc.name,
        doc.specialty,
        doc.workingHoursStart,
        doc.workingHoursEnd,
        doc.activeDays,
        doc.durationMinutes || 30,
        doc.fee || 500,
        doc.availableSlots || [],
      ]
    );
  }
  console.log(`Successfully seeded ${SEEDED_DOCTORS.length} doctors.`);

  console.log('Seeding appointment types (visit types)...');
  for (const type of SEEDED_APPOINTMENT_TYPES) {
    await client.query(
      `
      INSERT INTO appointment_types (id, name, duration_min, fee, description)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        duration_min = EXCLUDED.duration_min,
        fee = EXCLUDED.fee,
        description = EXCLUDED.description;
      `,
      [type.id, type.name, type.durationMin, type.fee, type.description]
    );
  }
  console.log(`Successfully seeded ${SEEDED_APPOINTMENT_TYPES.length} appointment types.`);

  const docCount = await client.query('SELECT count(*) as count FROM doctors');
  const typeCount = await client.query('SELECT count(*) as count FROM appointment_types');

  console.log(
    `Verification: ${docCount.rows[0].count} doctors, ${typeCount.rows[0].count} appointment types.`
  );

  await client.end();
  return {
    doctors: parseInt(docCount.rows[0].count, 10),
    appointmentTypes: parseInt(typeCount.rows[0].count, 10),
  };
}

if (process.argv[1] && process.argv[1].includes('seed.ts')) {
  runSeed()
    .then((res) => {
      console.log('Seed finished successfully:', res);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}

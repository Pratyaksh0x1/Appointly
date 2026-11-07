import { IDatabaseClient } from './client.js';
import { MemoryDatabaseClient } from './memory-db.js';
import { PostgresDatabaseClient } from './postgres-db.js';
import { getEnv } from '../config/env.js';
import { rootLogger } from '../logger/logger.js';

let dbInstance: IDatabaseClient | null = null;

export function getDatabaseClient(): IDatabaseClient {
  if (!dbInstance) {
    const env = getEnv();
    if (env.USE_IN_MEMORY_DB) {
      rootLogger.info('Initializing Appointly In-Memory Transactional Database');
      dbInstance = new MemoryDatabaseClient();
    } else {
      rootLogger.info('Connecting Appointly to PostgreSQL Database', {
        url: env.DATABASE_URL.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@'),
      });
      dbInstance = new PostgresDatabaseClient(env.DATABASE_URL);
    }
  }
  return dbInstance;
}

export { IDatabaseClient } from './client.js';
export { MemoryDatabaseClient } from './memory-db.js';
export { PostgresDatabaseClient } from './postgres-db.js';


import { Pool, type QueryResult } from 'pg';

/**
 * Shared pg pool for the MediTrack app database. Tests receive the same
 * query surface production uses so repository specs exercise real SQL.
 */
const pool = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? 'meditrack_test',
  max: 4,
});

export async function query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}

export async function endPool(): Promise<void> {
  await pool.end();
}

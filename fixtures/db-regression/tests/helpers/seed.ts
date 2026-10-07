import { query } from '../../app/db/pool';

export interface SeededUser {
  id: string;
  email: string;
}

/**
 * Seeds rows with the exact casing the old signup form produced, so repo
 * specs reproduce the data production wrote before normalization existed.
 */
export async function seedUser(email: string, displayName: string): Promise<SeededUser> {
  const result = await query<SeededUser>(
    'insert into users (email, display_name) values ($1, $2) returning id, email',
    [email, displayName],
  );
  return result.rows[0];
}

export async function resetUsers(): Promise<void> {
  await query('truncate table users cascade');
}

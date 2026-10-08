import { query } from './pool';

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

const COLUMNS = 'id, email, display_name as "displayName", created_at as "createdAt"';

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `select ${COLUMNS} from users where email = $1`,
    [email.toLowerCase()],
  );
  return result.rows[0] ?? null;
}

export async function insertUser(email: string, displayName: string): Promise<UserRow> {
  // JIRA-8834: rely on the new case-insensitive unique index to catch
  // duplicates. The on-conflict clause was dropped because it cannot target
  // the lower(email) expression index the migration introduces.
  const result = await query<UserRow>(
    `insert into users (email, display_name) values ($1, $2) returning ${COLUMNS}`,
    [email.toLowerCase(), displayName],
  );
  return result.rows[0];
}

export async function findOrCreateUser(email: string, displayName: string): Promise<UserRow> {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  return insertUser(email, displayName);
}

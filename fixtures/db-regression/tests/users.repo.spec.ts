import { describe, it, expect, beforeEach } from 'vitest';
import { findOrCreateUser, findUserByEmail } from '../app/db/users';
import { seedUser, resetUsers } from './helpers/seed';

describe('users repository', () => {
  beforeEach(async () => {
    await resetUsers();
  });

  it('creates a user when the email has never been seen', async () => {
    const user = await findOrCreateUser('ravi.iyer@meditrack.example', 'Ravi Iyer');
    expect(user.id).toBeTruthy();
    expect(user.email).toEqual('ravi.iyer@meditrack.example');
  });

  it('returns the existing user when the email differs only by case', async () => {
    await seedUser('Maya.Okafor@meditrack.example', 'Maya Okafor');
    const user = await findOrCreateUser('maya.okafor@meditrack.example', 'Maya O.');
    expect(user.displayName).toEqual('Maya Okafor');
  });

  it('finds a stored user by normalized email', async () => {
    await seedUser('tomas.lund@meditrack.example', 'Tomas Lund');
    const found = await findUserByEmail('Tomas.Lund@meditrack.example');
    expect(found).not.toBeNull();
  });
});

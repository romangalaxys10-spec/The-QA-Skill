import { handleCreateOrder, type ApiRequest, type ApiResponse } from '../../app/api/orders';

/**
 * Supertest-style client wired straight to the route handler. Status codes
 * and bodies are exactly what the express layer would emit because the
 * handler owns both.
 */
export function post(path: string, body?: unknown): ApiResponse {
  const req: ApiRequest = { method: 'POST', path, body };
  return handleCreateOrder(req);
}

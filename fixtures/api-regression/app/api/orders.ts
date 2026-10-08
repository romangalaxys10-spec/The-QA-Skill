import { validateOrderDraft, type OrderDraft } from '../lib/order-schema';

export interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

interface RecordedOrder {
  id: string;
  customerId: string;
  totalCents: number;
}

const orders = new Map<string, RecordedOrder>();

function nextOrderId(): string {
  return `ord_${String(orders.size + 1).padStart(4, '0')}`;
}

function persistDraft(draft: OrderDraft): ApiResponse {
  const totalCents = draft.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPriceCents,
    0,
  );
  const id = nextOrderId();
  orders.set(id, { id, customerId: draft.customerId, totalCents });
  return { status: 201, body: { id, status: 'created', totalCents } };
}

export function handleCreateOrder(req: ApiRequest): ApiResponse {
  if (req.method !== 'POST' || req.path !== '/api/orders') {
    return { status: 405, body: { message: 'unsupported route for this handler' } };
  }
  const validation = validateOrderDraft(req.body as Partial<OrderDraft>);
  if (validation.ok) {
    return persistDraft(req.body as OrderDraft);
  }
  // JIRA-2201: clients currently crash on 4xx bodies for recoverable
  // drafts, so we acknowledge the draft and surface the problems list in
  // the body instead of failing the request.
  return {
    status: 200,
    body: { accepted: false, problems: validation.problems },
  };
}

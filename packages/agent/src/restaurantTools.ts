import { appendEvent, createTask, getTask, setSlots, transition, type Db } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';

const TEMPLATE_KEY = 'restaurant_reservation';
const ABSOLUTE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const RESTAURANT_TOOLS: ToolSpec[] = [
  {
    def: {
      name: 'prepare_restaurant_reservation_handoff',
      description: 'Prepare a restaurant-reservation search for the exact date, local time, party size, place and optional restaurant/cuisine the user requested. This creates a Waiting task and returns supported booking links. It does not verify availability, hold a table, submit a reservation, or spend money. Say that plainly and show the returned links.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City, neighborhood, or exact area supplied by the user.' },
          date_time: { type: 'string', description: 'Future local date and time as ISO 8601 with an explicit timezone offset.' },
          party_size: { type: 'number', description: 'Whole number of diners from 1 to 20.' },
          query: { type: 'string', description: 'Optional restaurant name, cuisine, or preference supplied by the user.' },
        },
        required: ['location', 'date_time', 'party_size'],
        additionalProperties: false,
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'mark_restaurant_reservation_booked',
      description: 'Mark a restaurant handoff task booked only after the user explicitly says they completed the booking. This records the user report; it does not contact or independently verify the restaurant.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          provider: { type: 'string', description: 'Where the user says they booked, such as OpenTable or the restaurant.' },
          restaurant_name: { type: 'string' },
          confirmation_code: { type: 'string', description: 'Optional confirmation code supplied by the user. Never request or store payment-card data.' },
        },
        required: ['task_id'],
        additionalProperties: false,
      },
    },
    actionClass: 'task_management',
  },
];

function cleanText(value: unknown, label: string, max: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > max) throw new Error(`${label} is too long.`);
  return text;
}

function bookingLinks(args: { location: string; dateTime: string; partySize: number; query?: string }) {
  const match = ABSOLUTE_TIME.exec(args.dateTime);
  if (!match) throw new Error('Choose an exact future date and local time with a timezone offset.');
  const instant = Date.parse(args.dateTime);
  if (!Number.isFinite(instant) || instant <= Date.now()) throw new Error('Choose a reservation time in the future.');
  const term = [args.query, args.location].filter(Boolean).join(' ');
  const openTable = new URL('https://www.opentable.com/s');
  openTable.searchParams.set('dateTime', `${match[1]}T${match[2]}:00`);
  openTable.searchParams.set('covers', String(args.partySize));
  openTable.searchParams.set('term', term);
  const maps = new URL('https://www.google.com/maps/search/');
  maps.searchParams.set('api', '1');
  maps.searchParams.set('query', [args.query || 'restaurants', args.location].join(' '));
  return { open_table_url: openTable.toString(), google_maps_url: maps.toString() };
}

export async function executeRestaurantTool(
  db: Db,
  userId: string,
  threadId: string | null,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (name === 'prepare_restaurant_reservation_handoff') {
    let location: string;
    let query: string;
    let dateTime: string;
    try {
      location = cleanText(input.location, 'Location', 160);
      query = input.query === undefined ? '' : cleanText(input.query, 'Restaurant or cuisine', 160);
      dateTime = cleanText(input.date_time, 'Date and time', 64);
    } catch (error) {
      return { ok: false, error: 'bad_reservation_request', message: (error as Error).message };
    }
    const partySize = Number(input.party_size);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) {
      return { ok: false, error: 'bad_party_size', message: 'Party size must be a whole number from 1 to 20.' };
    }
    let links: ReturnType<typeof bookingLinks>;
    try { links = bookingLinks({ location, dateTime, partySize, query }); }
    catch (error) {
      return { ok: false, error: 'bad_reservation_request', message: (error as Error).message };
    }
    const task = await createTask(db, {
      ownerUserId: userId,
      templateKey: TEMPLATE_KEY,
      threadId,
      slots: {
        location,
        date_time: dateTime,
        party_size: partySize,
        ...(query ? { query } : {}),
        ...links,
        booking_status: 'not_booked',
      },
    });
    await transition(db, task.id, 'ready', { actor: 'agent', actorUserId: userId });
    await transition(db, task.id, 'attempting', { actor: 'agent', actorUserId: userId });
    const waiting = await transition(db, task.id, 'awaiting_owner', { actor: 'agent', actorUserId: userId });
    await appendEvent(db, {
      actor: 'agent', actorUserId: userId, kind: 'restaurant.handoff_prepared',
      subjectType: 'task', subjectId: task.id,
      payload: { providers: ['opentable', 'google_maps'], availabilityVerified: false, bookingSubmitted: false },
    });
    return {
      ok: true,
      task_id: waiting.id,
      state: waiting.state,
      reservation: { location, date_time: dateTime, party_size: partySize, ...(query ? { query } : {}) },
      handoffs: [
        { provider: 'OpenTable', url: links.open_table_url, purpose: 'Search live table availability and finish booking' },
        { provider: 'Google Maps', url: links.google_maps_url, purpose: 'Compare restaurants and supported booking providers' },
      ],
      availability_verified: false,
      booking_status: 'not_booked',
      message: 'No table has been held or booked. Open one of these links to review live availability and complete the reservation.',
    };
  }

  if (name === 'mark_restaurant_reservation_booked') {
    const taskId = String(input.task_id ?? '');
    if (!/^[0-9a-fA-F-]{36}$/.test(taskId)) return { ok: false, error: 'not_found', message: 'There is no restaurant reservation task with that id.' };
    const task = await getTask(db, taskId).catch(() => null);
    if (!task || task.owner_user_id !== userId || task.template_key !== TEMPLATE_KEY) {
      return { ok: false, error: 'not_found', message: 'There is no restaurant reservation task with that id.' };
    }
    if (task.state !== 'awaiting_owner') {
      return { ok: false, error: 'not_waiting', message: 'That restaurant reservation task is not waiting for a booking confirmation.' };
    }
    const patch: Record<string, unknown> = { booking_status: 'booked_user_reported' };
    try {
      if (input.provider !== undefined) patch.provider = cleanText(input.provider, 'Provider', 80);
      if (input.restaurant_name !== undefined) patch.restaurant_name = cleanText(input.restaurant_name, 'Restaurant name', 160);
      if (input.confirmation_code !== undefined) patch.confirmation_code = cleanText(input.confirmation_code, 'Confirmation code', 120);
    } catch (error) {
      return { ok: false, error: 'bad_booking_confirmation', message: (error as Error).message };
    }
    await setSlots(db, task.id, patch, { actor: 'user', actorUserId: userId });
    const confirmed = await transition(db, task.id, 'confirmed', { actor: 'user', actorUserId: userId });
    await appendEvent(db, {
      actor: 'user', actorUserId: userId, kind: 'restaurant.booking_reported',
      subjectType: 'task', subjectId: task.id, payload: { verification: 'user_report' },
    });
    return { ok: true, task_id: confirmed.id, state: confirmed.state, booking_status: 'booked_user_reported', verified_by: 'user_report' };
  }

  return { ok: false, error: 'unknown_tool', message: `no restaurant tool named ${name}` };
}

export const RESTAURANT_TOOL_NAMES = new Set(RESTAURANT_TOOLS.map((tool) => tool.def.name));

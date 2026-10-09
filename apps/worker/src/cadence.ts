/** Native turns are interactive work. A thirty-second scheduler cadence made
 * a three-second model response feel like a half-minute hang. Keep the queue
 * poll bounded at one second; SKIP LOCKED still serializes claims across
 * workers, while schedules and push delivery remain idempotent. */
export const WORKER_TICK_MS = 1_000;

// Shared constants. Safe to import from Workflows, Activities, the Worker and the API.

export const TASK_QUEUE = "juniper-salon";

/** One long-running Workflow owns the waitlist so client state changes happen one at a time. */
export const WAITLIST_WORKFLOW_ID = "juniper-waitlist";

/** Lena: same-day offers get 15 minutes to reply. */
export const OFFER_WINDOW_MS = 15 * 60 * 1000;

/** Demo speed: lets a presenter show a timeout without waiting 15 real minutes. */
export const DEMO_OFFER_WINDOW_MS = 45 * 1000;

/** Lena: stop sending offers 30 minutes before the appointment (adjustable per service later). */
export const CUTOFF_BEFORE_START_MS = 30 * 60 * 1000;

/** When every match is busy with another opening's offer, check again this often. */
export const RECHECK_BUSY_CLIENTS_MS = 60 * 1000;

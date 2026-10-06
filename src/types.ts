// Shared data types for the Juniper Salon earlier-appointment offers prototype.

export const STYLISTS = ["Maria", "Jordan", "Sam"] as const;
export type Stylist = (typeof STYLISTS)[number];

/** A block of time a client said they can come in, e.g. weekdays 12:00–18:00. */
export type AvailabilityWindow = {
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** Local "HH:MM" */
  from: string;
  /** Local "HH:MM" — the service must finish by this time. */
  to: string;
};

export type WaitlistClient = {
  clientId: string;
  name: string;
  phone: string;
  service: string;
  serviceMinutes: number;
  /** A stylist name, or "any" for no preference. */
  stylistPreference: Stylist | "any";
  availability: AvailabilityWindow[];
  availabilityLabel: string;
  /** Epoch ms — earlier joiners are offered first. */
  joinedAt: number;
  /** waiting = still wants an earlier appointment; booked = filled through an offer. */
  status: "waiting" | "booked" | "removed";
  /** Set when a text could not be delivered; skipped until staff fix the number. */
  unreachable?: { reason: string; at: number };
  /** The opening currently holding this client's one active offer. */
  activeOfferOpeningId?: string;
  bookedOpeningId?: string;
};

/** An opening in the schedule, created by staff after a cancellation. */
export type Opening = {
  openingId: string;
  stylist: Stylist;
  /** Local date "YYYY-MM-DD" */
  date: string;
  /** Local start time "HH:MM" */
  time: string;
  /** Human label, e.g. "Mon, Oct 5 at 3:00 PM" */
  label: string;
  /** Epoch ms of the appointment start. */
  startsAt: number;
  lengthMinutes: number;
  /** How long each client has to reply (15 minutes for same-day openings). */
  offerWindowMs: number;
  /** Stop sending offers this long before the appointment (30 minutes for now). */
  cutoffBeforeStartMs: number;
};

export type ClientSummary = Pick<
  WaitlistClient,
  "clientId" | "name" | "phone" | "service" | "serviceMinutes" | "stylistPreference" | "joinedAt"
>;

export type CandidateSearch = {
  /** Eligible clients for this opening, earliest joiner first. */
  eligible: ClientSummary[];
  /** Clients who would match but currently hold an offer for another opening. */
  busyElsewhere: ClientSummary[];
};

export type TextMessage = {
  clientId: string;
  name: string;
  body: string;
  at: number;
  kind: "offer" | "confirmation" | "not_booked" | "too_late" | "withdrawn" | "cancelled";
};

export type TimelineEvent = {
  at: number;
  clientId?: string;
  name?: string;
  kind:
    | "opened"
    | "proposed"
    | "approved"
    | "skipped"
    | "offered"
    | "send_failed"
    | "declined"
    | "timed_out"
    | "accepted"
    | "late_reply"
    | "unavailable"
    | "reopened"
    | "no_show"
    | "ended";
  note: string;
};

export type OpeningPhase =
  | "finding"
  | "awaiting_approval"
  | "sending"
  | "offer_out"
  | "waiting_for_clients"
  | "booked"
  | "ended";

export type OpeningOutcome =
  | "booked"
  | "no_show"
  | "no_acceptance"
  | "cutoff_reached"
  | "approval_not_given"
  | "cancelled_by_staff"
  | "reopened_too_late";

export type OpeningStatus = {
  opening: Opening;
  phase: OpeningPhase;
  /** Plain-language one-liner for staff. */
  headline: string;
  cutoffAt: number;
  proposed?: ClientSummary;
  /** The exact text staff are approving. */
  proposedMessage?: string;
  offer?: { clientId: string; name: string; service: string; sentAt: number; expiresAt: number };
  booking?: { clientId: string; name: string; service: string; bookedAt: number; squareBookingId: string };
  remainingEligible: ClientSummary[];
  busyElsewhere: ClientSummary[];
  timeline: TimelineEvent[];
  messages: TextMessage[];
  outcome?: { kind: OpeningOutcome; message: string; at: number };
};

export type ClientReply = { clientId: string; response: "accept" | "decline" };
export type ClientReplyResult = { result: "booked" | "declined" | "too_late"; message: string };

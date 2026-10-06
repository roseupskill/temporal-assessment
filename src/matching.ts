// Pure matching rules and sample waitlist data. No I/O, so it is safe to use inside Workflows.
import type { AvailabilityWindow, ClientSummary, Opening, WaitlistClient } from "./types";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Day of week for a local "YYYY-MM-DD" date, independent of the server's time zone. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function fitsAvailability(windows: AvailabilityWindow[], opening: Opening, minutes: number): boolean {
  const day = dayOfWeek(opening.date);
  const start = toMinutes(opening.time);
  return windows.some(
    (w) => w.days.includes(day) && start >= toMinutes(w.from) && start + minutes <= toMinutes(w.to),
  );
}

export type Ineligibility =
  | "not_waiting"
  | "unreachable"
  | "stylist"
  | "service_too_long"
  | "availability"
  | null;

/** Why a client cannot take this opening (ignoring active offers elsewhere), or null if they match. */
export function ineligibility(client: WaitlistClient, opening: Opening): Ineligibility {
  if (client.status !== "waiting") return "not_waiting";
  if (client.unreachable) return "unreachable";
  if (client.stylistPreference !== "any" && client.stylistPreference !== opening.stylist) return "stylist";
  if (client.serviceMinutes > opening.lengthMinutes) return "service_too_long";
  if (!fitsAvailability(client.availability, opening, client.serviceMinutes)) return "availability";
  return null;
}

export function summarize(c: WaitlistClient): ClientSummary {
  return {
    clientId: c.clientId,
    name: c.name,
    phone: c.phone,
    service: c.service,
    serviceMinutes: c.serviceMinutes,
    stylistPreference: c.stylistPreference,
    joinedAt: c.joinedAt,
  };
}

/** Phone numbers must have 10 digits (US). Anything else cannot receive a text. */
export function isTextablePhone(phone: string): boolean {
  return phone.replace(/\D/g, "").length === 10;
}

export function offerText(name: string, service: string, opening: Opening, minutesToReply: number): string {
  const first = name.split(" ")[0];
  return (
    `Hi ${first}, an earlier appointment is available at Juniper Salon ${opening.label} ` +
    `with ${opening.stylist} for a ${service.toLowerCase()}. Reply to accept or decline. ` +
    `This offer expires in ${minutesToReply} minute${minutesToReply === 1 ? "" : "s"}.`
  );
}

/**
 * Sample waitlist (fictional people, 555 numbers). Order of joining matters: earliest first.
 * Tom's number is missing digits (shows the unreachable path); Aiko's carrier fails once
 * and succeeds on retry (shows Temporal retrying the text).
 */
export function sampleWaitlist(now: number): WaitlistClient[] {
  const daysAgo = (d: number) => now - d * 24 * 60 * 60 * 1000;
  const base = { status: "waiting" as const };
  return [
    {
      ...base,
      clientId: "c-priya",
      name: "Priya Shah",
      phone: "(408) 555-0142",
      service: "Haircut",
      serviceMinutes: 45,
      stylistPreference: "Maria",
      availability: [{ days: ALL_DAYS, from: "10:00", to: "19:00" }],
      availabilityLabel: "Any day, 10 AM – 7 PM",
      joinedAt: daysAgo(16),
    },
    {
      ...base,
      clientId: "c-dana",
      name: "Dana Lopez",
      phone: "(408) 555-0117",
      service: "Color",
      serviceMinutes: 120,
      stylistPreference: "any",
      availability: [{ days: ALL_DAYS, from: "09:00", to: "19:00" }],
      availabilityLabel: "Any day, 9 AM – 7 PM",
      joinedAt: daysAgo(15),
    },
    {
      ...base,
      clientId: "c-tom",
      name: "Tom Becker",
      phone: "(408) 555-01",
      service: "Haircut",
      serviceMinutes: 45,
      stylistPreference: "any",
      availability: [{ days: ALL_DAYS, from: "09:00", to: "20:00" }],
      availabilityLabel: "Any day, 9 AM – 8 PM",
      joinedAt: daysAgo(14),
    },
    {
      ...base,
      clientId: "c-aiko",
      name: "Aiko Tanaka",
      phone: "(408) 555-0199",
      service: "Blowout",
      serviceMinutes: 30,
      stylistPreference: "Maria",
      availability: [{ days: ALL_DAYS, from: "08:00", to: "21:00" }],
      availabilityLabel: "Any day, 8 AM – 9 PM",
      joinedAt: daysAgo(12),
    },
    {
      ...base,
      clientId: "c-grace",
      name: "Grace Okafor",
      phone: "(408) 555-0163",
      service: "Trim",
      serviceMinutes: 30,
      stylistPreference: "any",
      availability: [{ days: [0, 6], from: "09:00", to: "17:00" }],
      availabilityLabel: "Weekends, 9 AM – 5 PM",
      joinedAt: daysAgo(10),
    },
    {
      ...base,
      clientId: "c-leo",
      name: "Leo Martins",
      phone: "(408) 555-0128",
      service: "Haircut",
      serviceMinutes: 45,
      stylistPreference: "Jordan",
      availability: [{ days: WEEKDAYS, from: "09:00", to: "18:00" }],
      availabilityLabel: "Weekdays, 9 AM – 6 PM",
      joinedAt: daysAgo(9),
    },
    {
      ...base,
      clientId: "c-hannah",
      name: "Hannah Kim",
      phone: "(408) 555-0181",
      service: "Haircut",
      serviceMinutes: 45,
      stylistPreference: "any",
      availability: [{ days: ALL_DAYS, from: "08:00", to: "21:00" }],
      availabilityLabel: "Any day, 8 AM – 9 PM",
      joinedAt: daysAgo(7),
    },
  ];
}

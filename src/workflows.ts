import {
  ActivityFailure,
  allHandlersFinished,
  ApplicationFailure,
  condition,
  continueAsNew,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";
import type { createActivities } from "./activities";
import { RECHECK_BUSY_CLIENTS_MS } from "./config";
import {
  approveOfferUpdate,
  cancelOpeningUpdate,
  claimClientUpdate,
  findCandidatesQuery,
  getOpeningStatusQuery,
  getWaitlistQuery,
  markBookedUpdate,
  markNoShowUpdate,
  markUnreachableUpdate,
  releaseClientUpdate,
  removeFromWaitlistUpdate,
  reopenOpeningUpdate,
  resetWaitlistUpdate,
  respondToOfferUpdate,
  skipClientUpdate,
  updatePhoneUpdate,
} from "./messages";
import { ineligibility, isTextablePhone, offerText, summarize } from "./matching";
import type {
  CandidateSearch,
  ClientReply,
  ClientReplyResult,
  ClientSummary,
  Opening,
  OpeningOutcome,
  OpeningStatus,
  TextMessage,
  TimelineEvent,
  WaitlistClient,
} from "./types";

type Activities = ReturnType<typeof createActivities>;

// Waitlist bookkeeping must eventually succeed, so it keeps retrying (default policy).
const waitlist = proxyActivities<Activities>({ startToCloseTimeout: "10 seconds" });

// Simulated Square calls.
const square = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "1 second", maximumAttempts: 10 },
});

// Texts retry briefly for carrier hiccups, but a bad number fails immediately.
const texting = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 4,
    nonRetryableErrorTypes: ["InvalidPhoneNumber"],
  },
});

// ───────────────────────────── Waitlist Workflow ─────────────────────────────
// A single entity Workflow owns waitlist state. Its handlers run one at a time, so two
// openings can never both claim the same client: "one active offer per client" holds.

export async function waitlistWorkflow(initial: WaitlistClient[]): Promise<void> {
  let clients: WaitlistClient[] = initial.map((c) => ({ ...c }));
  const find = (clientId: string) => clients.find((c) => c.clientId === clientId);
  const mustFind = (clientId: string) => {
    const c = find(clientId);
    if (!c) throw new Error(`No waitlist client ${clientId}`);
    return c;
  };

  setHandler(getWaitlistQuery, () => clients);

  setHandler(findCandidatesQuery, (opening, excludedIds) => {
    const excluded = new Set(excludedIds);
    const matches = clients
      .filter((c) => !excluded.has(c.clientId) && ineligibility(c, opening) === null)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    return {
      eligible: matches.filter((c) => !c.activeOfferOpeningId).map(summarize),
      busyElsewhere: matches
        .filter((c) => c.activeOfferOpeningId && c.activeOfferOpeningId !== opening.openingId)
        .map(summarize),
    };
  });

  setHandler(claimClientUpdate, ({ clientId, openingId }) => {
    const c = find(clientId);
    if (!c || c.status !== "waiting" || c.unreachable) return false;
    if (c.activeOfferOpeningId === openingId) return true; // idempotent on Activity retry
    if (c.activeOfferOpeningId) return false;
    c.activeOfferOpeningId = openingId;
    return true;
  });

  setHandler(releaseClientUpdate, ({ clientId, openingId }) => {
    const c = find(clientId);
    if (c?.activeOfferOpeningId === openingId) c.activeOfferOpeningId = undefined;
  });

  setHandler(markBookedUpdate, ({ clientId, openingId }) => {
    const c = mustFind(clientId);
    c.status = "booked";
    c.bookedOpeningId = openingId;
    c.activeOfferOpeningId = undefined;
  });

  setHandler(markUnreachableUpdate, ({ clientId, reason }) => {
    const c = mustFind(clientId);
    c.unreachable = { reason, at: Date.now() };
    c.activeOfferOpeningId = undefined;
  });

  setHandler(
    updatePhoneUpdate,
    ({ clientId, phone }) => {
      const c = mustFind(clientId);
      c.phone = phone.trim();
      c.unreachable = undefined;
      return c;
    },
    {
      validator: ({ clientId, phone }) => {
        mustFind(clientId);
        if (!isTextablePhone(phone)) throw new Error("Please enter a 10-digit mobile number.");
      },
    },
  );

  setHandler(
    removeFromWaitlistUpdate,
    ({ clientId }) => {
      mustFind(clientId).status = "removed";
    },
    {
      validator: ({ clientId }) => {
        if (mustFind(clientId).activeOfferOpeningId)
          throw new Error("This client is holding an offer right now. Try again after it resolves.");
      },
    },
  );

  setHandler(resetWaitlistUpdate, (fresh) => {
    clients = fresh.map((c) => ({ ...c }));
  });

  // Keep event history small over months of use.
  await condition(() => workflowInfo().continueAsNewSuggested && allHandlersFinished());
  await continueAsNew<typeof waitlistWorkflow>(clients);
}

// ───────────────────────────── Opening Workflow ──────────────────────────────
// One Workflow per open appointment slot (the Workflow ID is derived from the slot, so the
// same slot can't be worked twice). Offers go out one client at a time, each approved by staff.

type LiveOffer = {
  client: ClientSummary;
  expiresAt: number;
  reply?: "accept" | "decline";
  closed: boolean;
};

const fmtMinutes = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60000));
  return `${m} minute${m === 1 ? "" : "s"}`;
};

export async function openingWorkflow(opening: Opening): Promise<OpeningStatus> {
  const cutoffAt = opening.startsAt - opening.cutoffBeforeStartMs;
  const closeAt = opening.startsAt + opening.lengthMinutes * 60 * 1000;
  const status: OpeningStatus = {
    opening,
    phase: "finding",
    headline: "Looking for the next eligible client…",
    cutoffAt,
    remainingEligible: [],
    busyElsewhere: [],
    timeline: [],
    messages: [],
  };

  const considered = new Set<string>(); // offered or skipped for THIS opening only
  const offered = new Map<string, ClientSummary>();
  let decision: { kind: "approve" | "skip"; clientId: string } | undefined;
  let cancelRequest: { reason: string } | undefined;
  let reopenRequest: { reason: string } | undefined;
  let noShowMarked = false;
  let offer: LiveOffer | undefined;

  const log = (event: Omit<TimelineEvent, "at">) => status.timeline.push({ at: Date.now(), ...event });
  const who = (c: ClientSummary) => ({ clientId: c.clientId, name: c.name });

  async function text(c: ClientSummary, body: string, kind: TextMessage["kind"]) {
    try {
      const message = await texting.sendText({ clientId: c.clientId, name: c.name, phone: c.phone, body, kind });
      status.messages.push(message);
      return { ok: true as const };
    } catch (err) {
      const reason =
        err instanceof ActivityFailure && err.cause instanceof ApplicationFailure
          ? err.cause.message
          : "The text could not be sent.";
      return { ok: false as const, reason };
    }
  }

  async function end(kind: OpeningOutcome, message: string): Promise<OpeningStatus> {
    status.phase = "ended";
    status.proposed = undefined;
    status.proposedMessage = undefined;
    status.offer = undefined;
    status.remainingEligible = [];
    status.busyElsewhere = [];
    status.outcome = { kind, message, at: Date.now() };
    status.headline = message;
    log({ kind: "ended", note: message });
    await condition(allHandlersFinished); // let any late-reply texts finish
    return status;
  }

  // ── Message handlers ──
  setHandler(getOpeningStatusQuery, () => status);

  const requireProposed = ({ clientId }: { clientId: string }) => {
    if (status.phase !== "awaiting_approval" || status.proposed?.clientId !== clientId)
      throw new Error("That client is no longer waiting for approval on this opening.");
  };
  setHandler(
    approveOfferUpdate,
    ({ clientId }) => {
      decision = { kind: "approve", clientId };
      return "Approved. The offer is being sent.";
    },
    { validator: requireProposed },
  );
  setHandler(
    skipClientUpdate,
    ({ clientId }) => {
      decision = { kind: "skip", clientId };
      return "Skipped for this opening. They stay on the waitlist.";
    },
    { validator: requireProposed },
  );

  setHandler(
    cancelOpeningUpdate,
    ({ reason }) => {
      cancelRequest = { reason };
      return "The opening has been taken off offer.";
    },
    {
      validator: (_input: { reason: string }) => {
        if (status.phase === "booked") throw new Error("This opening is booked. Use “Client cancelled — reopen” instead.");
        if (status.phase === "ended") throw new Error("This opening has already ended.");
      },
    },
  );

  setHandler(
    reopenOpeningUpdate,
    ({ reason }) => {
      reopenRequest = { reason };
      return "The booking is being cancelled and the opening reopened.";
    },
    {
      validator: (_input: { reason: string }) => {
        if (status.phase !== "booked") throw new Error("Only a booked opening can be reopened.");
        if (Date.now() >= opening.startsAt) throw new Error("The appointment time has passed, so it can’t be reopened.");
      },
    },
  );

  setHandler(
    markNoShowUpdate,
    () => {
      noShowMarked = true;
      return "Marked as a no-show.";
    },
    {
      validator: () => {
        if (status.phase !== "booked") throw new Error("Only a booked appointment can be marked as a no-show.");
        if (Date.now() < opening.startsAt) throw new Error("The appointment hasn’t started yet.");
      },
    },
  );

  setHandler(
    respondToOfferUpdate,
    async ({ clientId, response }) => {
      const client = offered.get(clientId)!;
      if (status.booking?.clientId === clientId) {
        return { result: "booked", message: "You’re already booked for this appointment." };
      }
      if (offer && !offer.closed && offer.client.clientId === clientId && !offer.reply && Date.now() < offer.expiresAt) {
        offer.reply = response;
        if (response === "decline") return { result: "declined", message: "Thanks for letting us know." };
        // The first in-time "yes" is final; wait until the booking is recorded before confirming.
        await condition(() => status.booking?.clientId === clientId);
        return { result: "booked", message: "You’re booked! A confirmation text is on its way." };
      }
      log({ kind: "late_reply", ...who(client), note: `${client.name} replied “${response}” after the offer closed.` });
      await text(
        client,
        `Sorry ${client.name.split(" ")[0]}, that earlier appointment ${opening.label} is no longer available, so it wasn’t booked. ` +
          `You’re still on our waitlist and we’ll reach out about the next opening.`,
        "too_late",
      );
      return { result: "too_late", message: "This offer has expired, so the opening wasn’t booked." };
    },
    {
      validator: ({ clientId }) => {
        if (!offered.has(clientId)) throw new Error("This client was not offered this opening.");
      },
    },
  );

  log({ kind: "opened", note: `Opening created: ${opening.label} with ${opening.stylist}, ${opening.lengthMinutes} min.` });

  // ── Main loop: offer one client at a time until booked or there's no reason to continue ──
  for (;;) {
    // Offer phase
    for (;;) {
      if (cancelRequest) return end("cancelled_by_staff", `Taken off offer by staff: ${cancelRequest.reason}.`);
      if (Date.now() >= cutoffAt) {
        return end("cutoff_reached", `It’s now less than ${fmtMinutes(opening.cutoffBeforeStartMs)} before the appointment, so offers have stopped. The opening is unfilled.`);
      }

      status.phase = "finding";
      status.headline = "Looking for the next eligible client…";
      const search = await waitlist.findCandidates(opening, [...considered]);
      status.busyElsewhere = search.busyElsewhere;

      if (search.eligible.length === 0) {
        status.remainingEligible = [];
        if (search.busyElsewhere.length > 0) {
          status.phase = "waiting_for_clients";
          status.headline = "Remaining matches are holding offers for other openings. Checking again shortly.";
          await condition(() => !!cancelRequest, Math.max(1, Math.min(RECHECK_BUSY_CLIENTS_MS, cutoffAt - Date.now())));
          continue;
        }
        return end(
          "no_acceptance",
          offered.size > 0
            ? "Everyone eligible was contacted and no one accepted. The opening is unfilled."
            : "No one on the waitlist matches this opening. It is unfilled.",
        );
      }

      // Propose the earliest eligible joiner and wait for staff approval (until the cutoff).
      const candidate = search.eligible[0];
      status.remainingEligible = search.eligible.slice(1);
      status.proposed = candidate;
      status.proposedMessage = offerText(
        candidate.name,
        candidate.service,
        opening,
        Math.round(Math.min(opening.offerWindowMs, cutoffAt - Date.now()) / 60000) || 1,
      );
      status.phase = "awaiting_approval";
      status.headline = `Ready to text ${candidate.name}. Waiting for staff approval.`;
      log({ kind: "proposed", ...who(candidate), note: `${candidate.name} is next (earliest eligible on the waitlist).` });

      decision = undefined;
      const decided = await condition(() => decision !== undefined || !!cancelRequest, Math.max(1, cutoffAt - Date.now()));
      status.proposed = undefined;
      status.proposedMessage = undefined;
      if (cancelRequest) continue;
      if (!decided) {
        return end("approval_not_given", `No offer was approved before the cutoff, so nothing was sent to ${candidate.name}. The opening is unfilled.`);
      }
      if (decision!.kind === "skip") {
        considered.add(candidate.clientId);
        log({ kind: "skipped", ...who(candidate), note: `Staff skipped ${candidate.name} for this opening.` });
        continue;
      }
      log({ kind: "approved", ...who(candidate), note: `Staff approved the offer to ${candidate.name}.` });

      // Reserve the client's one active offer. Fails if another opening got there first.
      const claimed = await waitlist.claimClient({ clientId: candidate.clientId, openingId: opening.openingId });
      if (!claimed) {
        log({ kind: "unavailable", ...who(candidate), note: `${candidate.name} is no longer available (likely holding another offer). Moving on.` });
        continue;
      }
      considered.add(candidate.clientId);

      const windowMs = Math.min(opening.offerWindowMs, cutoffAt - Date.now());
      if (windowMs <= 0) {
        await waitlist.releaseClient({ clientId: candidate.clientId, openingId: opening.openingId });
        continue; // loop top ends at the cutoff
      }

      status.phase = "sending";
      status.headline = `Texting ${candidate.name}…`;
      const sent = await text(candidate, offerText(candidate.name, candidate.service, opening, Math.round(windowMs / 60000) || 1), "offer");
      if (!sent.ok) {
        await waitlist.markUnreachable({ clientId: candidate.clientId, reason: sent.reason });
        log({
          kind: "send_failed",
          ...who(candidate),
          note: `Couldn’t text ${candidate.name}: ${sent.reason} Marked unreachable until the number is fixed. Moving to the next client.`,
        });
        continue;
      }

      // The reply window starts once the text is actually delivered, and never runs past the cutoff.
      const sentAt = Date.now();
      const expiresAt = Math.min(sentAt + opening.offerWindowMs, cutoffAt);
      offer = { client: candidate, expiresAt, closed: false };
      offered.set(candidate.clientId, candidate);
      status.offer = { clientId: candidate.clientId, name: candidate.name, service: candidate.service, sentAt, expiresAt };
      status.phase = "offer_out";
      status.headline = `Offer sent to ${candidate.name}.`;
      log({ kind: "offered", ...who(candidate), note: `Offer texted to ${candidate.name} (${fmtMinutes(expiresAt - sentAt)} to reply).` });

      // Durable timer: race the client's reply (and staff cancellation) against the window.
      const current: LiveOffer = offer;
      await condition(() => current.reply !== undefined || !!cancelRequest, Math.max(1, current.expiresAt - Date.now()));
      current.closed = true;
      status.offer = undefined;

      if (current.reply === "accept") {
        await waitlist.markBooked({ clientId: candidate.clientId, openingId: opening.openingId });
        const { squareBookingId } = await square.createSquareBooking({
          openingId: opening.openingId,
          clientId: candidate.clientId,
          name: candidate.name,
          service: candidate.service,
          stylist: opening.stylist,
          startsAt: opening.startsAt,
          minutes: candidate.serviceMinutes,
        });
        status.booking = { clientId: candidate.clientId, name: candidate.name, service: candidate.service, bookedAt: Date.now(), squareBookingId };
        status.phase = "booked";
        status.headline = `Booked: ${candidate.name}, ${candidate.service.toLowerCase()} with ${opening.stylist}.`;
        status.remainingEligible = [];
        log({ kind: "accepted", ...who(candidate), note: `${candidate.name} accepted. Booked in Square and removed from the waitlist.` });
        await text(
          candidate,
          `You’re booked! ${candidate.service} with ${opening.stylist} at Juniper Salon ${opening.label}. See you then.`,
          "confirmation",
        );
        break;
      }

      await waitlist.releaseClient({ clientId: candidate.clientId, openingId: opening.openingId });
      if (current.reply === "decline") {
        log({ kind: "declined", ...who(candidate), note: `${candidate.name} declined. They stay on the waitlist.` });
        await text(candidate, `Thanks for letting us know. This opening wasn’t booked, and you’re still on our waitlist.`, "not_booked");
      } else if (cancelRequest) {
        log({ kind: "ended", ...who(candidate), note: `Offer to ${candidate.name} withdrawn by staff.` });
        await text(candidate, `Sorry, the earlier appointment ${opening.label} is no longer available. You’re still on our waitlist.`, "withdrawn");
      } else {
        log({ kind: "timed_out", ...who(candidate), note: `${candidate.name} didn’t reply within ${fmtMinutes(current.expiresAt - sentAt)}. They stay on the waitlist.` });
      }
    }

    // Booked phase: stay open until the appointment ends so staff can reopen or mark a no-show.
    reopenRequest = undefined;
    await condition(() => !!reopenRequest || noShowMarked, Math.max(1, closeAt - Date.now()));
    const booking = status.booking!;
    // (Handlers mutate these; re-read them through a widened type for the compiler.)
    const reopen = reopenRequest as { reason: string } | undefined;
    if (noShowMarked) {
      log({ kind: "no_show", clientId: booking.clientId, name: booking.name, note: `${booking.name} was marked as a no-show.` });
      return end("no_show", `${booking.name} didn’t show up. The opening is not re-offered after the appointment time.`);
    }
    if (!reopen) {
      return end("booked", `Filled by ${booking.name} (${booking.service.toLowerCase()}).`);
    }

    await square.cancelSquareBooking({ squareBookingId: booking.squareBookingId });
    const bookedClient = offered.get(booking.clientId)!;
    status.booking = undefined;
    log({ kind: "reopened", ...who(bookedClient), note: `${booking.name}’s booking was cancelled (${reopen.reason}). Reopening the slot.` });
    await text(bookedClient, `Your appointment at Juniper Salon ${opening.label} has been cancelled as requested.`, "cancelled");
    if (Date.now() >= cutoffAt) {
      return end("reopened_too_late", "The booking was cancelled, but it’s too close to the appointment to send new offers. The opening is unfilled.");
    }
  }
}

import { ApplicationFailure, Context, log } from "@temporalio/activity";
import type { Client } from "@temporalio/client";
import { WAITLIST_WORKFLOW_ID } from "./config";
import { isTextablePhone } from "./matching";
import type { CandidateSearch, Opening, TextMessage } from "./types";
import {
  claimClientUpdate,
  findCandidatesQuery,
  markBookedUpdate,
  markUnreachableUpdate,
  releaseClientUpdate,
  type ClientRef,
} from "./messages";

/**
 * Activities are where the outside world lives: the waitlist (today a Google Sheet, here a
 * Temporal entity Workflow), text messages (simulated), and Square bookings (simulated).
 * Temporal retries these on failure; the Workflow decides what a final failure means.
 */
export function createActivities(client: Client) {
  const waitlist = () => client.workflow.getHandle(WAITLIST_WORKFLOW_ID);

  return {
    async findCandidates(opening: Opening, excludedIds: string[]): Promise<CandidateSearch> {
      return waitlist().query(findCandidatesQuery, opening, excludedIds);
    },

    async claimClient(ref: ClientRef): Promise<boolean> {
      return waitlist().executeUpdate(claimClientUpdate, { args: [ref] });
    },

    async releaseClient(ref: ClientRef): Promise<void> {
      await waitlist().executeUpdate(releaseClientUpdate, { args: [ref] });
    },

    async markBooked(ref: ClientRef): Promise<void> {
      await waitlist().executeUpdate(markBookedUpdate, { args: [ref] });
    },

    async markUnreachable(input: { clientId: string; reason: string }): Promise<void> {
      await waitlist().executeUpdate(markUnreachableUpdate, { args: [input] });
    },

    /** Simulated SMS provider. Swap the body of this function for Twilio etc. */
    async sendText(input: {
      clientId: string;
      name: string;
      phone: string;
      body: string;
      kind: TextMessage["kind"];
    }): Promise<TextMessage> {
      const { attempt } = Context.current().info;
      if (!isTextablePhone(input.phone)) {
        throw ApplicationFailure.nonRetryable(`The number ${input.phone} isn’t a valid mobile number.`, "InvalidPhoneNumber");
      }
      // Demo: this number's carrier fails on the first try so the retry shows up in history.
      if (input.phone.endsWith("0199") && attempt === 1) {
        throw ApplicationFailure.retryable("Carrier temporarily unavailable.", "CarrierUnavailable");
      }
      log.info(`[SMS → ${input.name} ${input.phone}] ${input.body}`);
      return { clientId: input.clientId, name: input.name, body: input.body, at: Date.now(), kind: input.kind };
    },

    /** Simulated Square booking. The ID is derived from the slot + client so retries never double-book. */
    async createSquareBooking(input: {
      openingId: string;
      clientId: string;
      name: string;
      service: string;
      stylist: string;
      startsAt: number;
      minutes: number;
    }): Promise<{ squareBookingId: string }> {
      const squareBookingId = `sq-${input.openingId}-${input.clientId}`;
      log.info(`[Square] booked ${input.name} for ${input.service} with ${input.stylist} (${squareBookingId})`);
      return { squareBookingId };
    },

    async cancelSquareBooking(input: { squareBookingId: string }): Promise<void> {
      log.info(`[Square] cancelled ${input.squareBookingId}`);
    },
  };
}

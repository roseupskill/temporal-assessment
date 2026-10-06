// Message definitions (Queries and Updates) shared by Workflows, Activities and the API.
// Kept separate from workflows.ts so non-Workflow code never loads Workflow-only modules.
import { defineQuery, defineUpdate } from "@temporalio/workflow";
import type {
  CandidateSearch,
  ClientReply,
  ClientReplyResult,
  Opening,
  OpeningStatus,
  WaitlistClient,
} from "./types";

export type ClientRef = { clientId: string; openingId: string };
export const getWaitlistQuery = defineQuery<WaitlistClient[]>("getWaitlist");
export const findCandidatesQuery = defineQuery<CandidateSearch, [Opening, string[]]>("findCandidates");
export const claimClientUpdate = defineUpdate<boolean, [ClientRef]>("claimClient");
export const releaseClientUpdate = defineUpdate<void, [ClientRef]>("releaseClient");
export const markBookedUpdate = defineUpdate<void, [ClientRef]>("markBooked");
export const markUnreachableUpdate = defineUpdate<void, [{ clientId: string; reason: string }]>(
  "markUnreachable",
);
export const updatePhoneUpdate = defineUpdate<WaitlistClient, [{ clientId: string; phone: string }]>(
  "updatePhone",
);
export const removeFromWaitlistUpdate = defineUpdate<void, [{ clientId: string }]>("removeFromWaitlist");
export const resetWaitlistUpdate = defineUpdate<void, [WaitlistClient[]]>("resetWaitlist");
export const getOpeningStatusQuery = defineQuery<OpeningStatus>("getOpeningStatus");
export const approveOfferUpdate = defineUpdate<string, [{ clientId: string }]>("approveOffer");
export const skipClientUpdate = defineUpdate<string, [{ clientId: string }]>("skipClient");
export const cancelOpeningUpdate = defineUpdate<string, [{ reason: string }]>("cancelOpening");
export const reopenOpeningUpdate = defineUpdate<string, [{ reason: string }]>("reopenOpening");
export const markNoShowUpdate = defineUpdate<string, []>("markNoShow");
export const respondToOfferUpdate = defineUpdate<ClientReplyResult, [ClientReply]>("respondToOffer");

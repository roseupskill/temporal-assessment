import assert from "node:assert/strict";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { createActivities } from "../src/activities";
import { CUTOFF_BEFORE_START_MS, OFFER_WINDOW_MS, WAITLIST_WORKFLOW_ID } from "../src/config";
import { sampleWaitlist } from "../src/matching";
import {
  approveOfferUpdate,
  cancelOpeningUpdate,
  getOpeningStatusQuery,
  getWaitlistQuery,
  reopenOpeningUpdate,
  respondToOfferUpdate,
  skipClientUpdate,
} from "../src/messages";
import type { Opening, OpeningStatus, Stylist, WaitlistClient } from "../src/types";
import { openingWorkflow, waitlistWorkflow } from "../src/workflows";

const MIN = 60 * 1000;
const TASK_QUEUE = "juniper-test";

/**
 * Sample data for every test (see src/matching.ts). For a 60-minute Maria opening on a Monday
 * at 3 PM, the eligible order is: Priya → Tom (bad number) → Aiko (carrier hiccup) → Hannah.
 * Dana (color is too long), Grace (weekends only) and Leo (wants Jordan) don't match.
 */
async function withSalon(
  fn: (ctx: {
    env: TestWorkflowEnvironment;
    newOpening: (o: { stylist?: Stylist; time?: string; startsInMs?: number }) => Promise<WorkflowHandle<typeof openingWorkflow>>;
    waitlist: () => Promise<WaitlistClient[]>;
  }) => Promise<void>,
) {
  // Set TEMPORAL_TEST_SERVER_PATH to use a pre-downloaded test server; otherwise it is downloaded.
  const env = await TestWorkflowEnvironment.createTimeSkipping(
    process.env.TEMPORAL_TEST_SERVER_PATH
      ? { server: { executable: { type: "existing-path", path: process.env.TEMPORAL_TEST_SERVER_PATH } } }
      : undefined,
  );
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: require.resolve("../src/workflows"),
      activities: createActivities(env.client),
    });
    await worker.runUntil(async () => {
      const now = await env.currentTimeMs();
      const wl = await env.client.workflow.start(waitlistWorkflow, {
        workflowId: WAITLIST_WORKFLOW_ID,
        taskQueue: TASK_QUEUE,
        args: [sampleWaitlist(now)],
      });
      await fn({
        env,
        waitlist: () => wl.query(getWaitlistQuery),
        newOpening: async ({ stylist = "Maria", time = "15:00", startsInMs = 3 * 60 * MIN }) => {
          const opening: Opening = {
            openingId: `opening-2026-10-05-${time.replace(":", "")}-${stylist.toLowerCase()}`,
            stylist,
            date: "2026-10-05", // a Monday
            time,
            label: `today at ${time}`,
            startsAt: (await env.currentTimeMs()) + startsInMs,
            lengthMinutes: 60,
            offerWindowMs: OFFER_WINDOW_MS,
            cutoffBeforeStartMs: CUTOFF_BEFORE_START_MS,
          };
          return env.client.workflow.start(openingWorkflow, {
            workflowId: opening.openingId,
            taskQueue: TASK_QUEUE,
            args: [opening],
          });
        },
      });
    });
  } finally {
    await env.teardown();
  }
}

async function waitFor(
  handle: WorkflowHandle<typeof openingWorkflow>,
  predicate: (s: OpeningStatus) => boolean,
  label: string,
): Promise<OpeningStatus> {
  const deadline = Date.now() + 20_000;
  let last: OpeningStatus | undefined;
  for (;;) {
    try {
      last = await handle.query(getOpeningStatusQuery);
      if (predicate(last)) return last;
    } catch {
      // Not started yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}. Last: ${last?.headline}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const proposed = (h: WorkflowHandle<typeof openingWorkflow>, clientId: string) =>
  waitFor(h, (s) => s.phase === "awaiting_approval" && s.proposed?.clientId === clientId, `${clientId} proposed`);
const offerOut = (h: WorkflowHandle<typeof openingWorkflow>, clientId: string) =>
  waitFor(h, (s) => s.phase === "offer_out" && s.offer?.clientId === clientId, `offer out to ${clientId}`);
const approve = (h: WorkflowHandle<typeof openingWorkflow>, clientId: string) =>
  h.executeUpdate(approveOfferUpdate, { args: [{ clientId }] });

test("offers go to one client at a time, move on after a timeout or bad number, and book on accept", async () => {
  await withSalon(async ({ env, newOpening, waitlist }) => {
    const h = await newOpening({});

    // Earliest eligible joiner first, and nothing is sent until staff approve.
    const first = await proposed(h, "c-priya");
    assert.equal(first.messages.length, 0);
    assert.deepEqual(first.remainingEligible.map((c) => c.clientId), ["c-tom", "c-aiko", "c-hannah"]);

    await approve(h, "c-priya");
    await offerOut(h, "c-priya");
    assert.equal((await waitlist()).find((c) => c.clientId === "c-priya")?.activeOfferOpeningId, h.workflowId);

    // 15 minutes with no reply → automatically moves on (durable timer).
    await env.sleep(16 * MIN);
    await proposed(h, "c-tom");

    // Tom's number is invalid → marked unreachable, move on.
    await approve(h, "c-tom");
    const afterTom = await proposed(h, "c-aiko");
    assert.ok(afterTom.timeline.some((e) => e.kind === "send_failed" && e.clientId === "c-tom"));
    assert.ok((await waitlist()).find((c) => c.clientId === "c-tom")?.unreachable);

    // Aiko's carrier fails once; Temporal retries the text, then she accepts.
    await approve(h, "c-aiko");
    await offerOut(h, "c-aiko");
    const reply = await h.executeUpdate(respondToOfferUpdate, { args: [{ clientId: "c-aiko", response: "accept" }] });
    assert.equal(reply.result, "booked");

    const booked = await waitFor(h, (s) => s.phase === "booked" && s.messages.some((m) => m.kind === "confirmation"), "booked");
    assert.equal(booked.booking?.clientId, "c-aiko");
    const wl = await waitlist();
    assert.equal(wl.find((c) => c.clientId === "c-aiko")?.status, "booked");
    assert.equal(wl.find((c) => c.clientId === "c-priya")?.status, "waiting"); // timeout only applies to this opening
    assert.equal(wl.find((c) => c.clientId === "c-priya")?.activeOfferOpeningId, undefined);

    // Client changes their mind → staff reopen → next eligible client (Hannah) is proposed.
    await h.executeUpdate(reopenOpeningUpdate, { args: [{ reason: "client changed their mind" }] });
    await proposed(h, "c-hannah");
  });
});

test("a reply after the window closes is told the opening is no longer available", async () => {
  await withSalon(async ({ env, newOpening }) => {
    const h = await newOpening({});
    await proposed(h, "c-priya");
    await approve(h, "c-priya");
    await offerOut(h, "c-priya");
    await env.sleep(16 * MIN);
    await proposed(h, "c-tom");

    const late = await h.executeUpdate(respondToOfferUpdate, { args: [{ clientId: "c-priya", response: "accept" }] });
    assert.equal(late.result, "too_late");
    const s = await h.query(getOpeningStatusQuery);
    assert.ok(s.messages.some((m) => m.clientId === "c-priya" && m.kind === "too_late"));
    assert.equal(s.booking, undefined);
  });
});

test("a client only holds one active offer, even when two openings want them", async () => {
  await withSalon(async ({ newOpening }) => {
    const a = await newOpening({ time: "15:00" });
    const b = await newOpening({ time: "16:30" });
    await proposed(a, "c-priya");
    await proposed(b, "c-priya");

    await approve(a, "c-priya");
    await offerOut(a, "c-priya");

    // Opening B's approval loses the race: Priya is already holding A's offer.
    await approve(b, "c-priya");
    const bNext = await proposed(b, "c-tom");
    assert.ok(bNext.timeline.some((e) => e.kind === "unavailable" && e.clientId === "c-priya"));
    assert.ok(bNext.busyElsewhere.some((c) => c.clientId === "c-priya"));
    assert.ok(!bNext.messages.some((m) => m.clientId === "c-priya"));
  });
});

test("staff can withdraw an offer for a walk-in, and skipping keeps the client on the waitlist", async () => {
  await withSalon(async ({ newOpening, waitlist }) => {
    const h = await newOpening({});
    await proposed(h, "c-priya");
    await h.executeUpdate(skipClientUpdate, { args: [{ clientId: "c-priya" }] });
    await proposed(h, "c-tom");
    await h.executeUpdate(skipClientUpdate, { args: [{ clientId: "c-tom" }] });
    await proposed(h, "c-aiko");
    await approve(h, "c-aiko");
    await offerOut(h, "c-aiko");

    await h.executeUpdate(cancelOpeningUpdate, { args: [{ reason: "used for a walk-in" }] });
    const result = await h.result();
    assert.equal(result.outcome?.kind, "cancelled_by_staff");
    assert.ok(result.messages.some((m) => m.clientId === "c-aiko" && m.kind === "withdrawn"));

    const wl = await waitlist();
    assert.equal(wl.find((c) => c.clientId === "c-aiko")?.activeOfferOpeningId, undefined);
    assert.equal(wl.find((c) => c.clientId === "c-priya")?.status, "waiting");

    // Ended openings reject further staff actions with a clear reason.
    await assert.rejects(
      h.executeUpdate(cancelOpeningUpdate, { args: [{ reason: "again" }] }),
      (e: unknown) => e instanceof Error,
    );
  });
});

test("nothing is sent if staff don't approve before the 30-minute cutoff", async () => {
  await withSalon(async ({ newOpening }) => {
    const h = await newOpening({ startsInMs: 45 * MIN });
    await proposed(h, "c-priya");
    const result = await h.result(); // time skips to the cutoff
    assert.equal(result.outcome?.kind, "approval_not_given");
    assert.equal(result.messages.length, 0);
  });
});

test("offers near the cutoff get a shorter window so they never run past it", async () => {
  await withSalon(async ({ env, newOpening }) => {
    const h = await newOpening({ startsInMs: 40 * MIN }); // cutoff in 10 minutes
    await proposed(h, "c-priya");
    await approve(h, "c-priya");
    const out = await offerOut(h, "c-priya");
    assert.ok(out.offer!.expiresAt <= out.cutoffAt);
    await env.sleep(11 * MIN);
    const result = await h.result();
    assert.equal(result.outcome?.kind, "cutoff_reached");
  });
});

// Validators reject actions that don't fit the current state.
test("staff can't approve someone who isn't the proposed client", async () => {
  await withSalon(async ({ newOpening }) => {
    const h = await newOpening({});
    await proposed(h, "c-priya");
    await assert.rejects(approve(h, "c-hannah"), (e: unknown) => e instanceof WorkflowUpdateFailedError);
  });
});

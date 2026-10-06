import path from "node:path";
import { Client, Connection, WorkflowUpdateFailedError } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  CUTOFF_BEFORE_START_MS,
  DEMO_OFFER_WINDOW_MS,
  OFFER_WINDOW_MS,
  TASK_QUEUE,
  WAITLIST_WORKFLOW_ID,
} from "./config";
import { sampleWaitlist } from "./matching";
import {
  approveOfferUpdate,
  cancelOpeningUpdate,
  getOpeningStatusQuery,
  getWaitlistQuery,
  markNoShowUpdate,
  removeFromWaitlistUpdate,
  reopenOpeningUpdate,
  resetWaitlistUpdate,
  respondToOfferUpdate,
  skipClientUpdate,
  updatePhoneUpdate,
} from "./messages";
import { STYLISTS, type Opening, type OpeningStatus, type Stylist } from "./types";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  })
    .then((connection) => new Client({ connection, namespace: "default" }))
    .then(async (client) => {
      // Start the waitlist Workflow once; afterwards this is a no-op.
      await client.workflow.start("waitlistWorkflow", {
        workflowId: WAITLIST_WORKFLOW_ID,
        taskQueue: TASK_QUEUE,
        args: [sampleWaitlist(Date.now())],
        workflowIdConflictPolicy: "USE_EXISTING",
      });
      return client;
    })
    .catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  return clientPromise;
}

/** Turn a rejected Update (a validator said no) into a friendly 409 for the page. */
async function runUpdate(response: Response, action: () => Promise<unknown>) {
  try {
    const result = await action();
    response.json({ ok: true, result });
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      response.status(409).json({ error: error.cause?.message ?? error.message });
      return;
    }
    throw error;
  }
}

const opening = async (id: string) => (await getClient()).workflow.getHandle(String(id));

// ── Staff + client view state ──
app.get("/api/state", async (_request, response) => {
  const client = await getClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const openings: Array<OpeningStatus & { workflowId: string; running: boolean }> = [];
  const found: Array<{ workflowId: string; running: boolean }> = [];
  for await (const wf of client.workflow.list({
    query: `WorkflowType = 'openingWorkflow' AND StartTime > '${since}'`,
  })) {
    found.push({ workflowId: wf.workflowId, running: wf.status.name === "RUNNING" });
    if (found.length >= 20) break;
  }
  await Promise.all(
    found.map(async ({ workflowId, running }) => {
      try {
        const status = await client.workflow.getHandle(workflowId).query(getOpeningStatusQuery);
        openings.push({ ...status, workflowId, running });
      } catch {
        // Not queryable yet (e.g. the Worker hasn't picked it up). It will appear on the next refresh.
      }
    }),
  );
  openings.sort((a, b) => a.opening.startsAt - b.opening.startsAt);
  const waitlist = await client.workflow.getHandle(WAITLIST_WORKFLOW_ID).query(getWaitlistQuery);
  response.json({ now: Date.now(), openings, waitlist, stylists: STYLISTS });
});

// ── Staff creates an opening after a cancellation ──
app.post("/api/openings", async (request, response) => {
  const { stylist, date, time, lengthMinutes, demoSpeed } = request.body ?? {};
  if (!STYLISTS.includes(stylist)) return void response.status(400).json({ error: "Choose a stylist." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d{2}:\d{2}$/.test(time ?? "")) {
    return void response.status(400).json({ error: "Choose a date and start time." });
  }
  const minutes = Number(lengthMinutes);
  if (!Number.isFinite(minutes) || minutes < 15 || minutes > 480) {
    return void response.status(400).json({ error: "Length must be between 15 and 480 minutes." });
  }
  const start = new Date(`${date}T${time}:00`); // salon's local time
  if (start.getTime() - Date.now() <= CUTOFF_BEFORE_START_MS) {
    return void response.status(400).json({
      error: "That appointment starts within 30 minutes, so there isn’t time to send offers.",
    });
  }

  const label = isToday(start)
    ? `today at ${start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : `on ${start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;

  const input: Opening = {
    // One Workflow per slot: the same slot can't be worked twice at once.
    openingId: `opening-${date}-${time.replace(":", "")}-${(stylist as string).toLowerCase()}`,
    stylist: stylist as Stylist,
    date,
    time,
    label,
    startsAt: start.getTime(),
    lengthMinutes: minutes,
    offerWindowMs: demoSpeed ? DEMO_OFFER_WINDOW_MS : OFFER_WINDOW_MS,
    cutoffBeforeStartMs: CUTOFF_BEFORE_START_MS,
  };

  const client = await getClient();
  try {
    await client.workflow.start("openingWorkflow", {
      workflowId: input.openingId,
      taskQueue: TASK_QUEUE,
      args: [input],
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return void response.status(409).json({ error: `${stylist}’s ${time} opening is already being offered.` });
    }
    throw error;
  }
  response.status(201).json({ openingId: input.openingId });
});

function isToday(d: Date): boolean {
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// ── Staff actions on an opening (Updates, so the page gets an immediate yes/no) ──
app.post("/api/openings/:id/approve", async (req, res) => {
  const h = await opening(req.params.id);
  await runUpdate(res, () => h.executeUpdate(approveOfferUpdate, { args: [{ clientId: req.body.clientId }] }));
});
app.post("/api/openings/:id/skip", async (req, res) => {
  const h = await opening(req.params.id);
  await runUpdate(res, () => h.executeUpdate(skipClientUpdate, { args: [{ clientId: req.body.clientId }] }));
});
app.post("/api/openings/:id/cancel", async (req, res) => {
  const h = await opening(req.params.id);
  const reason = String(req.body?.reason || "used for a walk-in");
  await runUpdate(res, () => h.executeUpdate(cancelOpeningUpdate, { args: [{ reason }] }));
});
app.post("/api/openings/:id/reopen", async (req, res) => {
  const h = await opening(req.params.id);
  const reason = String(req.body?.reason || "client changed their mind");
  await runUpdate(res, () => h.executeUpdate(reopenOpeningUpdate, { args: [{ reason }] }));
});
app.post("/api/openings/:id/no-show", async (req, res) => {
  const h = await opening(req.params.id);
  await runUpdate(res, () => h.executeUpdate(markNoShowUpdate, { args: [] }));
});

// ── Simulated client reply (stands in for an inbound text) ──
app.post("/api/openings/:id/reply", async (req, res) => {
  const { clientId, response } = req.body ?? {};
  if (response !== "accept" && response !== "decline") {
    return void res.status(400).json({ error: "Reply must be accept or decline." });
  }
  const h = await opening(req.params.id);
  const description = await h.describe();
  if (description.status.name !== "RUNNING") {
    return void res.json({ ok: true, result: { result: "too_late", message: "This opening is no longer available." } });
  }
  await runUpdate(res, () => h.executeUpdate(respondToOfferUpdate, { args: [{ clientId, response }] }));
});

// ── Waitlist maintenance ──
app.post("/api/waitlist/:clientId/phone", async (req, res) => {
  const h = (await getClient()).workflow.getHandle(WAITLIST_WORKFLOW_ID);
  await runUpdate(res, () =>
    h.executeUpdate(updatePhoneUpdate, { args: [{ clientId: req.params.clientId, phone: String(req.body?.phone ?? "") }] }),
  );
});
app.post("/api/waitlist/:clientId/remove", async (req, res) => {
  const h = (await getClient()).workflow.getHandle(WAITLIST_WORKFLOW_ID);
  await runUpdate(res, () => h.executeUpdate(removeFromWaitlistUpdate, { args: [{ clientId: req.params.clientId }] }));
});
app.post("/api/demo/reset-waitlist", async (_req, res) => {
  const h = (await getClient()).workflow.getHandle(WAITLIST_WORKFLOW_ID);
  await runUpdate(res, () => h.executeUpdate(resetWaitlistUpdate, { args: [sampleWaitlist(Date.now())] }));
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : "Unexpected error" });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Juniper Salon offers app: http://localhost:${port}`));

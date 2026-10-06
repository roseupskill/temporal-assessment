# Juniper Salon: earlier-appointment offers

A working prototype for Lena at Juniper Salon. When a last-minute cancellation opens a slot, staff add the opening, and the app works through the waitlist **one client at a time**. Staff approve each text before it goes out, each client gets **15 minutes** to reply, and the process stops **30 minutes before the appointment**. It replaces the spreadsheet-and-texting routine and keeps a clear record of who was contacted, who declined and what happened.

## Run it (one command)

With Node.js 20+ installed and Docker Desktop running, from the repository folder:

```bash
npm install && npm run dev
```

Then open the app at <http://localhost:3000> and the Temporal Web UI at <http://localhost:8233>. Press Ctrl+C to stop, and `npm run stop` to shut down Temporal.

- **Presentation for Lena:** [`presentation/Juniper-Salon-Openings.pdf`](presentation/Juniper-Salon-Openings.pdf) (5 slides)
- **Temporal Web UI evidence:** [`evidence/temporal-ui-workflow.png`](evidence/temporal-ui-workflow.png)

## What Lena asked for → how it works

| Lena’s need | In the prototype |
|---|---|
| Earliest waitlist joiner first, if service, availability and stylist match | The waitlist is sorted by join date. A client matches if the service fits the slot length, the time fits their availability, and the stylist matches (or they have no preference). |
| One offer at a time, so two people can’t claim the slot | Only one live offer per opening. The first in-time “yes” books it. |
| Staff approve each offer before it’s sent | Each proposed client waits for **Text [name]** or **Skip this time**. Staff see the exact message first. |
| No approval in time → don’t send; staff see it | Nothing is sent. At the cutoff, the opening ends as unfilled with a clear note. |
| 15 minutes to reply, no repeated follow-ups | A durable 15-minute timer. If it runs out, the offer moves to the next person automatically. |
| Stop when there isn’t time to get there | Offers stop 30 minutes before the start. An offer sent close to the cutoff gets a shorter window so it never runs past it. |
| Failed text → mark unreachable, move on, let staff fix it | Bad numbers fail immediately and the client is marked **Unreachable** (skipped for all openings) until staff save a corrected number. Temporary carrier errors are retried. |
| Late “yes” → told it’s no longer available | The client gets a polite “no longer available” text and stays on the waitlist. |
| Decline or timeout only applies to this opening | They stay on the waitlist for future openings. |
| Accepted → confirmed, removed from the waitlist | A Square booking (simulated), a confirmation text, and the client marked booked. |
| Walk-in → cancel the open offer | **Give this time to a walk-in** withdraws the offer and texts the client that it’s no longer available. |
| Client changes their mind → reopen | **[Name] can’t make it: reopen** cancels the booking and continues with the next eligible client, if there’s still time. |
| No-show → staff mark it; never re-offered after the start time | **Mark as a no-show** appears once the appointment has started. No offers go out after the cutoff. |
| Several openings at once; a client has only one active offer | A single waitlist Workflow reserves each client for one opening at a time. If two openings want the same person, the second one moves on. |
| Warm, calm, phone-friendly | One column on a phone with three tabs (Openings, Waitlist, Client texts). Each opening says what’s happening in a plain sentence, shows one decision at a time, and a countdown ring while an offer is out. History and technical details are tucked behind “What’s happened”. |

## How it uses Temporal

- **`openingWorkflow`, one per opening.** The Workflow ID comes from the slot (`opening-2026-10-06-1500-maria`), so the same slot can’t be worked twice at once. It loops: find the next match → wait for staff approval (timeout = cutoff) → reserve the client → send the text → race a **durable timer** against the client’s reply → book, or move on. After booking, it stays open until the appointment ends so staff can reopen or mark a no-show. If the Worker or server restarts mid-offer, the timer and state survive.
- **`waitlistWorkflow`, a long-running entity Workflow** that owns waitlist state (today this lives in a Google Sheet). Its handlers run one at a time, which is what guarantees **one active offer per client** across openings. It uses `continueAsNew` to keep its history small.
- **Updates for every action that needs an immediate answer.** Staff approve, skip, cancel, reopen and no-show actions, plus client replies, are Updates with **validators**. For example, you can’t approve someone who isn’t the proposed client, and you can’t reopen after the start time. The page gets an instant yes or no, and a client’s “yes” only returns after the booking is recorded.
- **Queries** drive the staff screen (`getOpeningStatus`, `getWaitlist`).
- **Activities with retry policies** handle the outside world: sending texts (simulated; invalid numbers are non-retryable, carrier errors retry with backoff), Square bookings (simulated; the booking ID is derived from the slot and client so retries never double-book), and waitlist changes.
- **Event history** is the audit trail Lena was missing. Every offer, timeout, decline and retry is visible in the Temporal UI.

## Other commands

```bash
npm test          # 7 Workflow tests with a time-skipping test server (no Docker needed)
npm run typecheck
npm run stop      # stop the local Temporal service
```

## Demo script (about 3 minutes)

The sample waitlist is set up so one 3:00 PM, 60-minute opening with **Maria** shows every path. Leave **Practice mode** checked so the reply window is 45 seconds instead of 15 minutes. On a laptop, client texts sit beside the openings; on a phone they’re in the **Client texts** tab.

1. **Add an opening** (Maria, 3:00 PM, 1 hour). Priya is proposed first (earliest eligible). Point out the message preview and that nothing is sent yet. Dana (color is too long), Grace (weekends only) and Leo (wants Jordan) don’t match.
2. **Text Priya.** Her offer appears under Client texts, and the countdown ring starts. Let it run out: the history shows the timeout and **Tom** is proposed automatically.
3. **Text Tom.** His number is invalid, so he’s marked **Can’t text** and **Aiko** is proposed. Fix Tom’s number in the waitlist later to show he’s back in line.
4. **Text Aiko.** Her carrier fails once and Temporal retries it (visible in the Temporal UI). Tap **Yes, book me** on Priya’s old offer: she’s told it’s no longer available. Then tap **Yes, book me** for Aiko: the slot is booked and she gets a confirmation.
5. Optional: **Aiko can’t make it: reopen** → Hannah is proposed next. **Give this time to a walk-in** on another opening withdraws its offer.
6. Open **What’s happened → Open in Temporal** to show the event history in the Temporal UI.

Use **Restore the sample waitlist** (Waitlist tab) to rehearse again.

## Assumptions and next steps

- Texts and Square bookings are **simulated**. A real SMS provider (with inbound replies via webhook → `respondToOffer` Update) and Square’s API would replace the Activity bodies.
- Waitlist data is sample data held in a Temporal Workflow. Next would be syncing it with Lena’s Google Sheet.
- The 30-minute cutoff and 15-minute window are constants in `src/config.ts`. Lena wants the cutoff adjustable **per service** later.
- A client who accepts and then cancels is not automatically re-added to the waitlist or re-offered that opening.
- One staff view with no login. Times use the server’s local time zone.

## Repository map

- `src/workflows.ts`: `openingWorkflow` and `waitlistWorkflow`
- `src/messages.ts`: Query and Update definitions shared by Workflows, Activities and the API
- `src/activities.ts`: texting, Square and waitlist Activities
- `src/matching.ts`: eligibility rules, offer text, sample waitlist
- `src/config.ts`: Task Queue, timings
- `src/worker.ts`: Worker configuration
- `src/api.ts`: browser-facing API and Temporal Client
- `src/types.ts`: shared data types
- `public/`: phone-friendly staff screen and simulated client texts
- `tests/`: Workflow tests (timeout, unreachable, late reply, one active offer, walk-in, cutoff, validation)
- `evidence/`: Temporal Web UI screenshot of a representative opening Workflow
- `presentation/`: 5-slide PDF for Lena (problem, how it works, what's simulated, next step)

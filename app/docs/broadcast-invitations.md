# Broadcast through the Invitations tab (NEW-3)

Answers to the 27 Oct fix list's four questions, from the code as it stands.

## 1. Can a send be scheduled?

**No.** A batch goes out the moment **Send** is pressed
(`POST /editions/:id/invitations/send`). The emails are queued in the outbox
and the mail dispatcher hands them to ZeptoMail within seconds. There is no
"send at" date, and no queue of future batches.

Adding scheduling would need:

- a `scheduled_for` on the batch;
- a timer like the hourly reminder scheduler, which sends due batches;
- a way to cancel a scheduled batch;
- the recipient list worked out when the batch sends, not when it is scheduled, so firms that set up in between are handled correctly.

## 2. Is there an approval step before a bulk send?

**No second person approves a batch.** What does stand between an operator and
a bulk send:

- **The right.** Sending needs "Write to firms, regulators and participants"
  (`access:send`). Until this change, the send route only required a sign-in,
  so any operator could send. It now refuses with 403 without the right.
- **A preview.** The tab shows the audience and its count before sending. An
  uploaded file is checked first: no address, a malformed address, a
  duplicate in the file, or already sent this template. Only clean rows are sent.
- **The template.** Its wording is managed in Setup → Wording, inside the
  approved designs.

A maker-checker step, as for the results lock and report release, would mean:

- the batch is saved as "awaiting approval";
- a different operator approves it, which sends it.

The platform's critical-action (maker-checker) mechanism could carry this.
It is not built.

## 3. How do campaign sends and operational invitations avoid duplicates?

There are two separate paths:

|                | Operational invitation                                                                                                                                                                                                 | Campaign (Invitations tab)                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where          | Setup → Firm team: "Invite" or "Invite all unclaimed firms"                                                                                                                                                            | Invitations tab: template + audience or uploaded file                                                                                                      |
| Email          | The firm invitation email (F-01)                                                                                                                                                                                       | The chosen template                                                                                                                                        |
| Duplicate rule | A firm that has set up its space, or already has an open invitation, is skipped. Inviting the same firm at the same address again resends the open invitation with a new expiry date. It is never a second invitation. | A firm never gets the **same template** twice in an edition. Firms already sent it are skipped and counted as duplicates. A different template still goes. |

Where the two paths meet:

- **A campaign email to an unclaimed firm carries its invitation link.** The
  send opens the firm's invitation for that address, or reuses an open one, in
  the same transaction. No separate invitation email goes out, so the firm gets
  one email, not two.
- **Who a firm-audience campaign writes to:**
  1. the lead coordinator;
  2. else another active coordinator;
  3. else the open invitation's address;
  4. else (new, NEW-2) the contact imported with the firm directory.
- **Not deduplicated across the two paths.** A firm sent an operational
  invitation today can also receive a campaign template tomorrow. A firm sent
  a campaign template can also be invited from Firm team. Each path counts only
  its own sends. To avoid a firm getting both:
  - choose one path for the first invitation. For the CIS list that is the
    one-file import, then "Invite all unclaimed firms";
  - use the campaign for follow-ups, with the "Firms not yet invited" or
    "Invited, space not claimed" audiences.

  "Not yet invited" counts campaign sends only.

## 4. What tracking needs `ZEPTOMAIL_WEBHOOK_SECRET`?

Without the secret, the delivery webhook (`POST /invitations/zeptomail-webhook`)
refuses every call (503), so:

- **Bounces are not reported back.** A bounced address stays "accepted by the
  mail service" in the batch report and the firm's invitation row.
- **Opens and clicks are not recorded.** The batch report shows those columns as
  "not reported", never as zero.

These work without it:

- "accepted by the mail service" (ZeptoMail took the message);
- outright send failures.

ZeptoMail never reports a delivery to the inbox, so nothing claims "delivered".

To turn tracking on:

- set `ZEPTOMAIL_WEBHOOK_SECRET` on the API;
- point the ZeptoMail webhook at `https://<site>/api/invitations/zeptomail-webhook`, sending the secret in the `x-cis-webhook-secret` header or as `?secret=`;
- choose bounces, opens and clicks.

The Mail page shows whether the webhook is configured.

## Suggested 3-firm test batch

1. Import a 3-row CIS file in Setup → Firm team, with name, contact name, email and phone.
2. Either:
   - press "Invite all unclaimed firms" with the address pattern left empty, which sends 3 F-01 invitations; or
   - send the "First invitation" template to "Firms not yet invited" from the Invitations tab.
3. Check the batch's delivery report. Bounces, opens and clicks appear only once the webhook secret is set.

# Equipment Library - booking & tracking for The Plant

Necessary info:
**Student page** (`/`) — no login
- Pick a pick-up and return time first to check availability
- Browse by category, search, or open an item to see the next four weeks of availability; you can request several items in one booking.
- "Check a booking": reference + email shows the status, any message from staff, and lets you cancel.

**Admin** (`/admin/`) — staff login
- **Today:** what's waiting for approval, what to hand out, what's due back, what's overdue.
- **Bookings:** filter by status, search, export CSV, create walk-in bookings, edit dates/items.
- **Booking detail:** approve / reject (with a reason the student sees), hand out, check in
  (with a condition note), undo, staff-only notes, activity log, and a pre-written email to the borrower.
- **Calendar:** a timeline per item, 7/14/28 days, colour-coded by status.
- **Equipment:** items with asset numbers, photos, location, condition (available / maintenance /
  retired), staff notes and booking history. "Save as a copy" for adding the 2nd, 3rd… of the same kit.
- **Settings:** booking rules (notice, max length, items per request, allowed email domains),
  conditions of loan, pick-up instructions, optional auto-approval.

**Booking life-cycle**

| Status | Meaning | Blocks the item? |
|---|---|---|
| Pending | Student requested it | No — others can still request |
| Approved | Staff said yes | Yes |
| Collected (out) | Handed over | Yes |
| Overdue | Out and past its return time | Yes, and flagged everywhere |
| Returned | Checked back in | No (frees the rest of the slot) |
| Rejected / Cancelled | Closed | No |

---
Jay's notes for later:

### Adding/Removing Admins
**Add another admin later:** add their user in Supabase/Users, then run:
    insert into public.admins (user_id, email)
    select id, email from auth.users where email = 'email@email.com';

**Remove an admin:** `delete from public.admins where email = 'them@example.org';`

## How to use this page

1. A request comes in → it appears under **Today → Waiting for approval** and the Bookings badge counts it.
2. **Approve** (optionally with a message such as where to collect) or **Reject** with a reason.
   The student sees the outcome when they check their booking. A toast offers **"Let … know by email"**,
   which opens your mail app with a ready-made message.
3. When they collect: **Hand out**. When they bring it back: **Check in**, noting anything missing.
   If something needs repair, open the item and set its condition to **In maintenance**; students
   can't book it until you set it back.
4. Overdue loans show in red on Today, the calendar and the equipment list, with a prepared email for reminders (must send by yourself)

- **Backups:** Bookings → All → Export CSV for an overview.

<!--
The intake artifact for the demo. Create it as a real issue in the octodemo
fork so forge-builder Phase 1 reads it the way it will in production:

    gh label create metric-request --repo octodemo/build-once-run-on-any-agent-madrid \
      --color 0E8A16 --description "Request for a new metric build" --force
    gh issue create --repo octodemo/build-once-run-on-any-agent-madrid \
      --title "Track our 48-hour dispatch promise" \
      --body-file issues/dispatch-promise.md --label metric-request

The business rules are agreed up front and written here, so the agent has
nothing to ask about them. They match the human-owned acceptance tests in
acceptance/online-marketplace/story.json; the agent is never pointed at those.
-->

Operations wants to know whether we keep our dispatch promise: every order
should leave a fulfilment centre within 48 hours of being placed. Today we can
see how many orders are placed and cancelled each day, but nobody can say how
many promises we kept or broke without pulling raw data by hand.

What we need:

- Two new Dispatch metrics, by merchant: promises met
  (`total_dispatch_meet_count`) and promises missed (`total_dispatch_miss_count`)
- Counted per day and as a running total, like the existing Order metrics, so
  the two can sit side by side on the operations dashboard
- Built in the fulfilment domain, next to the Order metrics, for both regions:
  east (Madrid Este) and west (Madrid Oeste)

The rules, agreed with Operations:

- Met: the order was dispatched within 48 hours of being placed (at or before
  the deadline). Count it on the day it was dispatched.
- Missed: the order had not been dispatched when the 48 hours ran out. Count it
  on the day the deadline passed, even if the order shipped later.
- Cancelled before its deadline: not counted at all. Cancelled after its
  deadline: still a missed promise, counted on the day the deadline passed.
- One order is one promise, however many dispatch attempts it took. Use its
  first successful attempt.
- Rows marked `is_deleted` are test data. Ignore them, in both tables.

Things we know about the data:

- Orders are in `orders`: `merchant_id`, `placed_at`, `cancelled_at`.
- Dispatch attempts are in `dispatch_attempts`. The warehouse logs every
  attempt, so an order that failed twice before it went out has three rows. A
  successful attempt has `outcome = 'dispatched'`; a failed one has
  `outcome = 'failed'`.
- All timestamps use Madrid local time.

Not in scope for this request: a "currently overdue" backlog view, per-region
local business days, and anything that needs carrier tracking data. Those are
follow-ups.

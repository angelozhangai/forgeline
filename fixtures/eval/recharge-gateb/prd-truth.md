# PRD source of truth (multi-round reviewed): Wallet recharge balance

> This document = PRD original + gate A review final + PM confirmation. Gate B takes this + the code source of truth as its only input.

## 1. PRD original

Requirement: add "wallet recharge" — the user tops up an amount into an account balance once, later item purchases deduct from the balance, cutting repeated-payment friction.

- Recharge entry points: a "Recharge" button at the top of the item store + the My Wallet page.
- Tiers: 50 / 100 / 200 (three fixed tiers to start).
- Deduction: item purchases deduct from balance first; insufficient balance falls back to the original payment flow.
- History: one record per recharge/spend; the wallet page lists the latest 50 in reverse order.
- Out of scope: recharge bonuses / promos, withdrawals.

## 2. Gate A review final (open questions decided by the PM)

- **Balance expiry**: no expiry — balance stays valid indefinitely (PM decision).
- **Refund semantics**: the unspent portion of a recharge is refundable to the original payment method; the spent portion is not (PM decision).
- **Concurrent deduction**: item purchases must not over-deduct (same user, concurrent requests) — use a row-level lock on the balance + idempotency keys.
- **Fund consistency**: recharge crediting reconciles against the payment callback; failed callbacks go to a retry queue; never credit based on the client-side result.
- Complexity: L (payment callback, balance account, ledger, two frontend entry points). Repos touched: demo (backend) + example-web (user frontend).

## 3. PM confirmation

Confirmed. Additions: single recharge capped at 2000; ledger pagination 20 per page.

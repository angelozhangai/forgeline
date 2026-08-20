# Requirement: Wallet recharge balance

## Background
Today users buy items one purchase at a time with real money, making the conversion funnel long. We want a "wallet recharge": the user tops up an amount into an account balance once, and later item purchases deduct from the balance, cutting repeated-payment friction.

## User stories
- As a player, I want to top up 50/100/200 into my wallet first, then buy items straight from the balance without jumping to payment every time.
- As a player, I want the "My wallet" page to show my current balance and recent recharge/spend history.

## Scope
- New recharge entry points (a "Recharge" button at the top of the item store + the My Wallet page).
- Recharge tiers: 50 / 100 / 200 (three fixed tiers to start).
- Balance deduction: item purchases deduct from balance first; when balance is insufficient, fall back to the original payment flow.
- History: one record per recharge and per spend; the wallet page lists the latest 50 in reverse order.

## Out of scope
- Recharge bonuses / promo campaigns (next iteration).
- Withdrawals.

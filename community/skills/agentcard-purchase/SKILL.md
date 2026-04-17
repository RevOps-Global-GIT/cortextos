---
name: agentcard-purchase
description: "You need to make a purchase on behalf of Greg — buy a SaaS subscription, pay for an API, purchase a domain, or any transaction requiring a credit card. Use this skill to request approval, issue a scoped virtual Visa card via AgentCard, and complete the purchase autonomously. Requires the AgentCard MCP server to be configured."
triggers: ["buy", "purchase", "pay for", "subscribe to", "need a credit card", "make a payment", "sign up for paid plan", "buy a domain", "purchase API credits", "pay invoice", "need to pay", "financial transaction", "virtual card", "agentcard"]
external_calls: ["mcp.agentcard.sh", "api.agentcard.sh"]
---

# AgentCard Purchase (RevOps Global Internal)

Issue a scoped, single-use virtual Visa card to complete a purchase. Cards are funded on demand, capped at the approved amount, and auto-close after one transaction.

Requires: AgentCard MCP server configured via `agent-cards setup-mcp` (CLI: `npm i -g agentcard`). A saved payment method must exist — if `create_card` errors with a payment-method message, call `setup_payment_method` first.

This is the RevOps Global internal copy. It intentionally keeps card details in the agent context because the cortextos VM is a trusted environment. The public/community version needs a subprocess wrapper before it can ship — do not copy this file into `community/` without that redesign.

---

## When to Use

You need to spend real money on Greg's behalf. Examples:
- Buy a domain name
- Subscribe to a paid API or SaaS tool
- Purchase credits (OpenAI, cloud compute, etc.)
- Pay an invoice that was sent to the org

---

## Workflow

### Step 1: Request approval (uses the approvals skill)

Never create a card before getting approval. Use the `financial` category. Record the approved amount in the approval detail so Step 2 can read it back rather than reconstructing it.

```bash
APPR_ID=$(cortextos bus create-approval \
  "Purchase: $VENDOR — \$$AMOUNT for $REASON" \
  "financial" \
  "vendor=$VENDOR amount_cents=$AMOUNT_CENTS justification=$REASON")
echo "APPR_ID=$APPR_ID"

cortextos bus update-task "$TASK_ID" blocked
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" \
  "Purchase approval needed: \$$AMOUNT for $VENDOR — $REASON"
```

Wait for approval via inbox. Do not proceed until you receive `decision: approved`.

### Step 2: Bind the card amount to the approval

Read `amount_cents` back from the approval record rather than trusting a local variable. This prevents a drafting bug from issuing a larger card than Greg approved.

```bash
AMOUNT_CENTS=$(cortextos bus get-approval "$APPR_ID" --json | jq -r '.detail' | grep -oE 'amount_cents=[0-9]+' | cut -d= -f2)
if [ -z "$AMOUNT_CENTS" ]; then
  echo "ERROR: could not extract amount_cents from approval $APPR_ID"
  exit 1
fi
```

### Step 3: Create the virtual card

Issue the card scoped to the approved amount. Use `sandbox: true` when validating a new flow; only pass `sandbox: false` when actually charging.

```
mcp__agent-cards__create_card(amount_cents: $AMOUNT_CENTS, sandbox: false)
```

Example for a $15 purchase bound to an approval with `amount_cents=1500`:

```
mcp__agent-cards__create_card(amount_cents: 1500)
```

The tool returns: card ID, last4, expiry, balance, and billing address.

### Step 4: Get card details for checkout

`get_card_details` returns a 202 requiring user approval before revealing PAN/CVV. Wait for the approval, then resolve it:

```
mcp__agent-cards__get_card_details(card_id: "CARD_ID")
# → { status: 202, approval_id: "..." }

mcp__agent-cards__approve_request(
  approval_id: "...",
  decision: "approved",
  action: "card_details",
  resource_id: "CARD_ID"
)
# → { pan, cvv, exp_month, exp_year, billing_address }
```

### Step 5: Complete the purchase

Use the card details to complete checkout. For web checkouts, prefer `detect_checkout` with the AgentCard Pay Chrome extension — it autofills card + address and keeps PAN out of the browser DOM. If the extension is not installed, run `npx agent-cards extension install` and ask Greg to load it in Chrome.

Fallback (manual form fill via `agent-browser`): use the card details from Step 4 and Greg's billing address:

```
4126 NE 246th St
Ridgefield, WA 98642, US
```

If `detect_checkout` or vendor checkout fails AVS/3DS verification, fall back to `agent-browser` with the address above. AgentCard's default pass-through address fails AVS on many US merchants — always use Greg's real address.

### Step 6: Verify and close

Check that the transaction went through:

```
mcp__agent-cards__list_transactions(card_id: "CARD_ID")
```

Cards auto-close after one transaction, but close explicitly on both the happy path and the failure path so no card is left funded:

```
mcp__agent-cards__close_card(card_id: "CARD_ID")
```

### Step 7: Log the result

```bash
cortextos bus complete-task "$TASK_ID" --result "Purchased $VENDOR for \$$AMOUNT. Card ****$LAST4. Transaction: $STATUS"
cortextos bus log-event task purchase_completed info --meta "{\"vendor\":\"$VENDOR\",\"amount_cents\":$AMOUNT_CENTS,\"card_last4\":\"$LAST4\",\"approval_id\":\"$APPR_ID\"}"
```

---

## Limits (Free Tier)

| Limit | Value |
|-------|-------|
| Cards per month | 5 |
| Max per card | $50 |
| Card lifetime | 7 days (unused) |
| Transactions per card | 1 (single-use) |

Upgrade to Basic ($15/mo) for 15 cards/month and $500 max per card: `agent-cards plan upgrade`.

---

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `create_card` | Issue a new virtual card (amount_cents, sandbox) |
| `list_cards` | List all cards with status |
| `get_card_details` | Get PAN, CVV, expiry for checkout (requires approve_request) |
| `approve_request` | Resolve the 202 returned by `get_card_details` |
| `check_balance` | Check remaining balance (no sensitive data) |
| `close_card` | Permanently close a card (idempotent) |
| `list_transactions` | View transactions for a card |
| `detect_checkout` | Check if active Chrome tab is a checkout page (extension required) |

---

## Critical Rules

1. **Approval first, always.** Never create a card without an approved `financial` approval.
2. **Bind amount to approval.** Read `amount_cents` from the approval record, not from a drafted variable.
3. **Scope the amount.** Create the card for the exact purchase amount, not more. If a $12 domain, create a $12 card (1200 cents).
4. **One card per purchase.** Do not reuse cards across transactions.
5. **Close on both paths.** Call `close_card` on success and on failure — do not leave a funded card open.
6. **Never log full PAN/CVV.** Only reference cards by last4 in task results, events, and Telegram messages.
7. **Sandbox for new flows.** Use `sandbox: true` the first time you integrate with a new vendor.
8. **Use Greg's billing address.** `4126 NE 246th St, Ridgefield, WA 98642, US` — do not use AgentCard's pass-through address (fails AVS on many merchants).

You are a senior test architect. Below are a **requirement source of truth** and the **outer-loop acceptance contract (acceptance)** gate B produced for it.
Judge only the **semantic quality of the acceptance** — whether it can serve as a reliable baseline for reconciling "implementation vs requirement". Do not judge the tech design itself, do not rewrite anything.

Criteria:
- **coverage (0-100)**: does the acceptance cover the source of truth's **key paths and boundaries** (main flow + clarified boundaries such as expiry/refund/concurrency/failure rollback). Missing a key path scores low.
- **testability (0-100)**: are the scenarios **declarative** Given/When/Then with **explicit assertions** (observable outcomes/state), and are the contracts **concrete** (endpoint with method+path+request/response, or a function signature) rather than vague. High score if automation could be written directly from them.
- **declarative (true/false)**: do the scenarios describe "outcomes" rather than "operation steps". Any **imperative UI steps** like "click the button / open the page / type X into the input" → false.
- **issues**: list concrete problems one by one (which key path is uncovered, which scenario is imperative, which contract is vague). Empty array if none.
- **verdict**: `good` (usable as a reconciliation baseline) or `weak` (unreliable baseline, needs strengthening).

## Requirement source of truth
```
{{PRD_TRUTH}}
```

## Acceptance under judgment
```
{{ACCEPTANCE}}
```

## Output contract (strictly enforced)
Reply with exactly one fenced ```json block — no text outside the block, no comments, no trailing commas:

```json
{
  "coverage": 0,
  "testability": 0,
  "declarative": false,
  "issues": ["concrete problem; empty array if none"],
  "verdict": "good"
}
```

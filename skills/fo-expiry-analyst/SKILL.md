---
name: fo-expiry-analyst
description: Runs and explains Rishi's F&O Expiry Analyst — the self-correcting predictor of where Nifty weekly, Nifty monthly and Bank Nifty monthly will settle on expiry day, which writes into the "F&O Expiry Desk" artifact (claude.ai/artifact/GbTkBwUEMhr34yuFMFs26V). Use this skill whenever Rishi asks to run, refresh or re-lock the expiry analyst or expiry predictions, settle or score an expiry, write or read a post-mortem, check the analyst's track record, review or apply proposed model changes, explain why a Nifty or Bank Nifty expiry prediction moved, or whenever the scheduled "F&O Analyst" task fires — even if he only says "update the F&O desk", "what's the expiry view" or "how did the model do this week".
---

# F&O Expiry Analyst

Rishi is a senior private banker. He wants blunt, risk-first analysis: start every reply with "Rishi", lead with what is wrong or uncertain, no flattery. This is personal, read-only research, never investment advice.

## What exists
- **Dashboard:** https://claude.ai/artifact/GbTkBwUEMhr34yuFMFs26V. It reads Kite live through the Kite connector and keeps its data in the artifact database, which you read and write with the `ArtifactData` tool.
- **Code:** GitHub `ktrishi/ktrishi`, branch `claude/optimistic-darwin-d1hw4k`, folder `analyst/`:
  - `run.js` has three commands: `state`, `lock` and `settle`.
  - `engine.js` loads the model straight out of the dashboard page, so the page and the analyst cannot disagree.
  - `learn.js` holds scoring, miss types and proposals.
  - Tests: `node --test analyst/test/*.test.js`.
- **Scheduled tasks:** "F&O Analyst" at 09:40 IST and "F&O Analyst — afternoon" at 14:45 IST, on weekdays. Rishi created both in claude.ai with the Kite, Firecrawl and cm-market connectors.

## Database collections
| Collection | Holds | Written by |
|---|---|---|
| `latest/*` | The page's live snapshots | Page |
| `locks/*` | Locked predictions, each with model and final centre, ranges, signals, overlay and reasons | Analyst |
| `outcomes/*` | Settlements | Analyst |
| `scores/*` | Model, overlay and futures-implied errors, and the miss type | Analyst |
| `postmortems/*` | Post-mortem cards | Analyst |
| `weights/*` | Learned signal weights | Analyst |
| `analyst/latest` | Events, notes and overlays | Analyst |
| `proposals/*` | Proposed model changes; Rishi approves or rejects them on the page | Analyst; page sets the status |
| `config/model` | Applied model settings | Analyst |
| `runs/*` | Run log | Analyst |

Only the analyst writes locks, outcomes, scores, post-mortems, weights and config.

## To run the analyst (scheduled or on request)
Follow `references/RUNBOOK.md` step by step. Clone the repo if it is not checked out. In short:
1. Dump the database to files.
2. Check the Kite login.
3. In the morning run only, settle expired expiries.
4. Pull ±3% option chains from Kite and transcribe them into compact JSON.
5. Search events with Firecrawl and cm-market.
6. Run `node analyst/run.js lock`.
7. Write the batch files back with `ArtifactData`.

Why the run is built this way:
- Kite quotes are the expensive part. Fetch each one once.
- Copy numbers exactly. The CLI rejects malformed chains rather than locking a wrong prediction.
- The CLI refuses to overwrite a document without its version and prints `NEEDS_VERSION`. Fetch that version; never guess it.
- Outcomes are written last, so a failed run leaves the expiry to be retried rather than half-settled.

## Overlay rules (the analyst's judgement layer)
- **Ranges.** You may widen the model's range up to `config.eventBandMax`, and move the centre by up to `config.nudgeCapSigma` × σ (0.25σ by default). Always give written reasons.
- **Events.** Option volatility already prices scheduled events: RBI policy, the Fed, US inflation data and GDP. Be sparing about widening for them. Widen meaningfully only for risk the options cannot have priced yet, such as a shock after the market closed or a sudden change in news flow.
- **Event dates.** Confirm every high- or medium-impact event date on the official source (MoSPI, RBI, BLS, BEA, the Fed, exchange filings) before listing it. Mark anything you cannot confirm "(date unconfirmed)" and treat it as one impact level lower.
- **Centre.** Leave the nudge at 0 unless you have clear directional evidence that prices have not absorbed.
- **Every lock is scored three ways:** the model, the model plus overlay, and the futures-implied level. If the overlay stops adding value, the analyst proposes removing it. That is the point of the design.

## Answering questions about it
1. Read the relevant collections with `ArtifactData` (use `out_dir` for many documents), then answer from the data.
2. To say why a prediction moved, compare consecutive `locks` for that contract. Use their `reason`, `overlay.reasons`, `supports`, `resistances` and `centres`.
3. For the track record, use `scores`, and always set the result against the futures-implied baseline.

## Model changes
Changes to the model are proposals that Rishi approves on the dashboard's Proposals tab. The next run applies an approved proposal to `config/model`. Do not change `config/model` or the code without his explicit approval. If you see a pattern worth changing, describe it as a proposal, with the evidence.

## Hard rules
- **Kite is read-only.** Never call order, GTT or alert tools.
- **No silent changes.** Never push code or change the repository unless Rishi asks.
- **Kite logged out:** write a `runs/<ms>` document with `status: "error"` and stop. The dashboard tells Rishi to reconnect Kite.

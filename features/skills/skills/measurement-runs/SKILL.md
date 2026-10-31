---
name: measurement-runs
description: Use before planning, launching, watching or reporting any measurement, benchmark, model-backed check, paid or hours-long run, cost or time comparison, or before/after experiment.
---

# Measurement runs

**Before launch**
- Count the real volume from the data and cap the brief; if the count differs from the agreed estimate, stop and go to the user.
- A run of hours or days, or a new sequence of steps after a finished stage, is agreed first: what, order, duration, cost. A plan item is not consent to its duration.
- Stage model-backed checks smallest first, cost named before each stage, bulk on the cheapest model. Match the check to the risk: a change research showed the model is insensitive to gets a short smoke check, not a full judged run.
- Check on the cheapest data that can show the effect (a few cases, a replay of saved inputs) before a full run. A gap cheaper to measure now than on a full run is measured now.
- Plan for the shortest wall time: download only what is needed, once; keep reusable downloads until the part ends; install once and reuse; one representative instance and one round, more only when the effect is within run-to-run spread; estimates from a real breakdown.
- A cost or time run needs an idle machine (no games, editors, other test runs; laptop on mains). If busy, do not start: say what runs and how long a free machine is needed, start when told. A failed time-budget test: list running processes and check power before rerunning.
- Before a paid audit, list the change's possible faults and run the free code checks first. A fleet of expensive auditors runs once, at the end of a stage, cost named first; checks in between run on changed items only, on a cheaper model.

**While it runs**
- Measurement runs, watching and collecting numbers go to cheap subagents with a narrow brief, volume/cost/wall-time caps, one per independent check in parallel, each told to stop and report at a cap.
- A long run writes a progress line at a fixed interval (wall-clock stamp, "N of M", the stage) to a file a Monitor watches; stop early when it is stuck.
- A step 2x slower or costlier than its last comparable run, or a model call over ~6 minutes: find the cause now, never "will look later". Every background run has a watchdog for calls older than ~6 minutes. Keep calls small, saved and resumable.
- Save every call's result to a file so a rerun resumes and paid outputs are reused.

**Reading results**
- Compare before/after only under identical conditions (same brief, packet size, inputs, model); list what differs besides the change. Model judges get blind mixed packets.
- Before reporting, check my own method: data leakage, a metric that cannot fail, a fix copied from the failing case. When the result drives a decision, a fresh reviewer checks it.
- Dig every unexplained row (a jump, a worse number) to its cause before results go out. A "not a candidate" verdict needs the cause and every cheap untested idea run first.
- Drop variants outside the agreed bounds and say so. Before citing a run's number in a doc, read that run's script for its keys and name them.
- Report: what was found, what is emerging, what is unknown; no decision question.

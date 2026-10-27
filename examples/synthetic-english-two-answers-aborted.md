# Synthetic English Interview - Stopped After Two Answers

This is a fictional test case, not research data. The interview deliberately
stops after two participant answers and has no closing or finalization. Its
application representation is `paused`, with an unfinalized transcript. The
timestamps assigned during import are synthetic. No score is prescribed.

## Question 1 - Robustness

**Interviewer:** What does your organization do under difficult conditions to
maintain its position and stability?

**Participant:** I am 42 years old and I am the operations manager at the fictional
company Northbridge Components. In March, our main supplier stopped delivering
for ten days. We kept our largest customer orders running using a small stock
buffer, but two smaller orders were delayed by four days. Purchasing found a
second supplier and production changed the schedule. The alternative material
needed rework on one product, so it was not a complete solution. The team leaders
had a short call every morning, and employees volunteered for some additional
packing work. Responsibilities for rework were initially unclear, and purchasing
and production disagreed about priorities. We resolved that in a joint meeting
after two days. We now keep the contact details of the second supplier, but we
have not tested a wider contingency plan or checked whether all departments would
respond the same way.

## Question 2 - Agility

**Interviewer:** How does your organization act when a quick response is required?

**Participant:** For that supplier interruption, we recognized the problem on
Monday morning and made a decision the next morning. The new production schedule
started on Tuesday afternoon, and the first alternative delivery arrived on
Thursday. Production and purchasing could make small changes themselves, but any
additional spending above 5000 euros needed the directors approval. That approval
took a full day for one order. We had two options: the second supplier or delaying
production. We used both depending on the product. The workaround kept priority
orders moving, but rework reduced output for a week. Afterward we adjusted the
stock buffer for two parts and kept the second supplier contact. We did not review
the arrangements for other components, and we have no clear test results for how
quickly a different department could react.

## Interrupted

The participant stopped the interview at this point. There are no further
answers. Missing answers are not negative evidence. Any evaluation must be
identified as provisional and must retain these original English quotations.

## Stored Evaluation Example

- Interview ID: `synthetic:english-two-answers-20261001`
- Display name: `Synthetic English interview - stopped after 2 answers`
- Source: four turns, exactly two participant answers, English, paused and not finalized.
- Evaluation: real provider call using the `default` profile and prompt `profile-evidence-coding-v7`.
- Observed result on 2026-10-01: provisional overall score 4.5/7, eight scored items,
  one item with insufficient evidence. This is an observed test result, not a target score.
- Item rationale lengths: 746-889 characters. Original English evidence quotations
  and detailed rationales were verified in JSON, CSV, Markdown and HTML exports.
- Open the stored case in Evaluation Studio:
  <http://localhost:5275/?interviewId=synthetic%3Aenglish-two-answers-20261001&profileId=profile-default>

The seed script requires explicit `--confirm-synthetic-import`, creates only this
fixed-ID test case, and leaves an existing copy unchanged. It does not invoke any
model or voice provider; evaluation was started separately through the regular API.

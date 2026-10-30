import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignPublicationSubject, campaignPublicationTitle } from "./index.js";

test("publication titles compare without the issue-form type prefix (#2940)", () => {
  const subject = campaignPublicationTitle("Treat an Exiting Process's ESRCH as Absent");
  for (const title of ["[Bug]: Treat an Exiting Process's ESRCH as Absent", "[Feature]:  treat an exiting process's ESRCH as absent",
    "  [BUG] Treat an  Exiting Process's ESRCH as Absent "]) assert.equal(campaignPublicationTitle(title), subject, title);
  assert.notEqual(campaignPublicationTitle("[Bug]: Another subject"), subject);
  // Only one leading tag classifies the issue; later brackets and a tag alone are its subject.
  assert.equal(campaignPublicationTitle("[Bug]: [Runner] Repair"), "[runner] repair");
  assert.equal(campaignPublicationTitle("Repair [Bug]: case"), "repair [bug]: case");
  assert.equal(campaignPublicationTitle("[Bug]:"), "[bug]:");
});

test("the duplicate search subject keeps its case and drops only the type tag (#2940)", () => {
  assert.equal(campaignPublicationSubject("  [Bug]:  Treat ESRCH as Absent "), "Treat ESRCH as Absent");
  assert.equal(campaignPublicationSubject("Treat ESRCH as Absent"), "Treat ESRCH as Absent");
  assert.equal(campaignPublicationSubject("Keep Secrets Out [UI]"), "Keep Secrets Out [UI]");
  assert.equal(campaignPublicationSubject("[Bug]:"), "[Bug]:");
});

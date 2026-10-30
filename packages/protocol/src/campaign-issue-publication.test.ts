import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignPublicationTitle } from "./index.js";

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

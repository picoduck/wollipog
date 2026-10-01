import assert from "node:assert/strict";
import test from "node:test";
import { shareCreatedLabel, shareDisplayStatus, shareExpiryLabel, shareMoment } from "./transcript-share-time.js";

// Local wall-clock times, so the expectations hold in every time zone the suite runs in.
const at = (month: number, day: number, hour: number, minute: number, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(9, 30, 0, 26);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const active = (expiresAt: number) => ({ status: "active" as const, expiresAt });

test("a link is named by its expiry's short date and clock time, never by a locale timestamp", () => {
  assert.equal(shareMoment(at(10, 2, 0, 26), NOW), "Oct 2 at 12:26 AM");
  assert.equal(shareMoment(at(10, 2, 12, 5), NOW), "Oct 2 at 12:05 PM");
  assert.equal(shareMoment(at(9, 30, 23, 59), NOW), "Sep 30 at 11:59 PM", "today keeps its date, so it reads in a button name");
  assert.equal(shareMoment(at(1, 3, 9, 0, 2027), NOW), "Jan 3, 2027 at 9:00 AM", "another year names it");
});

test("an active link's expiry is relative and rounds to the unit the person chose", () => {
  // Just created: the request and the server's clock spend a moment before the row is drawn.
  assert.equal(shareExpiryLabel(active(NOW + HOUR - 2_000), NOW), "Expires in 1 hour");
  assert.equal(shareExpiryLabel(active(NOW + DAY - 2_000), NOW), "Expires in 1 day");
  assert.equal(shareExpiryLabel(active(NOW + 7 * DAY - 2_000), NOW), "Expires in 7 days");
  assert.equal(shareExpiryLabel(active(NOW + 30 * DAY - 2_000), NOW), "Expires in 30 days");
  assert.equal(shareExpiryLabel(active(NOW + 5 * HOUR + 10 * 60_000), NOW), "Expires in 5 hours");
  assert.equal(shareExpiryLabel(active(NOW + 23 * HOUR + 50 * 60_000), NOW), "Expires in 1 day");
  assert.equal(shareExpiryLabel(active(NOW + 25 * 60_000), NOW), "Expires in 25 minutes");
  assert.equal(shareExpiryLabel(active(NOW + 20_000), NOW), "Expires in 1 minute", "the last minute never reads 0");
});

test("an expired or revoked link says so, and an active link past its expiry is shown as expired", () => {
  assert.equal(shareExpiryLabel({ status: "expired", expiresAt: at(9, 20, 8, 0) }, NOW), "Expired on Sep 20");
  assert.equal(shareExpiryLabel({ status: "expired", expiresAt: at(12, 20, 8, 0, 2025) }, NOW), "Expired on Dec 20, 2025");
  assert.equal(shareExpiryLabel(active(NOW - 60_000), NOW), "Expired today at 12:25 AM");
  assert.equal(shareDisplayStatus(active(NOW - 60_000), NOW), "expired");
  assert.equal(shareDisplayStatus(active(NOW), NOW), "expired", "the server refuses it from its expiry on");
  assert.equal(shareDisplayStatus(active(NOW + 60_000), NOW), "active");
  assert.equal(shareExpiryLabel({ status: "revoked", expiresAt: NOW + DAY }, NOW), "Revoked");
  assert.equal(shareDisplayStatus({ status: "revoked", expiresAt: NOW - DAY }, NOW), "revoked", "revoked outranks expired");
});

test("the creation time reads today, yesterday or the date", () => {
  assert.equal(shareCreatedLabel(at(9, 30, 0, 26), NOW), "Created today at 12:26 AM");
  assert.equal(shareCreatedLabel(at(9, 29, 21, 5), NOW), "Created yesterday at 9:05 PM");
  assert.equal(shareCreatedLabel(at(9, 20, 13, 0), NOW), "Created Sep 20 at 1:00 PM");
  assert.equal(shareCreatedLabel(at(12, 31, 23, 0, 2025), NOW), "Created Dec 31, 2025 at 11:00 PM");
});

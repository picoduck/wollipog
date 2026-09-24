import assert from "node:assert/strict";
import test from "node:test";
import {
  accountLabelText,
  HIDDEN_ACCOUNT,
  isPersonalIdentifier,
  maskedAccountTitles,
  redactPersonalIdentifiers,
} from "./personal-identifiers.js";

test("email-shaped values are personal identifiers and aliases are not", () => {
  for (const value of ["person@example.com", " first.last+tag@mail.example.co.uk ", "Work (me@example.org)"]) {
    assert.equal(isPersonalIdentifier(value), true, value);
  }
  for (const value of ["Work", "Personal", "Claude Max", "user@localhost", "@handle", "", undefined, null]) {
    assert.equal(isPersonalIdentifier(value), false, String(value));
  }
});

test("plain-text labels keep aliases and never repeat a hidden identifier", () => {
  assert.equal(accountLabelText("Work"), "Work");
  assert.equal(accountLabelText("person@example.com"), HIDDEN_ACCOUNT);
  assert.equal(accountLabelText("person@example.com", "another account"), "another account");
});

test("status text redaction removes every address and leaves other words", () => {
  assert.equal(
    redactPersonalIdentifiers("a@example.com is not signed in; b@example.com is fine."),
    `${HIDDEN_ACCOUNT} is not signed in; ${HIDDEN_ACCOUNT} is fine.`,
  );
  assert.equal(redactPersonalIdentifiers("Usage appears after a provider response."), "Usage appears after a provider response.");
});

test("picker titles stay distinct when several hidden identifiers look alike", () => {
  assert.deepEqual(
    maskedAccountTitles(["Work", "me@example.com", "me@example.org", "Personal"]),
    ["Work", "Hidden Account 1", "Hidden Account 2", "Personal"],
  );
  assert.deepEqual(maskedAccountTitles(["Work", "me@example.com"]), ["Work", HIDDEN_ACCOUNT]);
  assert.deepEqual(maskedAccountTitles(["a@example.com", "b@example.com"], "Hidden Name"), ["Hidden Name 1", "Hidden Name 2"]);
});

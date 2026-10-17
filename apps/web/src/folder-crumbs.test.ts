import assert from "node:assert/strict";
import test from "node:test";
import { folderCrumbs } from "./folder-crumbs.js";

test("a folder under home starts its trail at Home", () => {
  assert.deepEqual(folderCrumbs("/home/ada/repos/billing", "/home/ada"), [
    { name: "Home", path: "/home/ada" },
    { name: "repos", path: "/home/ada/repos" },
    { name: "billing", path: "/home/ada/repos/billing" },
  ]);
  assert.deepEqual(folderCrumbs("/home/ada", "/home/ada"), [{ name: "Home", path: "/home/ada" }]);
  assert.deepEqual(folderCrumbs("/home/ada/repos/", "/home/ada/"), [
    { name: "Home", path: "/home/ada" },
    { name: "repos", path: "/home/ada/repos" },
  ], "trailing separators do not add empty crumbs");
});

test("a folder outside home starts its trail at the filesystem root", () => {
  assert.deepEqual(folderCrumbs("/home", "/home/ada"), [
    { name: "/", path: "/" },
    { name: "home", path: "/home" },
  ]);
  assert.deepEqual(folderCrumbs("/home/adam", "/home/ada"), [
    { name: "/", path: "/" },
    { name: "home", path: "/home" },
    { name: "adam", path: "/home/adam" },
  ], "a sibling whose name starts with home's is not inside it");
  assert.deepEqual(folderCrumbs("/", "/home/ada"), [{ name: "/", path: "/" }]);
  assert.deepEqual(folderCrumbs("/srv/data", null), [
    { name: "/", path: "/" },
    { name: "srv", path: "/srv" },
    { name: "data", path: "/srv/data" },
  ], "before home is known every trail starts at the root");
});

test("Windows paths keep their drive or share and their backslashes", () => {
  assert.deepEqual(folderCrumbs("C:\\Users\\misko\\repo", "C:\\Users\\misko"), [
    { name: "Home", path: "C:\\Users\\misko" },
    { name: "repo", path: "C:\\Users\\misko\\repo" },
  ]);
  assert.deepEqual(folderCrumbs("C:\\Users", "C:\\Users\\misko"), [
    { name: "C:", path: "C:\\" },
    { name: "Users", path: "C:\\Users" },
  ]);
  assert.deepEqual(folderCrumbs("D:\\work", "C:\\Users\\misko"), [
    { name: "D:", path: "D:\\" },
    { name: "work", path: "D:\\work" },
  ], "another drive is outside home");
  assert.deepEqual(folderCrumbs("\\\\nas\\share\\team", null), [
    { name: "\\\\nas\\share", path: "\\\\nas\\share\\" },
    { name: "team", path: "\\\\nas\\share\\team" },
  ]);
});

test("a home at the root replaces the root crumb", () => {
  assert.deepEqual(folderCrumbs("/data", "/"), [
    { name: "Home", path: "/" },
    { name: "data", path: "/data" },
  ]);
});

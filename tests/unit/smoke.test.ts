import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "../../src/core/version.ts";

test("runner executes TypeScript and resolves .ts imports from src", () => {
  assert.equal(VERSION, "1.0.0-dev");
});

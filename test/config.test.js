import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDataRoot } from "../src/config.js";

describe("runtime configuration", () => {
  it("resolves the fallback data directory", () => {
    assert.equal(
      resolveDataRoot({ argv: [], env: {}, cwd: "/tmp/app", fallback: "data" }),
      "/tmp/app/data",
    );
  });

  it("allows NORTHSTAR_DATA_DIR to point at a local knowledge directory", () => {
    assert.equal(
      resolveDataRoot({
        argv: [],
        env: { NORTHSTAR_DATA_DIR: "../knowledge-base" },
        cwd: "/tmp/app",
        fallback: "data",
      }),
      "/tmp/knowledge-base",
    );
  });

  it("lets --data-dir override the environment", () => {
    assert.equal(
      resolveDataRoot({
        argv: ["--data-dir", "/opt/northstar"],
        env: { NORTHSTAR_DATA_DIR: "/tmp/ignored" },
        cwd: "/tmp/app",
        fallback: "data",
      }),
      "/opt/northstar",
    );
  });

  it("rejects --data-dir without a path", () => {
    assert.throws(
      () => resolveDataRoot({ argv: ["--data-dir"], env: {}, cwd: "/tmp/app", fallback: "data" }),
      /requires a directory path/,
    );
  });
});

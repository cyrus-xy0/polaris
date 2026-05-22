import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDefaultDataRoot, hasDataRootOverride, resolveDataRoot, shouldSeedDemoData } from "../src/config.js";

describe("runtime configuration", () => {
  it("resolves the fallback data directory", () => {
    assert.equal(
      resolveDataRoot({ argv: [], env: {}, cwd: "/tmp/app", fallback: "data" }),
      "/tmp/app/data",
    );
  });

  it("allows POLARIS_DATA_DIR to point at a local knowledge directory", () => {
    assert.equal(
      resolveDataRoot({
        argv: [],
        env: { POLARIS_DATA_DIR: "../knowledge-base" },
        cwd: "/tmp/app",
        fallback: "data",
      }),
      "/tmp/knowledge-base",
    );
  });

  it("lets --data-dir override the environment", () => {
    assert.equal(
      resolveDataRoot({
        argv: ["--data-dir", "/opt/polaris"],
        env: { POLARIS_DATA_DIR: "/tmp/ignored" },
        cwd: "/tmp/app",
        fallback: "data",
      }),
      "/opt/polaris",
    );
  });

  it("rejects --data-dir without a path", () => {
    assert.throws(
      () => resolveDataRoot({ argv: ["--data-dir"], env: {}, cwd: "/tmp/app", fallback: "data" }),
      /requires a directory path/,
    );
  });

  it("uses an OS user data directory as the deploy-safe default", () => {
    assert.equal(
      getDefaultDataRoot({ env: { HOME: "/Users/demo" }, platform: "darwin", homeDir: "/fallback" }),
      "/Users/demo/Library/Application Support/Polaris",
    );
  });

  it("detects explicit data directory overrides", () => {
    assert.equal(hasDataRootOverride({ argv: [], env: {} }), false);
    assert.equal(hasDataRootOverride({ argv: ["--data-dir", "/opt/polaris"], env: {} }), true);
    assert.equal(hasDataRootOverride({ argv: [], env: { POLARIS_DATA_DIR: "/opt/polaris" } }), true);
  });

  it("only seeds demo data when explicitly requested", () => {
    assert.equal(shouldSeedDemoData({ argv: [], env: {} }), false);
    assert.equal(shouldSeedDemoData({ argv: ["--seed-demo"], env: {} }), true);
    assert.equal(shouldSeedDemoData({ argv: [], env: { POLARIS_SEED_DEMO: "1" } }), true);
  });
});

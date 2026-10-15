import test from "node:test";
import assert from "node:assert/strict";
import { buildArgs, buildFilter } from "./gcloud.js";

test("builds filter with escaping", () => {
  const f = buildFilter({ project: "my-proj-prod", minSeverity: "ERROR", namespace: 'a"b', textSearch: "boom" });
  assert.equal(f, 'severity>=ERROR AND resource.labels.namespace_name="a\\"b" AND "boom"');
});

test("always read-only and filter after --", () => {
  const a = buildArgs({ project: "my-proj-prod", filter: "--format=value(x)" });
  assert.deepEqual(a.slice(0, 2), ["logging", "read"]);
  assert.equal(a[a.length - 2], "--");
  assert.ok(a.includes("--freshness=1h"));
});

test("clamps limit and rejects bad project/freshness/time", () => {
  assert.ok(buildArgs({ project: "my-proj-prod", limit: 99999 }).includes("--limit=500"));
  assert.throws(() => buildArgs({ project: "x; rm -rf /" }));
  assert.throws(() => buildArgs({ project: "my-proj-prod", freshness: "1h --foo" }));
  assert.throws(() => buildFilter({ project: "my-proj-prod", startTime: "nope" }));
});

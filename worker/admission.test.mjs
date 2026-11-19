import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeConfig, startWorker } from "./test-fixture.mjs";

const objectName = "digital-twin-global";
const baseTime = Date.UTC(2030, 0, 1, 23, 59, 59);

function digest(label) {
  return createHash("sha256").update(label).digest("hex");
}

async function admissionFixture(t, bindings = {}, persistencePath) {
  const { workerd, stop } = await startWorker(t, { bindings, controlledClock: true, persistencePath });
  const namespace = await workerd.getDurableObjectNamespace("ADMISSION");
  const object = () => namespace.get(namespace.idFromName(objectName));
  const admission = object();
  await admission.setClock(baseTime);
  const storage = await workerd.unsafeGetDurableObjectStorage(runtimeConfig.name, "InferenceAdmission", { name: objectName });
  return { admission, storage, stop };
}

async function claim(admission, label, timestamp = baseTime) {
  const key = digest(label);
  assert.equal((await admission.claim(key, timestamp)).outcome, "claimed");
  return key;
}

test("SQLite admission serializes concurrent challenge claims and reserves at most two leases", async (t) => {
  const { admission, storage } = await admissionFixture(t);
  const replayed = digest("same token");
  const claims = await Promise.all(Array.from({ length: 12 }, () => admission.claim(replayed, baseTime)));
  assert.equal(claims.filter(({ outcome }) => outcome === "claimed").length, 1);
  assert.equal(claims.filter(({ outcome }) => outcome === "replay").length, 11);
  assert.equal((await admission.claim(digest("old"), baseTime - 300_000)).outcome, "expired");
  const keys = await Promise.all(Array.from({ length: 8 }, (_, index) => claim(admission, `unique ${index}`)));
  const grants = await Promise.all(keys.map((key) => admission.admit(key)));
  const won = grants.filter(({ outcome }) => outcome === "admitted");
  assert.equal(won.length, 2);
  assert.equal(grants.filter(({ outcome }) => outcome === "capacity").length, 6);
  const admittedIndex = grants.findIndex(({ outcome }) => outcome === "admitted");
  assert.equal((await admission.admit(keys[admittedIndex])).outcome, "replay");
  await admission.release(won[0].leaseId);
  await admission.release(won[0].leaseId);
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_leases"))[0].total, 1);
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_attempts"))[0].total, 2);
});

test("SQLite admission enforces rolling minutes across UTC midnight and races the last daily slot", async (t) => {
  const { admission, storage } = await admissionFixture(t, {
    DIGITAL_TWIN_DAILY_LIMIT: "2",
    DIGITAL_TWIN_MINUTE_LIMIT: "2",
  });
  for (const label of ["before midnight one", "before midnight two"]) {
    const grant = await admission.admit(await claim(admission, label));
    assert.equal(grant.outcome, "admitted");
    await admission.release(grant.leaseId);
  }
  const extra = await claim(admission, "waiting");
  const daily = await admission.admit(extra);
  assert.equal(daily.outcome, "daily_limit");
  assert.equal(daily.retryAfter, 1);
  await admission.setClock(baseTime + 1_001);
  const minute = await admission.admit(extra);
  assert.equal(minute.outcome, "minute_limit");
  assert.ok(minute.retryAfter > 0);
  await admission.setClock(baseTime + 60_000);
  const atBoundary = await admission.admit(extra);
  assert.equal(atBoundary.outcome, "admitted");
  await admission.release(atBoundary.leaseId);
  const keys = await Promise.all(["daily race one", "daily race two"].map((label) => claim(admission, label)));
  const grants = await Promise.all(keys.map((key) => admission.admit(key)));
  assert.deepEqual(grants.map(({ outcome }) => outcome).sort(), ["admitted", "daily_limit"]);
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_attempts"))[0].total, 2);
});

test("SQLite replay claims, spent quota, and leases persist across a workerd restart and recover by expiry", { timeout: 12_000 }, async (t) => {
  const persistencePath = await mkdtemp(join(tmpdir(), "digital-twin-admission-"));
  const limits = { DIGITAL_TWIN_MAX_CONCURRENT: "1" };
  const { admission, stop } = await admissionFixture(t, limits, persistencePath);
  const first = await claim(admission, "first");
  const grant = await admission.admit(first);
  assert.equal(grant.outcome, "admitted");
  const { leaseId, expiresAt } = grant;
  const waiting = await claim(admission, "waiting");
  await stop();

  const { admission: restarted, storage } = await admissionFixture(t, limits, persistencePath);
  t.after(() => rm(persistencePath, { recursive: true, force: true }));
  await restarted.setClock(baseTime + 1_000);
  assert.equal((await restarted.claim(first, baseTime)).outcome, "replay");
  assert.equal((await restarted.admit(waiting)).outcome, "capacity");
  await restarted.setClock(expiresAt);
  const recovered = await restarted.admit(waiting);
  assert.equal(recovered.outcome, "admitted");
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_attempts"))[0].total, 2);
  await restarted.release(leaseId);
  const leases = await storage.exec("SELECT id FROM inference_leases");
  assert.deepEqual(Array.from(leases, ({ id }) => id), [recovered.leaseId]);
  await restarted.setClock(baseTime + 361_000);
  await restarted.runCleanup();
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM inference_attempts"))[0].total, 1);
  await restarted.setClock(baseTime + 86_460_000);
  await restarted.runCleanup();
  for (const table of ["challenge_claims", "inference_leases", "inference_attempts"]) {
    assert.equal((await storage.exec(`SELECT COUNT(*) AS total FROM ${table}`))[0].total, 0);
  }
  assert.equal((await storage.exec("SELECT version FROM admission_schema"))[0].version, 1);
});

test("SQLite bounds the live challenge set and reports the local count scan", async (t) => {
  const { admission, storage } = await admissionFixture(t);
  const keys = Array.from({ length: 61 }, (_, index) => digest(`challenge ${index}`));
  const result = await Promise.all(keys.map((key) => admission.claim(key, baseTime)));
  assert.equal(result.filter(({ outcome }) => outcome === "claimed").length, 60);
  const denial = result.find(({ outcome }) => outcome === "claim_limit");
  assert.equal(denial?.retryAfter, 360);
  assert.equal((await storage.exec("SELECT COUNT(*) AS total FROM challenge_claims"))[0].total, 60);
  const reads = await admission.countReads();
  assert.ok(reads > 0 && reads <= 64);
  t.diagnostic(`SQLite rows read by the live-claim count at its cap: ${reads}`);
});

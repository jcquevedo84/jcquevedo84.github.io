import { DurableObject } from "cloudflare:workers";
import { loadAdmissionPolicy } from "./config.mjs";
import { isFreshChallenge } from "./turnstile.mjs";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CLAIM_TTL_MS = 6 * MINUTE_MS;
const MAX_LIVE_CLAIMS = 60;
const DISPATCH_WINDOW_MS = 5_000;
const LEASE_GRACE_MS = 5_000;
const CLEANUP_BATCH_SIZE = 64;

export const ADMISSION_OBJECT_NAME = "digital-twin-global";

function utcDayStart(now) {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function retryAfter(availableAt, now) {
  return Math.max(1, Math.ceil((availableAt - now) / 1_000));
}

export class InferenceAdmission extends DurableObject {
  #storage;
  #sql;
  #policy;
  #now;

  constructor(ctx, environment, now = Date.now) {
    super(ctx, environment);
    this.#storage = ctx.storage;
    this.#sql = ctx.storage.sql;
    this.#policy = loadAdmissionPolicy(environment);
    this.#now = now;

    this.#storage.transactionSync(() => {
      this.#sql.exec("CREATE TABLE IF NOT EXISTS admission_schema (version INTEGER PRIMARY KEY)");
      const versions = this.#sql.exec("SELECT version FROM admission_schema").toArray();
      if (versions.length === 1 && versions[0].version === 1) return;
      if (versions.length > 0) throw new Error("Unsupported admission schema");
      this.#sql.exec(`
        CREATE TABLE challenge_claims (
          digest TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          admitted INTEGER NOT NULL DEFAULT 0 CHECK (admitted IN (0, 1))
        ) WITHOUT ROWID;
        CREATE INDEX challenge_expiry ON challenge_claims(expires_at);
        CREATE TABLE inference_attempts (
          id TEXT PRIMARY KEY,
          admitted_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        CREATE INDEX attempt_time ON inference_attempts(admitted_at);
        CREATE TABLE inference_leases (
          id TEXT PRIMARY KEY,
          start_by INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        ) WITHOUT ROWID;
        INSERT INTO admission_schema VALUES (1);
      `);
    });
  }

  async claim(digest, issuedAt) {
    if (!this.#policy || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Admission unavailable");
    }
    const now = this.#now();
    if (!isFreshChallenge(issuedAt, now)) return { outcome: "expired" };

    const result = this.#storage.transactionSync(() => {
      this.#prune(now);
      if (this.#sql.exec("SELECT 1 FROM challenge_claims WHERE digest = ? AND expires_at > ?", digest, now).toArray().length) {
        return { outcome: "replay" };
      }
      const { count, first_expiry: firstExpiry } = this.#sql.exec(
        "SELECT COUNT(*) AS count, MIN(expires_at) AS first_expiry FROM challenge_claims WHERE expires_at > ?", now,
      ).one();
      if (count >= MAX_LIVE_CLAIMS) return { outcome: "claim_limit", retryAfter: retryAfter(firstExpiry, now) };

      this.#sql.exec("DELETE FROM challenge_claims WHERE digest = ? AND expires_at <= ?", digest, now);
      this.#sql.exec("INSERT INTO challenge_claims (digest, expires_at) VALUES (?, ?)", digest, now + CLAIM_TTL_MS);
      return { outcome: "claimed" };
    });
    if (result.outcome === "claimed") await this.#scheduleCleanup(now);
    return result;
  }

  async admit(digest) {
    if (!this.#policy || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Admission unavailable");
    }
    const now = this.#now();
    const dayStart = utcDayStart(now);
    const { day, minute, concurrent, providerTimeoutMs } = this.#policy;

    const result = this.#storage.transactionSync(() => {
      this.#prune(now);
      const claims = this.#sql.exec("SELECT admitted FROM challenge_claims WHERE digest = ? AND expires_at > ?", digest, now).toArray();
      if (claims.length !== 1 || claims[0].admitted) return { outcome: "replay" };

      const daily = this.#sql.exec("SELECT COUNT(*) AS count FROM inference_attempts WHERE admitted_at >= ?", dayStart).one();
      if (daily.count >= day) return { outcome: "daily_limit", retryAfter: retryAfter(dayStart + DAY_MS, now) };
      const recent = this.#sql.exec(
        "SELECT COUNT(*) AS count, MIN(admitted_at) AS first FROM inference_attempts WHERE admitted_at > ?", now - MINUTE_MS,
      ).one();
      if (recent.count >= minute) return { outcome: "minute_limit", retryAfter: retryAfter(recent.first + MINUTE_MS, now) };
      const live = this.#sql.exec(
        "SELECT COUNT(*) AS count, MIN(expires_at) AS first_expiry FROM inference_leases WHERE expires_at > ?", now,
      ).one();
      if (live.count >= concurrent) return { outcome: "capacity", retryAfter: retryAfter(live.first_expiry, now) };

      const leaseId = crypto.randomUUID();
      const startBy = now + DISPATCH_WINDOW_MS;
      const expiresAt = startBy + providerTimeoutMs + LEASE_GRACE_MS;
      this.#sql.exec("UPDATE challenge_claims SET admitted = 1 WHERE digest = ?", digest);
      this.#sql.exec("INSERT INTO inference_attempts VALUES (?, ?)", leaseId, now);
      this.#sql.exec("INSERT INTO inference_leases VALUES (?, ?, ?)", leaseId, startBy, expiresAt);
      return { outcome: "admitted", leaseId, startBy, expiresAt };
    });
    if (result.outcome === "admitted") await this.#scheduleCleanup(now);
    return result;
  }

  release(leaseId) {
    if (typeof leaseId !== "string" || !/^[a-f0-9-]{36}$/.test(leaseId)) return;
    this.#sql.exec("DELETE FROM inference_leases WHERE id = ?", leaseId);
  }

  async alarm() {
    const now = this.#now();
    this.#storage.transactionSync(() => this.#prune(now));
    await this.#scheduleCleanup(now, true);
  }

  #prune(now) {
    this.#sql.exec(`
      DELETE FROM challenge_claims WHERE digest IN (
        SELECT digest FROM challenge_claims WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
      )
    `, now, CLEANUP_BATCH_SIZE);
    this.#sql.exec(`
      DELETE FROM inference_leases WHERE id IN (
        SELECT id FROM inference_leases WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
      )
    `, now, CLEANUP_BATCH_SIZE);
    this.#sql.exec(`
      DELETE FROM inference_attempts WHERE id IN (
        SELECT id FROM inference_attempts WHERE admitted_at < ? AND admitted_at <= ? ORDER BY admitted_at LIMIT ?
      )
    `, utcDayStart(now), now - MINUTE_MS, CLEANUP_BATCH_SIZE);
  }

  async #scheduleCleanup(now, fromAlarm = false) {
    const next = this.#sql.exec(`
      SELECT MIN(expires_at) AS expiry FROM (
        SELECT MIN(expires_at) AS expires_at FROM challenge_claims
        UNION ALL SELECT MIN(expires_at) FROM inference_leases
        UNION ALL SELECT MAX(MIN(admitted_at) - MIN(admitted_at) % ? + ?, MIN(admitted_at) + ?) FROM inference_attempts
      )
    `, DAY_MS, DAY_MS, MINUTE_MS).one().expiry;
    if (next === null) return;
    const when = Math.max(now + 1_000, next);
    const scheduled = await this.#storage.getAlarm();
    if (scheduled === null || scheduled > when || (fromAlarm && scheduled <= now)) {
      await this.#storage.setAlarm(when);
    }
  }
}

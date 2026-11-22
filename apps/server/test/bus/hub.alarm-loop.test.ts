// The newest receipt is never purged (B11 L1). #nextDeadline must not count
// it either: when it did, a quiet hub whose newest receipt was past the 24 h
// retention re-armed its alarm at now + 1 forever (~18 alarms a second in
// production, millions of rows read a day).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { BusHub } from "../../src/bus/hub.js";
import { hubOf } from "./helpers.js";

const HOUR = 3_600_000;
const inHub = async <R>(fn: (i: BusHub, s: DurableObjectState) => R) =>
  runInDurableObject(await hubOf(), fn);

afterEach(() => inHub((i) => BusHub.setTestClock(i, null)));

const insertReceipt = (
  s: DurableObjectState,
  id: string,
  t: number,
  notified: boolean,
) =>
  s.storage.sql.exec(
    `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, size, created_at, expires_at, acked_at, notified_at, final_at)
     values (?, 'o', 'n', 'a', 'a', 'b', 'b', 'acked', 1, ?, ?, ?, ?, ?)`,
    id,
    t,
    t + HOUR,
    t,
    notified ? t : null,
    t,
  );

/** Runs the scheduled alarm `times` times at `now`; returns each re-arm relative to now. */
async function alarmRuns(now: number, times: number) {
  await inHub((i, s) => {
    BusHub.setTestClock(i, now);
    return s.storage.setAlarm(Date.now());
  });
  const arms: (number | null)[] = [];
  for (let k = 0; k < times; k++) {
    await runDurableObjectAlarm(await hubOf());
    const at = await inHub((_, s) => s.storage.getAlarm());
    arms.push(at === null ? null : at - now);
    if (at === null || at > now + 1) break;
  }
  return arms;
}

const receiptIds = () =>
  inHub((_, s) =>
    s.storage.sql
      .exec<{ id: string }>("select id from receipts order by rowid")
      .toArray()
      .map((r) => r.id),
  );

describe("BusHub alarm: the newest receipt sets no retention deadline", () => {
  for (const notified of [true, false]) {
    it(`a lone ${notified ? "notified" : "never-told final"} receipt past retention does not spin the alarm`, async () => {
      const t0 = Date.now() + 1000 * HOUR;
      await inHub((_, s) => {
        s.storage.sql.exec("delete from receipts");
        insertReceipt(s, "r-last", t0, notified);
      });
      const arms = await alarmRuns(t0 + 25 * HOUR, 3);
      expect(arms).not.toContain(1);
      expect(await receiptIds()).toEqual(["r-last"]);
    });
  }

  it("an older receipt is still purged once a newer one exists", async () => {
    const t0 = Date.now() + 2000 * HOUR;
    await inHub((_, s) => {
      s.storage.sql.exec("delete from receipts");
      insertReceipt(s, "r-old", t0, true);
      insertReceipt(s, "r-new", t0 + 24 * HOUR, true);
    });
    const arms = await alarmRuns(t0 + 25 * HOUR, 3);
    expect(await receiptIds()).toEqual(["r-new"]);
    expect(arms.at(-1)).not.toBe(1);
  });
});

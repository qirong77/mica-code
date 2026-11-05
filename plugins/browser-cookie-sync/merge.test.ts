import { describe, expect, it } from 'vitest';
import { cookieFingerprint, cookieKey, type SyncCookie } from './cookies.js';
import {
  describeConflict,
  holdChromeOperations,
  nextBaseline,
  planMerge,
  type Baseline
} from './merge.js';

const cookie = (patch: Partial<SyncCookie> = {}): SyncCookie => ({
  host: 'example.com',
  hostOnly: true,
  name: 'sid',
  path: '/',
  value: 'v1',
  expiresAt: 1_767_225_600,
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  ...patch
});

/** 上一次同步完之后两侧一致的指纹。 */
const synced = (value = 'v1'): Baseline => {
  const fingerprint = cookieFingerprint(cookie({ value }));
  return { [cookieKey(cookie())]: { c: fingerprint, m: fingerprint } };
};

describe('planMerge', () => {
  it('does nothing when both sides hold the same value', () => {
    const plan = planMerge({ chrome: [cookie()], mica: [cookie()], baseline: {} });
    expect(plan.unchanged).toBe(1);
    expect(plan.toChrome).toHaveLength(0);
    expect(plan.toMica).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it('copies a Chrome-only cookie into the controlled browser', () => {
    const plan = planMerge({ chrome: [cookie()], mica: [], baseline: {} });
    expect(plan.toMica.map((entry) => entry.value)).toEqual(['v1']);
    expect(plan.toChrome).toHaveLength(0);
  });

  it('copies a controlled-browser-only cookie back into Chrome', () => {
    const plan = planMerge({ chrome: [], mica: [cookie({ name: 'fresh' })], baseline: {} });
    expect(plan.toChrome.map((entry) => entry.name)).toEqual(['fresh']);
  });

  it('pushes the side that changed and leaves the other alone', () => {
    const micaChanged = planMerge({
      chrome: [cookie()],
      mica: [cookie({ value: 'v2' })],
      baseline: synced('v1')
    });
    expect(micaChanged.toChrome.map((entry) => entry.value)).toEqual(['v2']);
    expect(micaChanged.toMica).toHaveLength(0);

    const chromeChanged = planMerge({
      chrome: [cookie({ value: 'v9' })],
      mica: [cookie()],
      baseline: synced('v1')
    });
    expect(chromeChanged.toMica.map((entry) => entry.value)).toEqual(['v9']);
    expect(chromeChanged.toChrome).toHaveLength(0);
  });

  it('treats “both changed, differently” as a conflict and never overwrites either side', () => {
    const plan = planMerge({
      chrome: [cookie({ value: 'chrome-account' })],
      mica: [cookie({ value: 'mica-account' })],
      baseline: synced('v1')
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.toChrome).toHaveLength(0);
    expect(plan.toMica).toHaveLength(0);
    expect(describeConflict(plan.conflicts[0]!)).toMatchObject({
      host: 'example.com',
      name: 'sid',
      path: '/'
    });
  });

  it('treats a disagreement with no baseline as a conflict too: first-sync differences have no direction', () => {
    const plan = planMerge({
      chrome: [cookie({ value: 'a' })],
      mica: [cookie({ value: 'b' })],
      baseline: {}
    });
    expect(plan.conflicts).toHaveLength(1);
  });

  it('deletes on the side that still has a cookie the other side already dropped', () => {
    const plan = planMerge({ chrome: [cookie()], mica: [], baseline: synced('v1') });
    expect(plan.removeFromMica).toHaveLength(1);
    expect(plan.toMica).toHaveLength(0);

    const mirrored = planMerge({ chrome: [], mica: [cookie()], baseline: synced('v1') });
    expect(mirrored.removeFromChrome).toHaveLength(1);
    expect(mirrored.toChrome).toHaveLength(0);
  });

  it('only adds when a cookie is missing without ever having been synced', () => {
    const plan = planMerge({ chrome: [cookie()], mica: [], baseline: {} });
    expect(plan.removeFromMica).toHaveLength(0);
  });

  it('leaves everything for a disabled direction on the table and says why', () => {
    const plan = planMerge({
      chrome: [cookie()],
      mica: [cookie({ value: 'v9' })],
      baseline: synced('v1'),
      directions: { toChrome: false, toMica: true }
    });
    expect(plan.toChrome).toHaveLength(0);
    expect(plan.deferred).toEqual([{ reason: 'Mica → Chrome 方向关着', count: 1 }]);
    expect(plan.deferredKeys).toHaveLength(1);
  });

  it('cannot be asked to write Chrome while that direction is off', () => {
    const plan = planMerge({
      chrome: [],
      mica: [cookie()],
      baseline: synced('v1'),
      directions: { toChrome: false, toMica: true }
    });
    expect(plan.removeFromChrome).toHaveLength(0);
    expect(plan.deferred[0]?.count).toBe(1);
  });
});

describe('holdChromeOperations', () => {
  it('moves planned Chrome writes into the deferred bucket so the baseline keeps them', () => {
    const plan = planMerge({ chrome: [], mica: [cookie()], baseline: {} });
    expect(plan.toChrome).toHaveLength(1);
    holdChromeOperations(plan, 'Chrome 正开着');
    expect(plan.toChrome).toHaveLength(0);
    expect(plan.deferred).toEqual([{ reason: 'Chrome 正开着', count: 1 }]);
    expect(plan.deferredKeys).toEqual([cookieKey(cookie())]);
  });
});

describe('nextBaseline', () => {
  const planOf = (plan: ReturnType<typeof planMerge>) => plan;

  it('records fingerprints of both sides after a successful sync, never the values', () => {
    const plan = planMerge({ chrome: [], mica: [cookie()], baseline: {} });
    const baseline = nextBaseline({ plan, chrome: [cookie()], mica: [cookie()], previous: {} });
    const entry = baseline[cookieKey(cookie())]!;
    expect(entry.c).toBe(cookieFingerprint(cookie()));
    expect(entry.m).toBe(cookieFingerprint(cookie()));
    expect(JSON.stringify(baseline)).not.toContain('v1');
  });

  it('keeps the previous entry for conflicts so the difference does not vanish', () => {
    const previous = synced('v1');
    const plan = planOf(
      planMerge({
        chrome: [cookie({ value: 'chrome-account' })],
        mica: [cookie({ value: 'mica-account' })],
        baseline: previous
      })
    );
    const baseline = nextBaseline({
      plan,
      chrome: [cookie({ value: 'chrome-account' })],
      mica: [cookie({ value: 'mica-account' })],
      previous
    });
    expect(baseline[cookieKey(cookie())]).toEqual(previous[cookieKey(cookie())]);
  });

  it('keeps the previous entry for a withheld direction too', () => {
    const previous = synced('v1');
    const plan = planOf(
      planMerge({
        chrome: [cookie()],
        mica: [cookie({ value: 'v9' })],
        baseline: previous,
        directions: { toChrome: false, toMica: true }
      })
    );
    expect(plan.deferredKeys).toHaveLength(1);
    const baseline = nextBaseline({
      plan,
      chrome: [cookie()],
      mica: [cookie({ value: 'v9' })],
      previous
    });
    expect(baseline[cookieKey(cookie())]).toEqual(previous[cookieKey(cookie())]);
  });

  it('drops entries both sides no longer have', () => {
    const baseline = nextBaseline({ plan: planMerge({ chrome: [], mica: [], baseline: {} }), chrome: [], mica: [], previous: synced('v1') });
    expect(baseline).toEqual({});
  });
});

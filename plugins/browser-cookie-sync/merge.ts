import {
  cookieFingerprint,
  cookieKey,
  type SyncCookie
} from './cookies.js';

/**
 * 三方合并：Chrome、受控浏览器、上一次同步的**内容指纹**。
 *
 * 为什么必须有基线：cookie 上没有「修改时间」（两边的库都不给），只比两侧的当前值回答不了
 * 「是谁变的」。基线记的是上次同步完两边各自的指纹，于是每条 cookie 只有四种情况：
 *
 * - 两侧一样 → 不用动；
 * - 只有一侧变了（另一侧仍等于基线）→ 变的那侧赢，写过去；
 * - 两侧都变了、且变得不一样 → **冲突，谁都不动**（同一个站点在两边常常是两个账号，默默
 *   覆盖等于把用户在那边的登录态换掉）；
 * - 一侧有、另一侧没有，而基线里两边都有 → 判定为「那一侧删了」→ 另一侧也删。
 *
 * 首次同步（没有基线）时两侧的差异一律算冲突：那种差异说明不了方向，只能让人选。
 */

export type BaselineEntry = { c: string; m: string };
export type Baseline = Record<string, BaselineEntry>;

export type CookieConflict = {
  key: string;
  chrome: SyncCookie;
  mica: SyncCookie;
};

export type MergePlan = {
  /** 要写进 Chrome 的（新增或覆盖）。 */
  toChrome: SyncCookie[];
  /** 要写进受控浏览器的。 */
  toMica: SyncCookie[];
  /** 要从 Chrome 删掉的（那一侧已经没有了）。 */
  removeFromChrome: SyncCookie[];
  removeFromMica: SyncCookie[];
  conflicts: CookieConflict[];
  unchanged: number;
  /** 这一轮不处理的原因 → 条目数（方向关掉时用它解释「为什么有差异却没同步」）。 */
  deferred: { reason: string; count: number }[];
  /** 被跳过的条目（方向关着）：基线要沿用上一份，否则这份差异会被当成已同步。 */
  deferredKeys: string[];
};

export type SyncDirections = { toChrome: boolean; toMica: boolean };

function index(cookies: SyncCookie[]): Map<string, SyncCookie> {
  const map = new Map<string, SyncCookie>();
  for (const cookie of cookies) map.set(cookieKey(cookie), cookie);
  return map;
}

export function planMerge({
  chrome,
  mica,
  baseline,
  directions = { toChrome: true, toMica: true }
}: {
  chrome: SyncCookie[];
  mica: SyncCookie[];
  baseline: Baseline;
  directions?: SyncDirections;
}): MergePlan {
  const chromeByKey = index(chrome);
  const micaByKey = index(mica);
  const keys = new Set<string>([...chromeByKey.keys(), ...micaByKey.keys(), ...Object.keys(baseline)]);

  const plan: MergePlan = {
    toChrome: [],
    toMica: [],
    removeFromChrome: [],
    removeFromMica: [],
    conflicts: [],
    unchanged: 0,
    deferred: [],
    deferredKeys: []
  };

  const defer = (reason: string, count = 1) => {
    const existing = plan.deferred.find((entry) => entry.reason === reason);
    if (existing) existing.count += count;
    else plan.deferred.push({ reason, count });
  };

  for (const key of keys) {
    const onChrome = chromeByKey.get(key);
    const onMica = micaByKey.get(key);
    const base = baseline[key];

    if (onChrome && onMica) {
      const cf = cookieFingerprint(onChrome);
      const mf = cookieFingerprint(onMica);
      if (cf === mf) {
        plan.unchanged += 1;
        continue;
      }
      if (!base) {
        plan.conflicts.push({ key, chrome: onChrome, mica: onMica });
        continue;
      }
      const chromeChanged = cf !== base.c;
      const micaChanged = mf !== base.m;
      if (chromeChanged && !micaChanged) {
        push('toMica', onChrome);
      } else if (micaChanged && !chromeChanged) {
        push('toChrome', onMica);
      } else {
        plan.conflicts.push({ key, chrome: onChrome, mica: onMica });
      }
      continue;
    }

    if (onChrome && !onMica) {
      // 基线里两边都有 → 受控浏览器那边删了/登出了，跟着删；否则只是还没同步过
      if (base) {
        push('removeFromMica', onChrome);
      } else {
        push('toMica', onChrome);
      }
      continue;
    }

    if (!onChrome && onMica) {
      if (base) {
        push('removeFromChrome', onMica);
      } else {
        push('toChrome', onMica);
      }
      continue;
    }

    // 两边都没有：基线里那条不用再记（下一个人读基线时它就是噪音）
  }

  function push(
    bucket: 'toChrome' | 'toMica' | 'removeFromChrome' | 'removeFromMica',
    cookie: SyncCookie
  ): void {
    const writingChrome = bucket === 'toChrome' || bucket === 'removeFromChrome';
    if (writingChrome && !directions.toChrome) {
      defer('Mica → Chrome 方向关着');
      plan.deferredKeys.push(cookieKey(cookie));
      return;
    }
    if (!writingChrome && !directions.toMica) {
      defer('Chrome → Mica 方向关着');
      plan.deferredKeys.push(cookieKey(cookie));
      return;
    }
    plan[bucket].push(cookie);
  }

  return plan;
}

/**
 * 应用之后的新基线。
 *
 * 只写「这一轮真的同步过」的条目：被跳过的（方向关着）与冲突的沿用上一份基线，否则
 * 那份待同步的差异会被记成「已经一致」，下一次就凭空消失了。
 */
export function nextBaseline({
  plan,
  chrome,
  mica,
  previous
}: {
  plan: MergePlan;
  chrome: SyncCookie[];
  mica: SyncCookie[];
  previous: Baseline;
}): Baseline {
  const chromeByKey = index(chrome);
  const micaByKey = index(mica);
  const pending = new Set<string>();
  for (const conflict of plan.conflicts) pending.add(conflict.key);
  for (const key of plan.deferredKeys) pending.add(key);

  const next: Baseline = {};
  for (const key of new Set([...chromeByKey.keys(), ...micaByKey.keys()])) {
    if (pending.has(key)) {
      const carried = previous[key];
      if (carried) next[key] = carried;
      continue;
    }
    const onChrome = chromeByKey.get(key);
    const onMica = micaByKey.get(key);
    if (!onChrome || !onMica) continue;
    next[key] = { c: cookieFingerprint(onChrome), m: cookieFingerprint(onMica) };
  }
  return next;
}

/** 冲突条目在面板上要的那几行（域名 / 名字 / 路径）。 */
export function describeConflict(conflict: CookieConflict): {
  key: string;
  host: string;
  name: string;
  path: string;
} {
  return {
    key: conflict.key,
    host: conflict.chrome.host,
    name: conflict.chrome.name,
    path: conflict.chrome.path
  };
}

/**
 * 这一轮不写 Chrome（它正开着、或者用户没允许边开边写）时，把写 Chrome 的那批挪进「跳过」。
 *
 * 挪走而不是留在计划里：留在里面会让调用方以为已经写过了。挪进 `deferredKeys` 之后，
 * 基线会沿用上一份，下一轮（Chrome 关掉之后）这份差异还在。
 */
export function holdChromeOperations(plan: MergePlan, reason: string): MergePlan {
  const held = [...plan.toChrome, ...plan.removeFromChrome];
  if (held.length === 0) return plan;
  plan.deferredKeys.push(...held.map((cookie) => cookieKey(cookie)));
  plan.deferred.push({ reason, count: held.length });
  plan.toChrome = [];
  plan.removeFromChrome = [];
  return plan;
}

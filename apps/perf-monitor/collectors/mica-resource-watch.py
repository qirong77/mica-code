#!/usr/bin/env python3
"""低开销的进程资源与异常现场采集器（macOS）。

常驻每分钟记录：
  - 系统：swap 用量/总量、空闲页、压缩内存、wired、swapin/swapout 速率、磁盘吞吐与队列、load
  - 进程：footprint/RSS 及其增量、CPU 时间增量、读写字节增量、逻辑写入、pageins、线程数、FD 数、nice
  - 覆盖：所有「值得关注」的进程逐个记录；其余进程的存在由聚合值兜底，每 30 分钟额外落一份全量
异常触发（内存压力、换页、load、写盘）时保存用户态现场，并请求 root 侧抓 fs_usage 文件路径。

输出体积受控：常态约 10-20KB/分钟，监控器自身不能成为写盘源。
"""
import ctypes
import json
import os
import re
import subprocess
import time
from datetime import datetime

INTERVAL = float(os.environ.get("MICA_RESOURCE_INTERVAL", "60"))
LOG_DIR = os.path.expanduser(os.environ.get("CPUWATCH_LOG_DIR", "~/Library/Logs/cpu-watch"))
INCIDENT_DIR = os.path.join(LOG_DIR, "incidents")
# 这个路径必须与 root 侧捕获器读取的绝对路径一致，否则 fs_usage 永远不会触发。
TRIGGER_PATH = os.path.expanduser(os.environ.get(
    "MICA_PERF_TRIGGER", "~/Library/Logs/cpu-watch/.capture.request"))
RETENTION_DAYS = int(os.environ.get("CPUWATCH_RETENTION_DAYS", "7"))
# 系统吞吐与获权限进程的 I/O 均可触发；root 仅负责具体文件路径追踪。
DISK_TRIGGER_MB_S = float(os.environ.get("MICA_RESOURCE_DISK_TRIGGER_MB_S", "40"))
SWAP_TRIGGER_PCT = float(os.environ.get("MICA_RESOURCE_SWAP_TRIGGER_PCT", "85"))
LOAD_TRIGGER = float(os.environ.get("MICA_RESOURCE_LOAD_TRIGGER", "12"))
INCIDENT_COOLDOWN = float(os.environ.get("MICA_RESOURCE_INCIDENT_COOLDOWN", "1800"))
MAX_BYTES = int(os.environ.get("MICA_RESOURCE_MAX_BYTES", str(16 * 1024 * 1024)))
ROTATE_KEEP = int(os.environ.get("MICA_RESOURCE_ROTATE_KEEP", "5"))
FULL_EVERY_S = float(os.environ.get("MICA_RESOURCE_FULL_EVERY_S", "1800"))

# 落盘门槛：低于这些阈值的进程不进逐条记录，由聚合值兜底。
MIN_FOOTPRINT_MB = float(os.environ.get("MICA_RESOURCE_MIN_FOOTPRINT_MB", "24"))
MIN_FOOTPRINT_DELTA_MB = float(os.environ.get("MICA_RESOURCE_MIN_FOOTPRINT_DELTA_MB", "4"))
MIN_WRITE_MB_S = float(os.environ.get("MICA_RESOURCE_MIN_WRITE_MB_S", "0.01"))
MIN_READ_MB_S = float(os.environ.get("MICA_RESOURCE_MIN_READ_MB_S", "0.5"))
MIN_CPU_PCT = float(os.environ.get("MICA_RESOURCE_MIN_CPU_PCT", "0.5"))

# 这些进程无论多小都逐条保留，便于归因。
TRACK_RE = re.compile(
    r"mica|bun|node|electron|chrome|d-chat|lca|mds|mdworker|git|tsc|vite|npm|spotify|windowserver|python",
    re.I,
)

SAMPLE = 4  # 请求与 RUsageV4 完全匹配；V1 不会填 I/O 与峰值字段。
TASK_INFO = 4  # PROC_PIDTASKINFO
BSD_INFO = 3  # PROC_PIDTBSDINFO


class RUsageV4(ctypes.Structure):
    _fields_ = [
        ("uuid", ctypes.c_ubyte * 16), ("user", ctypes.c_uint64),
        ("system", ctypes.c_uint64), ("pkg", ctypes.c_uint64),
        ("interrupt", ctypes.c_uint64), ("pageins", ctypes.c_uint64),
        ("wired", ctypes.c_uint64), ("resident", ctypes.c_uint64),
        ("footprint", ctypes.c_uint64), ("start", ctypes.c_uint64),
        ("exit", ctypes.c_uint64), ("child_user", ctypes.c_uint64),
        ("child_system", ctypes.c_uint64), ("child_pkg", ctypes.c_uint64),
        ("child_interrupt", ctypes.c_uint64), ("child_pageins", ctypes.c_uint64),
        ("child_elapsed", ctypes.c_uint64),
        ("read", ctypes.c_uint64), ("write", ctypes.c_uint64),
        ("qos_default", ctypes.c_uint64), ("qos_maintenance", ctypes.c_uint64),
        ("qos_background", ctypes.c_uint64), ("qos_utility", ctypes.c_uint64),
        ("qos_legacy", ctypes.c_uint64), ("qos_user", ctypes.c_uint64),
        ("qos_interactive", ctypes.c_uint64), ("billed_system", ctypes.c_uint64),
        ("serviced_system", ctypes.c_uint64), ("logical", ctypes.c_uint64),
        ("lifetime_max", ctypes.c_uint64), ("instructions", ctypes.c_uint64),
        ("cycles", ctypes.c_uint64), ("energy", ctypes.c_uint64),
        ("serviced_energy", ctypes.c_uint64), ("interval_max", ctypes.c_uint64),
        ("runnable", ctypes.c_uint64),
    ]


class ProcTaskInfo(ctypes.Structure):
    _fields_ = [
        ("virtual_size", ctypes.c_uint64), ("resident_size", ctypes.c_uint64),
        ("total_user", ctypes.c_uint64), ("total_system", ctypes.c_uint64),
        ("threads_user", ctypes.c_uint64), ("threads_system", ctypes.c_uint64),
        ("policy", ctypes.c_int32), ("faults", ctypes.c_int32),
        ("pageins", ctypes.c_int32), ("cow_faults", ctypes.c_int32),
        ("messages_sent", ctypes.c_int32), ("messages_received", ctypes.c_int32),
        ("syscalls_mach", ctypes.c_int32), ("syscalls_unix", ctypes.c_int32),
        ("csw", ctypes.c_int32), ("threadnum", ctypes.c_int32),
        ("numrunning", ctypes.c_int32), ("priority", ctypes.c_int32),
    ]


class ProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32),
        ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32),
        ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
        ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32),
        ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32),
        ("svgid", ctypes.c_uint32), ("reserved", ctypes.c_uint32),
        ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
        ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
        ("pjobc", ctypes.c_uint32), ("tdev", ctypes.c_uint32),
        ("tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32),
        ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64),
    ]


LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib")
PROC_PID_RUSAGE = LIBPROC.proc_pid_rusage
PROC_PID_RUSAGE.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
PROC_PID_RUSAGE.restype = ctypes.c_int
PROC_PIDINFO = LIBPROC.proc_pidinfo
PROC_PIDINFO.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
PROC_PIDINFO.restype = ctypes.c_int


class MachTimebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


_timebase = MachTimebase()
ctypes.CDLL("/usr/lib/libSystem.B.dylib").mach_timebase_info(ctypes.byref(_timebase))
TIMEBASE_NS = _timebase.numer / _timebase.denom
LIBSYSTEM = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
LIBSYSTEM.mach_host_self.restype = ctypes.c_uint32
HOST_PORT = LIBSYSTEM.mach_host_self()


def host_cpu_ticks():
    ticks = (ctypes.c_uint32 * 4)()
    count = ctypes.c_uint32(4)
    # HOST_CPU_LOAD_INFO: user, system, idle, nice, across all cores.
    rc = LIBSYSTEM.host_statistics(HOST_PORT, 3, ticks, ctypes.byref(count))
    return list(ticks) if rc == 0 and count.value == 4 else None


def run(args, timeout=8):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def process_list():
    out = run(["ps", "-ww", "-Ao", "pid=,ppid=,args="], timeout=20)
    result = []
    for line in out.splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) != 3:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        result.append((pid, ppid, parts[2][:600]))
    return result, bool(out)


def basename_of(argv):
    head = argv.split(None, 1)[0] if argv.strip() else ""
    name = head.rsplit("/", 1)[-1]
    return name[:40] or "?"


def usage(pid):
    r = RUsageV4()
    if PROC_PID_RUSAGE(pid, SAMPLE, ctypes.byref(r)) != 0:
        return None
    task = ProcTaskInfo()
    task_rc = PROC_PIDINFO(pid, TASK_INFO, 0, ctypes.byref(task), ctypes.sizeof(task))
    bsd = ProcBsdInfo()
    bsd_rc = PROC_PIDINFO(pid, BSD_INFO, 0, ctypes.byref(bsd), ctypes.sizeof(bsd))
    return {
        "start": r.start, "cpu_ns": (r.user + r.system) * TIMEBASE_NS, "pageins": r.pageins,
        "resident": r.resident, "footprint": r.footprint,
        "read": r.read, "write": r.write, "logical": r.logical,
        "lifetime_max": r.lifetime_max, "interval_max": r.interval_max,
        "threads": task.threadnum if task_rc > 0 else None,
        "running_threads": task.numrunning if task_rc > 0 else None,
        "faults": task.faults if task_rc > 0 else None,
        "task_pageins": task.pageins if task_rc > 0 else None,
        "open_files": bsd.nfiles if bsd_rc > 0 else None,
        "nice": bsd.nice if bsd_rc > 0 else None,
    }


def vm_pages():
    out = run(["vm_stat"])
    page_size = 16384
    pages = {}
    m = re.search(r"page size of (\d+) bytes", out)
    if m:
        page_size = int(m.group(1))
    for line in out.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        try:
            pages[k.strip().lower()] = int(v.strip().rstrip("."))
        except ValueError:
            pass
    return pages, page_size


def system_state(prev=None, elapsed=0):
    pages, page_size = vm_pages()
    swap = run(["sysctl", "-n", "vm.swapusage"]).strip()
    vals = {}
    for key in ("total", "used", "free"):
        m = re.search(r"%s = ([0-9.]+)M" % key, swap)
        if m:
            vals[key] = float(m.group(1))
    free = pages.get("pages free", 0) * page_size
    compressor = pages.get("pages occupied by compressor", 0) * page_size
    wired = pages.get("pages wired down", 0) * page_size
    swapins = run(["sysctl", "-n", "vm.compressor.swapper.swapins_total"]).strip()
    swapouts = run(["sysctl", "-n", "vm.compressor.swapper.swapouts_total"]).strip()
    thrash = run(["sysctl", "-n", "vm.compressor.swapper.wakeups.thrashing_detected"]).strip()
    # iostat 的第一次输出是「开机以来的平均值」，必须取第二次才是当前吞吐。
    disk = run(["iostat", "-d", "-c", "2", "-w", "1"], timeout=8)
    disk_rows = []
    for line in disk.splitlines():
        fields = line.split()
        if len(fields) >= 3 and re.fullmatch(r"[0-9.]+", fields[-1]):
            try:
                disk_rows.append({"kb_per_transfer": float(fields[-3]),
                                  "tps": float(fields[-2]), "mb_s": float(fields[-1])})
            except ValueError:
                pass
    # 内存压力等级是系统自己给出的判定：1 正常 / 2 警告 / 4 危急。
    try:
        pressure = int(run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]).strip() or 0)
    except ValueError:
        pressure = 0
    disk_free_gb = disk_used_pct = None
    try:
        st = os.statvfs("/System/Volumes/Data")
        disk_total = st.f_blocks * st.f_frsize
        disk_free = st.f_bavail * st.f_frsize
        disk_free_gb = round(disk_free / 1073741824, 1)
        disk_used_pct = round((disk_total - disk_free) / disk_total * 100, 1) if disk_total else None
    except OSError:
        pass
    uptime_h = None
    try:
        import re as _re
        m = _re.search(r"sec = (\d+)", run(["sysctl", "-n", "kern.boottime"]))
        if m:
            uptime_h = round((time.time() - int(m.group(1))) / 3600, 2)
    except (OSError, ValueError):
        pass
    result = {
        "swap_used_mb": vals.get("used"), "swap_total_mb": vals.get("total"),
        "free_mb": round(free / 1048576, 1),
        "compressor_mb": round(compressor / 1048576, 1),
        "wired_mb": round(wired / 1048576, 1),
        "pressure": pressure,
        "disk_free_gb": disk_free_gb, "disk_used_pct": disk_used_pct,
        "uptime_h": uptime_h,
        "swapins": int(swapins or 0), "swapouts": int(swapouts or 0),
        "thrashing_detected": int(thrash or 0),
        "disk": disk_rows[-1] if disk_rows else None,
        "load": [round(x, 2) for x in os.getloadavg()],
        "cpu_ticks": host_cpu_ticks(),
    }
    if prev and result['cpu_ticks'] and prev.get('cpu_ticks'):
        delta = [(a - b) % (2 ** 32) for a, b in zip(result['cpu_ticks'], prev['cpu_ticks'])]
        if sum(delta):
            result['cpu_pct'] = round((1 - delta[2] / sum(delta)) * 100, 1)
    if prev and elapsed > 0:
        result["swapin_mb_s"] = round(max(0, result["swapins"] - prev["swapins"]) * page_size / 1048576 / elapsed, 2)
        result["swapout_mb_s"] = round(max(0, result["swapouts"] - prev["swapouts"]) * page_size / 1048576 / elapsed, 2)
    return result


def mb(value):
    return round(value / 1048576, 1)


def write_line(obj, kind=None, path=None):
    os.makedirs(LOG_DIR, exist_ok=True)
    path = path or os.path.join(LOG_DIR, "resource-%s.jsonl" % datetime.now().strftime("%Y%m%d"))
    try:
        if os.path.getsize(path) > MAX_BYTES:
            for i in range(ROTATE_KEEP, 0, -1):
                src = "%s.%d" % (path, i)
                dst = "%s.%d" % (path, i + 1)
                if os.path.exists(src):
                    if i == ROTATE_KEEP:
                        os.remove(src)
                    else:
                        os.replace(src, dst)
            os.replace(path, path + ".1")
    except OSError:
        pass
    with open(path, "a") as f:
        head = {"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "schema": 2}
        if kind:
            head["k"] = kind
        f.write(json.dumps({**head, **obj}, separators=(",", ":"), ensure_ascii=False) + "\n")


def prune():
    cutoff = time.time() - RETENTION_DAYS * 86400
    for root in (LOG_DIR, INCIDENT_DIR):
        try:
            for name in os.listdir(root):
                path = os.path.join(root, name)
                if os.path.isfile(path) and os.path.getmtime(path) < cutoff:
                    os.remove(path)
        except OSError:
            pass


def ps_snapshot():
    return run(["ps", "-Ao", "pid=,ppid=,rss=,vsz=,state=,nice=,time=,command="], timeout=20)[:200000]


def capture_handles(stamp, pids):
    """不用 root 也能拿到同用户进程当前打开的文件——这是定位「在写哪个文件」最直接的证据。"""
    for pid in pids[:6]:
        out = run(["lsof", "-n", "-P", "-p", str(pid), "-F", "n"], timeout=12)
        if not out:
            continue
        try:
            with open(os.path.join(INCIDENT_DIR, "%s.lsof-%d.log" % (stamp, pid)), "w") as f:
                f.write("\n".join(out.splitlines()[:4000]))
        except OSError:
            pass


def incident(state, records, reason):
    now = time.time()
    if now - incident.last < INCIDENT_COOLDOWN:
        return None
    incident.last = now
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    os.makedirs(INCIDENT_DIR, exist_ok=True)
    top_growth = sorted(records, key=lambda x: x.get("fpd", 0), reverse=True)[:30]
    top_mem = sorted(records, key=lambda x: x.get("fp", 0), reverse=True)[:30]
    data = {"schema": 2, "reason": reason, "system": state, "top_growth": top_growth,
            "top_footprint": top_mem,
            "top_cpu": sorted(records, key=lambda x: x.get("cpu") or 0, reverse=True)[:20],
            "top_write": sorted(records, key=lambda x: x.get("write_mb_s") or 0, reverse=True)[:20],
            "ps": ps_snapshot()}
    with open(os.path.join(INCIDENT_DIR, stamp + ".json"), "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    # 交给 root 抓路径的 PID 要按「谁真的在动」排序，而不是写入为 0 的占位进程。
    pids = []
    for r in [x for x in data["top_write"] if (x.get("write_mb_s") or 0) > 0] + [x for x in top_growth if x.get("fpd", 0) > 0] + top_mem + data["top_cpu"]:
        if r["pid"] not in pids:
            pids.append(r["pid"])
    trigger = {"id": stamp, "reason": reason,
               "pid": pids[0] if pids else None,
               "pids": pids[:8],
               "created": now, "incident": os.path.join(INCIDENT_DIR, stamp + ".json")}
    tmp = TRIGGER_PATH + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(trigger, f)
        os.replace(tmp, TRIGGER_PATH)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
    capture_handles(stamp, pids[:6])
    return stamp


incident.last = 0.0


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    prune()
    registry_path = os.path.join(LOG_DIR, "registry-%s.jsonl" % datetime.now().strftime("%Y%m%d"))
    registry = {}
    # 重启后读回当天登记表，避免每重启一次就把全表重写一遍。
    try:
        with open(registry_path) as f:
            for line in f:
                try:
                    o = json.loads(line)
                    registry[o["pid"]] = (o.get("start", 0), o.get("argv", ""))
                except (ValueError, KeyError):
                    continue
    except OSError:
        pass
    main.registry_day = registry_path
    previous = {}
    previous_system = None
    last = time.monotonic()
    last_full = 0.0
    last_prune = time.monotonic()
    write_line({"interval_s": INTERVAL, "tracked_regex": TRACK_RE.pattern,
                "rusage_flavor": SAMPLE, "mach_timebase": [_timebase.numer, _timebase.denom],
                "trigger_path": TRIGGER_PATH, "full_every_s": FULL_EVERY_S}, "start")
    while True:
        started = time.monotonic()
        if started - last_prune >= 3600:
            prune()
            last_prune = started
        elapsed = max(0.1, started - last)
        entries, ps_ok = process_list()
        if not ps_ok:
            # 采样被跳过时必须显式记录，否则表现为「日志莫名其妙变稀」。
            write_line({"reason": "ps timeout", "process_count_seen": len(entries)}, "warn")
        records = []
        interesting = []
        agg = {"count": 0, "footprint_mb": 0.0, "cpu_pct": 0.0, "threads": 0}
        # 登记表按天切换；旧实现启动一次就固定文件名，跨午夜会关联失败。
        registry_path = os.path.join(LOG_DIR, "registry-%s.jsonl" % datetime.now().strftime("%Y%m%d"))
        if getattr(main, "registry_day", None) != registry_path:
            registry = {}
            main.registry_day = registry_path
        for pid, ppid, argv in entries:
            info = usage(pid)
            if not info:
                continue
            old = previous.get(pid)
            write_mb_s = read_mb_s = cpu_pct = fp_delta = 0.0
            if old and old["start"] == info["start"]:
                write_mb_s = max(0, info["write"] - old["write"]) / 1048576 / elapsed
                read_mb_s = max(0, info["read"] - old["read"]) / 1048576 / elapsed
                cpu_pct = max(0, info["cpu_ns"] - old["cpu_ns"]) / 1e9 / elapsed * 100
                fp_delta = (info["footprint"] - old["footprint"]) / 1048576
            fp_mb = mb(info["footprint"])
            agg["count"] += 1
            agg["footprint_mb"] += fp_mb
            agg["cpu_pct"] += cpu_pct
            agg["threads"] += info["threads"] or 0
            tracked = bool(TRACK_RE.search(argv))
            # 命令行只在登记表里写一次，样本里只留可读名字，避免把日志写爆。
            reg = registry.get(pid)
            if reg is None or reg != (info["start"], argv):
                registry[pid] = (info["start"], argv)
                write_line({"pid": pid, "start": info["start"], "pp": ppid, "argv": argv,
                            "name": basename_of(argv)},
                           None, registry_path)
            # V4 可提供同用户进程的 I/O；无权读取的系统进程仍不包含在此表内。
            record = {
                "pid": pid, "pp": ppid, "n": basename_of(argv),
                "start": str(info["start"]),
                "fp": fp_mb, "rss": mb(info["resident"]), "fpd": round(fp_delta, 1),
                "cpu": round(cpu_pct, 1) if old and old["start"] == info["start"] else None,
                "read_mb_s": round(read_mb_s, 4) if old and old["start"] == info["start"] else None,
                "write_mb_s": round(write_mb_s, 4) if old and old["start"] == info["start"] else None,
                "th": info["threads"], "rt": info["running_threads"],
                "fd": info["open_files"], "ni": info["nice"],
                "pi": info["pageins"], "imx": mb(info["interval_max"]),
            }
            record["_argv"] = argv if tracked else ""
            interesting.append(record)
            record["_keep"] = (tracked or fp_mb >= MIN_FOOTPRINT_MB
                               or abs(fp_delta) >= MIN_FOOTPRINT_DELTA_MB
                               or cpu_pct >= MIN_CPU_PCT
                               or write_mb_s >= MIN_WRITE_MB_S or read_mb_s >= MIN_READ_MB_S)
            previous[pid] = info
        # 除阈值命中外，始终保留占用/写入/CPU 的前若干名，避免小进程突然抬头被漏掉。
        for key, top_n in (("fp", 15), ("fpd", 15), ("cpu", 10), ("write_mb_s", 10)):
            for r in sorted(interesting, key=lambda x: x[key] or 0, reverse=True)[:top_n]:
                r["_keep"] = True
        records = [r for r in interesting if r["_keep"]]
        # 清掉已退出进程，避免长跑时字典无限增长。
        if len(previous) > 4000:
            alive = {pid for pid, _, _ in entries}
            previous = {k: v for k, v in previous.items() if k in alive}
        last = started
        state = system_state(previous_system, elapsed)
        previous_system = state
        now = time.monotonic()
        full = (now - last_full) >= FULL_EVERY_S
        if full:
            last_full = now
        agg["seen_count"] = len(entries)
        agg["denied_or_exited"] = len(entries) - agg["count"]
        write_line({"dt": round(elapsed, 1), "agg": {k: round(v, 1) if isinstance(v, float) else v
                                                     for k, v in agg.items()},
                    "sys": state,
                    "procs": [{k: v for k, v in r.items() if not k.startswith("_")} for r in records],
                    "full": [{k: v for k, v in r.items() if not k.startswith("_")} for r in interesting]
                    if full else None}, "sample")
        swap_pct = (state["swap_used_mb"] / state["swap_total_mb"] * 100
                    if state.get("swap_total_mb") else 0)
        reasons = []
        if state.get("pressure", 0) >= 2:
            reasons.append("pressure=%d" % state["pressure"])
        if swap_pct >= SWAP_TRIGGER_PCT:
            reasons.append("swap=%.0f%%" % swap_pct)
        if state["load"][0] >= LOAD_TRIGGER:
            reasons.append("load=%.1f" % state["load"][0])
        if state.get("swapin_mb_s", 0) >= 8 or state.get("swapout_mb_s", 0) >= 8:
            reasons.append("swapio=%.1f/%.1f" % (state.get("swapin_mb_s", 0), state.get("swapout_mb_s", 0)))
        disk_mb_s = (state.get("disk") or {}).get("mb_s") or 0
        if disk_mb_s >= DISK_TRIGGER_MB_S:
            reasons.append("disk=%.0fMB/s" % disk_mb_s)
        writers = sorted(interesting, key=lambda x: x.get("write_mb_s") or 0, reverse=True)
        if writers and (writers[0].get("write_mb_s") or 0) >= 0.25:
            reasons.append("pid_write=%d:%.2fMB/s" % (writers[0]["pid"], writers[0]["write_mb_s"]))
        if reasons and elapsed >= 10 and os.environ.get("MICA_RESOURCE_DISABLE_INCIDENTS") != "1":
            view = [{"argv": r.get("_argv", ""),
                     **{k: v for k, v in r.items() if not k.startswith("_")}} for r in interesting]
            stamp = incident(state, view, ",".join(reasons))
            if stamp:
                write_line({"incident": stamp, "reason": ",".join(reasons)}, "incident")
        if os.environ.get("MICA_RESOURCE_ONCE") == "1":
            return
        time.sleep(max(1, INTERVAL - (time.monotonic() - started)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

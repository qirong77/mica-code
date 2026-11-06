#!/usr/bin/env python3
"""Small native-interface regression check: CPU units and V4 I/O, no system-wide tracing."""
import importlib.util
import json
import os
import tempfile
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("resource_collector", Path(__file__).with_name("mica-resource-watch.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

before = collector.usage(os.getpid())
t0 = time.process_time()
while time.process_time() - t0 < 0.03:
    pass
expected = time.process_time() - t0
after = collector.usage(os.getpid())
measured = (after["cpu_ns"] - before["cpu_ns"]) / 1e9
assert 0.7 <= measured / expected <= 1.3, (measured, expected)
assert after["footprint"] > 0
with tempfile.TemporaryDirectory(prefix="mica-perf-check-") as root:
    with open(os.path.join(root, "write-check.bin"), "wb") as f:
        f.write(b"x" * (2 * 1024 * 1024))
        f.flush()
        os.fsync(f.fileno())
    written = collector.usage(os.getpid())["write"] - after["write"]
    assert written >= 2 * 1024 * 1024, written
print(json.dumps({"cpu_seconds": round(measured, 4), "reference_seconds": round(expected, 4),
                  "write_bytes": written, "rusage_flavor": collector.SAMPLE,
                  "mach_ns_per_tick": collector.TIMEBASE_NS}))

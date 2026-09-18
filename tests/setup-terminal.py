"""Optional POSIX terminal smoke test: python3 tests/setup-terminal.py."""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="wall-setup-") as directory:
    master, slave = pty.openpty()
    target = Path(directory) / ".env.local"
    code = f'import {{setup}} from {json.dumps((root / "local/setup.mjs").as_uri())}; await setup({{file:{json.dumps(str(target))}}});'
    child = subprocess.Popen(
        ["node", "--input-type=module", "-e", code],
        stdin=slave, stdout=slave, stderr=slave,
        env={key: value for key, value in os.environ.items() if key != "BFL_API_KEY"},
    )
    os.close(slave)
    output = b""
    sent = False
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output += os.read(master, 8192)
                except OSError:
                    break
            if b"key will stay hidden" in output and not sent:
                os.write(master, b"terminal-test-not-a-real-key\n")
                sent = True
            if child.poll() is not None:
                break
        assert child.wait(timeout=3) == 0, "Setup did not finish"
        assert b"terminal-test-not-a-real-key" not in output, "Key leaked into terminal output"
        assert "BFL_API_KEY=terminal-test-not-a-real-key" in target.read_text()
        print("PASS: pasted key saved, never echoed to the terminal")
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)

"""Test-only outer terminal for exercising macOS script (which requires a TTY)."""
import errno
import os
import pty
import select
import signal
import sys
import time

send_secret = sys.argv[1] == "secret"
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])

seen = b""
deadline = time.monotonic() + 8
try:
    while True:
        if time.monotonic() > deadline:
            os.killpg(pid, signal.SIGKILL)
            raise RuntimeError("PTY test timed out")
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                break
            raise
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        seen = (seen + data)[-256:]
        if send_secret and b"READY" in seen:
            os.write(master, b"fake-secret-DO-NOT-CAPTURE\n")
            send_secret = False
finally:
    os.close(master)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)

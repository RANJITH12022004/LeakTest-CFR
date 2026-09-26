#!/usr/bin/env python3
"""Deploy audit-trail fixes to production Pi via SSH (password auth)."""
import os
import sys
import time
import paramiko

HOST = os.environ.get("PI_HOST", "100.90.98.85")
USER = os.environ.get("PI_USER", "rle")
PASSWORD = os.environ.get("PI_PASSWORD", "rle")
KIOSK = "/opt/kiosk"
FILES = ["app.py", "audit_service.py", "script.js"]
WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(ssh, cmd, timeout=120):
    print(f"$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    code = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print(err.rstrip(), file=sys.stderr)
    if code != 0:
        raise RuntimeError(f"Command failed ({code}): {cmd}")
    return out


def main():
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = f"{KIOSK}/backups/audit-fix-{stamp}"

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"Connecting to {USER}@{HOST} ...")
    ssh.connect(HOST, username=USER, password=PASSWORD, timeout=20, look_for_keys=False, allow_agent=False)
    sftp = ssh.open_sftp()

    run(ssh, f"sudo mkdir -p '{backup}'")
    for name in FILES:
        src = os.path.join(WORKSPACE, name)
        if not os.path.isfile(src):
            raise FileNotFoundError(src)
        remote_tmp = f"/tmp/{name}.deploy"
        sftp.put(src, remote_tmp)
        run(ssh, f"test -f '{KIOSK}/{name}' && sudo cp '{KIOSK}/{name}' '{backup}/{name}' || true")
        run(ssh, f"sudo mv '{remote_tmp}' '{KIOSK}/{name}' && sudo chown root:root '{KIOSK}/{name}'")

    run(ssh, "sudo systemctl restart kiosk-bridge.service")
    time.sleep(2)
    run(ssh, "sudo systemctl is-active kiosk-bridge.service")
    sftp.close()
    ssh.close()
    print(f"Deploy OK. Backup: {backup}")


if __name__ == "__main__":
    main()

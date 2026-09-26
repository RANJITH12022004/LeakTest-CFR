#!/usr/bin/env python3
"""Smoke-test login audit logging against a running kiosk API."""
import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def get(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {}, method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def main():
    # Wrong password attempt (unknown or known user)
    try:
        post("/api/data/auth/login", {"username": "audit_test_user", "password": "wrong-password"})
    except urllib.error.HTTPError as e:
        print("login denied as expected:", e.code)

    print("Manual check: open Audit Trails and confirm Login denied rows show username, role, and userID in Details.")


if __name__ == "__main__":
    main()

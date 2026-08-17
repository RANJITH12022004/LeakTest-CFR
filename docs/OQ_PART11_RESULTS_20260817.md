# TD-2B 21 CFR Part 11 OQ Results

**Execution date:** 2026-08-17T14:38:02.574940
**API base:** http://127.0.0.1:5000

## Summary

- **Pass:** 69
- **Fail:** 12
- **N/A:** 9
- **Overall:** Non-Compliant

## Test accounts

| User ID | Role | Password (post-setup) |
|---------|------|------------------------|
| OQADM1 | Admin | Oq@Chg1234! |
| OQREV1 | Supervisor | Oq@Chg1234! |
| OQQAA1 | QA | Oq@Chg1234! |
| OQUSR1 | User | Oq@Chg1234! |

## Results matrix

| Test ID | Description | Role | Result | Evidence | Remark |
|---------|-------------|------|--------|----------|--------|
| FAC-01 | Factory caps 10 users / 10 admins / 10 reviewers / 10 QA | Factory | Pass | maxUsers=10 maxAdmins=10 maxSupervisors=10 maxQa=10 |  |
| OQ-UM-01 | Administrator Creation | OQADM1 | Pass | member id=5 |  |
| OQ-UM-03 | Reviewer Creation | OQADM1 | Pass | member id=6 |  |
| OQ-UM-05 | User Creation | OQADM1 | Pass | member id=7 |  |
| OQ-UM-07 | QA Creation | OQADM1 | Pass | member id=8 |  |
| OQ-UM-02 | Administrator Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-04 | Reviewer Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-06 | User Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-08 | QA Disabling | OQADM1 | Pass | login HTTP 403 |  |
| OQ-UM-09 | User Profile Edit Restriction | OQUSR1 | Pass | HTTP 403 |  |
| OQ-UM-AT | Audit Trail Check — User Management | OQREV1 | Pass |  |  |
| OQ-RP-01 | Individual Function Assignment | OQADM1 | Pass | HTTP 200 |  |
| OQ-RP-02 | Assignment Restricted to Authorised Role | OQUSR1 | Pass | HTTP 403 |  |
| OQ-RP-03 | Individual Power Enforcement | OQUSR1 | Pass | recipe=403 members=403 audit=403 datetime=403 |  |
| OQ-RP-AT | Audit Trail Check — Permission Configuration | OQADM1 | Pass |  |  |
| OQ-SEC-01 | Password Change — Administrator | OQADM1 | Pass | HTTP 200 |  |
| OQ-SEC-02 | Password Change — Reviewer | OQREV1 | Pass | HTTP 200 |  |
| OQ-SEC-03 | Password Change — User | OQUSR1 | Pass | HTTP 200 |  |
| OQ-SEC-04 | Password Change — QA | OQQAA1 | Pass | HTTP 200 |  |
| OQ-SEC-05 | Mandatory Password Change on First Login | New users | Pass |  | Verified during OQ user setup (mustChangePassword flow) |
| OQ-SEC-06 | Multiple Wrong Password Attempts | OQUSR1 | Pass |  |  |
| OQ-SEC-07 | Account Unlocking | OQADM1 | Pass |  |  |
| OQ-SEC-07 | Account Unlocking (non-admin denied) | OQUSR1 | Pass |  | negative unlock |
| OQ-SEC-08 | Password Policy Enforcement | OQADM1 | Pass |  |  |
| OQ-SEC-AT | Audit Trail Check — Security | OQADM1 | Pass |  |  |
| OQ-RC-01 | SP / Recipe Creation | OQUSR1 | Pass | id=10 |  |
| OQ-RC-02 | SP / Recipe Pending-Approval State | System | Pass | pending |  |
| OQ-RC-03 | Segregation of Duties — Creator Cannot Self-Approve | OQRC3 | Pass | HTTP 403 |  |
| OQ-RC-04 | SP / Recipe Approval | OQREV1 | Pass |  |  |
| OQ-RC-05 | SP / Recipe Rejection | OQREV1 | Pass | HTTP 200 |  |
| OQ-RC-06 | SP / Recipe Edit Restriction | OQUSR1 | Pass | pending |  |
| OQ-RC-AT | Audit Trail Check — SP/Recipe | OQREV1 | Pass |  |  |
| OQ-TE-HW | Adapter check before live taps | OQUSR1 | Pass | HTTP 200 mode=spd1 |  |
| OQ-TE-01 | Quick Test Execution | OQUSR1 | Fail | tap/start HTTP 400 Timeout |  |
| OQ-TE-02 | SP / Recipe Test Execution | OQUSR1 | Pass |  |  |
| OQ-TE-AT | Audit Trail Check — Test Execution | OQREV1 | Pass |  |  |
| OQ-WF-01 | Pre-Approval Printout / Preview | OQUSR1 | Pass |  | operator stuck on preview |
| OQ-WF-06 | Final Report Only Post-Approval (pending blocked) | System | Pass | HTTP 403 |  |
| OQ-WF-02 | Approval Method — User ID & Password | OQREV1 | Fail | HTTP 409 login=no |  |
| OQ-WF-04 | Approval of a PASS Result | OQREV1 | Fail |  |  |
| OQ-WF-06 | Final Report Generated Post-Approval | System | Fail |  | HTTP fallback |
| OQ-WF-05 | Approval of a FAIL Result | OQREV1 | Pass | HTTP 200 |  |
| OQ-WF-03 | Approval Method — Biometric / Fingerprint | OQREV1 | N/A |  | sensor identify did not succeed (Timed out waiting for finger) |
| OQ-WF-AT | Audit Trail Check — Approval | OQREV1 | Pass |  | A preview; B token (no approver login); PDF on token |
| OQ-PF-01 | Power Interruption During Active Test | User | N/A |  | Hardware mains switch |
| OQ-PF-02 | Power Restoration & Status on Re-Login | User | N/A |  | Hardware |
| OQ-PF-03 | Auto-Abort of Interrupted Test | System | Pass | smoke_powercut_checkpoint.py |  |
| OQ-PF-04 | Auto-Save & Auto-Approval on Power Failure | System | Pass |  | Auto-Approved – Power Failure |
| OQ-PF-AT | Audit Trail Check — Power Failure | Reviewer/QA | Fail |  |  |
| OQ-SYS-01 | Real-Time Clock (RTC) Setting | OQADM1 | Pass | HTTP 200 |  |
| OQ-SYS-02 | Date/Time Retention After Power Cycle | Administrator | N/A |  | Hardware power cycle |
| OQ-SYS-AT | Audit Trail Check — Date/Time Edit | OQADM1 | Fail |  |  |
| OQ-CV-01 | Instrument Calibration | Administrator | N/A |  | Metrological / placeholder UI |
| OQ-CV-02 | Instrument Validation | Administrator | Fail | verify_audit_trail partial |  |
| OQ-CV-03 | Calibration / Validation Restricted to Administrator | OQUSR1 | Pass | HTTP 403 |  |
| OQ-CV-04 | USB1 Port Validation | Administrator | N/A |  | No dedicated validation screen |
| OQ-CV-05 | USB2 Port Validation | Administrator | N/A |  | No dedicated validation screen |
| OQ-CV-AT | Audit Trail & Report Check — Calibration/Validation | Reviewer/QA | Pass |  |  |
| OQ-RPT-01 | Report Generation | User | Pass |  | reports created in §5/§6 |
| OQ-RPT-02 | Thermal Printer Output | User | Fail |  | no live ESP report id |
| OQ-RPT-06 | Historical Report Reprint | Authorised User | Fail |  | no live report |
| OQ-RPT-07 | Reprinted Report Data Accuracy | Reviewer/QA | Fail |  | no live report |
| OQ-RPT-03 | Dot Matrix Printer Output | User | N/A |  | A4 skipped |
| OQ-RPT-04 | Report Export | Authorised User | N/A |  | USB export hardware |
| OQ-RPT-05 | Role-Based Report Access | User | Pass | admin=7 user=7 own=True |  |
| OQ-RPT-AT | Audit Trail Check — Reporting | Reviewer/QA | Fail |  |  |
| OQ-CARD-01 | perm_test_access | OQPERM1 | Pass | checkpoint=200 members=403 audit=403 |  |
| OQ-CARD-02 | perm_test_report_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-03 | perm_recipe_manage | OQPERM1 | Pass | HTTP 201 |  |
| OQ-CARD-04 | perm_recipe_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-05 | perm_profile_admin | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-06 | perm_validation_test | OQPERM1 | Pass | HTTP 401 Unauthorized |  |
| OQ-CARD-07 | perm_validation_report_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-08 | perm_datetime | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-09 | perm_reports_view | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-10 | perm_audit_view | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-11 | perm_export_usb | OQPERM1 | Pass | HTTP 200 |  |
| OQ-CARD-12 | perm_export_approve | OQPERM1 | Pass | token |  |
| OQ-CARD-NEG | reports_view cannot set datetime or view audit | OQPERM1 | Pass | datetime=403 audit=403 |  |
| IP-01 | IP Configure network addresses | OQADM1 | Pass | {'lan': '192.168.1.100', 'ok': True, 'refreshedAt': '2026-08-17T09:07:53Z', 'wlan': '192.168.1.65'} |  |
| OQ-AT-01 | Administrator Audit Trail Access | OQADM1 | Pass | HTTP 200 |  |
| OQ-AT-02 | Reviewer Audit Trail Access | OQREV1 | Pass | HTTP 200 |  |
| OQ-AT-03 | QA Audit Trail Access | OQQAA1 | Pass | HTTP 200 |  |
| OQ-AT-04 | User Audit Trail Restriction | OQUSR1 | Pass | HTTP 403 |  |
| OQ-AT-05 | Audit Trail Integrity | System | Pass |  | No delete route; append-only SQLite |
| OQ-AT-06 | Completeness Check | Reviewer/QA | Fail | Login; Logout; User update; Approval verification; User permissions updated; Recipe created; Quick test started; Password reset; Added new user; Audit log viewed; Report approved; Report PDF generated; Quick test performed; Report preview viewed; Recipe rejected; Recipe approved; Recipe edited; Password changed; Login failed; Profile updated; User unlocked; Power interruption; Power interruption logout; Report aborted (power loss); Validation started; Validation aborted; check adaptor and holder; Entered USP 1 validation; holder error; Validation finished; Test aborted; Test finished; Exited screen; Opened Load Recipe; Test started; Opened Quick Test; Entered screen; Test auto-aborted; Loaded recipe; User enabled | missing: Print thermal |
| OQ-NG-01 | User Attempting Administrator Function | OQUSR1 | Pass |  |  |
| OQ-NG-02 | Reviewer Attempting Administrator Function | OQREV1 | Pass |  |  |
| OQ-NG-03 | User Attempting SP/Recipe Approval | OQUSR1 | Pass |  | no recipe-approve permission |
| OQ-NG-04 | Disabled User Login Attempt | OQUSR2 | Pass | HTTP 403 |  |

## Deviations (Fail only)

- **OQ-TE-01** — Quick Test Execution: tap/start HTTP 400 Timeout
- **OQ-WF-02** — Approval Method — User ID & Password: HTTP 409 login=no
- **OQ-WF-04** — Approval of a PASS Result: 
- **OQ-WF-06** — Final Report Generated Post-Approval: HTTP fallback
- **OQ-PF-AT** — Audit Trail Check — Power Failure: 
- **OQ-SYS-AT** — Audit Trail Check — Date/Time Edit: 
- **OQ-CV-02** — Instrument Validation: verify_audit_trail partial
- **OQ-RPT-02** — Thermal Printer Output: no live ESP report id
- **OQ-RPT-06** — Historical Report Reprint: no live report
- **OQ-RPT-07** — Reprinted Report Data Accuracy: no live report
- **OQ-RPT-AT** — Audit Trail Check — Reporting: 
- **OQ-AT-06** — Completeness Check: missing: Print thermal

## Audit completeness (distinct actions)

- Login
- Logout
- User update
- Approval verification
- User permissions updated
- Recipe created
- Quick test started
- Password reset
- Added new user
- Audit log viewed
- Report approved
- Report PDF generated
- Quick test performed
- Report preview viewed
- Recipe rejected
- Recipe approved
- Recipe edited
- Password changed
- Login failed
- Profile updated
- User unlocked
- Power interruption
- Power interruption logout
- Report aborted (power loss)
- Validation started
- Validation aborted
- check adaptor and holder
- Entered USP 1 validation
- holder error
- Validation finished
- Test aborted
- Test finished
- Exited screen
- Opened Load Recipe
- Test started
- Opened Quick Test
- Entered screen
- Test auto-aborted
- Loaded recipe
- User enabled
- User disabled
- Factory settings updated
- IP addresses viewed
- Holder check error
- System date change

## Smoke script outputs

### smoke_profile_enable_unlock.py
```
  OK   admin login
  OK   enable/unlock blocked without session (HTTP 403)
  OK   enable succeeded for OQADM2
  FAIL audit missing recent 'User enabled' entry
  OK   session cleared after logout

Passed: 4  Failed: 1

```

### verify_audit_trail.py
```
=== Audit trail verification ===
API: http://127.0.0.1:5000
User: OQADM1

  OK   Login
  OK   Report created id=11
  OK   Quick test performed audit on report save
  OK   Logout (manual) recorded on live API
  FAIL In-process login HTTP 403
Traceback (most recent call last):
  File "/opt/kiosk/scripts/verify_audit_trail.py", line 582, in <module>
    sys.exit(main())
             ~~~~^^
  File "/opt/kiosk/scripts/verify_audit_trail.py", line 544, in main
    verify_hardware_routes(c, res, since_ms)
    ~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^
  File "/opt/kiosk/scripts/verify_audit_trail.py", line 445, in verify_hardware_routes
    check = c.adapter_check()
  File "/opt/kiosk/scripts/verify_audit_trail.py", line 168, in adapter_check
    r = self._request("POST", "/api/hardware/adapter/check")
  File "/opt/kiosk/scripts/verify_audit_trail.py", line 111, in _request
    with urllib.request.urlopen(req, timeout=30) as resp:
         ~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.13/urllib/request.py", line 189, in urlopen
    return opener.open(url, data, timeout)
           ~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.13/urllib/request.py", line 489, in open
    response = self._open(req, data)
  File "/usr/lib/python3.13/urllib/request.py", line 506, in _open
    result = self._call_chain(self.handle_open, protocol, protocol +
                              '_open', req)
  File "/usr/lib/python3.13/urllib/request.py", line 466, in _call_chain
    result = func(*args)
  File "/usr/lib/python3.13/urllib/request.py", line 1348, in http_open
    return self.do_open(http.client.HTTPConnection, req)
           ~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.13/urllib/request.py", line 1323, in do_open
    r = h.getresponse()
  File "/usr/lib/python3.13/http/client.py", line 1430, in getresponse
    response.begin()
    ~~~~~~~~~~~~~~^^
  File "/usr/lib/python3.13/http/client.py", line 331, in begin
    version, status, reason = self._read_status()
                              ~~~~~~~~~~~~~~~~~^^
  File "/usr/lib/python3.13/http/client.py", line 300, in _read_status
    raise RemoteDisconnected("Remote end closed connection without"
                             " response")
http.client.RemoteDisconnected: Remote end closed connection without response

```

### smoke_powercut_checkpoint.py
```
  OK   checkpoint saved with durationSeconds=94
  OK   isolated STORAGE_DIR (mirror optional)
  OK   isolated STORAGE_DIR skip 0-byte USB wipe recovery
  OK   reconstructed start≠end with duration=94 (start=2026-08-17T09:05:08.352857Z, end=2026-08-17T09:06:42.352857Z)
  OK   checkpoint detected as mid-test
  OK   power-cut report saved id=6 duration=94s start≠end
  OK   checkpoint cleared after recovery
  OK   audit: Power interruption
  OK   audit: Power interruption logout

Passed: 9  Failed: 0
[2026-08-17 14:36:43,904] WARNING in app: Ignoring stale clean-stop flag; mid-test checkpoint present — treating as unclean shutdown

```

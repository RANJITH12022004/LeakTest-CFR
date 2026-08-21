/**
 * validation_vd.js — Vacuum Decay validation flow (input page + live run)
 */
(function () {
    'use strict';

    window._vdValidationParams = null;
    window.validationRunElapsedSec = 0;
    window.validationRunHoldStarted = false;
    window.validationRunCurrentVacuumMmHg = null;
    window.validationRunDurationSec = null;

    function isVdValidationMode() {
        return lastValidationType === 'distance' && !!window._vdValidationParams;
    }

    window.getFactoryMaxVacuumMmHg = function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            if (stored) {
                var s = JSON.parse(stored);
                var v = parseInt(s.maxVacuumMmHg, 10);
                if (!isNaN(v) && v >= 1 && v <= 650) return v;
            }
        } catch (e) {}
        return 650;
    };

    window.parseMmSs = function (str) {
        var s = String(str || '').trim();
        if (!s) return null;
        var parts = s.split(':');
        if (parts.length !== 2) return null;
        var mins = parseInt(parts[0], 10);
        var secs = parseInt(parts[1], 10);
        if (isNaN(mins) || isNaN(secs) || mins < 0 || secs < 0 || secs > 59) return null;
        var total = mins * 60 + secs;
        return total > 0 ? total : null;
    };

    window.formatMmSs = function (totalSeconds) {
        var t = Math.max(0, parseInt(totalSeconds, 10) || 0);
        var m = Math.floor(t / 60);
        var s = t % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };

    /** Auto-insert ':' while typing mm:ss (e.g. 0130 → 01:30). */
    window.applyMmSsAutoColon = function (el) {
        if (!el) return;
        var digits = String(el.value || '').replace(/\D/g, '').slice(0, 4);
        var formatted = digits.length <= 2
            ? digits
            : (digits.slice(0, 2) + ':' + digits.slice(2));
        if (el.value !== formatted) {
            el.value = formatted;
            try {
                if (typeof el.setSelectionRange === 'function') {
                    var pos = formatted.length;
                    el.setSelectionRange(pos, pos);
                }
            } catch (e) { /* ignore */ }
        }
    };

    function setVdInputError(msg) {
        var el = document.getElementById('vd-val-input-error');
        if (!el) return;
        if (msg) {
            el.textContent = msg;
            el.style.display = 'block';
        } else {
            el.textContent = '';
            el.style.display = 'none';
        }
    }

    window.confirmVdValidationInput = function () {
        var vacEl = document.getElementById('vd-val-vacuum-mmhg');
        var timeEl = document.getElementById('vd-val-time');
        var maxVac = getFactoryMaxVacuumMmHg();
        var vacuum = parseFloat(vacEl && vacEl.value ? vacEl.value : '');
        var durationSec = parseMmSs(timeEl && timeEl.value ? timeEl.value : '');
        if (isNaN(vacuum) || vacuum < 1) {
            setVdInputError('Enter a valid vacuum value (mmHg).');
            return;
        }
        if (vacuum > maxVac) {
            setVdInputError('Vacuum cannot exceed factory maximum of ' + maxVac + ' mmHg.');
            return;
        }
        if (!durationSec) {
            setVdInputError('Enter a valid time in mm:ss format (e.g. 01:30).');
            return;
        }
        setVdInputError('');
        window._vdValidationParams = {
            vacuumMmHg: vacuum,
            durationSec: durationSec,
            durationDisplay: formatMmSs(durationSec)
        };
        showAppModal('Please use pressure gauge', 'Instruction', function () {
            goToPage('validation-run');
        });
    };

    function setValidationRunLayoutMode(vdMode) {
        var vdPanel = document.getElementById('val-run-vd-panel');
        var pdPanel = document.getElementById('val-run-pd-panel');
        if (vdPanel) vdPanel.style.display = vdMode ? '' : 'none';
        if (pdPanel) pdPanel.style.display = vdMode ? 'none' : '';
        document.querySelectorAll('.val-run-vd-only').forEach(function (el) {
            el.style.display = vdMode ? '' : 'none';
        });
        document.querySelectorAll('.val-run-pd-only').forEach(function (el) {
            el.style.display = vdMode ? 'none' : '';
        });
    }

    var _origInitValidationRunPage = window.initValidationRunPage;
    window.initValidationRunPage = function () {
        if (isVdValidationMode()) {
            var p = window._vdValidationParams;
            validationRunDurationSec = p.durationSec;
            VALIDATION_RUN_DURATION_SEC = p.durationSec;
            validationRunElapsedSec = 0;
            validationRunHoldStarted = false;
            validationRunCurrentVacuumMmHg = null;
            setValidationRunLayoutMode(true);
            setValRunEl('val-run-usp', 'Vacuum');
            setValRunEl('val-run-set-vacuum', String(p.vacuumMmHg));
            setValRunEl('val-run-set-time', p.durationDisplay);
            setValRunEl('val-run-set-vacuum-live', String(p.vacuumMmHg));
            setValRunEl('val-run-set-time-live', p.durationDisplay);
            setValRunEl('val-run-current-vacuum', '--');
            setValRunEl('val-run-elapsed-time', '00:00');
            setValRunEl('val-run-status', 'Ready');
            setValRunEl('val-run-status-sub', 'Press Start to begin');
            _setValRunStatusStyle('ready');
            _setValResultVisible(false);
            validationRunCurrentCount = 0;
            validationRunState = 'idle';
            validationRunBackendPending = false;
            validationRunSecondsRemaining = p.durationSec;
            applyValidationRunLockUi(false);
            if (validationRunIntervalId != null) {
                clearInterval(validationRunIntervalId);
                validationRunIntervalId = null;
            }
            _resetValidationRunActionButtonToStart();
            return;
        }
        setValidationRunLayoutMode(false);
        if (typeof _origInitValidationRunPage === 'function') _origInitValidationRunPage();
    };

    function parseVdSseLine(data) {
        var raw = String(data.normalized != null ? data.normalized : data.line || '');
        var norm = raw.replace(/^#/, '').replace(/\*$/, '');
        var out = {};
        if (norm.indexOf(':') >= 0 && norm.indexOf(',') < 0) {
            var head = norm.split(':');
            out[head[0].trim().toLowerCase()] = head.slice(1).join(':').trim();
        }
        norm.split(',').forEach(function (part) {
            var kv = part.split(':');
            if (kv.length >= 2) {
                out[kv[0].trim().toLowerCase()] = kv.slice(1).join(':').trim();
            }
        });
        return out;
    }

    var _origValidationRunHardwareMessage = window.validationRunHardwareMessage;
    window.validationRunHardwareMessage = function (ev) {
        if (!isVdValidationMode()) {
            if (typeof _origValidationRunHardwareMessage === 'function') {
                return _origValidationRunHardwareMessage(ev);
            }
            return;
        }
        if (validationRunState !== 'running') return;
        try {
            var raw = ev.data;
            if (raw == null || raw === '') return;
            var data = JSON.parse(raw);
            if (data.ping) return;
            var kind = String(data.kind || '');
            var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/^#/, '').replace(/\*$/, '');
            var parsed = parseVdSseLine(data);
            var pressureVal = parsed.su != null ? parsed.su : (parsed.vacuum != null ? parsed.vacuum : parsed.pressure);
            if (pressureVal != null) {
                var v = parseFloat(pressureVal);
                if (!isNaN(v)) _applyVdLivePressure(v);
            }
            if (norm === 'target_reached' || norm.indexOf('target_reached') >= 0) {
                _startVdHoldAfterTarget();
            }
            // Pi owns hold timer and sends #STOP — do not complete on ESP #IDLE.
            if (kind === 'error' || kind === 'adapter_error') {
                if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
                if (validationRunIntervalId != null) {
                    clearInterval(validationRunIntervalId);
                    validationRunIntervalId = null;
                }
                validationRunState = 'idle';
                stopValidationOnBackend().catch(function () {});
                _closeValidationRunHardwareEs();
                _resetValidationRunActionButtonToStart();
                showAppModal('Hardware error during validation: ' + (norm || 'Unknown'), 'Validation');
            }
        } catch (ex) { /* ignore */ }
    };

    function _stopVdPressurePoll() {
        if (window._vdPressurePollId != null) {
            clearInterval(window._vdPressurePollId);
            window._vdPressurePollId = null;
        }
    }
    window._stopVdPressurePoll = _stopVdPressurePoll;

    function _applyVdLivePressure(v) {
        if (v == null || isNaN(v)) return;
        validationRunCurrentVacuumMmHg = v;
        setValRunEl('val-run-current-vacuum', Number(v).toFixed(1));
        if (validationRunHoldStarted || validationRunState !== 'running') return;
        var target = window._vdValidationParams && window._vdValidationParams.vacuumMmHg;
        if (target == null || isNaN(parseFloat(target))) return;
        target = parseFloat(target);
        if (window._vdStartPressureMmHg == null) {
            window._vdStartPressureMmHg = v;
            return;
        }
        var startP = window._vdStartPressureMmHg;
        var crossed = (startP > target && v <= target) || (startP < target && v >= target);
        if (crossed) _startVdHoldAfterTarget();
    }

    function _startVdPressurePoll() {
        _stopVdPressurePoll();
        window._vdPressurePollId = setInterval(function () {
            if (validationRunState !== 'running') return;
            if (typeof apiRequest !== 'function') return;
            apiRequest(API_BASE + '/api/hardware/status', { method: 'GET' }).then(function (res) {
                if (!res || res.ok === false) return;
                var raw = res.pressureMmHg != null ? res.pressureMmHg : res.pressure;
                var v = parseFloat(raw);
                if (!isNaN(v)) _applyVdLivePressure(v);
            }).catch(function () { /* ignore */ });
        }, 1000);
    }

    function _maybeStartVdHold(vacuumVal) {
        if (validationRunHoldStarted || validationRunState !== 'running') return;
        var target = window._vdValidationParams && window._vdValidationParams.vacuumMmHg;
        if (target == null || isNaN(parseFloat(target))) return;
        if (vacuumVal < parseFloat(target)) return;
        _startVdHoldAfterTarget();
    }

    function _startVdHoldAfterTarget() {
        if (validationRunHoldStarted || validationRunState !== 'running') return;
        if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
        validationRunHoldStarted = true;
        validationRunElapsedSec = 0;
        setValRunEl('val-run-elapsed-time', '00:00');
        setValRunEl('val-run-status', 'Holding vacuum');
        setValRunEl('val-run-status-sub', 'Hold in progress');
        if (validationRunIntervalId != null) clearInterval(validationRunIntervalId);
        validationRunIntervalId = setInterval(validationRunTimerTick, 1000);
    }

    var _origValidationRunTimerTick = window.validationRunTimerTick;
    window.validationRunTimerTick = function () {
        if (!isVdValidationMode()) {
            if (typeof _origValidationRunTimerTick === 'function') return _origValidationRunTimerTick();
            return;
        }
        if (!validationRunHoldStarted) return;
        validationRunElapsedSec++;
        setValRunEl('val-run-elapsed-time', formatMmSs(validationRunElapsedSec));
        if (validationRunElapsedSec >= validationRunDurationSec) {
            if (validationRunIntervalId != null) {
                clearInterval(validationRunIntervalId);
                validationRunIntervalId = null;
            }
            completeValidationRunAfterDuration();
        }
    };

    var _origStartValidationOnBackend = window.startValidationOnBackend;
    window.startValidationOnBackend = function () {
        if (!isVdValidationMode()) {
            if (typeof _origStartValidationOnBackend === 'function') {
                return _origStartValidationOnBackend();
            }
            return Promise.resolve({ ok: true });
        }
        var p = window._vdValidationParams;
        function _vdVacuumStartRequest() {
            return apiRequest(API_BASE + '/api/hardware/validation/vacuum/start', {
                method: 'POST',
                body: { vacuumMmHg: p.vacuumMmHg, durationSec: p.durationSec }
            });
        }
        return apiRequest(API_BASE + '/api/health').then(function (health) {
            if (!health || health.vacuumValidation !== true) {
                return Promise.reject(new Error(
                    'Server is running old code. Close the Flask terminal, run run_dev.bat, then refresh the page (Ctrl+F5).'
                ));
            }
            return _vdVacuumStartRequest();
        }).catch(function (err) {
            var msg = err && err.message ? String(err.message) : '';
            if (msg.toUpperCase().indexOf('METHOD NOT ALLOWED') >= 0) {
                return Promise.reject(new Error(
                    'Server needs restart. Close the old Flask window, run run_dev.bat from the kiosk folder, then refresh (Ctrl+F5).'
                ));
            }
            throw err;
        });
    };

    var _origStopValidationOnBackend = window.stopValidationOnBackend;
    window.stopValidationOnBackend = function () {
        if (isVdValidationMode()) {
            return apiRequest(API_BASE + '/api/hardware/leak/stop', { method: 'POST' }).catch(function () {
                return { ok: true };
            });
        }
        if (typeof _origStopValidationOnBackend === 'function') {
            return _origStopValidationOnBackend();
        }
        return Promise.resolve({ ok: true });
    };

    var _origBuildValidationRunSnapshot = window.buildValidationRunSnapshot;
    window.buildValidationRunSnapshot = function (isPass, opts) {
        if (!isVdValidationMode()) {
            if (typeof _origBuildValidationRunSnapshot === 'function') {
                return _origBuildValidationRunSnapshot(isPass, opts);
            }
            return {};
        }
        opts = opts || {};
        var p = window._vdValidationParams || {};
        var now = new Date().toISOString();
        var status;
        if (opts.aborted) status = 'aborted';
        else if (isPass === true) status = 'Pass';
        else if (isPass === false) status = 'Fail';
        else status = 'completed';
        return {
            validationSubtype: 'distance',
            usp: 'Vacuum',
            setVacuumMmHg: p.vacuumMmHg,
            setDurationSec: p.durationSec,
            setDurationDisplay: p.durationDisplay,
            actualVacuumMmHg: validationRunCurrentVacuumMmHg,
            actualDurationSec: validationRunElapsedSec,
            validationDurationSec: p.durationSec,
            status: status,
            completedAt: now
        };
    };

    var _origCompleteValidationRunAfterDuration = window.completeValidationRunAfterDuration;
    window.completeValidationRunAfterDuration = function () {
        if (!isVdValidationMode()) {
            if (typeof _origCompleteValidationRunAfterDuration === 'function') {
                return _origCompleteValidationRunAfterDuration();
            }
            return;
        }
        validationRunState = 'idle';
        validationRunBackendPending = false;
        applyValidationRunLockUi(false);
        stopValidationOnBackend().catch(function () {});
        _closeValidationRunHardwareEs();
        setValRunEl('val-run-status', 'Completed');
        setValRunEl('val-run-status-sub', 'Releasing pressure');
        _setValResultVisible(false);
        _resetValidationRunActionButtonToStart();

        var releaseSec = (typeof getReleasePressureLockSec === 'function') ? getReleasePressureLockSec() : 80;
        var lockFn = (typeof showReleasePressureLock === 'function')
            ? showReleasePressureLock
            : function () { return Promise.resolve(); };

        lockFn(releaseSec).then(function () {
            setValRunEl('val-run-status-sub', 'Saving report');
            // Pass/Fail is set only on the report approval screen — no modal here.
            validationSessionResults.distance = buildValidationRunSnapshot(null);
            validationCompletion.distance = true;
            saveCombinedValidationReport();
        });
    };

    var _vdAbortSaveInFlight = false;
    var _origAbortValidationRun = window.abortValidationRun;
    window.abortValidationRun = function (options) {
        options = options || {};
        if (!isVdValidationMode()) {
            if (typeof _origAbortValidationRun === 'function') {
                return _origAbortValidationRun(options);
            }
            return Promise.resolve();
        }
        if (!isValidationOperationActive()) {
            return Promise.resolve();
        }
        if (_vdAbortSaveInFlight || validationRunBackendPending) {
            return Promise.resolve({ inFlight: true });
        }

        function _performVdAbort() {
            _vdAbortSaveInFlight = true;
            if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
            if (validationRunIntervalId != null) {
                clearInterval(validationRunIntervalId);
                validationRunIntervalId = null;
            }
            var btn = document.getElementById('btn-validation-start-abort');
            if (btn) btn.disabled = true;
            validationRunBackendPending = true;
            setValRunEl('val-run-status', 'Aborted');
            setValRunEl('val-run-status-sub', 'Releasing pressure');
            _setValRunStatusStyle('ready');
            _setValResultVisible(false);

            return stopValidationOnBackend().catch(function () {}).then(function () {
                _closeValidationRunHardwareEs();
                validationRunState = 'idle';
                applyValidationRunLockUi(false);
                _resetValidationRunActionButtonToStart();
                logAuditEvent('Validation aborted', 'Vacuum validation aborted by user', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: {
                        validationType: 'distance',
                        status: 'aborted',
                        actualVacuumMmHg: validationRunCurrentVacuumMmHg,
                        actualDurationSec: validationRunElapsedSec
                    }
                });
                var releaseSec = (typeof getReleasePressureLockSec === 'function') ? getReleasePressureLockSec() : 80;
                var lockFn = (typeof showReleasePressureLock === 'function')
                    ? showReleasePressureLock
                    : function () { return Promise.resolve(); };
                return lockFn(releaseSec);
            }).then(function () {
                validationSessionResults.distance = buildValidationRunSnapshot(false, { aborted: true });
                validationCompletion.distance = true;
                var reportPayload = (typeof buildCombinedValidationReportPayload === 'function')
                    ? buildCombinedValidationReportPayload()
                    : null;
                if (!reportPayload) {
                    return { openedPreview: false };
                }
                // Ensure aborted status for backend approval/PDF path.
                reportPayload.status = 'aborted';
                reportPayload.name = 'Validation - Vacuum - Aborted';
                if (reportPayload.testData) reportPayload.testData.status = 'aborted';
                if (Array.isArray(reportPayload.validationRuns)) {
                    reportPayload.validationRuns.forEach(function (r) {
                        if (r) r.status = 'aborted';
                    });
                }
                if (reportPayload.testData && Array.isArray(reportPayload.testData.validationRuns)) {
                    reportPayload.testData.validationRuns.forEach(function (r) {
                        if (r) r.status = 'aborted';
                    });
                }
                _postRunSessionHold = true;
                if (typeof markAutoLogoutActivity === 'function') markAutoLogoutActivity();
                return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: reportPayload })
                    .then(function (result) {
                        if (typeof clearTestRunCheckpoint === 'function') clearTestRunCheckpoint();
                        validationSessionResults = { distance: null, load: null };
                        validationCompletion = { distance: false, load: false };
                        var reportId = result && result.id;
                        currentReportFilter = 'validation';
                        if (reportId && typeof openReportPreview === 'function') {
                            openReportPreview(reportId);
                            return { openedPreview: true };
                        }
                        _postRunSessionHold = false;
                        goToPage('reports');
                        return { openedPreview: false };
                    })
                    .catch(function (err) {
                        _postRunSessionHold = false;
                        console.error('Failed to save aborted validation report', err);
                        showAppModal(
                            'Failed to save aborted validation report: ' + (err && err.message ? err.message : 'Unknown error'),
                            'Validation'
                        );
                        goToPage('reports');
                        return { openedPreview: false };
                    });
            }).finally(function () {
                _vdAbortSaveInFlight = false;
                validationRunBackendPending = false;
                if (btn) btn.disabled = false;
                applyValidationRunLockUi(false);
            });
        }

        if (options.skipConfirm) {
            return _performVdAbort();
        }
        var confirmFn = (typeof showConfirmModal === 'function')
            ? showConfirmModal
            : function (msg) { return Promise.resolve(window.confirm(msg)); };
        return confirmFn('Validation is running. Do you want to abort?', 'Abort Validation').then(function (ok) {
            if (!ok) return { cancelled: true };
            return _performVdAbort();
        });
    };

    var _origToggleValidationRunState = window.toggleValidationRunState;
    window.toggleValidationRunState = function () {
        if (!isVdValidationMode()) {
            if (typeof _origToggleValidationRunState === 'function') {
                return _origToggleValidationRunState();
            }
            return;
        }
        if (validationRunBackendPending || _vdAbortSaveInFlight) return;
        if (validationRunState === 'idle') {
            var btn = document.getElementById('btn-validation-start-abort');
            var label = document.getElementById('btn-validation-label');
            validationRunBackendPending = true;
            applyValidationRunLockUi(true);
            if (btn) btn.disabled = true;
            setValRunEl('val-run-status', 'Starting');
            setValRunEl('val-run-status-sub', 'Starting hardware…');

            function _vdStartFailed(err) {
                if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
                validationRunState = 'idle';
                applyValidationRunLockUi(false);
                _closeValidationRunHardwareEs();
                stopValidationOnBackend().catch(function () {});
                setValRunEl('val-run-status', 'Ready');
                setValRunEl('val-run-status-sub', 'Press Start to begin');
                _setValRunStatusStyle('ready');
                showAppModal('Failed to start validation: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
            }

            _closeValidationRunHardwareEs();
            startValidationOnBackend().then(function (res) {
                if (!res || res.ok !== true) {
                    return Promise.reject(new Error((res && res.error) ? String(res.error) : 'Hardware did not acknowledge start'));
                }
                try {
                    validationRunHardwareEs = new EventSource(_getHardwareSseUrl());
                } catch (esErr) {
                    return Promise.reject(esErr);
                }
                validationRunSseListener = validationRunHardwareMessage;
                validationRunHardwareEs.addEventListener('message', validationRunSseListener);

                validationRunState = 'running';
                validationRunElapsedSec = 0;
                validationRunHoldStarted = false;
                validationRunCurrentVacuumMmHg = null;
                window._vdStartPressureMmHg = null;
                window._validationLeakAbortInFlight = false;
                setValRunEl('val-run-elapsed-time', '00:00');
                setValRunEl('val-run-current-vacuum', '0.0');
                setValRunEl('val-run-status', 'Evacuating');
                setValRunEl('val-run-status-sub', 'Waiting for set vacuum');
                _setValRunStatusStyle('running');
                _setValResultVisible(false);
                _startVdPressurePoll();
                if (typeof startPressureBuildWatchdog === 'function') {
                    startPressureBuildWatchdog({
                        getSetTarget: function () {
                            var p = window._vdValidationParams;
                            return p ? p.vacuumMmHg : null;
                        },
                        getLive: function () { return validationRunCurrentVacuumMmHg; },
                        isActive: function () {
                            return validationRunState === 'running' && !validationRunHoldStarted;
                        },
                        onFail: function () {
                            if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
                            if (window._validationLeakAbortInFlight) {
                                var stopFnDup = (typeof hardwareLeakStopUntilAck === 'function')
                                    ? hardwareLeakStopUntilAck
                                    : (typeof hardwareLeakStopAwait === 'function')
                                        ? hardwareLeakStopAwait
                                        : stopValidationOnBackend;
                                Promise.resolve(stopFnDup()).catch(function () {});
                                return;
                            }
                            window._validationLeakAbortInFlight = true;
                            if (validationRunIntervalId != null) {
                                clearInterval(validationRunIntervalId);
                                validationRunIntervalId = null;
                            }
                            validationRunState = 'idle';
                            validationRunHoldStarted = false;
                            _closeValidationRunHardwareEs();
                            _stopVdPressurePoll();
                            _resetValidationRunActionButtonToStart();
                            setValRunEl('val-run-status', 'Error');
                            setValRunEl('val-run-status-sub', 'Pressure not building');
                            // Modal + STOP until STOP_ACK (backend retries until ACK).
                            showAppModal('Check for leaks. Pressure not building', 'Validation');
                            try {
                                var pFail = window._vdValidationParams || {};
                                if (typeof auditValidationAbortedLeaksFound === 'function') {
                                    auditValidationAbortedLeaksFound({
                                        setVacuumMmHg: pFail.vacuumMmHg,
                                        liveVacuumMmHg: validationRunCurrentVacuumMmHg
                                    });
                                } else if (typeof logAuditEvent === 'function') {
                                    logAuditEvent(
                                        'Validation aborted - leaks found',
                                        'Check for leaks. Pressure not building',
                                        { eventType: 'lifecycle', entityType: 'validation', outcome: 'failed' }
                                    );
                                }
                            } catch (auditErr) { /* keep abort path alive */ }
                            var stopFn = (typeof hardwareLeakStopUntilAck === 'function')
                                ? hardwareLeakStopUntilAck
                                : (typeof hardwareLeakStopAwait === 'function')
                                    ? hardwareLeakStopAwait
                                    : stopValidationOnBackend;
                            Promise.resolve(stopFn()).catch(function () {}).finally(function () {
                                window._validationLeakAbortInFlight = false;
                            });
                        }
                    });
                }
                logAuditEvent('Validation started', 'Vacuum validation run started', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: { validationType: 'distance', vacuumMmHg: window._vdValidationParams.vacuumMmHg }
                });
                if (typeof syncOperationCheckpoint === 'function' && typeof buildValidationCheckpointPayload === 'function') {
                    try { syncOperationCheckpoint(buildValidationCheckpointPayload()); } catch (cpE) { /* ignore */ }
                }
                if (btn) {
                    btn.className = 'btn btn-primary val-run-start-btn is-abort';
                    btn.disabled = false;
                    btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9726;</span><span id="btn-validation-label">Stop</span>';
                }
                if (label) label.textContent = 'Stop';
                if (validationRunIntervalId != null) {
                    clearInterval(validationRunIntervalId);
                    validationRunIntervalId = null;
                }
            }).catch(_vdStartFailed).finally(function () {
                validationRunBackendPending = false;
                if (btn) btn.disabled = false;
            });
        } else {
            abortValidationRun();
        }
    };

    window.goBackFromValidationRun = function () {
        var backPage = 'vd-validation-input';
        if (isValidationOperationActive()) {
            return abortValidationRun().then(function (result) {
                if (result && (result.openedPreview || result.cancelled || result.inFlight)) return;
                _suppressValidationNavGuardOnce = true;
                goToPage(backPage);
            });
        }
        _suppressValidationNavGuardOnce = true;
        goToPage(backPage);
    };

    function applyVdInputMaxVacuum(maxVac) {
        var vacEl = document.getElementById('vd-val-vacuum-mmhg');
        if (vacEl) {
            vacEl.max = String(maxVac);
            vacEl.placeholder = 'Max ' + maxVac + ' mmHg';
        }
        setVdInputError('');
    }

    function initVdValidationInputPage() {
        applyVdInputMaxVacuum(getFactoryMaxVacuumMmHg());
        if (typeof apiRequest !== 'function') return;
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
            var settings = (result && result.settings) ? result.settings : (result || {});
            var v = parseInt(settings.maxVacuumMmHg, 10);
            if (!isNaN(v) && v >= 1 && v <= 650) {
                try {
                    var stored = localStorage.getItem('factorySettings');
                    var merged = stored ? JSON.parse(stored) : {};
                    merged.maxVacuumMmHg = v;
                    localStorage.setItem('factorySettings', JSON.stringify(merged));
                } catch (e) { /* ignore */ }
            }
            applyVdInputMaxVacuum(getFactoryMaxVacuumMmHg());
        }).catch(function () {
            applyVdInputMaxVacuum(getFactoryMaxVacuumMmHg());
        });
    }

    /** Hold after TARGET_REACHED before enabling external gauge entry (ms). */
    var CALIB_HOLD_AFTER_TARGET_MS = 1200;
    window._vacuumCalRun = null;

    function getFactoryCalibrationSettings() {
        var target = 400;
        var release = 80;
        try {
            var stored = localStorage.getItem('factorySettings');
            if (stored) {
                var s = JSON.parse(stored);
                var t = parseInt(s.calibrationTargetVacuumMmHg, 10);
                var r = parseInt(s.calibrationReleaseTimeSec, 10);
                if (!isNaN(t) && t >= 1 && t <= 650) target = t;
                if (!isNaN(r) && r >= 1 && r <= 5999) release = r;
            }
        } catch (e) { /* ignore */ }
        return {
            targetVacuumMmHg: target,
            releaseTimeSec: release,
            holdAfterTargetMs: CALIB_HOLD_AFTER_TARGET_MS
        };
    }

    function _setCalRunEl(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text != null ? String(text) : '--';
    }

    function _closeVacuumCalEs() {
        _stopCalPressurePoll();
        if (window._vacuumCalEsListener && window._vacuumCalEs) {
            try {
                window._vacuumCalEs.removeEventListener('message', window._vacuumCalEsListener);
            } catch (e2) { /* ignore */ }
        }
        window._vacuumCalEsListener = null;
        if (window._vacuumCalEs) {
            try {
                window._vacuumCalEs.close();
            } catch (e) { /* ignore */ }
            window._vacuumCalEs = null;
        }
    }

    function _setCalGaugeEntryEnabled(enabled) {
        var panel = document.getElementById('cal-gauge-entry-panel');
        var input = document.getElementById('cal-page-gauge-input');
        var applyBtn = document.getElementById('btn-calibration-apply');
        if (panel) {
            panel.classList.toggle('is-enabled', !!enabled);
            panel.removeAttribute('hidden');
        }
        if (input) {
            input.disabled = !enabled;
            if (!enabled) input.value = '';
        }
        if (applyBtn) applyBtn.disabled = !enabled;
        if (enabled && input) {
            setTimeout(function () {
                try { input.focus(); } catch (e) { /* ignore */ }
            }, 80);
        }
    }

    function _closeCalibrationGaugeModal() {
        var modal = document.getElementById('calibration-gauge-modal');
        if (modal) modal.style.display = 'none';
        var submitBtn = document.getElementById('cal-gauge-submit-btn');
        var cancelBtn = document.getElementById('cal-gauge-cancel-btn');
        if (submitBtn) submitBtn.onclick = null;
        if (cancelBtn) cancelBtn.onclick = null;
    }

    function _isVacuumCalRunActive(run) {
        if (!run || !run.phase) return false;
        return run.phase !== 'idle' && run.phase !== 'done';
    }

    function _startCalibrationHoldAfterTarget(run) {
        if (!run || run.phase !== 'evacuating') return;
        if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
        // Holding starts at TARGET_REACHED; after 1.20 s enable actual-pressure entry.
        run.phase = 'holding';
        _clearVacuumCalTimers();
        run.holdSec = 0;
        run.holdStartedAtMs = Date.now();
        _setCalGaugeEntryEnabled(false);
        _setCalRunEl('cal-run-status', 'Target reached — holding…');
        _setCalRunEl('cal-hold-elapsed', '00:00');
        var holdMs = parseInt(run.holdAfterTargetMs, 10);
        if (isNaN(holdMs) || holdMs < 1) holdMs = CALIB_HOLD_AFTER_TARGET_MS;
        window._vacuumCalHoldTick = setInterval(function () {
            if (!window._vacuumCalRun || window._vacuumCalRun !== run) return;
            if (run.phase !== 'holding') return;
            var elapsedMs = Date.now() - (run.holdStartedAtMs || Date.now());
            run.holdSec = Math.floor(elapsedMs / 1000);
            _setCalRunEl(
                'cal-hold-elapsed',
                (typeof formatMmSs === 'function') ? formatMmSs(run.holdSec) : String(run.holdSec)
            );
        }, 200);
        window._vacuumCalHoldTimer = setTimeout(function () {
            window._vacuumCalHoldTimer = null;
            if (window._vacuumCalHoldTick != null) {
                clearInterval(window._vacuumCalHoldTick);
                window._vacuumCalHoldTick = null;
            }
            if (!window._vacuumCalRun || window._vacuumCalRun !== run) return;
            if (run.phase !== 'holding') return;
            run.phase = 'prompt';
            _setCalRunEl('cal-run-status', 'Enter actual pressure, then Calibrate');
            _setCalGaugeEntryEnabled(true);
        }, holdMs);
    }

    function _clearVacuumCalTimers() {
        if (window._vacuumCalHoldTimer != null) {
            clearTimeout(window._vacuumCalHoldTimer);
            window._vacuumCalHoldTimer = null;
        }
        if (window._vacuumCalHoldTick != null) {
            clearInterval(window._vacuumCalHoldTick);
            window._vacuumCalHoldTick = null;
        }
    }

    function _stopCalPressurePoll() {
        if (window._calPressurePollId != null) {
            clearInterval(window._calPressurePollId);
            window._calPressurePollId = null;
        }
    }

    function _startCalPressurePoll() {
        _stopCalPressurePoll();
        window._calPressurePollId = setInterval(function () {
            var run = window._vacuumCalRun;
            if (!run || run.phase === 'done' || run.phase === 'idle' || run.phase === 'prompt'
                || run.phase === 'holding' || run.phase === 'applying') return;
            if (typeof apiRequest !== 'function') return;
            apiRequest(API_BASE + '/api/hardware/status', { method: 'GET' }).then(function (res) {
                if (!res || res.ok === false) return;
                var raw = res.pressureMmHg != null ? res.pressureMmHg : res.pressure;
                var v = parseFloat(raw);
                if (isNaN(v)) return;
                run.liveVacuumMmHg = v;
                _setCalRunEl('cal-live-vacuum', v.toFixed(1));
                if (run.phase !== 'evacuating') return;
                if (run.startPressureMmHg == null) {
                    run.startPressureMmHg = v;
                    return;
                }
                var target = run.targetVacuumMmHg;
                var startP = run.startPressureMmHg;
                var crossed = (startP > target && v <= target) || (startP < target && v >= target);
                if (crossed) _startCalibrationHoldAfterTarget(run);
            }).catch(function () { /* ignore */ });
        }, 1000);
    }

    function buildCalibrationReportPayload(actualPressure, run, options) {
        options = options || {};
        var aborted = !!options.aborted;
        var remarks = options.remarks != null ? String(options.remarks) : '';
        var user = window.currentUser || {};
        var now = new Date().toISOString();
        var status = aborted ? 'aborted' : 'Completed';
        var gauge = (actualPressure != null && !isNaN(Number(actualPressure))) ? Number(actualPressure) : null;
        var td = {
            calibrationSubtype: 'vacuum',
            setVacuumMmHg: run.targetVacuumMmHg,
            actualVacuumMmHg: gauge,
            calibValue: gauge,
            releaseTimeSec: run.releaseTimeSec,
            holdAfterTargetMs: run.holdAfterTargetMs != null ? run.holdAfterTargetMs : CALIB_HOLD_AFTER_TARGET_MS,
            liveVacuumAtPrompt: run.liveVacuumMmHg,
            status: status,
            remarks: remarks || undefined,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatedByUsername: (typeof normalizeReportUsername === 'function')
                ? normalizeReportUsername(user.username || user.name || '')
                : (user.username || user.name || ''),
            createdAt: now,
            completedAt: now
        };
        var payload = {
            name: 'Calibration - Vacuum - ' + run.targetVacuumMmHg + ' mmHg',
            type: 'calibration',
            calibrationSubtype: 'vacuum',
            status: status,
            setVacuumMmHg: run.targetVacuumMmHg,
            actualVacuumMmHg: gauge,
            calibValue: gauge,
            releaseTimeSec: run.releaseTimeSec,
            createdAt: now,
            completedAt: now,
            operatedByUsername: td.operatedByUsername,
            operatorName: td.operatorName,
            employeeId: td.employeeId,
            testData: td
        };
        if (remarks) {
            payload.remarks = remarks;
        }
        return payload;
    }

    function saveCalibrationReport(payload) {
        window._postRunSessionHold = true;
        if (typeof markAutoLogoutActivity === 'function') markAutoLogoutActivity();
        var isAborted = String((payload && payload.status) || '').toLowerCase() === 'aborted'
            || String((payload && payload.testData && payload.testData.status) || '').toLowerCase() === 'aborted';
        return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
            .then(function (result) {
                if (typeof clearTestRunCheckpoint === 'function') clearTestRunCheckpoint();
                var reportId = result && result.id;
                currentReportFilter = 'calibration';
                if (reportId && typeof openReportPreview === 'function') {
                    // Completed → pending approval gate; aborted → preview (same as test abort).
                    openReportPreview(reportId, isAborted ? {} : { setGate: true });
                } else {
                    window._postRunSessionHold = false;
                    goToPage('reports');
                }
            })
            .catch(function (err) {
                window._postRunSessionHold = false;
                console.error('Failed to save calibration report', err);
                showAppModal(
                    (isAborted ? 'Failed to save aborted calibration report: ' : 'Calibration saved to device failed: ')
                        + (err && err.message ? err.message : 'Unknown error'),
                    'Calibration'
                );
                goToPage('reports');
            });
    }

    function _stopVacuumCalibrationHardware() {
        if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
        _clearVacuumCalTimers();
        _stopCalPressurePoll();
        _closeVacuumCalEs();
        _closeCalibrationGaugeModal();
        _setCalGaugeEntryEnabled(false);
        if (typeof apiRequest === 'function') {
            return apiRequest(API_BASE + '/api/hardware/calibration/stop', { method: 'POST' }).catch(function () {});
        }
        return Promise.resolve();
    }

    function abortVacuumCalibration() {
        var run = window._vacuumCalRun;
        var startBtn = document.getElementById('btn-calibration-start');
        var backBtn = document.getElementById('btn-calibration-back');
        if (!_isVacuumCalRunActive(run)) {
            _stopVacuumCalibrationHardware();
            window._vacuumCalRun = null;
            if (startBtn) startBtn.disabled = false;
            if (backBtn) backBtn.textContent = 'Back';
            goToPage('validate');
            return Promise.resolve();
        }
        if (run.phase === 'applying' || run._abortSaveInFlight) {
            return Promise.resolve();
        }
        run._abortSaveInFlight = true;
        var phaseAtAbort = run.phase;
        _setCalRunEl('cal-run-status', 'Aborting…');
        return _stopVacuumCalibrationHardware().then(function () {
            if (typeof logAuditEvent === 'function') {
                logAuditEvent(
                    'Calibration aborted',
                    'Vacuum calibration aborted by user (phase=' + phaseAtAbort + ')',
                    {
                        eventType: 'lifecycle',
                        entityType: 'calibration',
                        extra: {
                            setVacuumMmHg: run.targetVacuumMmHg,
                            phase: phaseAtAbort,
                            liveVacuumMmHg: run.liveVacuumMmHg,
                            holdSec: run.holdSec
                        }
                    }
                );
            }
            var payload = buildCalibrationReportPayload(null, run, {
                aborted: true,
                remarks: 'Calibration aborted by user'
            });
            window._vacuumCalRun = null;
            if (startBtn) startBtn.disabled = false;
            if (backBtn) backBtn.textContent = 'Back';
            return saveCalibrationReport(payload);
        });
    }
    window.abortVacuumCalibration = abortVacuumCalibration;

    function vacuumCalibrationHardwareMessage(ev) {
        var run = window._vacuumCalRun;
        if (!run || run.phase === 'done' || run.phase === 'prompt'
            || run.phase === 'holding' || run.phase === 'applying') return;
        try {
            var raw = ev.data;
            if (raw == null || raw === '') return;
            var data = JSON.parse(raw);
            if (data.ping) return;
            var parsed = parseVdSseLine(data);
            var norm = String(data.normalized != null ? data.normalized : data.line || '').toLowerCase().replace(/^#/, '').replace(/\*$/, '');
            var vacuum = null;
            if (parsed.su != null) vacuum = parseFloat(parsed.su);
            else if (parsed.vacuum != null) vacuum = parseFloat(parsed.vacuum);
            else if (parsed.pressure != null) vacuum = parseFloat(parsed.pressure);
            if (vacuum != null && !isNaN(vacuum)) {
                run.liveVacuumMmHg = vacuum;
                _setCalRunEl('cal-live-vacuum', vacuum.toFixed(1));
            }
            if (run.phase === 'evacuating') {
                var targetReached = norm === 'target_reached'
                    || norm.indexOf('target_reached') >= 0
                    || norm.indexOf('target,reached') >= 0
                    || norm.indexOf('target reached') >= 0;
                if (targetReached) {
                    _startCalibrationHoldAfterTarget(run);
                } else if (vacuum != null && !isNaN(vacuum)) {
                    if (run.startPressureMmHg == null) {
                        run.startPressureMmHg = vacuum;
                    } else {
                        var target = run.targetVacuumMmHg;
                        var startP = run.startPressureMmHg;
                        var crossed = (startP > target && vacuum <= target) || (startP < target && vacuum >= target);
                        if (crossed) _startCalibrationHoldAfterTarget(run);
                    }
                }
            }
        } catch (ex) { /* ignore */ }
    }

    function _readAndValidateCalGaugeInput(inputEl) {
        var input = inputEl || document.getElementById('cal-page-gauge-input');
        if (!input) return null;
        var raw = String(input.value || '').trim();
        var val = parseFloat(raw);
        var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
        if (!raw || isNaN(val) || val < 1) {
            showAppModal('Enter the actual pressure from the external gauge (mmHg).', 'Calibration');
            try { input.focus(); } catch (e) { /* ignore */ }
            return null;
        }
        if (val > maxVac) {
            showAppModal('Actual pressure cannot exceed ' + maxVac + ' mmHg.', 'Calibration');
            try { input.focus(); } catch (e) { /* ignore */ }
            return null;
        }
        return val;
    }

    function submitVacuumCalibrationGauge() {
        var run = window._vacuumCalRun;
        if (!run || run.phase !== 'prompt') return;
        var val = _readAndValidateCalGaugeInput(document.getElementById('cal-page-gauge-input'));
        if (val == null) return;
        finishVacuumCalibration(val);
    }
    window.submitVacuumCalibrationGauge = submitVacuumCalibrationGauge;

    function finishVacuumCalibration(actualPressure) {
        var run = window._vacuumCalRun;
        if (!run) return;
        var setVac = run.targetVacuumMmHg;
        var startBtn = document.getElementById('btn-calibration-start');
        var applyBtn = document.getElementById('btn-calibration-apply');
        var backBtn = document.getElementById('btn-calibration-back');
        run.phase = 'applying';
        _setCalGaugeEntryEnabled(false);
        if (applyBtn) applyBtn.disabled = true;
        _setCalRunEl('cal-run-status', 'Sending CALIBVALUE ' + actualPressure + '…');
        apiRequest(API_BASE + '/api/hardware/calibration/apply', {
            method: 'POST',
            body: {
                gaugeValue: actualPressure,
                calibValue: actualPressure,
                setVacuumMmHg: setVac,
                releaseTimeSec: run.releaseTimeSec
            }
        })
            .then(function (res) {
                if (!res || res.ok !== true) {
                    return Promise.reject(new Error((res && res.error) ? String(res.error) : 'ESP did not acknowledge CALIBVALUE'));
                }
                // Same rule as test/validation: every START must end with STOP.
                _setCalRunEl('cal-run-status', 'Stopping…');
                return apiRequest(API_BASE + '/api/hardware/calibration/stop', { method: 'POST' });
            })
            .then(function (res) {
                if (!res || res.ok !== true) {
                    return Promise.reject(new Error((res && res.error) ? String(res.error) : 'ESP did not acknowledge STOP'));
                }
                if (typeof logAuditEvent === 'function') {
                    logAuditEvent(
                        'Calibration completed',
                        'Vacuum calibration gauge=' + actualPressure + ' set=' + setVac,
                        {
                            eventType: 'lifecycle',
                            entityType: 'calibration',
                            extra: {
                                setVacuumMmHg: setVac,
                                gaugeValue: actualPressure,
                                calibValue: actualPressure,
                                releaseTimeSec: run.releaseTimeSec
                            }
                        }
                    );
                }
                run.phase = 'done';
                run._stopSent = true;
                _clearVacuumCalTimers();
                _closeVacuumCalEs();
                _setCalRunEl('cal-run-status', 'Releasing pressure…');
                var releaseSec = run.releaseTimeSec
                    || ((typeof getReleasePressureLockSec === 'function') ? getReleasePressureLockSec() : 80);
                var lockFn = (typeof showReleasePressureLock === 'function')
                    ? showReleasePressureLock
                    : function () { return Promise.resolve(); };
                return lockFn(releaseSec, { sendStop: false }).then(function () {
                    var payload = buildCalibrationReportPayload(actualPressure, run);
                    window._lastFailedValidation = null;
                    return saveCalibrationReport(payload);
                });
            })
            .catch(function (err) {
                run.phase = 'idle';
                _clearVacuumCalTimers();
                _setCalGaugeEntryEnabled(false);
                if (startBtn) startBtn.disabled = false;
                if (backBtn) backBtn.textContent = 'Back';
                _setCalRunEl('cal-run-status', 'Calibration failed');
                showAppModal('Failed to apply calibration: ' + (err && err.message ? err.message : 'Unknown error'), 'Calibration');
                if (!run._stopSent) {
                    apiRequest(API_BASE + '/api/hardware/calibration/stop', { method: 'POST' }).catch(function () {});
                }
            });
    }

    function startVacuumCalibrationRun() {
        if (window._vacuumCalRun && window._vacuumCalRun.phase && window._vacuumCalRun.phase !== 'idle' && window._vacuumCalRun.phase !== 'done') {
            return;
        }
        var settings = getFactoryCalibrationSettings();
        var startBtn = document.getElementById('btn-calibration-start');
        var backBtn = document.getElementById('btn-calibration-back');
        window._vacuumCalRun = {
            targetVacuumMmHg: settings.targetVacuumMmHg,
            releaseTimeSec: settings.releaseTimeSec,
            holdAfterTargetMs: settings.holdAfterTargetMs,
            liveVacuumMmHg: null,
            holdSec: 0,
            phase: 'starting'
        };
        _setCalRunEl('cal-set-vacuum', String(settings.targetVacuumMmHg));
        _setCalRunEl('cal-live-vacuum', '--');
        _setCalRunEl('cal-release-time', String(settings.releaseTimeSec));
        _setCalRunEl('cal-hold-elapsed', '00:00');
        _setCalRunEl('cal-run-status', 'Starting calibration…');
        _setCalGaugeEntryEnabled(false);
        if (startBtn) startBtn.disabled = true;
        if (backBtn) backBtn.textContent = 'Abort';
        _clearVacuumCalTimers();
        _closeVacuumCalEs();
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
            var fs = (result && result.settings) ? result.settings : (result || {});
            try { localStorage.setItem('factorySettings', JSON.stringify(fs)); } catch (e) { /* ignore */ }
            settings = getFactoryCalibrationSettings();
            if (window._vacuumCalRun) {
                window._vacuumCalRun.targetVacuumMmHg = settings.targetVacuumMmHg;
                window._vacuumCalRun.releaseTimeSec = settings.releaseTimeSec;
                window._vacuumCalRun.holdAfterTargetMs = settings.holdAfterTargetMs;
                _setCalRunEl('cal-set-vacuum', String(settings.targetVacuumMmHg));
                _setCalRunEl('cal-release-time', String(settings.releaseTimeSec));
            }
        }).catch(function () { /* use cached */ });
        apiRequest(API_BASE + '/api/hardware/calibration/start', {
            method: 'POST',
            body: { targetVacuumMmHg: settings.targetVacuumMmHg }
        }).then(function (res) {
            if (!res || res.ok !== true) {
                return Promise.reject(new Error((res && res.error) ? String(res.error) : 'Hardware did not acknowledge START'));
            }
            try {
                window._vacuumCalEs = new EventSource((typeof _getHardwareSseUrl === 'function') ? _getHardwareSseUrl() : (API_BASE + '/api/hardware/stream'));
                window._vacuumCalEsListener = vacuumCalibrationHardwareMessage;
                window._vacuumCalEs.addEventListener('message', window._vacuumCalEsListener);
            } catch (esErr) {
                return Promise.reject(new Error('Could not connect to hardware stream'));
            }
            if (window._vacuumCalRun) {
                window._vacuumCalRun.phase = 'evacuating';
                window._calibrationLeakAbortInFlight = false;
                _setCalRunEl('cal-run-status', 'Evacuating to ' + settings.targetVacuumMmHg + ' mmHg (START)');
                _setCalRunEl('cal-live-vacuum', '0.0');
                _startCalPressurePoll();
                if (typeof startPressureBuildWatchdog === 'function') {
                    startPressureBuildWatchdog({
                        getSetTarget: function () {
                            var r = window._vacuumCalRun;
                            return r ? r.targetVacuumMmHg : null;
                        },
                        getLive: function () {
                            var r = window._vacuumCalRun;
                            return r ? r.liveVacuumMmHg : null;
                        },
                        isActive: function () {
                            var r = window._vacuumCalRun;
                            return !!(r && r.phase === 'evacuating');
                        },
                        onFail: function () {
                            var startBtnFail = document.getElementById('btn-calibration-start');
                            var backBtnFail = document.getElementById('btn-calibration-back');
                            if (window._calibrationLeakAbortInFlight) {
                                Promise.resolve(_stopVacuumCalibrationHardware()).catch(function () {});
                                return;
                            }
                            window._calibrationLeakAbortInFlight = true;
                            var setVac = null;
                            var liveVac = null;
                            if (window._vacuumCalRun) {
                                setVac = window._vacuumCalRun.targetVacuumMmHg;
                                liveVac = window._vacuumCalRun.liveVacuumMmHg;
                                window._vacuumCalRun.phase = 'idle';
                            }
                            if (startBtnFail) startBtnFail.disabled = false;
                            if (backBtnFail) backBtnFail.textContent = 'Back';
                            _setCalRunEl('cal-run-status', 'Pressure not building');
                            // Modal + STOP_CALIB until ACK (same time).
                            showAppModal('Check for leaks. Pressure not building', 'Calibration');
                            try {
                                if (typeof auditCalibrationAbortedLeaksFound === 'function') {
                                    auditCalibrationAbortedLeaksFound({
                                        setVacuumMmHg: setVac,
                                        liveVacuumMmHg: liveVac
                                    });
                                } else if (typeof logAuditEvent === 'function') {
                                    logAuditEvent(
                                        'Calibration aborted - leaks found',
                                        'Check for leaks. Pressure not building',
                                        { eventType: 'lifecycle', entityType: 'calibration', outcome: 'failed' }
                                    );
                                }
                            } catch (auditErr) { /* keep abort path alive */ }
                            Promise.resolve(_stopVacuumCalibrationHardware()).catch(function () {}).finally(function () {
                                window._calibrationLeakAbortInFlight = false;
                            });
                        }
                    });
                }
                // Persist in-progress calibration so power loss can synthesize a Fail report.
                try {
                    var u = window.currentUser || {};
                    var un = (u.username || u.name || '').trim();
                    var now = new Date().toISOString();
                    var cp = {
                        type: 'calibration',
                        name: 'Calibration - Vacuum - ' + settings.targetVacuumMmHg + ' mmHg',
                        calibrationSubtype: 'vacuum',
                        setVacuumMmHg: settings.targetVacuumMmHg,
                        operatedByUsername: un,
                        operatorName: (u.name || u.username || '').trim(),
                        employeeId: un,
                        startedAt: now,
                        createdAt: now,
                        testData: {
                            status: 'running',
                            calibrationSubtype: 'vacuum',
                            setVacuumMmHg: settings.targetVacuumMmHg,
                            releaseTimeSec: settings.releaseTimeSec,
                            operatedByUsername: un,
                            operatorName: (u.name || u.username || '').trim(),
                            employeeId: un,
                            createdAt: now
                        }
                    };
                    if (typeof syncOperationCheckpoint === 'function') {
                        syncOperationCheckpoint(cp);
                    } else if (typeof apiRequest === 'function') {
                        apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'PUT', body: cp }).catch(function () {});
                    }
                } catch (cpErr) { /* ignore */ }
            }
        }).catch(function (err) {
            if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
            _closeVacuumCalEs();
            if (typeof apiRequest === 'function') {
                apiRequest(API_BASE + '/api/hardware/calibration/stop', { method: 'POST' }).catch(function () {});
            }
            if (startBtn) startBtn.disabled = false;
            if (backBtn) backBtn.textContent = 'Back';
            if (window._vacuumCalRun) window._vacuumCalRun.phase = 'idle';
            _setCalRunEl('cal-run-status', 'Start failed');
            showAppModal('Failed to start calibration: ' + (err && err.message ? err.message : 'Unknown error'), 'Calibration');
        });
    }

    function initVacuumCalibrationPage() {
        var settings = getFactoryCalibrationSettings();
        var startBtn = document.getElementById('btn-calibration-start');
        var backBtn = document.getElementById('btn-calibration-back');
        window._vacuumCalRun = null;
        _clearVacuumCalTimers();
        _closeVacuumCalEs();
        _closeCalibrationGaugeModal();
        _setCalGaugeEntryEnabled(false);
        _setCalRunEl('cal-set-vacuum', String(settings.targetVacuumMmHg));
        _setCalRunEl('cal-live-vacuum', '--');
        _setCalRunEl('cal-release-time', String(settings.releaseTimeSec));
        _setCalRunEl('cal-hold-elapsed', '00:00');
        _setCalRunEl('cal-run-status', 'Ready to start');
        if (startBtn) startBtn.disabled = false;
        if (backBtn) backBtn.textContent = 'Back';
    }

    window.confirmVacuumCalibration = function () {
        startVacuumCalibrationRun();
    };

    var _origGoToPageVd = window.goToPage;
    window.goToPage = function (pageName) {
        var result = _origGoToPageVd.apply(this, arguments);
        if (pageName === 'vd-validation-input') {
            setTimeout(initVdValidationInputPage, 50);
        }
        if (pageName === 'vacuum-calibration') {
            setTimeout(initVacuumCalibrationPage, 50);
        }
        return result;
    };

})();

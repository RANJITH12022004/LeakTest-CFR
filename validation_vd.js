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
    window.buildValidationRunSnapshot = function (isPass) {
        if (!isVdValidationMode()) {
            if (typeof _origBuildValidationRunSnapshot === 'function') {
                return _origBuildValidationRunSnapshot(isPass);
            }
            return {};
        }
        var p = window._vdValidationParams;
        var now = new Date().toISOString();
        return {
            validationSubtype: 'distance',
            usp: 'Vacuum',
            setVacuumMmHg: p.vacuumMmHg,
            setDurationSec: p.durationSec,
            setDurationDisplay: p.durationDisplay,
            actualVacuumMmHg: validationRunCurrentVacuumMmHg,
            actualDurationSec: validationRunElapsedSec,
            validationDurationSec: p.durationSec,
            status: isPass ? 'Pass' : 'Fail',
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
        setValRunEl('val-run-status-sub', 'Select Pass or Fail');
        _setValResultVisible(false);
        _resetValidationRunActionButtonToStart();

        var p = window._vdValidationParams;
        var targetVac = p.vacuumMmHg;
        var actualVac = validationRunCurrentVacuumMmHg;
        var actualTimeDisplay = formatMmSs(validationRunElapsedSec);

        if (typeof showValidationPassFailModal !== 'function') {
            validationSessionResults.distance = buildValidationRunSnapshot(true);
            validationCompletion.distance = true;
            saveCombinedValidationReport();
            return;
        }

        showValidationPassFailModal({
            setVacuumMmHg: targetVac,
            actualVacuumMmHg: actualVac,
            setDurationDisplay: p.durationDisplay,
            actualDurationSec: validationRunElapsedSec,
            actualDurationDisplay: actualTimeDisplay
        }).then(function (choice) {
            if (choice === 'pass') {
                logAuditEvent('Validation marked Pass', 'Operator marked vacuum validation Pass', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: {
                        validationType: 'distance',
                        status: 'Pass',
                        setVacuumMmHg: targetVac,
                        actualVacuumMmHg: actualVac
                    }
                });
                validationSessionResults.distance = buildValidationRunSnapshot(true);
                validationCompletion.distance = true;
                saveCombinedValidationReport();
                return;
            }
            logAuditEvent('Validation marked Fail', 'Operator marked vacuum validation Fail — redirecting to calibration', {
                eventType: 'lifecycle',
                entityType: 'validation',
                extra: {
                    validationType: 'distance',
                    status: 'Fail',
                    setVacuumMmHg: targetVac,
                    actualVacuumMmHg: actualVac
                }
            });
            window._lastFailedValidation = {
                setVacuumMmHg: targetVac,
                actualVacuumMmHg: actualVac,
                setDurationDisplay: p.durationDisplay,
                actualDurationSec: validationRunElapsedSec,
                actualDurationDisplay: actualTimeDisplay,
                status: 'Fail'
            };
            validationCompletion.distance = false;
            if (typeof showLoadingOverlay === 'function') {
                showLoadingOverlay('Please wait', 'Redirecting to CALIBRATION', { cancellable: false });
            }
            setTimeout(function () {
                if (typeof hideLoadingOverlay === 'function') hideLoadingOverlay();
                goToPage('vacuum-calibration');
            }, 1500);
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
        if (validationRunBackendPending) return;
        if (validationRunState === 'idle') {
            var btn = document.getElementById('btn-validation-start-abort');
            var label = document.getElementById('btn-validation-label');
            validationRunBackendPending = true;
            applyValidationRunLockUi(true);
            if (btn) btn.disabled = true;
            setValRunEl('val-run-status', 'Starting');
            setValRunEl('val-run-status-sub', 'Connecting to hardware…');

            function _vdStartFailed(err) {
                validationRunState = 'idle';
                applyValidationRunLockUi(false);
                _closeValidationRunHardwareEs();
                setValRunEl('val-run-status', 'Ready');
                setValRunEl('val-run-status-sub', 'Press Start to begin');
                _setValRunStatusStyle('ready');
                showAppModal('Failed to start validation: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
            }

            _closeValidationRunHardwareEs();
            try {
                validationRunHardwareEs = new EventSource(_getHardwareSseUrl());
            } catch (esErr) {
                validationRunBackendPending = false;
                if (btn) btn.disabled = false;
                _vdStartFailed(esErr);
                return;
            }
            validationRunSseListener = validationRunHardwareMessage;
            validationRunHardwareEs.addEventListener('message', validationRunSseListener);

            startValidationOnBackend().then(function (res) {
                if (!res || res.ok !== true) {
                    return Promise.reject(new Error((res && res.error) ? String(res.error) : 'Hardware did not acknowledge start'));
                }
                validationRunState = 'running';
                validationRunElapsedSec = 0;
                validationRunHoldStarted = false;
                validationRunCurrentVacuumMmHg = null;
                window._vdStartPressureMmHg = null;
                setValRunEl('val-run-elapsed-time', '00:00');
                setValRunEl('val-run-current-vacuum', '0.0');
                setValRunEl('val-run-status', 'Evacuating');
                setValRunEl('val-run-status-sub', 'Waiting for set vacuum');
                _setValRunStatusStyle('running');
                _setValResultVisible(false);
                _startVdPressurePoll();
                logAuditEvent('Validation started', 'Vacuum validation run started', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: { validationType: 'distance', vacuumMmHg: window._vdValidationParams.vacuumMmHg }
                });
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
            return abortValidationRun().then(function () {
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

    var CALIB_HOLD_AFTER_TARGET_SEC = 5;
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
            holdAfterTargetSec: CALIB_HOLD_AFTER_TARGET_SEC
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

    function _startCalibrationHoldAfterTarget(run) {
        if (!run || run.phase !== 'evacuating') return;
        run.phase = 'holding';
        run.holdSec = 0;
        _setCalRunEl('cal-run-status', 'Target reached — holding 5 s');
        _setCalRunEl('cal-hold-elapsed', '00:00');
        _clearVacuumCalTimers();
        window._vacuumCalHoldTimer = setInterval(function () {
            var r = window._vacuumCalRun;
            if (!r || r.phase !== 'holding') return;
            r.holdSec += 1;
            _setCalRunEl('cal-hold-elapsed', formatMmSs(r.holdSec));
            if (r.holdSec >= r.holdAfterTargetSec) {
                _clearVacuumCalTimers();
                r.phase = 'prompt';
                _setCalRunEl('cal-run-status', 'Enter external gauge reading');
                showCalibrationGaugeModal(r);
            }
        }, 1000);
    }

    function _clearVacuumCalTimers() {
        if (window._vacuumCalHoldTimer != null) {
            clearInterval(window._vacuumCalHoldTimer);
            window._vacuumCalHoldTimer = null;
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
            if (!run || run.phase === 'done' || run.phase === 'idle' || run.phase === 'prompt') return;
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

    function abortVacuumCalibration() {
        _clearVacuumCalTimers();
        _stopCalPressurePoll();
        _closeVacuumCalEs();
        if (typeof apiRequest === 'function') {
            apiRequest(API_BASE + '/api/hardware/calibration/stop', { method: 'POST' }).catch(function () {});
        }
        window._vacuumCalRun = null;
        goToPage('validate');
    }
    window.abortVacuumCalibration = abortVacuumCalibration;

    function vacuumCalibrationHardwareMessage(ev) {
        var run = window._vacuumCalRun;
        if (!run || run.phase === 'done' || run.phase === 'prompt') return;
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

    function showCalibrationGaugeModal(run) {
        return new Promise(function (resolve) {
            var modal = document.getElementById('calibration-gauge-modal');
            var input = document.getElementById('cal-gauge-pressure-input');
            var submitBtn = document.getElementById('cal-gauge-submit-btn');
            var cancelBtn = document.getElementById('cal-gauge-cancel-btn');
            if (!modal || !input) {
                resolve(null);
                return;
            }
            input.value = '';
            modal.style.display = 'flex';
            setTimeout(function () {
                try { input.focus(); } catch (e) { /* ignore */ }
            }, 80);
            function cleanup() {
                modal.style.display = 'none';
                if (submitBtn) submitBtn.onclick = null;
                if (cancelBtn) cancelBtn.onclick = null;
            }
            if (cancelBtn) {
                cancelBtn.onclick = function () {
                    cleanup();
                    resolve(null);
                };
            }
            if (submitBtn) {
                submitBtn.onclick = function () {
                    var raw = String(input.value || '').trim();
                    var val = parseFloat(raw);
                    var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
                    if (!raw || isNaN(val) || val < 1) {
                        showAppModal('Enter the actual pressure from the external gauge (mmHg).', 'Calibration');
                        input.focus();
                        return;
                    }
                    if (val > maxVac) {
                        showAppModal('Actual pressure cannot exceed ' + maxVac + ' mmHg.', 'Calibration');
                        input.focus();
                        return;
                    }
                    cleanup();
                    resolve(val);
                };
            }
        }).then(function (actualPressure) {
            if (actualPressure == null) {
                _setCalRunEl('cal-run-status', 'Cancelled — ready to retry');
                if (window._vacuumCalRun) window._vacuumCalRun.phase = 'idle';
                return;
            }
            finishVacuumCalibration(actualPressure);
        });
    }

    function buildCalibrationReportPayload(actualPressure, run) {
        var user = window.currentUser || {};
        var now = new Date().toISOString();
        var td = {
            calibrationSubtype: 'vacuum',
            setVacuumMmHg: run.targetVacuumMmHg,
            actualVacuumMmHg: actualPressure,
            calibValue: actualPressure,
            releaseTimeSec: run.releaseTimeSec,
            holdAfterTargetSec: run.holdAfterTargetSec,
            liveVacuumAtPrompt: run.liveVacuumMmHg,
            status: 'Completed',
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatedByUsername: (typeof normalizeReportUsername === 'function')
                ? normalizeReportUsername(user.username || user.name || '')
                : (user.username || user.name || ''),
            createdAt: now,
            completedAt: now
        };
        return {
            name: 'Calibration - Vacuum - ' + run.targetVacuumMmHg + ' mmHg',
            type: 'calibration',
            calibrationSubtype: 'vacuum',
            status: 'Completed',
            setVacuumMmHg: run.targetVacuumMmHg,
            actualVacuumMmHg: actualPressure,
            calibValue: actualPressure,
            releaseTimeSec: run.releaseTimeSec,
            createdAt: now,
            completedAt: now,
            operatedByUsername: td.operatedByUsername,
            operatorName: td.operatorName,
            employeeId: td.employeeId,
            testData: td
        };
    }

    function saveCalibrationReport(payload) {
        return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
            .then(function (result) {
                var reportId = result && result.id;
                currentReportFilter = 'calibration';
                if (reportId && typeof openReportPreview === 'function') {
                    openReportPreview(reportId, { setGate: true });
                } else {
                    goToPage('reports');
                }
            })
            .catch(function (err) {
                console.error('Failed to save calibration report', err);
                showAppModal('Calibration saved to device failed: ' + (err && err.message ? err.message : 'Unknown error'), 'Calibration');
                goToPage('reports');
            });
    }

    function finishVacuumCalibration(actualPressure) {
        var run = window._vacuumCalRun;
        if (!run) return;
        _setCalRunEl('cal-run-status', 'Applying calibration…');
        apiRequest(API_BASE + '/api/hardware/calibration/apply', {
            method: 'POST',
            body: {
                calibValue: actualPressure,
                releaseTimeSec: run.releaseTimeSec
            }
        }).then(function (res) {
            if (!res || res.ok !== true) {
                return Promise.reject(new Error((res && res.error) ? String(res.error) : 'ESP did not acknowledge calibration'));
            }
            logAuditEvent('Calibration completed', 'Vacuum calibration K=' + actualPressure + ' RL_TM=' + run.releaseTimeSec, {
                eventType: 'lifecycle',
                entityType: 'calibration',
                extra: {
                    setVacuumMmHg: run.targetVacuumMmHg,
                    calibValue: actualPressure,
                    releaseTimeSec: run.releaseTimeSec
                }
            });
            run.phase = 'done';
            _clearVacuumCalTimers();
            _closeVacuumCalEs();
            apiRequest(API_BASE + '/api/hardware/calibration/stop', { method: 'POST' }).catch(function () {});
            var payload = buildCalibrationReportPayload(actualPressure, run);
            window._lastFailedValidation = null;
            return saveCalibrationReport(payload);
        }).catch(function (err) {
            _setCalRunEl('cal-run-status', 'Calibration failed');
            showAppModal('Failed to apply calibration: ' + (err && err.message ? err.message : 'Unknown error'), 'Calibration');
        });
    }

    function startVacuumCalibrationRun() {
        if (window._vacuumCalRun && window._vacuumCalRun.phase && window._vacuumCalRun.phase !== 'idle' && window._vacuumCalRun.phase !== 'done') {
            return;
        }
        var settings = getFactoryCalibrationSettings();
        var startBtn = document.getElementById('btn-calibration-start');
        window._vacuumCalRun = {
            targetVacuumMmHg: settings.targetVacuumMmHg,
            releaseTimeSec: settings.releaseTimeSec,
            holdAfterTargetSec: settings.holdAfterTargetSec,
            liveVacuumMmHg: null,
            holdSec: 0,
            phase: 'starting'
        };
        _setCalRunEl('cal-set-vacuum', String(settings.targetVacuumMmHg));
        _setCalRunEl('cal-live-vacuum', '--');
        _setCalRunEl('cal-release-time', String(settings.releaseTimeSec));
        _setCalRunEl('cal-hold-elapsed', '00:00');
        _setCalRunEl('cal-run-status', 'Starting calibration…');
        if (startBtn) startBtn.disabled = true;
        _clearVacuumCalTimers();
        _closeVacuumCalEs();
        try {
            window._vacuumCalEs = new EventSource((typeof _getHardwareSseUrl === 'function') ? _getHardwareSseUrl() : (API_BASE + '/api/hardware/stream'));
            window._vacuumCalEsListener = vacuumCalibrationHardwareMessage;
            window._vacuumCalEs.addEventListener('message', window._vacuumCalEsListener);
        } catch (esErr) {
            if (startBtn) startBtn.disabled = false;
            if (window._vacuumCalRun) window._vacuumCalRun.phase = 'idle';
            _setCalRunEl('cal-run-status', 'Hardware stream unavailable');
            showAppModal('Could not connect to hardware stream.', 'Calibration');
            return;
        }
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
            var fs = (result && result.settings) ? result.settings : (result || {});
            try { localStorage.setItem('factorySettings', JSON.stringify(fs)); } catch (e) { /* ignore */ }
            settings = getFactoryCalibrationSettings();
            if (window._vacuumCalRun) {
                window._vacuumCalRun.targetVacuumMmHg = settings.targetVacuumMmHg;
                window._vacuumCalRun.releaseTimeSec = settings.releaseTimeSec;
                _setCalRunEl('cal-set-vacuum', String(settings.targetVacuumMmHg));
                _setCalRunEl('cal-release-time', String(settings.releaseTimeSec));
            }
        }).catch(function () { /* use cached */ });
        apiRequest(API_BASE + '/api/hardware/calibration/start', {
            method: 'POST',
            body: { targetVacuumMmHg: settings.targetVacuumMmHg }
        }).then(function (res) {
            if (!res || res.ok !== true) {
                return Promise.reject(new Error((res && res.error) ? String(res.error) : 'Hardware did not acknowledge START_CALIB'));
            }
            if (window._vacuumCalRun) {
                window._vacuumCalRun.phase = 'evacuating';
                _setCalRunEl('cal-run-status', 'Evacuating to ' + settings.targetVacuumMmHg + ' mmHg');
                _setCalRunEl('cal-live-vacuum', '0.0');
                _startCalPressurePoll();
            }
        }).catch(function (err) {
            _closeVacuumCalEs();
            if (startBtn) startBtn.disabled = false;
            if (window._vacuumCalRun) window._vacuumCalRun.phase = 'idle';
            _setCalRunEl('cal-run-status', 'Start failed');
            showAppModal('Failed to start calibration: ' + (err && err.message ? err.message : 'Unknown error'), 'Calibration');
        });
    }

    function initVacuumCalibrationPage() {
        var settings = getFactoryCalibrationSettings();
        var startBtn = document.getElementById('btn-calibration-start');
        window._vacuumCalRun = null;
        _clearVacuumCalTimers();
        _closeVacuumCalEs();
        _setCalRunEl('cal-set-vacuum', String(settings.targetVacuumMmHg));
        _setCalRunEl('cal-live-vacuum', '--');
        _setCalRunEl('cal-release-time', String(settings.releaseTimeSec));
        _setCalRunEl('cal-hold-elapsed', '00:00');
        _setCalRunEl('cal-run-status', 'Ready to start');
        if (startBtn) startBtn.disabled = false;
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

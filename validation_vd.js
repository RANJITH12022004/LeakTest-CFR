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
        var norm = String(data.normalized != null ? data.normalized : data.line || '').replace(/\*$/, '');
        var out = {};
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
            var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
            var parsed = parseVdSseLine(data);
            if (parsed.vacuum != null) {
                var v = parseFloat(parsed.vacuum);
                if (!isNaN(v)) {
                    validationRunCurrentVacuumMmHg = v;
                    setValRunEl('val-run-current-vacuum', v.toFixed(1));
                    _maybeStartVdHold(v);
                }
            }
            if (parsed.pressure != null) {
                var p = parseFloat(parsed.pressure);
                if (!isNaN(p)) {
                    validationRunCurrentVacuumMmHg = p;
                    setValRunEl('val-run-current-vacuum', p.toFixed(1));
                    _maybeStartVdHold(p);
                }
            }
            if (kind === 'completed' || norm === 'completed' || norm === 'complete.') {
                if (validationRunIntervalId != null) {
                    clearInterval(validationRunIntervalId);
                    validationRunIntervalId = null;
                }
                if (validationRunHoldStarted) {
                    completeValidationRunAfterDuration();
                }
            }
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

    function _maybeStartVdHold(vacuumVal) {
        if (validationRunHoldStarted || validationRunState !== 'running') return;
        var target = window._vdValidationParams && window._vdValidationParams.vacuumMmHg;
        if (target == null || isNaN(parseFloat(target))) return;
        if (vacuumVal < parseFloat(target)) return;
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
                setValRunEl('val-run-elapsed-time', '00:00');
                setValRunEl('val-run-current-vacuum', '0.0');
                setValRunEl('val-run-status', 'Evacuating');
                setValRunEl('val-run-status-sub', 'Waiting for set vacuum');
                _setValRunStatusStyle('running');
                _setValResultVisible(false);
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

    function initVacuumCalibrationPage() {
        var data = window._lastFailedValidation;
        var params = window._vdValidationParams || {};
        if (!data && params.vacuumMmHg == null) {
            goToPage('validate');
            return;
        }
        var setVacuum = (params.vacuumMmHg != null)
            ? params.vacuumMmHg
            : (data && data.setVacuumMmHg != null ? data.setVacuumMmHg : null);
        var setDurationDisplay = (params.durationDisplay)
            || (data && data.setDurationDisplay)
            || '--';
        var setVacEl = document.getElementById('cal-set-vacuum');
        var actualVacEl = document.getElementById('cal-actual-vacuum');
        var setTimeEl = document.getElementById('cal-set-time');
        var actualTimeEl = document.getElementById('cal-actual-time');
        if (setVacEl) setVacEl.textContent = setVacuum != null ? String(setVacuum) : '--';
        if (actualVacEl) {
            actualVacEl.value = '';
            var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
            actualVacEl.max = String(maxVac);
        }
        if (setTimeEl) setTimeEl.textContent = setDurationDisplay;
        if (actualTimeEl) {
            actualTimeEl.textContent = (data && data.actualDurationDisplay)
                || (data && data.actualDurationSec != null ? formatMmSs(data.actualDurationSec) : '--');
        }
        if (!window._vacuumCalGaugePromptShown) {
            window._vacuumCalGaugePromptShown = true;
            showAppModal('Please use pressure gauge', 'Instruction');
        }
        if (actualVacEl) {
            setTimeout(function () {
                try { actualVacEl.focus(); } catch (e) { /* ignore */ }
            }, 80);
        }
    }

    window.confirmVacuumCalibration = function () {
        var data = window._lastFailedValidation || {};
        var params = window._vdValidationParams || {};
        var setVacuum = (params.vacuumMmHg != null)
            ? params.vacuumMmHg
            : (data.setVacuumMmHg != null ? data.setVacuumMmHg : null);
        var actualVacEl = document.getElementById('cal-actual-vacuum');
        var actualRaw = actualVacEl ? String(actualVacEl.value || '').trim() : '';
        var actualVacuum = parseFloat(actualRaw);
        var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
        if (!actualRaw || isNaN(actualVacuum) || actualVacuum < 1) {
            showAppModal('Enter the actual vacuum (mmHg).', 'Calibration');
            if (actualVacEl) actualVacEl.focus();
            return;
        }
        if (actualVacuum > maxVac) {
            showAppModal('Actual vacuum cannot exceed ' + maxVac + ' mmHg.', 'Calibration');
            if (actualVacEl) actualVacEl.focus();
            return;
        }
        logAuditEvent('Calibration confirmed', 'Operator entered actual vacuum on calibration — no report generated', {
            eventType: 'lifecycle',
            entityType: 'calibration',
            extra: {
                validationType: 'distance',
                setVacuumMmHg: setVacuum,
                actualVacuumMmHg: actualVacuum
            }
        });
        window._lastFailedValidation = null;
        validationCompletion.distance = false;
        if (validationSessionResults) validationSessionResults.distance = null;
        goToPage('validate');
    };

    var _origGoToPageVd = window.goToPage;
    window.goToPage = function (pageName) {
        var result = _origGoToPageVd.apply(this, arguments);
        if (pageName === 'vd-validation-input') {
            setTimeout(initVdValidationInputPage, 50);
        }
        if (pageName === 'vacuum-calibration') {
            window._vacuumCalGaugePromptShown = false;
            setTimeout(initVacuumCalibrationPage, 50);
        }
        return result;
    };

})();

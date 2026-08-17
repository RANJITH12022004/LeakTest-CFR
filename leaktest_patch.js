/**
 * leaktest_patch.js — Leak Test adaptations overriding tap-density helpers in script.js
 */
(function () {
    'use strict';

    var DEFAULT_CYCLE_COUNT = 3;
    var STANDARD_HOLD_SECONDS = [30, 60, 30];

    window._leakTestLastReading = { pressureMbar: null, leakRate: null, cycleResult: null };

    function methodLabel(mode) {
        mode = String(mode || '').toUpperCase();
        if (mode === 'VACUUM_DECAY') return 'Vacuum Decay';
        if (mode === 'PRESSURE_DECAY') return 'Pressure Decay';
        if (mode === 'CUSTOM') return 'Custom';
        return mode || '--';
    }

    function chamberLabel(val) {
        var s = String(val || '').toUpperCase();
        if (s === 'SMALL' || s === '50') return 'Small';
        if (s === 'MEDIUM' || s === '100') return 'Medium';
        if (s === 'LARGE' || s === '250') return 'Large';
        return val || '--';
    }

    function normalizeChamber(val) {
        var s = String(val || '').toUpperCase();
        if (s === '50' || s === 'SMALL' || s === 'S') return 'SMALL';
        if (s === '100' || s === 'MEDIUM' || s === 'M') return 'MEDIUM';
        if (s === '250' || s === 'LARGE' || s === 'L') return 'LARGE';
        return s;
    }

    function evacuationLabel(rate) {
        var s = String(rate || '').toUpperCase();
        return s === 'FAST' ? 'Fast' : (s === 'STANDARD' ? 'Standard' : (rate || '--'));
    }

    function recipeTargetVacuum(recipe) {
        if (!recipe) return null;
        if (recipe.targetVacuumMbar != null) return parseFloat(recipe.targetVacuumMbar);
        if (recipe.dropHeight != null) {
            var h = parseFloat(recipe.dropHeight);
            if (!isNaN(h) && h < 0) return h;
            if (!isNaN(h) && h <= 5) return -100;
            if (!isNaN(h)) return -50;
        }
        var mode = String(recipe.method || recipe.uspMode || '').toUpperCase();
        if (mode === 'VACUUM_DECAY') return -50;
        if (mode === 'PRESSURE_DECAY') return -100;
        return null;
    }

    function recipeEvacuationRate(recipe) {
        if (!recipe) return 'STANDARD';
        if (recipe.evacuationRate) return String(recipe.evacuationRate).toUpperCase();
        var speed = recipe.speed != null ? String(recipe.speed).toUpperCase() : '';
        if (speed === 'FAST' || speed === 'STANDARD') return speed;
        var sp = parseInt(recipe.speed, 10);
        if (sp === 300) return 'FAST';
        if (sp === 250) return 'STANDARD';
        var mode = String(recipe.method || recipe.uspMode || '').toUpperCase();
        if (mode === 'VACUUM_DECAY') return 'FAST';
        if (mode === 'PRESSURE_DECAY') return 'STANDARD';
        return 'STANDARD';
    }

    function recipeCyclesFrom(recipe) {
        if (!recipe) return [];
        if (recipe.cycles && recipe.cycles.length) return recipe.cycles;
        var steps = recipe.steps || [];
        return steps.map(function (s) {
            return { holdSeconds: parseInt(s.holdSeconds || s.tapCount || 30, 10) || 30 };
        });
    }

    function buildLeakRecipeFromForm(prefix) {
        prefix = prefix || 'quick';
        var productName = (document.getElementById(prefix + '-product-name') || document.getElementById('recipe-product-name'));
        var batchNumber = (document.getElementById(prefix + '-batch-number'));
        var modeFn = prefix === 'quick' ? getQuickUspMode : getCreateUspMode;
        var mode = modeFn();
        var targetVacuum = -50;
        var evacuationRate = 'FAST';
        if (mode === 'VACUUM_DECAY') {
            targetVacuum = -50;
            evacuationRate = 'FAST';
        } else if (mode === 'PRESSURE_DECAY') {
            targetVacuum = -100;
            evacuationRate = 'STANDARD';
        } else {
            var speedRadio = document.querySelector('input[name="' + prefix + '-speed"]:checked') ||
                document.querySelector('input[name="create-speed"]:checked');
            evacuationRate = speedRadio ? String(speedRadio.value).toUpperCase() : 'STANDARD';
            var heightRadio = document.querySelector('input[name="' + prefix + '-height"]:checked') ||
                document.querySelector('input[name="create-height"]:checked');
            targetVacuum = heightRadio ? parseFloat(heightRadio.value) : -50;
        }
        var chamberRadio = document.querySelector('input[name="' + prefix + '-cylinder"]:checked') ||
            document.querySelector('input[name="create-cylinder"]:checked');
        var chamberSize = chamberRadio ? normalizeChamber(chamberRadio.value) : 'MEDIUM';
        var holds;
        if (isUspStandardProcedureMode(mode)) {
            holds = computeStandardUspTaps(DEFAULT_CYCLE_COUNT);
        } else if (prefix === 'quick' && window._quickStepTaps && window._quickStepTaps.length) {
            holds = window._quickStepTaps.slice();
        } else if (prefix !== 'quick' && window._createRecipeStepTaps && window._createRecipeStepTaps.length) {
            holds = window._createRecipeStepTaps.slice();
        } else {
            holds = STANDARD_HOLD_SECONDS.slice();
        }
        var cycles = holds.map(function (h) { return { holdSeconds: parseInt(h, 10) || 30 }; });
        var steps = cycles.map(function (c) {
            return {
                holdSeconds: c.holdSeconds,
                tapCount: c.holdSeconds,
                speed: evacuationRate,
                dropHeight: targetVacuum
            };
        });
        return {
            productName: productName && productName.value ? String(productName.value).trim() : '',
            batchNumber: batchNumber && batchNumber.value ? String(batchNumber.value).trim() : '',
            name: productName && productName.value ? String(productName.value).trim() : '',
            method: mode,
            uspMode: mode,
            usp: methodLabel(mode),
            targetVacuumMbar: targetVacuum,
            evacuationRate: evacuationRate,
            speed: evacuationRate,
            dropHeight: targetVacuum,
            chamberSize: chamberSize,
            sampleVolumeMl: chamberSize,
            stepCount: cycles.length,
            cycles: cycles,
            steps: steps,
            maxLeakRate: 0.5
        };
    }

    // --- Override standard procedure helpers ---
    window.USP_DEFAULT_STEP_COUNT = DEFAULT_CYCLE_COUNT;

    window.computeStandardUspTaps = function (stepCount) {
        var n = Math.max(1, parseInt(stepCount, 10) || DEFAULT_CYCLE_COUNT);
        var holds = [];
        for (var i = 0; i < n; i++) {
            holds.push(STANDARD_HOLD_SECONDS[i % STANDARD_HOLD_SECONDS.length]);
        }
        return holds;
    };

    window.formatUspStandardTapsSummary = function (stepCount) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || DEFAULT_CYCLE_COUNT));
        var holds = computeStandardUspTaps(n);
        var parts = [];
        for (var i = 0; i < n; i++) {
            parts.push('Cycle ' + (i + 1) + ': ' + holds[i] + 's');
        }
        return parts.join('  |  ');
    };

    window.applyQuickUspModeToSpeedHeight = function () {
        var mode = getQuickUspMode();
        var speedWrap = document.getElementById('quick-custom-speed-height-wrap');
        if (speedWrap) speedWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
        var quickStepsSec = document.getElementById('quick-recipe-steps-section');
        if (quickStepsSec) quickStepsSec.style.display = mode === 'CUSTOM' ? '' : 'none';
        if (isUspStandardProcedureMode(mode)) {
            applyStandardUspStepDefaults('quick');
            if (typeof _refreshQuickStepSummary === 'function') _refreshQuickStepSummary();
        }
        if (mode === 'VACUUM_DECAY') {
            var s1 = document.querySelector('input[name="quick-speed"][value="FAST"]');
            var h1 = document.querySelector('input[name="quick-height"][value="-50"]');
            if (s1) s1.checked = true;
            if (h1) h1.checked = true;
        } else if (mode === 'PRESSURE_DECAY') {
            var s2 = document.querySelector('input[name="quick-speed"][value="STANDARD"]');
            var h2 = document.querySelector('input[name="quick-height"][value="-100"]');
            if (s2) s2.checked = true;
            if (h2) h2.checked = true;
        }
        if (typeof _updateQuickStepsPageUspUi === 'function') _updateQuickStepsPageUspUi();
    };

    window.applyCreateUspModeToSpeedHeight = function () {
        var mode = getCreateUspMode();
        var speedWrap = document.getElementById('create-custom-speed-height-wrap');
        if (speedWrap) speedWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
        var stepsSec = document.getElementById('create-recipe-steps-section');
        if (stepsSec) stepsSec.style.display = mode === 'CUSTOM' ? '' : 'none';
        if (isUspStandardProcedureMode(mode)) {
            applyStandardUspStepDefaults('create');
            if (typeof _refreshCreateStepSummary === 'function') _refreshCreateStepSummary();
        }
        if (mode === 'VACUUM_DECAY') {
            var s1 = document.querySelector('input[name="create-speed"][value="FAST"]');
            var h1 = document.querySelector('input[name="create-height"][value="-50"]');
            if (s1) s1.checked = true;
            if (h1) h1.checked = true;
        } else if (mode === 'PRESSURE_DECAY') {
            var s2 = document.querySelector('input[name="create-speed"][value="STANDARD"]');
            var h2 = document.querySelector('input[name="create-height"][value="-100"]');
            if (s2) s2.checked = true;
            if (h2) h2.checked = true;
        }
        if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
        if (typeof _updateCreateStepsPageUspUi === 'function') _updateCreateStepsPageUspUi();
    };

    window._updateQuickStepsPageUspUi = function () {
        var standard = isUspStandardProcedureMode(getQuickUspMode());
        var tapsWrap = document.getElementById('quick-steps-taps-wrap');
        var infoEl = document.getElementById('quick-usp-taps-readonly');
        if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
        if (infoEl) {
            if (standard) {
                var radio = document.querySelector('input[name="quick-step-card"]:checked');
                var n = radio ? parseInt(radio.value, 10) : (window._quickStepCount || DEFAULT_CYCLE_COUNT);
                infoEl.textContent = 'Hold times are fixed for standard methods: ' + formatUspStandardTapsSummary(n);
                infoEl.style.display = '';
            } else {
                infoEl.style.display = 'none';
            }
        }
    };

    window._updateCreateStepsPageUspUi = function () {
        var standard = isUspStandardProcedureMode(getCreateUspMode());
        var tapsWrap = document.getElementById('create-steps-taps-wrap');
        var infoEl = document.getElementById('create-usp-taps-readonly');
        if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
        if (infoEl) {
            if (standard) {
                var radio = document.querySelector('input[name="create-step-card"]:checked');
                var n = radio ? parseInt(radio.value, 10) : (window._createRecipeStepCount || DEFAULT_CYCLE_COUNT);
                infoEl.textContent = 'Hold times are fixed for standard methods: ' + formatUspStandardTapsSummary(n);
                infoEl.style.display = '';
            } else {
                infoEl.style.display = 'none';
            }
        }
    };

    window.recipeUspLabel = function (r) {
        if (!r) return '--';
        return methodLabel(r.method || r.uspMode || r.usp);
    };

    window.recipeTapSpeed = function (r) {
        return recipeEvacuationRate(r);
    };

    window.recipeDropHeightMm = function (r) {
        return recipeTargetVacuum(r);
    };

    window.getTestRunSteps = function () {
        var recipe = lastTestRunRecipe;
        if (!recipe) return null;
        var cycles = recipeCyclesFrom(recipe);
        if (cycles.length) {
            return cycles.map(function (c) {
                return {
                    holdSeconds: c.holdSeconds,
                    tapCount: c.holdSeconds,
                    speed: recipeEvacuationRate(recipe),
                    dropHeight: recipeTargetVacuum(recipe)
                };
            });
        }
        if (recipe.steps && recipe.steps.length > 0) return recipe.steps;
        return [{ holdSeconds: 30, tapCount: 30 }];
    };

    window.getTestRunStepTapTarget = function (stepIndex) {
        var step = testRunSteps[stepIndex];
        if (!step) return 0;
        return parseInt(step.holdSeconds || step.tapCount, 10) || 0;
    };

    // startQuickTestRun and startTestRun: simplified vacuum-hold versions live in script.js.

    window.renderTestRunResultsTable = function () {
        var tbody = document.getElementById('test-run-results-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!testRunStepResults || testRunStepResults.length === 0) {
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="6">No cycle data yet.</td>';
            tbody.appendChild(emptyRow);
            return;
        }
        testRunStepResults.forEach(function (entry) {
            var tr = document.createElement('tr');
            var cycleNumber = entry.stepIndex + 1;
            tr.innerHTML =
                '<td>' + cycleNumber + '</td>' +
                '<td>' + (entry.targetPressure != null ? entry.targetPressure : '--') + '</td>' +
                '<td>' + (entry.measuredPressure != null ? entry.measuredPressure : '--') + '</td>' +
                '<td>' + (entry.deltaPressure != null ? entry.deltaPressure : '--') + '</td>' +
                '<td>' + (entry.leakRate != null ? entry.leakRate : entry.tapDensity || '--') + '</td>' +
                '<td>' + (entry.resultText || '--') + '</td>';
            tbody.appendChild(tr);
        });
    };

    window.recordCurrentStepResult = function () {
        var bulkEl = document.getElementById('run-bulk-density');
        var tapEl = document.getElementById('run-tap-density');
        var resultEl = document.getElementById('run-result');
        var reading = window._leakTestLastReading || {};
        var recipe = lastTestRunRecipe || {};
        var target = recipeTargetVacuum(recipe);
        var measured = reading.pressureMbar;
        var entry = {
            stepIndex: testRunCurrentStepIndex,
            targetPressure: target,
            measuredPressure: measured,
            deltaPressure: (target != null && measured != null) ? (measured - target).toFixed(2) : '--',
            leakRate: reading.leakRate,
            bulkDensity: bulkEl ? bulkEl.textContent : '--',
            tapDensity: tapEl ? tapEl.textContent : '--',
            resultText: reading.cycleResult || (resultEl ? resultEl.textContent : '--')
        };
        testRunStepResults.push(entry);
        renderTestRunResultsTable();
        syncTestRunCheckpoint();
    };

    window._testRunFinishStepVolumeAndResults = function (stepIndex) {
        recordCurrentStepResult();
        var isLastStep = (stepIndex + 1) >= testRunTotalSteps;
        showTestRunStepCompleteModal(isLastStep);
        return Promise.resolve(true);
    };

    window.updateTestRunTapDisplay = function (elapsedSeconds) {
        var target = getTestRunStepTapTarget(testRunCurrentStepIndex);
        var elapsed = parseFloat(elapsedSeconds, 10) || 0;
        testRunCurrentTapCount = elapsed;
        setRunCard('run-tap-count-card', String(Math.floor(elapsed)));
        setRunCard('run-tap-count-of-card', 'of ' + target + 's');
    };

    function parseLeakSseLine(data) {
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

    window.waitForHardwareTapSequence = function (holdSeconds, _speedMode, opts) {
        opts = opts || {};
        var recipe = lastTestRunRecipe || {};
        var holdGoal = Math.max(1, parseInt(holdSeconds, 10) || 30);
        return new Promise(function (resolve, reject) {
            if (!testRunHardwareEs) {
                reject(new Error('Hardware stream not connected.'));
                return;
            }
            var handler = function (ev) {
                try {
                    var raw = ev.data;
                    if (raw == null || raw === '') return;
                    var data = JSON.parse(raw);
                    if (data.ping) return;
                    var kind = String(data.kind || '');
                    var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
                    var parsed = parseLeakSseLine(data);
                    if (parsed.pressure != null) {
                        var p = parseFloat(parsed.pressure);
                        if (!isNaN(p)) {
                            window._leakTestLastReading.pressureMbar = p.toFixed(2);
                            setRunCard('run-bulk-density', p.toFixed(2));
                        }
                    }
                    if (parsed.leak != null) {
                        var lr = parseFloat(parsed.leak);
                        if (!isNaN(lr)) {
                            window._leakTestLastReading.leakRate = lr.toFixed(3);
                            setRunCard('run-tap-density', lr.toFixed(3));
                            var maxLeak = parseFloat(recipe.maxLeakRate || 0.5);
                            var passFail = lr <= maxLeak ? 'PASS' : 'FAIL';
                            window._leakTestLastReading.cycleResult = passFail;
                            setRunCard('run-result', passFail);
                        }
                    }
                    if (parsed.elapsed != null) {
                        updateTestRunTapDisplay(parsed.elapsed);
                    }
                    if (parsed.complete) {
                        window._leakTestLastReading.cycleResult = parsed.complete;
                        setRunCard('run-result', parsed.complete);
                    }
                    if (kind === 'completed' || norm === 'completed' || norm === 'complete.') {
                        cleanup();
                        resolve();
                        return;
                    }
                    if (norm.indexOf('complete:') >= 0 || (parsed.complete && (parsed.complete === 'PASS' || parsed.complete === 'FAIL'))) {
                        cleanup();
                        resolve();
                        return;
                    }
                    if (kind === 'adapter_error') {
                        cleanup();
                        reject(new Error('adapter_interrupt'));
                    }
                    if (kind === 'error') {
                        cleanup();
                        reject(new Error(norm || 'Hardware reported an error.'));
                    }
                } catch (ex) { /* ignore */ }
            };

            function cleanup() {
                if (testRunHardwareEs) {
                    testRunHardwareEs.removeEventListener('message', handler);
                }
                if (_testRunHardwareTapListener === handler) {
                    _testRunHardwareTapListener = null;
                }
            }

            _testRunHardwareTapListener = handler;
            testRunHardwareEs.addEventListener('message', handler);

            var payload = {
                targetVacuumMbar: recipeTargetVacuum(recipe),
                evacuationRate: recipeEvacuationRate(recipe),
                chamberSize: normalizeChamber(recipe.chamberSize || recipe.sampleVolumeMl || 'MEDIUM'),
                maxLeakRate: parseFloat(recipe.maxLeakRate || 0.5),
                cycles: [{ holdSeconds: holdGoal }]
            };

            apiRequest(API_BASE + '/api/hardware/leak/start', {
                method: 'POST',
                body: payload
            }).then(function (res) {
                if (!res || res.ok === false) {
                    cleanup();
                    reject(new Error((res && res.error) ? String(res.error) : 'Leak test start rejected.'));
                }
            }).catch(function (err) {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
            });
        });
    };

    window.runTestRunHardwareStep = function (stepIndex, opts) {
        opts = opts || {};
        if (stepIndex < 0 || stepIndex >= testRunTotalSteps) return Promise.resolve();
        var step = testRunSteps[stepIndex];
        if (!step) return Promise.reject(new Error('Invalid cycle.'));
        testRunCurrentStepIndex = stepIndex;
        var holdTarget = getTestRunStepTapTarget(stepIndex);
        if (holdTarget < 1) return Promise.reject(new Error('Invalid hold time for this cycle.'));
        if (!opts.resume) testRunStepTapsBase = 0;
        setRunCard('run-current-step-card', String(stepIndex + 1));
        setRunCard('run-tap-count-of-card', 'of ' + holdTarget + 's');
        updateTestRunTapDisplay(0);
        window._leakTestLastReading = { pressureMbar: null, leakRate: null, cycleResult: null };
        if (opts.resume) {
            setRunCard('run-status-text', 'Running');
            setRunCard('run-status-subtext', 'Test in progress');
        }
        return waitForHardwareTapSequence(holdTarget, null, { baseCompleted: testRunStepTapsBase })
            .then(function () { return _testRunFinishStepVolumeAndResults(stepIndex); })
            .catch(function (err) {
                if (err && err.message === 'adapter_interrupt') {
                    pauseTestRunForAdapterInterrupt();
                    return;
                }
                return Promise.reject(err);
            });
    };

    window.openTestRunInitialWeightModal = function () {
        return new Promise(function (resolve) {
            _testRunInitialWeightResolve = resolve;
            var overlay = document.getElementById('test-run-initial-weight-overlay');
            var input = document.getElementById('test-run-initial-weight-input');
            var label = overlay && overlay.querySelector('label');
            if (label) label.textContent = 'Sample ID';
            if (input) {
                input.placeholder = 'Enter sample ID';
                input.value = 'SAMPLE-001';
            }
            if (overlay) overlay.style.display = 'flex';
            setTimeout(function () {
                if (input && typeof openOSKForInput === 'function') openOSKForInput(input);
            }, 0);
        });
    };

    // toggleTestRunState: simplified vacuum-hold version lives in script.js.

    window._leakPatchLoadManageRecipesUnused = function () {
        var msgEl = document.getElementById('manage-recipes-message');
        var tableEl = document.querySelector('.manage-recipes-table');
        var tbody = document.getElementById('manage-recipes-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';
        refreshActiveQaCount();
        getRecipes().then(function (recipes) {
            var mode = recipeListMode === 'load' ? 'load' : 'manage';
            var createBtn = document.querySelector('#page-manage-recipes .btn-create-recipe');
            var u = window.currentUser;
            var canManage = u && typeof canAccess === 'function' && canAccess(u, 'recipe-manage');
            if (createBtn) createBtn.style.display = (mode === 'load' || !canManage) ? 'none' : '';
            if (tableEl) {
                var headRow = tableEl.querySelector('thead tr');
                if (headRow) {
                    if (mode === 'load') {
                        headRow.innerHTML = '<th>Product</th><th>Chamber</th><th>Cycles</th><th>Target Vacuum</th><th>Evacuation Rate</th><th>Method</th><th class="actions-col">Load</th>';
                    } else {
                        headRow.innerHTML = '<th>Product</th><th>Chamber</th><th>Cycles</th><th>Target Vacuum</th><th>Evacuation Rate</th><th>Method</th><th>Approval</th><th class="actions-col">Actions</th>';
                    }
                }
            }
            if (mode === 'load') {
                recipes = (recipes || []).filter(function (r) { return getEffectiveRecipeApprovalStatus(r) === 'approved'; });
            }
            if (!recipes.length) {
                if (msgEl) {
                    msgEl.style.display = '';
                    msgEl.textContent = mode === 'load' ? 'No approved recipes available.' : 'No recipes found.';
                }
                if (tableEl) tableEl.style.display = 'none';
                return;
            }
            lastDisplayedRecipes = recipes;
            if (msgEl) msgEl.style.display = 'none';
            if (tableEl) tableEl.style.display = '';
            recipes.forEach(function (r) {
                var tr = document.createElement('tr');
                var name = r.productName || r.name || '--';
                var chamber = chamberLabel(r.chamberSize || r.sampleVolumeMl);
                var cyclesCount = r.stepCount || (r.cycles && r.cycles.length) || (r.steps && r.steps.length) || '--';
                var tv = recipeTargetVacuum(r);
                var tvStr = tv != null ? String(tv) + ' mbar' : '--';
                var evacStr = evacuationLabel(recipeEvacuationRate(r));
                var methodStr = recipeUspLabel(r);
                if (mode === 'load') {
                    tr.innerHTML = '<td>' + name + '</td><td>' + chamber + '</td><td>' + cyclesCount + '</td><td>' + tvStr + '</td><td>' + evacStr + '</td><td>' + methodStr + '</td><td class="actions-cell actions-col"><button type="button" class="btn-action btn-load" onclick="loadRecipeById(' + (r.id || 0) + ')" title="Load">Load</button></td>';
                } else {
                    var appr = getEffectiveRecipeApprovalStatus(r);
                    var apprLabel = appr === 'pending' ? 'Pending' : 'Approved';
                    var actionsBtnHtml = '<button type="button" class="btn-action btn-actions" onclick="openRecipeActionsModal(' + (r.id || 0) + ')" title="Actions"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg> Actions</button>';
                    tr.innerHTML = '<td>' + name + '</td><td>' + chamber + '</td><td>' + cyclesCount + '</td><td>' + tvStr + '</td><td>' + evacStr + '</td><td>' + methodStr + '</td><td>' + apprLabel + '</td><td class="actions-cell">' + actionsBtnHtml + '</td>';
                }
                tbody.appendChild(tr);
            });
        });
    };

    function persistLeakRecipe(recipe) {
        window._recipeSaveInFlight = true;
        var editId = window.currentEditingRecipeId;
        var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
        var method = editId ? 'PUT' : 'POST';
        return apiRequest(url, { method: method, body: recipe }).then(function (result) {
            window._recipeSaveInFlight = false;
            window.currentEditingRecipeId = null;
            return result;
        }).catch(function (err) {
            window._recipeSaveInFlight = false;
            throw err;
        });
    }

    // completeRecipeFromStep2 and onCreateRecipeContinueClick: simplified recipe
    // (name + vacuum + time) versions live in script.js.

})();

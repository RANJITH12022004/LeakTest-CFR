// Leak Test - navigation + API
document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || e.key === '=')) e.preventDefault();
});
['gesturestart', 'gesturechange', 'gestureend'].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false });
});
document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length > 1) e.preventDefault();
}, { passive: false });

var API_BASE = '';
var currentReportFilter = null;
var membersCache = [];
var FACTORY_USERNAME = 'RLERLT';
var currentMemberIdForRoleEdit = null;
var appModalResolve = null;
var lastValidationType = 'distance'; // 'distance' = Vacuum Decay, 'load' = Pressure Decay
var validationRunState = 'idle'; // 'idle' | 'running'
var validationRunIntervalId = null;
var validationRunCurrentCount = 0;
var validationRunTarget = 300;
var validationRunTolerance = 15;
var validationRunMin = 285;
var validationRunMax = 315;
var validationRunBackendPending = false;
var validationHardwareEnabled = true;
var validationCompletion = { distance: false, load: false }; // distance=Vacuum Decay, load=Pressure Decay
/** VACUUM_DECAY (distance) and PRESSURE_DECAY (load) results held until both validations complete. */
var validationSessionResults = { distance: null, load: null };
/** 60s timed validation: hardware hold time via SSE */
var validationRunHardwareEs = null;
var validationRunSseListener = null;
var VALIDATION_RUN_DURATION_SEC = 60;
var validationRunSecondsRemaining = 60;
var biometricEnabledSetting = true;
var currentReportId = null;
var currentReportData = null;
var currentRecipeForPrint = null;
var lastKnownDateTime = null;
var dateTimeClockInterval = null;
var _wallClockResyncInterval = null;
var lastDisplayedRecipes = [];
var pendingRecipeToLoad = null;
var _recipeSaveInFlight = false;
var recipeListMode = 'manage'; // 'manage' | 'load'
var approvalVerifyResolve = null;
var approvalVerifyReject = null;
var adminApprovalVerifyResolve = null;
var adminApprovalVerifyReject = null;
var _approvalVerifyModalOriginal = null;
var _approvalVerifyButtonOriginal = null;
var _approvalVerifyEmptyCredentialsMessage = 'Enter QA username and password.';
var _approvalVerifyPurpose = 'recipe';
var _suppressTestRunNavGuardOnce = false;
var _suppressValidationNavGuardOnce = false;
/** 'expired' | 'mandatory' — which POST to use from the shared reset page. */
var _passwordResetScreenMode = 'expired';
var _mandatoryPasswordResetPending = false;

/** Display label: Supervisor role shown as Reviewer (stored value unchanged). */
function displayRoleLabel(role) {
    var r = String(role || '').trim();
    if (String(r).toLowerCase() === 'supervisor') return 'Reviewer';
    return r || '--';
}

/** Approved-by line may contain "(supervisor)" from stored reports — show as Reviewer. */
function formatApprovedByLine(line) {
    var s = String(line || '').trim();
    if (!s || s === '--') return '--';
    return s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
}

/** Audit trail details: hide inactivity limits; show Reviewer instead of Supervisor. */
function formatAuditDetailsText(details) {
    var s = String(details || '');
    s = s.replace(/\s*\(\s*\d+\s*min\s+limit\s*\)/gi, '');
    s = s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
    return s.trim();
}

function isQuickTestRecipe(recipe) {
    if (!recipe) return false;
    if (recipe.testSource === 'quick') return true;
    if (recipe.testSource === 'recipe') return false;
    var recipeId = recipe.id || recipe.recipeId;
    return !recipeId;
}

function formatTestAuditDetails(recipe, parts) {
    parts = parts || {};
    var segs = [];
    segs.push('type: ' + (isQuickTestRecipe(recipe) ? 'Quick Test' : 'Recipe Test'));
    var name = (recipe && (recipe.productName || recipe.name)) || '';
    if (name) segs.push('recipe: ' + name);
    var batch = recipe && recipe.batchNumber;
    if (batch != null && String(batch).trim() && String(batch).trim() !== '--') {
        segs.push('batch: ' + String(batch).trim());
    }
    if (recipe && recipe.vacuumMmHg != null && !isNaN(recipe.vacuumMmHg)) {
        segs.push('vacuum: ' + recipe.vacuumMmHg + ' mmHg');
    }
    if (recipe && recipe.durationDisplay) {
        segs.push('time: ' + recipe.durationDisplay);
    } else if (recipe && recipe.durationSec != null) {
        segs.push('time: ' + recipe.durationSec + 's');
    }
    if (parts.result) segs.push('result: ' + parts.result);
    if (parts.reportId) segs.push('report id ' + parts.reportId);
    if (parts.reason) segs.push(String(parts.reason));
    return segs.join(' | ');
}

function testAuditExtra(recipe, more) {
    more = more || {};
    return Object.assign({
        testType: isQuickTestRecipe(recipe) ? 'quick' : 'recipe',
        productName: recipe && recipe.productName,
        recipeName: recipe && recipe.productName,
        batchNumber: recipe && recipe.batchNumber,
        recipeId: recipe && (recipe.id || recipe.recipeId || ''),
        vacuumMmHg: recipe && recipe.vacuumMmHg,
        durationSec: recipe && recipe.durationSec
    }, more);
}

function getActivePageName() {
    var active = document.querySelector('.page.active');
    if (!active || !active.id) return '';
    return active.id.indexOf('page-') === 0 ? active.id.slice(5) : active.id;
}

function isEditableTarget(el) {
    if (!el) return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (el.isContentEditable) return true;
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var t = String(el.type || 'text').toLowerCase();
    return t !== 'button' && t !== 'checkbox' && t !== 'radio' && t !== 'submit' && t !== 'reset';
}

function isTestRunActive() {
    return getActivePageName() === 'test-run' && testRunButtonState === 'abort';
}

function isValidationOperationActive() {
    return validationRunState === 'running' || validationRunBackendPending === true;
}

function isValidationRunActive() {
    return isValidationOperationActive();
}

function applyValidationRunLockUi(locked) {
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('validation-run-locked', !!locked);
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = locked ? 'none' : '';
        btn.style.opacity = locked ? '0.45' : '';
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
    });
    var logoEl = document.getElementById('header-logo');
    if (logoEl) logoEl.style.pointerEvents = locked ? 'none' : '';
}

function isValidationPartiallyCompleted() {
    return !!validationCompletion.distance;
}

function isValidationFullyCompleted() {
    return !!validationCompletion.distance;
}

function getMissingValidationLabel() {
    return validationCompletion.distance ? '' : 'Vacuum';
}

function stopActiveRunForLogout() {
    if (testRunButtonState === 'abort' && typeof abortTestRunAndSave === 'function') {
        return abortTestRunAndSave();
    }

    // Abort active validation hardware run before logout.
    if (validationRunState === 'running' || validationRunBackendPending) {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        _closeValidationRunHardwareEs();
        return stopValidationOnBackend().catch(function () {}).finally(function () {
            validationRunState = 'idle';
            validationRunBackendPending = false;
        });
    }
    return Promise.resolve();
}

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    if (isEditableTarget(e.target)) return;
    if (isTestRunActive() || isValidationRunActive()) {
        e.preventDefault();
    }
}, true);

function closeAppModal() {
    var overlay = document.getElementById('app-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    if (appModalResolve) {
        appModalResolve(false);
        appModalResolve = null;
    }
}

function showAppModal(message, title, onClose) {
    var overlay = document.getElementById('app-modal-overlay');
    var titleEl = document.getElementById('app-modal-title');
    var msgEl = document.getElementById('app-modal-message');
    var buttonsEl = document.getElementById('app-modal-buttons');
    if (!overlay || !titleEl || !msgEl || !buttonsEl) {
        window.alert(message);
        if (typeof onClose === 'function') onClose();
        return;
    }
    titleEl.textContent = title || 'Message';
    msgEl.textContent = message || '';
    buttonsEl.innerHTML = '';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-role-select btn-role-user';
    okBtn.textContent = 'OK';
    okBtn.onclick = function () {
        if (appModalResolve) {
            appModalResolve(true);
            appModalResolve = null;
        }
        overlay.style.display = 'none';
        if (typeof onClose === 'function') onClose();
    };
    buttonsEl.appendChild(okBtn);
    overlay.style.display = 'flex';
}

function showConfirmModal(message, title, options) {
    options = options || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            var ok = window.confirm(message);
            resolve(ok);
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        buttonsEl.innerHTML = '';
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = options.cancelLabel || 'Cancel';
        cancelBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(false);
                appModalResolve = null;
            }
        };
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-role-select btn-confirm-ok';
        var t = String(title || '').trim().toLowerCase();
        okBtn.textContent = options.okLabel
            || ((t === 'test running') ? 'Abort Test' : (t === 'operation in progress') ? 'Abort' : 'OK');
        okBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(true);
                appModalResolve = null;
            }
        };
        buttonsEl.appendChild(cancelBtn);
        buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
    });
}

/**
 * After vacuum validation: operator chooses Pass or Fail.
 * @param {Object} summary - { setVacuumMmHg, actualVacuumMmHg, setDurationDisplay, actualDurationDisplay }
 * @returns {Promise<'pass'|'fail'>}
 */
function showValidationPassFailModal(summary) {
    summary = summary || {};
    window._pendingValidationResult = {
        setVacuumMmHg: summary.setVacuumMmHg,
        actualVacuumMmHg: summary.actualVacuumMmHg,
        setDurationDisplay: summary.setDurationDisplay,
        actualDurationSec: summary.actualDurationSec,
        actualDurationDisplay: summary.actualDurationDisplay,
        validationParams: window._vdValidationParams || null
    };
    var setVac = summary.setVacuumMmHg != null ? String(summary.setVacuumMmHg) : '--';
    var actualVac = summary.actualVacuumMmHg != null ? Number(summary.actualVacuumMmHg).toFixed(1) : '--';
    var setTime = summary.setDurationDisplay || '--';
    var actualTime = summary.actualDurationDisplay || '--';
    var message =
        'Set vacuum: ' + setVac + ' mmHg\n' +
        'Actual vacuum: ' + actualVac + ' mmHg\n' +
        'Set time: ' + setTime + '\n' +
        'Elapsed time: ' + actualTime + '\n\n' +
        'Select Pass or Fail to continue.';
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            resolve(window.confirm('Mark validation as Pass?') ? 'pass' : 'fail');
            return;
        }
        titleEl.textContent = 'Validation Complete';
        msgEl.textContent = message;
        msgEl.style.whiteSpace = 'pre-line';
        buttonsEl.innerHTML = '';
        var failBtn = document.createElement('button');
        failBtn.type = 'button';
        failBtn.className = 'btn-role-select btn-validation-fail';
        failBtn.textContent = 'Fail';
        failBtn.onclick = function () {
            overlay.style.display = 'none';
            msgEl.style.whiteSpace = '';
            resolve('fail');
        };
        var passBtn = document.createElement('button');
        passBtn.type = 'button';
        passBtn.className = 'btn-role-select btn-validation-pass';
        passBtn.textContent = 'Pass';
        passBtn.onclick = function () {
            overlay.style.display = 'none';
            msgEl.style.whiteSpace = '';
            resolve('pass');
        };
        buttonsEl.appendChild(failBtn);
        buttonsEl.appendChild(passBtn);
        overlay.style.display = 'flex';
    });
}

function updateProfileFromCurrentUser(user) {
    if (!user) return;
    var name = user.name || user.username || '';
    var role = user.role || '';
    var username = user.username || '';
    var nameEl = document.getElementById('profile-name-display');
    if (nameEl) {
        nameEl.textContent = name || '---';
    }
    var userIdEl = document.getElementById('profile-username-display');
    if (userIdEl) {
        userIdEl.textContent = username || '---';
    }
    var roleEl = document.getElementById('profile-role-display');
    if (roleEl) {
        roleEl.textContent = displayRoleLabel(role);
    }
    var changeBtn = document.getElementById('btn-profile-change-password');
    if (changeBtn) {
        var memberId = user.id;
        var roleLc = String(role || '').toLowerCase();
        var uname = String(username || '').trim().toUpperCase();
        var isFactory = (memberId === 0 || memberId === undefined || memberId === null)
            || roleLc === 'factory'
            || uname === 'RLERLT'
            || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(roleLc, user));
        changeBtn.style.display = isFactory ? 'none' : '';
        changeBtn.disabled = !!isFactory;
    }
}

function openProfilePasswordChange() {
    var user = (typeof window.currentUser !== 'undefined' && window.currentUser)
        ? window.currentUser
        : ((typeof currentUser !== 'undefined' && currentUser) ? currentUser : null);
    if (!user) {
        if (typeof showAppModal === 'function') showAppModal('No user logged in.', 'User Profile');
            return;
        }
    var memberId = user.id;
    var role = String(user.role || '').toLowerCase();
    var uname = String(user.username || '').trim().toUpperCase();
    var isFactory = (memberId === 0 || memberId === undefined || memberId === null)
        || role === 'factory'
        || uname === 'RLERLT'
        || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, user));
    if (isFactory) {
        if (typeof showAppModal === 'function') {
            showAppModal('Factory password cannot be changed from Profile.', 'User Profile');
        }
            return;
        }
    showProfilePasswordChangeScreen(user.username || user.name || '');
}

function showProfilePasswordChangeScreen(username) {
    window._passwordResetScreenMode = 'profile';
    window._mandatoryPasswordResetPending = false;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    var cancelBtn = document.getElementById('password-reset-cancel-btn');
    if (titleEl) titleEl.textContent = 'Change Password';
    if (subEl) {
        subEl.textContent = 'Enter your current password, then create and confirm a new password.';
    }
    if (cancelBtn) cancelBtn.style.display = '';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = '';
        if (newEl) newEl.value = '';
        if (confEl) confEl.value = '';
        if (oldEl && typeof oldEl.focus === 'function') oldEl.focus();
    }, 60);
}

function cancelProfilePasswordChange() {
    window._passwordResetScreenMode = 'expired';
    window._mandatoryPasswordResetPending = false;
    var cancelBtn = document.getElementById('password-reset-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    goToPage('user-profile');
}

function _setPasswordResetCancelVisible(visible) {
    var cancelBtn = document.getElementById('password-reset-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = visible ? '' : 'none';
}

function apiRequest(path, options) {
    options = options || {};
    var base = API_BASE || '';
    var p = String(path || '');
    if (base && p.indexOf(base) === 0) {
        p = p.slice(base.length);
        if (p.charAt(0) !== '/') p = '/' + p;
    }
    var url = base + p;
    var headers = { 'Content-Type': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        var hdrRole = window.currentUser.role;
        if (!hdrRole && typeof getCurrentRole === 'function') {
            var gr = getCurrentRole();
            if (gr) hdrRole = gr;
        }
        if (hdrRole) headers['X-User-Role'] = hdrRole;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    if (options.headers) for (var h in options.headers) headers[h] = options.headers[h];
    var opts = { method: options.method || 'GET', headers: headers };
    if (options.body !== undefined) opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    return fetch(url, opts).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok) {
            if (ct.indexOf('json') !== -1) {
                return r.json().then(function (data) {
                    var msg = (data && (data.error || data.message)) ? String(data.error || data.message) : (r.statusText || r.status);
                    throw new Error(msg);
                }).catch(function (err) {
                    throw err instanceof Error ? err : new Error(r.statusText || r.status);
                });
            }
            return r.text().then(function (text) {
                throw new Error(text || r.statusText || r.status);
            }).catch(function () {
                throw new Error(r.statusText || r.status);
            });
        }
        if (ct.indexOf('json') !== -1) return r.json();
        return r.text();
    });
}

var _approvalVerifyReturnPage = 'home';

function openApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        if (!els) {
            reject(new Error('QA verification UI is missing.'));
            return;
        }
        approvalVerifyResolve = resolve;
        approvalVerifyReject = reject;
        _storeApprovalVerifyModalOriginalUiOnce();
        _restoreApprovalVerifyModalOriginalUi();
        _setApprovalVerifyModalButtonHandlers(submitApprovalVerifyModal, cancelApprovalVerifyModal);
        var o = options == null ? {} : options;
        _approvalVerifyPurpose = o.purpose || 'recipe';
        if (o.titleText && els.titleEl) els.titleEl.textContent = o.titleText;
        if (o.subtitleText && els.subtitleEl) els.subtitleEl.textContent = o.subtitleText;
        if (o.usernameLabelText && els.usernameLabelEl) els.usernameLabelEl.textContent = o.usernameLabelText;
        if (o.usernamePlaceholder && els.usernameEl) els.usernameEl.setAttribute('placeholder', o.usernamePlaceholder);
        _approvalVerifyEmptyCredentialsMessage = o.emptyCredentialsMessage || 'Enter QA username and password.';
        if (els.errEl) {
            els.errEl.textContent = '';
            els.errEl.style.display = 'none';
        }
        els.usernameEl.value = '';
        els.passwordEl.value = '';
        if (!els.passwordEl._approvalVerifyEnterHandler) {
            els.passwordEl._approvalVerifyEnterHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (adminApprovalVerifyResolve) submitAdminApprovalVerifyModal();
                    else submitApprovalVerifyModal();
                }
            };
            els.passwordEl.addEventListener('keydown', els.passwordEl._approvalVerifyEnterHandler);
        }
        setTimeout(function () { els.usernameEl.focus(); }, 30);
    });
}

function closeApprovalVerifyModal() {
    if (typeof goToPage === 'function') goToPage(_approvalVerifyReturnPage || 'home');
}

function cancelApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (approvalVerifyResolve) {
        approvalVerifyResolve(null);
        approvalVerifyResolve = null;
    }
    if (approvalVerifyReject) approvalVerifyReject = null;
}

function submitApprovalVerifyModal() {
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        if (errEl) {
            errEl.textContent = _approvalVerifyEmptyCredentialsMessage;
            errEl.style.display = 'block';
        }
        return;
    }
    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: _approvalVerifyPurpose }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            if (errEl) {
                errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(data.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    }).catch(function (err) {
        if (errEl) {
            errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
            errEl.style.display = 'block';
        }
    });
}

function submitApprovalVerifyBiometricModal() {
    var errEl = document.getElementById('approval-verify-error');
    if (!biometricEnabledSetting) {
        if (errEl) {
            errEl.textContent = 'Biometric verification is disabled by Factory Settings.';
            errEl.style.display = 'block';
        }
        return;
    }
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    runBiometricVerifyWithRetry({
        purpose: _approvalVerifyPurpose,
        title: 'Verify Fingerprint',
        message: 'Place an Admin/QA fingerprint on the scanner to authorize this action.',
        failureHint: 'Place your finger on the scanner and tap Try again.'
    }).then(function (result) {
        if (!result || !result.ok) {
            if (result && result.error !== 'cancelled' && errEl) {
                errEl.textContent = result.message || result.error || 'Fingerprint verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(result.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    });
}

function _getApprovalVerifyModalElements() {
    var overlay = document.getElementById('page-approval-verify');
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    if (!overlay || !usernameEl || !passwordEl || !errEl) return null;
    var usernameLabelEl = overlay.querySelector('label[for="approval-verify-username"]');
    var actionsRow = overlay.querySelector('.add-member-actions');
    var userBtn = actionsRow ? actionsRow.querySelector('button.btn-primary') : null;
    var cancelBtn = null;
    if (actionsRow) {
        var secs = actionsRow.querySelectorAll('button.btn-secondary');
        for (var i = 0; i < secs.length; i++) {
            var oc = secs[i].getAttribute('onclick') || '';
            if (oc.indexOf('cancelApprovalVerifyModal') >= 0 || oc.indexOf('cancelAdminApprovalVerifyModal') >= 0) {
                cancelBtn = secs[i];
                break;
            }
        }
    }
    var titleEl = document.getElementById('approval-verify-title');
    var subtitleEl = document.getElementById('approval-verify-subtitle');
    return { overlay: overlay, usernameEl: usernameEl, passwordEl: passwordEl, errEl: errEl, usernameLabelEl: usernameLabelEl, userBtn: userBtn, cancelBtn: cancelBtn, titleEl: titleEl, subtitleEl: subtitleEl };
}

function _storeApprovalVerifyModalOriginalUiOnce() {
    if (_approvalVerifyModalOriginal) return;
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    _approvalVerifyModalOriginal = {
        titleText: els.titleEl ? els.titleEl.textContent : null,
        subtitleText: els.subtitleEl ? els.subtitleEl.textContent : null,
        usernameLabelText: els.usernameLabelEl ? els.usernameLabelEl.textContent : null,
        usernamePlaceholder: els.usernameEl ? els.usernameEl.getAttribute('placeholder') : null
    };
    _approvalVerifyButtonOriginal = {
        userBtnOnclick: els.userBtn ? els.userBtn.onclick : null,
        cancelBtnOnclick: els.cancelBtn ? els.cancelBtn.onclick : null
    };
}

function _restoreApprovalVerifyModalOriginalUi() {
    var els = _getApprovalVerifyModalElements();
    if (!els || !_approvalVerifyModalOriginal) return;
    if (els.titleEl && _approvalVerifyModalOriginal.titleText != null) els.titleEl.textContent = _approvalVerifyModalOriginal.titleText;
    if (els.subtitleEl && _approvalVerifyModalOriginal.subtitleText != null) els.subtitleEl.textContent = _approvalVerifyModalOriginal.subtitleText;
    if (els.usernameLabelEl && _approvalVerifyModalOriginal.usernameLabelText != null) els.usernameLabelEl.textContent = _approvalVerifyModalOriginal.usernameLabelText;
    if (els.usernameEl && _approvalVerifyModalOriginal.usernamePlaceholder != null) els.usernameEl.setAttribute('placeholder', _approvalVerifyModalOriginal.usernamePlaceholder);
    if (_approvalVerifyButtonOriginal) {
        if (els.userBtn) els.userBtn.onclick = _approvalVerifyButtonOriginal.userBtnOnclick;
        if (els.cancelBtn) els.cancelBtn.onclick = _approvalVerifyButtonOriginal.cancelBtnOnclick;
    }
}

function _setApprovalVerifyModalButtonHandlers(verifyFn, cancelFn) {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    if (els.userBtn) els.userBtn.onclick = verifyFn;
    if (els.cancelBtn) els.cancelBtn.onclick = cancelFn;
}

function _normUserKey(v) {
    return String(v || '').trim().toLowerCase();
}

// Admin-only verification modal for starting a test run.
function openAdminApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        var opts = options || {};
        if (!els) {
            reject(new Error('Admin verification UI is missing.'));
            return;
        }

        _storeApprovalVerifyModalOriginalUiOnce();
        adminApprovalVerifyResolve = resolve;
        adminApprovalVerifyReject = reject;

        els.errEl.textContent = '';
        els.errEl.style.display = 'none';
        els.usernameEl.value = '';
        els.passwordEl.value = '';

        if (els.titleEl) els.titleEl.textContent = opts.titleText || 'Admin approval required';
        if (els.subtitleEl) els.subtitleEl.textContent = opts.subtitleText || 'Enter admin credentials to continue.';
        if (els.usernameLabelEl) els.usernameLabelEl.textContent = 'Admin username';
        if (els.usernameEl) els.usernameEl.setAttribute('placeholder', 'Enter admin username');

        _setApprovalVerifyModalButtonHandlers(submitAdminApprovalVerifyModal, cancelAdminApprovalVerifyModal);

        setTimeout(function () { els.usernameEl.focus(); }, 30);
    });
}

function cancelAdminApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (adminApprovalVerifyResolve) {
        adminApprovalVerifyResolve(null);
        adminApprovalVerifyResolve = null;
    }
    if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
}

function submitAdminApprovalVerifyModal() {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;

    var username = els.usernameEl ? String(els.usernameEl.value || '').trim() : '';
    var password = els.passwordEl ? String(els.passwordEl.value || '') : '';

    if (!username || !password) {
        els.errEl.textContent = 'Enter admin username and password.';
        els.errEl.style.display = 'block';
        return;
    }

    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: 'recipe' }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            els.errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
            els.errEl.style.display = 'block';
            return;
        }

        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (adminApprovalVerifyResolve) {
            adminApprovalVerifyResolve({
                token: String(data.token),
                username: _normUserKey(data.verifier && data.verifier.username),
                role: role
            });
            adminApprovalVerifyResolve = null;
        }
        if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
    }).catch(function (err) {
        els.errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
        els.errEl.style.display = 'block';
    });
}

function distributeTotalTaps(total, stepCount) {
    var t = parseInt(total, 10);
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    if (isNaN(t) || t < n) return null;
    var base = Math.floor(t / n);
    var rem = t - base * n;
    var arr = [];
    for (var i = 0; i < n; i++) {
        arr.push(base + (i < rem ? 1 : 0));
    }
    return arr;
}

function computeStandardUspTaps(stepCount) {
    var taps = [];
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    for (var i = 0; i < n; i++) {
        taps.push(i === 0 ? 10 : (i === 1 ? 500 : 1250));
    }
    return taps;
}

var USP_DEFAULT_STEP_COUNT = 10;

function isUspStandardProcedureMode(mode) {
    mode = String(mode || '').toUpperCase();
    return mode === 'VACUUM_DECAY' || mode === 'PRESSURE_DECAY';
}

function applyStandardUspStepDefaults(target) {
    var n = USP_DEFAULT_STEP_COUNT;
    var taps = computeStandardUspTaps(n);
    if (target === 'quick' || target === 'both') {
        window._quickStepCount = n;
        window._quickStepTaps = taps.slice();
    }
    if (target === 'create' || target === 'both') {
        window._createRecipeStepCount = n;
        window._createRecipeStepTaps = taps.slice();
    }
}

function formatUspStandardTapsSummary(stepCount) {
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 1));
    var taps = computeStandardUspTaps(n);
    var parts = [];
    for (var i = 0; i < n; i++) {
        parts.push('Step ' + (i + 1) + ': ' + taps[i]);
    }
    return parts.join('  |  ');
}

function computeCreateRecipeStepTapsForStepCount(stepCount) {
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    if (getCreateUspMode() === 'CUSTOM') {
        if (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n) {
            return window._createRecipeStepTaps.slice();
        }
        return null;
    }
    return computeStandardUspTaps(n);
}

function refreshActiveQaCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'qa') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeQaCount = n;
    }).catch(function () { window._activeQaCount = 0; });
}

function refreshActiveSupervisorCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'supervisor') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeSupervisorCount = n;
    }).catch(function () { window._activeSupervisorCount = 0; });
}

function userCanApproveByQaRule() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'recipe-approve');
    }
    return false;
}

/** Test reports: must have test-report-approve permission (Factory bypass in UI). */
function userCanApproveTestReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'test-report-approve');
    }
    return false;
}

function userCanApproveValidationReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        // Test report approval also covers validation reports.
        return userHasInternalKey(u, 'validation-report-approve') || userHasInternalKey(u, 'test-report-approve');
    }
    return false;
}

function userCanApproveCalibrationReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'calibration-report-approve');
    }
    return false;
}

function getReportApprovalType(preview) {
    return String((preview || window._lastReportPreview || {}).type || 'test').trim().toLowerCase();
}

function userCanApproveReportOfType(reportType, userObj) {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = userObj || window.currentUser;
    if (!u || typeof userHasInternalKey !== 'function') return false;
    var t = String(reportType || 'test').trim().toLowerCase();
    if (t === 'calibration') return userHasInternalKey(u, 'calibration-report-approve');
    if (t === 'validation') {
        return userHasInternalKey(u, 'validation-report-approve') || userHasInternalKey(u, 'test-report-approve');
    }
    return userHasInternalKey(u, 'test-report-approve');
}


window._reportApprovalGate = null;
var _reportApprovalPollTimerId = null;

function normalizeReportUsername(u) {
    return String(u || '').trim().toLowerCase();
}

function getCurrentReportUsername() {
    var u = window.currentUser;
    if (!u) return '';
    return normalizeReportUsername(u.username || u.name || '');
}

function getReportOperatedByUsername(preview) {
    var p = preview || window._lastReportPreview || {};
    var td = p.testData || {};
    return normalizeReportUsername(p.operatedByUsername || td.operatedByUsername || td.employeeId || p.employeeId);
}

function isReportPendingApproval(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'pending';
}

function isReportApproved(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'approved';
}

function isCurrentUserReportOperator(preview) {
    var op = getReportOperatedByUsername(preview);
    var cur = getCurrentReportUsername();
    return !!(op && cur && op === cur);
}

function isReportPreviewLockedForCurrentUser(preview) {
    if (typeof isFactorySessionUser === 'function' && isFactorySessionUser()) return false;
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    if (reportTypeNorm !== 'test' && reportTypeNorm !== 'validation' && reportTypeNorm !== 'calibration') return false;
    if (!isReportPendingApproval(p)) return false;
    return isCurrentUserReportOperator(p);
}

function setReportApprovalGate(reportId, operatedByUsername) {
    if (reportId == null) {
        window._reportApprovalGate = null;
        return;
    }
    window._reportApprovalGate = {
        reportId: reportId,
        operatedByUsername: normalizeReportUsername(operatedByUsername)
    };
}

function clearReportApprovalGate() {
    window._reportApprovalGate = null;
    stopReportApprovalPoll();
}

function setReportApprovalGateFromPreview(preview, reportId) {
    if (!isReportPendingApproval(preview)) {
        clearReportApprovalGate();
        return;
    }
    if (isReportPreviewLockedForCurrentUser(preview)) {
        setReportApprovalGate(reportId, getReportOperatedByUsername(preview));
    } else {
        clearReportApprovalGate();
    }
}

function stopReportApprovalPoll() {
    if (_reportApprovalPollTimerId != null) {
        clearInterval(_reportApprovalPollTimerId);
        _reportApprovalPollTimerId = null;
    }
}

function startReportApprovalPollIfLocked() {
    stopReportApprovalPoll();
    if (!isReportPreviewLockedForCurrentUser(window._lastReportPreview)) return;
    var rid = currentReportId;
    if (rid == null) return;
    _reportApprovalPollTimerId = setInterval(function () {
        if (!isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
            stopReportApprovalPoll();
            return;
        }
        apiRequest(API_BASE + '/api/reports/' + rid + '/preview').then(function (data) {
            if (!data || !data.preview) return;
            var st = String(data.preview.reportApprovalStatus || '').trim().toLowerCase();
            if (st === 'approved') {
                populateReportPreview(data.preview);
                clearReportApprovalGate();
                applyReportPreviewLockUi(data.preview);
                _saveReportPdfSilent(rid);
                showAppModal('Report has been approved. You may now print or leave this screen.', 'Report');
            }
        }).catch(function () {});
    }, 5000);
}

function setReportApproveBiometricRetryVisible(visible) {
    var btn = document.getElementById('btn-report-approve-biometric-retry');
    if (btn) btn.style.display = visible ? '' : 'none';
}

function clearReportApproveVerifyError() {
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.style.display = 'none';
    setReportApproveBiometricRetryVisible(false);
}

function resetReportApproveForm() {
    var ta = document.getElementById('report-approve-remarks-input');
    if (ta) ta.value = '';
    var userEl = document.getElementById('report-approve-verifier-username');
    var passEl = document.getElementById('report-approve-verifier-password');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    var passRadio = document.querySelector('input[name="report-approve-pass-fail"][value="PASS"]');
    if (passRadio) passRadio.checked = true;
    clearReportApproveVerifyError();
}

function setReportApproveVerifyError(message, options) {
    options = options || {};
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = message ? String(message) : '';
    errEl.style.display = message ? 'block' : 'none';
    if (options.showBiometricRetry) {
        setReportApproveBiometricRetryVisible(true);
    }
}

function wireReportApproveVerifierListeners() {
    if (window._reportApproveVerifierListenersWired) return;
    window._reportApproveVerifierListenersWired = true;
    var userEl = document.getElementById('report-approve-verifier-username');
    if (!userEl) return;
    userEl.addEventListener('input', function () {
        setReportApprovePanelInteractionState(window._lastReportPreview);
    });
}

function setReportApprovePanelInteractionState(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    wireReportApproveVerifierListeners();
    var pending = isReportPendingApproval(preview);
    var isOp = isCurrentUserReportOperator(preview);
    var isFactory = typeof isFactorySessionUser === 'function' && isFactorySessionUser();
    var fieldsEnabled = !!pending;
    apprPanel.classList.toggle('is-operator-view', !!(pending && isOp && !isFactory));
    var hintEl = document.getElementById('report-approve-operator-hint');
    if (hintEl) hintEl.style.display = (pending && isOp && !isFactory) ? 'block' : 'none';
    ['#report-approve-remarks-input', 'input[name="report-approve-pass-fail"]',
        '#report-approve-verifier-username', '#report-approve-verifier-password'].forEach(function (sel) {
        apprPanel.querySelectorAll(sel).forEach(function (el) { el.disabled = !fieldsEnabled; });
    });
    var submitBtn = document.getElementById('btn-report-approve-submit');
    // Keep the action available for pending reports. The submit flow gives a
    // useful validation message for missing credentials and prevents
    // self-approval; the server enforces the same separation-of-duty rule.
    if (submitBtn) submitBtn.disabled = !fieldsEnabled;
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    if (bioBtn) bioBtn.disabled = !fieldsEnabled;
    apprPanel.querySelectorAll('.report-approve-card-wrap').forEach(function (wrap) {
        if (fieldsEnabled) wrap.classList.remove('is-disabled');
        else wrap.classList.add('is-disabled');
    });
}

function updateReportApprovePanelForPreview(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    var pending = isReportPendingApproval(preview);
    var rid = currentReportId;
    if (pending && rid != null && rid !== window._reportApproveFormReportId) {
        resetReportApproveForm();
        window._reportApproveFormReportId = rid;
    }
    if (!pending) {
        window._reportApproveFormReportId = null;
    }
    var reportTypeNorm = String((preview || {}).type || 'test').trim().toLowerCase();
    var titleEl = document.getElementById('report-approve-panel-title') || apprPanel.querySelector('h3');
    if (titleEl) {
        if (reportTypeNorm === 'calibration') titleEl.textContent = 'Calibration report approval';
        else if (reportTypeNorm === 'validation') titleEl.textContent = 'Validation report approval';
        else titleEl.textContent = 'Test report approval';
    }
    apprPanel.style.display = pending ? 'block' : 'none';
    if (!pending) clearReportApproveVerifyError();
    setReportApprovePanelInteractionState(preview);
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    var bioWrap = document.getElementById('report-approve-biometric-wrap');
    var showBio = typeof biometricEnabledSetting === 'undefined' || biometricEnabledSetting;
    if (bioBtn) bioBtn.style.display = showBio ? '' : 'none';
    if (bioWrap) bioWrap.style.display = showBio ? '' : 'none';
}

function scrollReportApprovePanelIntoView() {
    var panel = document.getElementById('report-approve-panel');
    if (!panel || panel.style.display === 'none') return;
    try {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
        panel.scrollIntoView(true);
    }
}

function scrollReportPendingBannerIntoView() {
    var banner = document.getElementById('report-pending-lock-banner');
    if (!banner || banner.style.display === 'none') return;
    try {
        banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        banner.scrollIntoView(true);
    }
}

function applyReportPreviewLockUi(preview) {
    preview = preview || window._lastReportPreview;
    var locked = isReportPreviewLockedForCurrentUser(preview);
    var pending = isReportPendingApproval(preview);
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('report-approval-locked', !!locked);
    var banner = document.getElementById('report-pending-lock-banner');
    if (banner) banner.style.display = locked ? 'block' : 'none';
    var closeBtn = document.querySelector('#report-preview-actions .btn-close');
    if (closeBtn) closeBtn.style.display = locked ? 'none' : '';
    var backBtn = document.getElementById('header-back-btn');
    if (backBtn) backBtn.style.visibility = locked ? 'hidden' : '';
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = locked ? 'none' : '';
        btn.style.opacity = locked ? '0.45' : '';
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
        if (locked) el.setAttribute('aria-disabled', 'true');
        else el.removeAttribute('aria-disabled');
    });
    updateReportApprovePanelForPreview(preview);
    updateReportPreviewPrintExportButtons(preview);
    if (pending || locked) {
        markAutoLogoutActivity();
        if (typeof syncKioskScreenWakeLock === 'function') syncKioskScreenWakeLock();
    }
}

function stampOperatorOnTestReportPayload(payload) {
    if (!payload) return payload;
    var u = window.currentUser || {};
    var un = normalizeReportUsername(u.username || u.name || '');
    var name = String(u.name || u.username || '—').trim();
    var emp = String(u.username || un || '').trim();
    payload.operatedByUsername = un;
    payload.operatorName = name;
    payload.employeeId = emp;
    payload.testData = payload.testData || {};
    payload.testData.operatedByUsername = un;
    payload.testData.operatorName = name;
    payload.testData.employeeId = emp;
    return payload;
}

function abortPendingReportOnLogout() {
    var gate = window._reportApprovalGate;
    if (!gate || gate.reportId == null) return Promise.resolve();
    if (typeof isFactorySessionUser === 'function' && isFactorySessionUser()) {
        clearReportApprovalGate();
        return Promise.resolve();
    }
    return apiRequest(API_BASE + '/api/data/reports/' + gate.reportId + '/abort', { method: 'POST' }).then(function () {
        clearReportApprovalGate();
    }).catch(function () {
        clearReportApprovalGate();
    });
}

function reportActionsBlockedForPreview(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    return approvalSt === 'pending' && (reportTypeNorm === 'test' || reportTypeNorm === 'validation' || reportTypeNorm === 'calibration');
}

function finishTestRunReportSaved(reportId) {
    resetQuickTestFormAfterRunIfPending();
    if (reportId) {
        if (typeof openReportPreview === 'function') {
            openReportPreview(reportId, { setGate: true });
        } else {
            _postRunSessionHold = false;
            goToPage('reports');
        }
    } else {
        _postRunSessionHold = false;
        goToPage('reports');
        if (typeof loadReports === 'function') loadReports();
    }
}

/** Recipe approval modal copy; verifier must have recipe-approve permission card. */
function _approvalVerifyModalOptionsForRecipe() {
    return {
        purpose: 'recipe',
        titleText: 'Recipe approval required',
        subtitleText: 'Enter credentials for a user with Recipe approval permission.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Approver username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

/** Test report approval: verifier must have test-report-approve permission card. */
function _approvalVerifyModalOptionsForReport() {
    return {
        purpose: 'report',
        titleText: 'Test report approval',
        subtitleText: 'Enter credentials for a user with Test report approval permission.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Approver username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

function getEffectiveRecipeApprovalStatus(recipe) {
    if (!recipe) return 'approved';
    var st = recipe.recipeApprovalStatus;
    if (st == null || st === '') return 'approved';
    return st;
}

function getCreateUspMode() {
    var r = document.querySelector('input[name="create-usp-mode"]:checked');
    return r ? String(r.value).toUpperCase() : 'VACUUM_DECAY';
}

function getQuickUspMode() {
    var r = document.querySelector('input[name="quick-usp-mode"]:checked');
    return r ? String(r.value).toUpperCase() : 'VACUUM_DECAY';
}

function applyCreateUspModeToSpeedHeight() {
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
        var s1 = document.querySelector('input[name="create-speed"][value="300"]');
        var h1 = document.querySelector('input[name="create-height"][value="14"]');
        if (s1) s1.checked = true;
        if (h1) h1.checked = true;
    } else if (mode === 'PRESSURE_DECAY') {
        var s2 = document.querySelector('input[name="create-speed"][value="250"]');
        var h2 = document.querySelector('input[name="create-height"][value="3"]');
        if (s2) s2.checked = true;
        if (h2) h2.checked = true;
    }
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
    if (typeof _updateCreateStepsPageUspUi === 'function') _updateCreateStepsPageUspUi();
}

function applyQuickUspModeToSpeedHeight() {
    var mode = getQuickUspMode();
    var speedWrap = document.getElementById('quick-custom-speed-height-wrap');
    if (speedWrap) speedWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    var totalWrap = document.getElementById('quick-custom-total-wrap');
    if (totalWrap) totalWrap.style.display = mode === 'CUSTOM' ? '' : 'none';
    var quickStepsSec = document.getElementById('quick-recipe-steps-section');
    if (quickStepsSec) quickStepsSec.style.display = mode === 'CUSTOM' ? '' : 'none';
    if (isUspStandardProcedureMode(mode)) {
        applyStandardUspStepDefaults('quick');
        if (typeof _refreshQuickStepSummary === 'function') _refreshQuickStepSummary();
    }
    if (mode === 'VACUUM_DECAY') {
        var s1 = document.querySelector('input[name="quick-speed"][value="300"]');
        var h1 = document.querySelector('input[name="quick-height"][value="14"]');
        if (s1) s1.checked = true;
        if (h1) h1.checked = true;
    } else if (mode === 'PRESSURE_DECAY') {
        var s2 = document.querySelector('input[name="quick-speed"][value="250"]');
        var h2 = document.querySelector('input[name="quick-height"][value="3"]');
        if (s2) s2.checked = true;
        if (h2) h2.checked = true;
    }
    if (typeof _updateQuickStepsPageUspUi === 'function') _updateQuickStepsPageUspUi();
}

function _updateQuickStepsPageUspUi() {
    var standard = isUspStandardProcedureMode(getQuickUspMode());
    var tapsWrap = document.getElementById('quick-steps-taps-wrap');
    var infoEl = document.getElementById('quick-usp-taps-readonly');
    if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
    if (infoEl) {
        if (standard) {
            var radio = document.querySelector('input[name="quick-step-card"]:checked');
            var n = radio ? parseInt(radio.value, 10) : (window._quickStepCount || 10);
            infoEl.textContent = 'Hold time per cycle (seconds) are fixed for USP (not editable): ' + formatUspStandardTapsSummary(n);
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }
}

function _updateCreateStepsPageUspUi() {
    var standard = isUspStandardProcedureMode(getCreateUspMode());
    var tapsWrap = document.getElementById('create-steps-taps-wrap');
    var infoEl = document.getElementById('create-usp-taps-readonly');
    if (tapsWrap) tapsWrap.style.display = standard ? 'none' : '';
    if (infoEl) {
        if (standard) {
            var radio = document.querySelector('input[name="create-step-card"]:checked');
            var n = radio ? parseInt(radio.value, 10) : (window._createRecipeStepCount || 10);
            infoEl.textContent = 'Hold time per cycle (seconds) are fixed for USP (not editable): ' + formatUspStandardTapsSummary(n);
            infoEl.style.display = '';
        } else {
            infoEl.style.display = 'none';
        }
    }
}

var PAGE_TITLES = {
    'home': 'Leak Test Apparatus',
    'quick-test': 'Quick Test',
    'create-recipe-step1': 'Create Recipe',
    'manage-recipes': null,
    'manage-members': 'Manage Profiles',
    'load-validation': 'Pressure Decay',
    'distance-validation': 'Vacuum Decay',
    'add-member': 'Add New Member',
    'validate': 'Validation',
    'validate-type-select': 'Vacuum Validation',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    'settings': 'Settings',
    'datetime': 'Date and Time',
    'ip-configure': 'IP Configure',
    'factory-settings': 'Factory Settings',
    'reports': 'Reports',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'usp1-detail': 'Vacuum Decay',
    'usp2-detail': 'Pressure Decay',
    'test-run': 'Test Run',
    'validation-run': 'Validation Test',
    'vd-validation-input': 'Vacuum Validation',
    'vacuum-calibration': 'Calibration'
};

var _auditActivePage = null;
var _auditSkipPages = { login: true, 'password-expired-reset': true };
var _testRunAdapterInterruptAudited = false;

var PAGE_AUDIT_LABELS = {
    home: 'Home',
    'quick-test': 'Quick Test',
    'create-recipe-step1': 'Create Recipe',
    'manage-recipes': 'Manage Recipes',
    'manage-members': 'Manage Profiles',
    'locked-members': 'Locked Members',
    'disabled-members': 'Disabled Members',
    'load-validation': 'Pressure Decay Validation',
    'distance-validation': 'Vacuum Decay Validation',
    'add-member': 'Add New Member',
    validate: 'Validation',
    'validate-type-select': 'Vacuum Validation',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    settings: 'Settings',
    datetime: 'Date and Time',
    'ip-configure': 'IP Configure',
    'factory-settings': 'Factory Settings',
    reports: 'Reports',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'usp1-detail': 'Vacuum Decay validation',
    'usp2-detail': 'Pressure Decay validation',
    'test-run': 'Test Run',
    'validation-run': 'Validation Test',
    'vd-validation-input': 'Vacuum Validation Input',
    'vacuum-calibration': 'Vacuum Calibration',
    'disable-recipes': 'Disabled Recipes'
};

function logAuditEvent(action, details, options) {
    options = options || {};
    if (!window.currentUser) return Promise.resolve();
    var body = {
        action: action,
        details: details || '',
        outcome: options.outcome || 'success',
        eventType: options.eventType || 'lifecycle',
        entityType: options.entityType || '',
        entityName: options.entityName || '',
        entityId: options.entityId,
        reason: options.reason || '',
        extra: options.extra || {}
    };
    return apiRequest(API_BASE + '/api/data/audit-log/event', {
        method: 'POST',
        body: body
    }).catch(function () {});
}

function auditPageLabel(pageName) {
    if (pageName === 'manage-recipes') {
        return (typeof recipeListMode !== 'undefined' && recipeListMode === 'load')
            ? 'Load Recipe'
            : 'Manage Recipes';
    }
    if (PAGE_AUDIT_LABELS[pageName]) return PAGE_AUDIT_LABELS[pageName];
    if (PAGE_TITLES[pageName]) return PAGE_TITLES[pageName];
    return pageName;
}

function auditNavPageChange(newPage) {
    if (_auditSkipPages[newPage]) {
        _auditActivePage = null;
        return;
    }
    if (newPage === _auditActivePage) return;
    var prev = _auditActivePage;
    _auditActivePage = newPage;
    // Operations-only: no Entered/Exited screen spam. One-shot Opened* when
    // entering a workflow family from outside that family.
    var validateFamily = {
        validate: true,
        'validate-type-select': true,
        'vd-validation-input': true,
        'validation-run': true,
        'distance-validation': true,
        'load-validation': true,
        'usp1-detail': true,
        'usp2-detail': true
    };
    var calibFamily = {
        'calibration-type-select': true,
        'vacuum-calibration': true,
        'load-calibration': true,
        'distance-zero-calibration': true
    };
    var settingsFamily = {
        settings: true,
        datetime: true,
        'ip-configure': true,
        'ip-config': true,
        'factory-settings': true,
        'disable-recipes': true
    };
    if (validateFamily[newPage] && !validateFamily[prev]) {
        logAuditEvent('Opened Validation', 'Validation menu opened', { eventType: 'navigation' });
    } else if (calibFamily[newPage] && !calibFamily[prev]) {
        logAuditEvent('Opened Calibration', 'Calibration menu opened', { eventType: 'navigation' });
    } else if (settingsFamily[newPage] && !settingsFamily[prev]) {
        logAuditEvent('Opened Settings', 'Settings opened', { eventType: 'navigation' });
    }
}

/** Audit action for adapter/holder faults: Vacuum Decay → holder error; Pressure Decay → check adaptor and holder. */
function adapterErrorAuditActionForKind(kind) {
    return kind === 'usp2' ? 'check adaptor and holder' : 'holder error';
}

function adapterErrorAuditActionForRecipe(recipe) {
    return adapterErrorAuditActionForKind(recipeExpectedAdapterKind(recipe));
}

function adapterErrorAuditActionForValidation() {
    return adapterErrorAuditActionForKind(validationExpectedAdapterKind());
}

function adapterErrorTitleForKind(kind) {
    return kind === 'usp2' ? 'Check adaptor and holder' : 'Holder error';
}

function adapterErrorTitleForRecipe(recipe) {
    return adapterErrorTitleForKind(recipeExpectedAdapterKind(recipe));
}

function adapterErrorTitleForValidation() {
    return adapterErrorTitleForKind(validationExpectedAdapterKind());
}

function auditTestUspHolderAction(recipe) {
    return adapterErrorAuditActionForRecipe(recipe);
}

function logTestAdapterError(recipe, extra) {
    logAuditEvent(auditTestUspHolderAction(recipe), 'Holder check failed for test run', {
        eventType: 'lifecycle',
        entityType: 'hardware',
        entityName: 'holder',
        outcome: 'failed',
        extra: extra || {}
    });
}

function logValidationAdapterError(extra) {
    var action = adapterErrorAuditActionForValidation();
    logAuditEvent(action, 'Holder check failed for ' + validationHolderLabel() + ' validation', {
        eventType: 'lifecycle',
        entityType: 'hardware',
        entityName: 'holder',
        outcome: 'failed',
        extra: extra || {}
    });
}

function auditTestRunStarted(rec) {
    var recipe = rec || lastTestRunRecipe;
    if (!recipe) return;
    var isQuick = isQuickTestRecipe(recipe);
    var action = isQuick ? 'Quick test started' : 'Recipe test started';
    logAuditEvent(action, formatTestAuditDetails(recipe), {
        eventType: 'lifecycle',
        entityType: 'test',
        entityName: recipe.productName || '',
        entityId: recipe.id || recipe.recipeId || '',
        extra: testAuditExtra(recipe)
    });
}

function auditTestRunFinished(reportId) {
    var recipe = lastTestRunRecipe;
    var result = testRunResultText || (typeof _computeTestRunResult === 'function' ? _computeTestRunResult() : '');
    logAuditEvent(
        isQuickTestRecipe(recipe) ? 'Quick test finished' : 'Recipe test finished',
        formatTestAuditDetails(recipe, { reportId: reportId, result: result }),
        {
        eventType: 'lifecycle',
        entityType: 'report',
        entityId: reportId || '',
            entityName: recipe && recipe.productName ? recipe.productName : '',
            extra: testAuditExtra(recipe, { reportId: reportId, result: result })
        }
    );
}

function auditTestRunAborted(reason) {
    var recipe = lastTestRunRecipe;
    logAuditEvent(
        isQuickTestRecipe(recipe) ? 'Quick test aborted' : 'Recipe test aborted',
        formatTestAuditDetails(recipe, { reason: reason || 'User aborted test run' }),
        {
        eventType: 'lifecycle',
        entityType: 'test',
            entityName: recipe && recipe.productName ? recipe.productName : '',
            extra: testAuditExtra(recipe, { reason: reason || '' })
        }
    );
}

function auditTestRunAutoAborted(reason, stepIndex) {
    var recipe = lastTestRunRecipe;
    logAuditEvent(
        isQuickTestRecipe(recipe) ? 'Quick test auto-aborted' : 'Recipe test auto-aborted',
        formatTestAuditDetails(recipe, { reason: reason || 'Hardware stopped the test run' }),
        {
        eventType: 'lifecycle',
        entityType: 'test',
            entityName: recipe && recipe.productName ? recipe.productName : '',
        outcome: 'failed',
            extra: testAuditExtra(recipe, {
                stepIndex: stepIndex != null ? stepIndex : testRunCurrentStepIndex,
                reason: reason || ''
            })
        }
    );
}

/** Audit when pressure-build leak guard stops a run (Check for leaks modal). */
function auditTestRunAbortedLeaksFound(extraInfo) {
    var recipe = lastTestRunRecipe;
    var reason = 'Check for leaks. Pressure not building';
    var details = formatTestAuditDetails(recipe, { reason: reason });
    if (extraInfo && typeof extraInfo === 'object') {
        var bits = [];
        if (extraInfo.setVacuumMmHg != null) bits.push('set: ' + extraInfo.setVacuumMmHg + ' mmHg');
        if (extraInfo.liveVacuumMmHg != null) bits.push('live: ' + extraInfo.liveVacuumMmHg + ' mmHg');
        if (bits.length) details = details + ' | ' + bits.join(' | ');
    }
    logAuditEvent(
        isQuickTestRecipe(recipe) ? 'Quick test aborted - leaks found' : 'Recipe test aborted - leaks found',
        details,
        {
            eventType: 'lifecycle',
            entityType: 'test',
            entityName: recipe && recipe.productName ? recipe.productName : '',
            outcome: 'failed',
            extra: testAuditExtra(recipe, {
                reason: reason,
                setVacuumMmHg: extraInfo && extraInfo.setVacuumMmHg,
                liveVacuumMmHg: extraInfo && extraInfo.liveVacuumMmHg,
                leakAbort: true
            })
        }
    );
}
window.auditTestRunAbortedLeaksFound = auditTestRunAbortedLeaksFound;

function auditValidationAbortedLeaksFound(extraInfo) {
    var reason = 'Check for leaks. Pressure not building';
    var details = validationAdapterLabel() + ' validation aborted - leaks found | ' + reason;
    if (extraInfo && typeof extraInfo === 'object') {
        var bits = [];
        if (extraInfo.setVacuumMmHg != null) bits.push('set: ' + extraInfo.setVacuumMmHg + ' mmHg');
        if (extraInfo.liveVacuumMmHg != null) bits.push('live: ' + extraInfo.liveVacuumMmHg + ' mmHg');
        if (bits.length) details = details + ' | ' + bits.join(' | ');
    }
    logAuditEvent('Validation aborted - leaks found', details, {
        eventType: 'lifecycle',
        entityType: 'validation',
        outcome: 'failed',
        extra: {
            reason: reason,
            validationType: lastValidationType || '',
            setVacuumMmHg: extraInfo && extraInfo.setVacuumMmHg,
            liveVacuumMmHg: extraInfo && extraInfo.liveVacuumMmHg,
            leakAbort: true
        }
    });
}
window.auditValidationAbortedLeaksFound = auditValidationAbortedLeaksFound;

function auditCalibrationAbortedLeaksFound(extraInfo) {
    var reason = 'Check for leaks. Pressure not building';
    var details = 'Calibration aborted - leaks found | ' + reason;
    if (extraInfo && typeof extraInfo === 'object') {
        var bits = [];
        if (extraInfo.setVacuumMmHg != null) bits.push('set: ' + extraInfo.setVacuumMmHg + ' mmHg');
        if (extraInfo.liveVacuumMmHg != null) bits.push('live: ' + extraInfo.liveVacuumMmHg + ' mmHg');
        if (bits.length) details = details + ' | ' + bits.join(' | ');
    }
    logAuditEvent('Calibration aborted - leaks found', details, {
        eventType: 'lifecycle',
        entityType: 'calibration',
        outcome: 'failed',
        extra: {
            reason: reason,
            setVacuumMmHg: extraInfo && extraInfo.setVacuumMmHg,
            liveVacuumMmHg: extraInfo && extraInfo.liveVacuumMmHg,
            leakAbort: true
        }
    });
}
window.auditCalibrationAbortedLeaksFound = auditCalibrationAbortedLeaksFound;

async function fetchDateTimeFromBackend() {
    try {
        var r = await fetch((API_BASE || '') + '/api/get_datetime');
        if (r.ok) {
            var data = await r.json();
            if (data && (data.datetime || data.date)) return data;
        }
    } catch (e) {}
    return null;
}

/** Same as get_datetime but also compares RTC to WiFi/network time (does not change the clock). */
async function fetchDateTimeFromBackendCompare() {
    try {
        var r = await fetch((API_BASE || '') + '/api/get_datetime?compare=1');
        if (r.ok) {
            var data = await r.json();
            if (data && (data.datetime || data.date)) return data;
        }
    } catch (e) {}
    return null;
}

/** Parse API naive ISO wall time (YYYY-MM-DDTHH:MM:SS) as local components — not UTC via Date(). */
function parseWallDatetimeIso(isoStr) {
    var s = String(isoStr || '').trim().replace('Z', '');
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return {
        y: parseInt(m[1], 10),
        mo: parseInt(m[2], 10),
        d: parseInt(m[3], 10),
        h: parseInt(m[4], 10),
        mi: parseInt(m[5], 10),
        sec: parseInt(m[6] || '0', 10)
    };
}

function formatWallClockParts(p) {
    return {
        dateString: String(p.d).padStart(2, '0') + '/' + String(p.mo).padStart(2, '0') + '/' + p.y,
        timeString: String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0') + ':' + String(p.sec).padStart(2, '0')
    };
}

function wallClockPartsPlusSeconds(parts, extraSec) {
    var t = new Date(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.sec + (extraSec || 0));
    return {
        y: t.getFullYear(),
        mo: t.getMonth() + 1,
        d: t.getDate(),
        h: t.getHours(),
        mi: t.getMinutes(),
        sec: t.getSeconds()
    };
}

var _wallClockAnchor = null;

function applyWallClockToTopBar(parts) {
    if (!parts) return;
    var fmt = formatWallClockParts(parts);
    lastKnownDateTime = { timeString: fmt.timeString, dateString: fmt.dateString };
    var timeEl = document.getElementById('current-time');
    var dateEl = document.getElementById('current-date');
    if (timeEl) timeEl.textContent = fmt.timeString;
    if (dateEl) dateEl.textContent = fmt.dateString;
}

function tickWallClockFromAnchor() {
    if (!_wallClockAnchor || !_wallClockAnchor.parts) return;
    var elapsed = Math.floor((Date.now() - _wallClockAnchor.at) / 1000);
    applyWallClockToTopBar(wallClockPartsPlusSeconds(_wallClockAnchor.parts, elapsed));
}

function updateDateTime() {
    fetchDateTimeFromBackend().then(function (data) {
        var timeString = '--:--:--';
        var dateString = '--/--/----';
        if (data && data.datetime) {
            var parts = parseWallDatetimeIso(data.datetime);
            if (parts) {
                _wallClockAnchor = { parts: parts, at: Date.now() };
                var fmt = formatWallClockParts(parts);
                dateString = fmt.dateString;
                timeString = fmt.timeString;
                lastKnownDateTime = { timeString: timeString, dateString: dateString };
            }
        } else if (data && data.date && data.time) {
            dateString = (data.date || '').replace(/-/g, '/');
            timeString = (data.time || '--:--').split(':').slice(0, 2).join(':');
            if (data.time && data.time.split(':').length >= 3) timeString = data.time;
            else timeString = timeString + ':00';
            lastKnownDateTime = { timeString: timeString, dateString: dateString };
        } else if (lastKnownDateTime) {
            timeString = lastKnownDateTime.timeString;
            dateString = lastKnownDateTime.dateString;
        }
        if (_wallClockAnchor && _wallClockAnchor.parts) {
            applyWallClockToTopBar(_wallClockAnchor.parts);
        } else {
            var timeEl = document.getElementById('current-time');
            var dateEl = document.getElementById('current-date');
            if (timeEl) timeEl.textContent = timeString;
            if (dateEl) dateEl.textContent = dateString;
        }
    });
}

function showLoginScreen() {
    _auditActivePage = null;
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (app) app.style.display = 'none';
    if (login) login.style.display = 'flex';
    stopAutoLogoutWatcher();
    resetLoginFormFields();
    if (typeof loadLoginFactorySettingsDisplay === 'function') loadLoginFactorySettingsDisplay();
}

/** Clear login ID and password fields (call on logout / session end). */
function resetLoginFormFields() {
    var loginUid = document.getElementById('login-uid');
    var loginPwd = document.getElementById('login-pwd');
    if (loginUid) loginUid.value = '';
    if (loginPwd) loginPwd.value = '';
}

function showAppContainer() {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'flex';
    // Top bar always reloads from hardware RTC (source of truth) on every login.
    _wallClockAnchor = null;
    updateDateTime();
    if (!dateTimeClockInterval) {
        dateTimeClockInterval = setInterval(function () {
            tickWallClockFromAnchor();
            if (!_wallClockResyncInterval) {
                _wallClockResyncInterval = setInterval(updateDateTime, 5000);
            }
        }, 1000);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
        ensureAutoLogoutWatcher();
    }
}

function updateSettingsVisibility() {
    var u = window.currentUser;
    var role = typeof getCurrentRole === 'function' ? getCurrentRole() : '';
    var rl = String(role || '').toLowerCase();
    function showIf(sel, featureKey) {
        var el = document.querySelector(sel);
        if (!el) return;
        var ok = u && typeof canAccess === 'function' ? canAccess(u, featureKey) : false;
        el.style.display = ok ? '' : 'none';
    }
    showIf('.settings-datetime', 'edit-datetime');
    var ipCard = document.querySelector('.settings-ip-configure');
    if (ipCard) ipCard.style.display = '';
    showIf('.settings-recipes', 'recipe-manage');
    var disableCard = document.querySelector('.settings-disable');
    if (disableCard) {
        var show =
            (u && typeof canAccess === 'function' && canAccess(u, 'disable-recipes')) ||
            rl === 'factory';
        disableCard.style.display = show ? '' : 'none';
    }
    showIf('.settings-validation', 'validation-test');
    var factoryCard = document.querySelector('.settings-factory');
    if (factoryCard) {
        factoryCard.style.display = rl === 'factory' ? '' : 'none';
    }
    var resetCard = document.querySelector('.settings-reset');
    if (resetCard) {
        resetCard.style.display = rl === 'factory' ? '' : 'none';
    }
}

/** Hide sidebar / home tiles the current user cannot access (RBAC). */
function refreshShellAccessVisibility() {
    var u = window.currentUser;
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        var page = btn.getAttribute('data-page');
        var feat = btn.getAttribute('data-rbac-nav');
        if (!feat && typeof SCREEN_FEATURE_MAP !== 'undefined' && SCREEN_FEATURE_MAP[page]) {
            feat = SCREEN_FEATURE_MAP[page];
        }
        if (!feat) feat = page;
        var ok = true;
        if (page === 'home') {
            ok = true;
        } else if (page === 'reports') {
            ok = !!(u && typeof canAccess === 'function' && (canAccess(u, 'reports-view') || canAccess(u, 'audit-view')));
        } else if (u && typeof canAccess === 'function') {
            ok = canAccess(u, feat);
        } else if (!u) {
            ok = false;
        }
        btn.style.display = ok ? '' : 'none';
    });
    document.querySelectorAll('.test-card[data-rbac-nav]').forEach(function (el) {
        var feat = el.getAttribute('data-rbac-nav');
        var ok = u && typeof canAccess === 'function' && feat ? canAccess(u, feat) : false;
        el.style.display = ok ? '' : 'none';
    });
    var mp = document.querySelector('.profile-actions button[onclick*="manage-members"]');
    var am = document.querySelector('.profile-actions button[onclick*="openAddMember"]');
    if (mp) mp.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-manage') ? '' : 'none';
    if (am) am.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-add') ? '' : 'none';
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
}

function goToPage(pageName) {
    if (!_suppressTestRunNavGuardOnce && isTestRunActive && typeof isTestRunActive === 'function') {
        if (isTestRunActive() && pageName !== 'test-run') {
            showConfirmModal('Test is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
                if (!ok) return;
                if (typeof abortTestRunAndSave === 'function') {
                    abortTestRunAndSave().then(function (result) {
                        if (result && result.openedPreview) return;
                        _suppressTestRunNavGuardOnce = true;
                        goToPage(pageName);
                    });
                    return;
                }
                _suppressTestRunNavGuardOnce = true;
                goToPage(pageName);
            });
            return;
        }
    }
    _suppressTestRunNavGuardOnce = false;
    if (!_suppressValidationNavGuardOnce && isValidationOperationActive() && pageName !== 'validation-run') {
        showConfirmModal('Validation is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
            if (!ok) return;
            abortValidationRun({ skipConfirm: true }).then(function (result) {
                if (result && (result.openedPreview || result.inFlight)) return;
                _suppressValidationNavGuardOnce = true;
                goToPage(pageName);
            });
        });
        return;
    }
    _suppressValidationNavGuardOnce = false;
    if (pageName !== 'report-preview' && typeof isReportPreviewLockedForCurrentUser === 'function' &&
        isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
        showAppModal('This report is awaiting approval. You must stay on the report screen until a reviewer approves it.', 'Report');
        var active = document.querySelector('.page.active');
        if (!active || active.id !== 'page-report-preview') {
            var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
            if (rid) openReportPreview(rid);
        }
        return;
    }
    if (window._mandatoryPasswordResetPending && pageName !== 'password-expired-reset') {
        showAppModal('Please reset your password to continue.', 'Reset Password');
        return;
    }
    if (pageName === 'factory-settings') {
        var role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
        if (String(role || '').toLowerCase() !== 'factory') {
            showAppModal('Only Factory user can access Factory Settings.', 'Permission');
            pageName = 'settings';
        }
    }
    if (pageName !== 'login' && pageName !== 'password-expired-reset') {
        if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
            showAppModal('Please log in.', 'Session');
            if (typeof showLoginScreen === 'function') showLoginScreen();
            return;
        }
        var skipNavForEditMember = (pageName === 'add-member' && editingMemberId != null);
        if (!skipNavForEditMember && typeof checkNavigationAccess === 'function' && !checkNavigationAccess(pageName)) {
            showAppModal('You do not have permission to open this screen.', 'Permission');
            return;
        }
        if (skipNavForEditMember && typeof canEditMembers === 'function' && !canEditMembers()) {
            showAppModal('You do not have permission to edit profiles.', 'Permission');
            return;
        }
    }
    document.querySelectorAll('.page').forEach(function (p) {
        p.classList.remove('active');
    });
    var page = document.getElementById('page-' + pageName);
    if (page) {
        page.classList.add('active');
    }
    document.querySelectorAll('.nav-item').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-page') === pageName);
    });
    var sidebarProfile = document.querySelector('.sidebar .user-profile');
    if (sidebarProfile) {
        if (pageName === 'user-profile') sidebarProfile.classList.add('active');
        else sidebarProfile.classList.remove('active');
    }
    var title = document.getElementById('header-title');
    if (title) {
        if (pageName === 'manage-recipes') {
            title.textContent = (typeof recipeListMode !== 'undefined' && recipeListMode === 'load')
                ? 'Load Recipe'
                : 'Manage Recipes';
        } else if (PAGE_TITLES[pageName]) {
            title.textContent = PAGE_TITLES[pageName];
        }
    }
    var logoEl = document.getElementById('header-logo');
    var backBtnEl = document.getElementById('header-back-btn');
    if (pageName === 'home') {
        if (logoEl) logoEl.style.display = 'block';
        if (backBtnEl) backBtnEl.style.display = 'none';
    } else {
        if (logoEl) logoEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'block';
    }
    if (pageName === 'reports' && typeof loadReports === 'function') {
        if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
        setTimeout(function () { loadReports(currentReportFilter || null); }, 50);
    }
    if (pageName === 'report-preview' && typeof refreshReportsActionButtons === 'function') {
        setTimeout(refreshReportsActionButtons, 50);
    }
    if (pageName === 'settings') {
        setTimeout(function () {
            if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
        }, 50);
    }
    if (pageName === 'ip-configure' && typeof refreshIpConfigureAddresses === 'function') {
        refreshIpConfigureAddresses();
    }
    if (pageName === 'factory-settings') {
        setTimeout(function () {
            if (typeof initFactorySettings === 'function') initFactorySettings();
        }, 50);
    }
    if (pageName === 'quick-test') {
        setTimeout(function () {
            if (typeof loadCreateRecipeFactoryPresets === 'function') {
                loadCreateRecipeFactoryPresets();
            }
        }, 50);
    }
    if (pageName === 'manage-members' || pageName === 'locked-members' || pageName === 'disabled-members') {
        setTimeout(function () {
            if (typeof loadMembersAndRender === 'function') loadMembersAndRender();
        }, 50);
    }
    if (pageName === 'manage-recipes') {
        setTimeout(function () {
            if (typeof loadManageRecipes === 'function') loadManageRecipes();
        }, 50);
    }
    if (pageName === 'validate-type-select') {
        setTimeout(function () {
            // Clear selection when entering the validation type page.
            // This prevents retaining the previous selection.
            lastValidationType = null;
            var r1 = document.querySelector('input[name="val-type"][value="distance"]');
            var r2 = document.querySelector('input[name="val-type"][value="load"]');
            if (r1) r1.checked = false;
            if (r2) r2.checked = false;
        }, 0);
    }
    if (pageName === 'disable-recipes') {
        logAuditEvent('Opened disabled recipes', 'Disabled recipes list opened', { eventType: 'navigation' });
        setTimeout(function () {
            if (typeof loadDisableRecipes === 'function') loadDisableRecipes();
        }, 50);
    }
    if (pageName === 'create-recipe-step1') {
        setTimeout(function () {
            if (typeof loadCreateRecipeFactoryPresets === 'function') {
                loadCreateRecipeFactoryPresets();
            }
            if (window._createRecipePreserveStep1) {
                window._createRecipePreserveStep1 = false;
                if (typeof syncCreateRecipeConsolePresets === 'function') syncCreateRecipeConsolePresets();
                if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
                return;
            }
            if (window.currentEditingRecipeId && typeof loadRecipeForEdit === 'function') {
                loadRecipeForEdit();
            } else if (typeof updateCreateRecipeContinueButton === 'function') {
                updateCreateRecipeContinueButton();
            }
            if (typeof syncCreateRecipeConsolePresets === 'function') syncCreateRecipeConsolePresets();
        }, 50);
    }
    if (pageName === 'view-recipes') {
        setTimeout(function () {
            if (typeof loadViewRecipes === 'function') loadViewRecipes();
        }, 50);
    }
    if (pageName === 'validation-run') {
        setTimeout(function () {
            if (typeof initValidationRunPage === 'function') initValidationRunPage();
        }, 50);
    }
    if (pageName === 'datetime') {
        setTimeout(function () {
            if (typeof initializeDatetime === 'function') initializeDatetime();
        }, 50);
    }
    if (pageName === 'add-member') {
        setTimeout(function () {
            if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
                _refreshAddMemberPermissionsPanelVisibility();
            }
            if (typeof ensureAddMemberPageScroll === 'function') {
                ensureAddMemberPageScroll();
            }
        }, 50);
    }
    if (pageName === 'validate-type-select' || pageName === 'usp1-detail' ||
            pageName === 'usp2-detail') {
        setTimeout(function () {
            if (typeof ensureValidationPageScroll === 'function') {
                ensureValidationPageScroll(pageName);
            }
        }, 50);
    }
    if (pageName === 'user-profile') {
        setTimeout(function () {
            var u = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
            if (typeof updateProfileFromCurrentUser === 'function') updateProfileFromCurrentUser(u);
        }, 50);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    auditNavPageChange(pageName);
}

function goBack() {
    var activePage = document.querySelector('.page.active');
    var pageId = activePage ? activePage.id : '';
    if (pageId === 'page-quick-test') {
        goToPage('home');
    } else if (pageId === 'page-test-run') {
        if (isTestRunActive && typeof isTestRunActive === 'function' && isTestRunActive()) {
            showConfirmModal('Test is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
                if (!ok) return;
                if (typeof abortTestRunAndSave === 'function') {
                    abortTestRunAndSave().then(function (result) {
                        if (result && result.openedPreview) return;
                        _suppressTestRunNavGuardOnce = true;
                        goToPage('home');
                    });
                    return;
                }
                _suppressTestRunNavGuardOnce = true;
                goToPage('home');
            });
            return;
        }
        goToPage('home');
    } else if (pageId === 'page-create-recipe-step1') {
        goToPage('manage-recipes');
    } else if (pageId === 'page-report-preview') {
        if (typeof isReportPreviewLockedForCurrentUser === 'function' &&
            isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
            showAppModal('This report must be approved before you can leave. Ask a reviewer to verify approval on this screen.', 'Report');
            return;
        }
        goToPage('reports');
    } else if (pageId === 'page-recipe-print-preview') {
        goToPage('view-recipes');
    } else if (pageId === 'page-view-recipes') {
        goToPage('reports');
    } else if (pageId === 'page-factory-settings') {
        goToPage('settings');
    } else if (pageId === 'page-usp1-detail' || pageId === 'page-usp2-detail') {
        goToPage('validate-type-select');
    } else if (pageId === 'page-load-validation' || pageId === 'page-distance-validation') {
        goToPage('validate-type-select');
    } else if (pageId === 'page-validation-run') {
        if (isValidationOperationActive()) {
            showConfirmModal('Validation is running. Do you want to abort and exit?', 'Operation in progress').then(function (ok) {
                if (!ok) return;
                abortValidationRun({ skipConfirm: true }).then(function (result) {
                    if (result && (result.openedPreview || result.inFlight)) return;
                    _suppressValidationNavGuardOnce = true;
                    goToPage('validate-type-select');
                });
            });
            return;
        }
        if (typeof goBackFromValidationRun === 'function') goBackFromValidationRun();
        return;
    } else if (pageId === 'page-validate-type-select' || pageId === 'page-validate' || pageId === 'page-vd-validation-input') {
        if (isValidationOperationActive()) {
            showAppModal('Stop the validation run before exiting.', 'Validation');
            return;
        }
        if (pageId === 'page-validate') {
            goToPage('home');
        } else {
            goToPage('validate');
        }
        return;
    } else if (pageId === 'page-calibration-type-select') {
        goToPage('validate');
    } else if (pageId === 'page-vacuum-calibration') {
        goToPage('validate');
    } else if (pageId === 'page-load-calibration' || pageId === 'page-distance-zero-calibration') {
        goToPage('calibration-type-select');
    } else if (pageId === 'page-datetime') {
        goToPage('settings');
    } else if (pageId === 'page-locked-members' || pageId === 'page-disabled-members') {
        goToPage('manage-members');
    } else if (pageId === 'page-settings' || pageId === 'page-reports' || pageId === 'page-user-profile' || pageId === 'page-manage-recipes') {
        goToPage('home');
    } else if (pageId === 'page-password-expired-reset') {
        if (window._mandatoryPasswordResetPending) {
            showAppModal('Please reset your password before leaving this screen.', 'Reset Password');
            return;
        }
        if (window._passwordResetScreenMode === 'profile') {
            cancelProfilePasswordChange();
            return;
        }
        _restoreSidebarAndHeaderAfterExpiredReset();
        showLoginScreen();
    } else {
        goToPage('home');
    }
}

function login() {
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    var username = (uidEl && uidEl.value) ? String(uidEl.value).trim() : '';
    var password = (pwdEl && pwdEl.value) ? String(pwdEl.value) : '';
    if (!username || !password) {
        showAppModal('Please enter User/Employee ID and Password.', 'Login');
        return;
    }
    // Use raw fetch here so we can show backend error messages (lockout, disabled, etc.)
    fetch((API_BASE || '') + '/api/data/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        var msg = data.error || '';
        var remaining = (typeof data.remainingAttempts === 'number') ? data.remainingAttempts : null;
        if (result.status === 403 && data && data.passwordChangeRequired) {
            showMandatoryPasswordResetScreen(data.username || username);
            return;
        }
        if (result.status === 403 && data && data.passwordExpired) {
            showPasswordExpiredResetScreen(data.username || username, password);
            return;
        }
        if (result.status === 401) {
            if (remaining != null && remaining > 0) {
                msg = 'Incorrect password. ' + remaining + ' tr' + (remaining === 1 ? 'y' : 'ies') + ' remaining.';
            } else {
                msg = msg || 'Invalid username or password.';
            }
        } else if (result.status === 403) {
            msg = msg || 'Account locked. Contact admin.';
        } else if (!msg) {
            msg = 'Login failed (HTTP ' + result.status + ').';
        }
        showAppModal(msg, 'Login Failed');
    }).catch(function (err) {
        showAppModal('Login failed: ' + (err && err.message ? err.message : 'Network error'), 'Login Error');
    });
}

function showPasswordExpiredResetScreen(username, oldPassword) {
    window._passwordResetScreenMode = 'expired';
    window._mandatoryPasswordResetPending = false;
    _setPasswordResetCancelVisible(false);
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset Expired Password';
    if (subEl) subEl.textContent = 'Your password has expired. Set a new password to continue.';
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = oldPassword || '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (newEl && typeof newEl.focus === 'function') newEl.focus();
    }, 60);
}

function showMandatoryPasswordResetScreen(username) {
    window._passwordResetScreenMode = 'mandatory';
    window._mandatoryPasswordResetPending = true;
    _setPasswordResetCancelVisible(false);
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset your password';
    if (subEl) {
        subEl.textContent = 'Your account was created with a temporary password. Choose a new password that only you know before you can use the app.';
    }
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (oldEl && typeof oldEl.focus === 'function') oldEl.focus();
    }, 60);
}

function _restoreSidebarAndHeaderAfterExpiredReset() {
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (sidebar) {
        var prev = sidebar.getAttribute('data-prev-display');
        sidebar.style.display = prev != null ? prev : '';
        sidebar.removeAttribute('data-prev-display');
    }
    if (header) {
        var prevH = header.getAttribute('data-prev-display');
        header.style.display = prevH != null ? prevH : '';
        header.removeAttribute('data-prev-display');
    }
}

function submitPasswordResetFromLoginPage() {
    if (window._passwordResetScreenMode === 'mandatory') {
        submitMandatoryPasswordReset();
    } else if (window._passwordResetScreenMode === 'profile') {
        submitProfilePasswordChange();
    } else {
        submitExpiredPasswordReset();
    }
}

function submitProfilePasswordChange() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Change Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Change Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Change Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Change Password');
        return;
    }

    apiRequest(API_BASE + '/api/data/auth/change-password', {
        method: 'POST',
        body: { oldPassword: oldPassword, newPassword: newPassword }
    }).then(function (result) {
        if (!result || result.ok !== true) {
            showAppModal((result && result.error) ? String(result.error) : 'Password change failed.', 'Change Password');
            return;
        }
        window._passwordResetScreenMode = 'expired';
        window._mandatoryPasswordResetPending = false;
        _setPasswordResetCancelVisible(false);
        if (oldEl) oldEl.value = '';
        if (newEl) newEl.value = '';
        if (confEl) confEl.value = '';
        goToPage('user-profile');
        showAppModal('Password updated.', 'Change Password');
    }).catch(function (err) {
        showAppModal((err && err.message) ? err.message : 'Password change failed.', 'Change Password');
    });
}

function submitMandatoryPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/mandatory-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok && data.user) {
            window._mandatoryPasswordResetPending = false;
            window._passwordResetScreenMode = 'expired';
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            _restoreSidebarAndHeaderAfterExpiredReset();
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            showAppModal('Password updated.', 'Reset Password');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function submitExpiredPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/password-expired-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok) {
            _restoreSidebarAndHeaderAfterExpiredReset();
            showLoginScreen();
            var loginUid = document.getElementById('login-uid');
            var loginPwd = document.getElementById('login-pwd');
            if (loginUid) loginUid.value = username;
            if (loginPwd) loginPwd.value = '';
            showAppModal('Password updated. Please log in with your new password.', 'Reset Password');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function logout() {
    var runActive =
        (testRunButtonState === 'abort') ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true);
    var pendingGate = window._reportApprovalGate && window._reportApprovalGate.reportId != null &&
        !(typeof isFactorySessionUser === 'function' && isFactorySessionUser());

    var doLogout = function () {
        abortPendingReportOnLogout().then(function () {
            return stopActiveRunForLogout();
        }).finally(function () {
            apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'user' } }).catch(function () {});
            window.currentUser = null;
            try { localStorage.removeItem('currentUser'); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = null;
            currentReportFilter = null;
            clearReportApprovalGate();
            showLoginScreen();
        });
    };

    if (runActive) {
        var logoutConfirmMsg = (validationRunState === 'running' || validationRunBackendPending)
            ? 'Validation is running. Do you want to abort and logout?'
            : 'Test is running. Do you want to abort and logout?';
        showConfirmModal(logoutConfirmMsg, 'Operation in progress').then(function (ok) {
            if (!ok) return;
            doLogout();
        });
        return;
    }

    if (pendingGate) {
        showAppModal('You cannot log out until this report has been approved by a reviewer.', 'Report');
        var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
        if (rid && typeof openReportPreview === 'function') openReportPreview(rid);
        return;
    }

    doLogout();
}

function normalizeBiometricEnabled(value) {
    if (typeof value === 'string') {
        var v = value.trim().toLowerCase();
        if (v === 'disabled' || v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
        if (v === 'enabled' || v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
    }
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    return true;
}

function applyBiometricSetting(enabled) {
    biometricEnabledSetting = normalizeBiometricEnabled(enabled);
    var loginDivider = document.getElementById('login-divider');
    if (loginDivider) {
        loginDivider.style.display = biometricEnabledSetting ? '' : 'none';
    }
    var loginBtn = document.getElementById('login-biometric-btn');
    if (loginBtn) {
        loginBtn.style.display = biometricEnabledSetting ? '' : 'none';
        loginBtn.disabled = !biometricEnabledSetting;
    }
    var enrollBtn = document.getElementById('enroll-biometric-btn');
    if (enrollBtn) {
        enrollBtn.style.display = biometricEnabledSetting ? '' : 'none';
        enrollBtn.disabled = !biometricEnabledSetting;
    }
}

/** Minutes (0 = off). Updated from factory settings API / localStorage. */
var factoryAutoLogoutMinutes = 0;
var _autoLogoutLastActivityMs = 0;
var _autoLogoutIntervalId = null;
var _autoLogoutListenersAttached = false;
/** True from post-test wait through report save until pending preview is on screen. */
var _postRunSessionHold = false;

function applyFactoryAutoLogoutSetting(settings) {
    var raw = settings && settings.autoLogoutMinutes != null ? settings.autoLogoutMinutes : 0;
    var m = parseInt(raw, 10);
    if (isNaN(m)) m = 0;
    m = Math.max(0, Math.min(10080, m));
    factoryAutoLogoutMinutes = m;
    if (m < 1) {
        stopAutoLogoutWatcher();
    } else {
        markAutoLogoutActivity();
        if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
            ensureAutoLogoutWatcher();
        }
    }
}

function markAutoLogoutActivity() {
    _autoLogoutLastActivityMs = Date.now();
}

function _isDomOverlayVisible(id) {
    var el = document.getElementById(id);
    if (!el) return false;
    if (el.style && el.style.display === 'none') return false;
    if (el.style && (el.style.display === 'flex' || el.style.display === 'block')) return true;
    try {
        var cs = window.getComputedStyle(el);
        return !!(cs && cs.display !== 'none' && cs.visibility !== 'hidden');
    } catch (e) {
        return false;
    }
}

function isPendingApprovalReportOpen() {
    if (window._reportApprovalGate && window._reportApprovalGate.reportId != null) return true;
    var app = document.querySelector('.app-container');
    if (app && app.classList.contains('report-approval-locked')) return true;
    var page = document.getElementById('page-report-preview');
    if (page && page.classList.contains('active') && typeof isReportPendingApproval === 'function' && isReportPendingApproval()) {
        return true;
    }
    return false;
}

function isAutoLogoutRunBlocked() {
    if (testRunButtonState === 'abort') return true;
    if (validationRunState === 'running' || validationRunBackendPending === true) return true;
    if (_postRunSessionHold || window._postRunSessionHold) return true;
    if (typeof _abortSaveInFlight !== 'undefined' && _abortSaveInFlight) return true;
    if (_releasePressureTimerId != null) return true;
    var cal = window._vacuumCalRun;
    if (cal && cal.phase && cal.phase !== 'idle' && cal.phase !== 'done') return true;
    if (isPendingApprovalReportOpen()) return true;
    var overlayIds = [
        'release-pressure-overlay',
        'app-loading-overlay',
        'calibration-gauge-modal',
        'biometric-progress-overlay',
        'app-modal-overlay',
        'test-run-step-complete-overlay',
        'test-run-abort-overlay',
        'test-run-completion-overlay'
    ];
    for (var i = 0; i < overlayIds.length; i++) {
        if (_isDomOverlayVisible(overlayIds[i])) return true;
    }
    return false;
}

var _kioskWakeLock = null;

function requestKioskScreenWakeLock() {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== 'function') return;
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
        _kioskWakeLock = lock;
        if (lock && typeof lock.addEventListener === 'function') {
            lock.addEventListener('release', function () {
                if (_kioskWakeLock === lock) _kioskWakeLock = null;
            });
        }
    }).catch(function () {});
}

function releaseKioskScreenWakeLock() {
    if (!_kioskWakeLock) return;
    try { _kioskWakeLock.release(); } catch (e) { /* ignore */ }
    _kioskWakeLock = null;
}

function syncKioskScreenWakeLock() {
    if (isAutoLogoutRunBlocked()) {
        if (!_kioskWakeLock) requestKioskScreenWakeLock();
    } else {
        releaseKioskScreenWakeLock();
    }
}

if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && isAutoLogoutRunBlocked()) {
            requestKioskScreenWakeLock();
        }
    });
}

function ensureAutoLogoutListeners() {
    if (_autoLogoutListenersAttached) return;
    _autoLogoutListenersAttached = true;
    var opts = { capture: true, passive: true };
    ['pointerdown', 'touchstart', 'click', 'keydown', 'wheel'].forEach(function (ev) {
        document.addEventListener(ev, markAutoLogoutActivity, opts);
    });
}

function stopAutoLogoutWatcher() {
    if (_autoLogoutIntervalId != null) {
        clearInterval(_autoLogoutIntervalId);
        _autoLogoutIntervalId = null;
    }
}

function ensureAutoLogoutWatcher() {
    ensureAutoLogoutListeners();
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) return;
    if (factoryAutoLogoutMinutes < 1) return;
    markAutoLogoutActivity();
    if (_autoLogoutIntervalId != null) return;
    _autoLogoutIntervalId = setInterval(autoLogoutTick, 10000);
}

function autoLogoutTick() {
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
        stopAutoLogoutWatcher();
        return;
    }
    var app = document.querySelector('.app-container');
    if (!app || app.style.display === 'none') return;
    if (isAutoLogoutRunBlocked()) {
        markAutoLogoutActivity();
        syncKioskScreenWakeLock();
        return;
    }
    syncKioskScreenWakeLock();
    if (factoryAutoLogoutMinutes < 1) return;
    var limitMs = factoryAutoLogoutMinutes * 60000;
    if (Date.now() - _autoLogoutLastActivityMs >= limitMs) {
        stopAutoLogoutWatcher();
        performAutoLogoutDueToInactivity();
    }
}

function performAutoLogoutDueToInactivity() {
    if (isAutoLogoutRunBlocked()) {
        markAutoLogoutActivity();
        return;
    }
    var pendingGate = window._reportApprovalGate && window._reportApprovalGate.reportId != null &&
        !(typeof isFactorySessionUser === 'function' && isFactorySessionUser());
    var finish = function () {
        apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'inactivity' } }).catch(function () {});
        window.currentUser = null;
        try { localStorage.removeItem('currentUser'); } catch (e) {}
        if (typeof currentUser !== 'undefined') currentUser = null;
        clearReportApprovalGate();
        showLoginScreen();
        setTimeout(function () {
            showAppModal('You were logged out due to inactivity.', 'Session');
        }, 200);
    };
    if (pendingGate) {
        markAutoLogoutActivity();
        return;
    }
    if (testRunButtonState === 'abort' && typeof abortTestRunAndSave === 'function') {
        abortTestRunAndSave().finally(finish);
        return;
    }
    finish();
}

function loginBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric login is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    if (window._loginBiometricInFlight) return;
    window._loginBiometricInFlight = true;
    var abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    window._loginBiometricAbort = function () {
        if (abortCtrl) abortCtrl.abort();
    };
    showBiometricProgressOverlay(
        'Biometric Login',
        'Activating fingerprint scanner. Place your finger on the sensor.'
    );
    var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    };
    if (abortCtrl) fetchOpts.signal = abortCtrl.signal;
    fetch((API_BASE || '') + '/api/data/auth/login-biometric', fetchOpts).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            window.currentUser = data.user;
            try { localStorage.setItem('currentUser', JSON.stringify(data.user)); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = data.user;
            updateProfileFromCurrentUser(data.user);
            showAppContainer();
            refreshActiveQaCount();
            goToPage('home');
            return;
        }
        if (result.status === 403 && data && data.passwordChangeRequired && data.username) {
            showMandatoryPasswordResetScreen(data.username);
            return;
        }
        var msg = (data && data.error) ? String(data.error) : 'Biometric login failed.';
        showAppModal(msg, 'Biometric Login');
    }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showAppModal('Biometric login failed: ' + (err && err.message ? err.message : 'Network error'), 'Biometric Login');
    }).finally(function () {
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
    });
}

var _biometricEnrollUsername = null;
var _biometricEnrollCancelled = false;

function _getBiometricEnrollUsername() {
    var bioUserEl = document.getElementById('member-biometric-username');
    var formUserEl = document.getElementById('add-userid');
    if (bioUserEl && bioUserEl.textContent && bioUserEl.textContent.trim() !== '--') {
        return bioUserEl.textContent.trim();
    }
    if (formUserEl && formUserEl.value) return formUserEl.value.trim();
    return '';
}

function _setBioEnrollStepActive(step) {
    var steps = document.querySelectorAll('#bio-enroll-steps .bio-enroll-step');
    steps.forEach(function (el) {
        var n = parseInt(el.getAttribute('data-step'), 10);
        el.classList.remove('active', 'done');
        if (n < step) el.classList.add('done');
        else if (n === step) el.classList.add('active');
    });
}

function _setBioFingerAnimState(state) {
    var stage = document.getElementById('bio-finger-stage');
    if (!stage) return;
    stage.classList.remove('state-place', 'state-scan', 'state-remove', 'state-done');
    if (state) stage.classList.add('state-' + state);
}

function setBiometricOverlayRetryVisible(visible) {
    var retryBtn = document.getElementById('biometric-progress-retry-btn');
    if (retryBtn) retryBtn.style.display = visible ? '' : 'none';
}

function showBiometricEnrollUi(opts) {
    opts = opts || {};
    var overlay = document.getElementById('biometric-progress-overlay');
    var titleEl = document.getElementById('biometric-progress-title');
    var msgEl = document.getElementById('biometric-progress-message');
    var hintEl = document.getElementById('biometric-progress-hint');
    var spinner = document.getElementById('biometric-progress-spinner');
    var stepsWrap = document.getElementById('bio-enroll-steps');
    var fingerStage = document.getElementById('bio-finger-stage');
    var enrollMode = !!opts.enrollMode;
    var verifyMode = !!opts.verifyMode;
    if (stepsWrap) stepsWrap.style.display = enrollMode ? 'flex' : 'none';
    if (fingerStage) fingerStage.style.display = (enrollMode || verifyMode) ? 'block' : 'none';
    if (titleEl && opts.title) titleEl.textContent = opts.title;
    if (msgEl && opts.message !== undefined) msgEl.textContent = opts.message || '';
    if (hintEl) hintEl.textContent = opts.hint || '';
    if (spinner) spinner.style.display = opts.scanning ? 'block' : 'none';
    if (opts.step) _setBioEnrollStepActive(opts.step);
    if (opts.fingerState) _setBioFingerAnimState(opts.fingerState);
    else if (verifyMode && opts.scanning) _setBioFingerAnimState('scan');
    else if (verifyMode && !opts.scanning) _setBioFingerAnimState('place');
    if (overlay) overlay.style.display = 'flex';
}

function showBiometricProgressOverlay(title, message) {
    setBiometricOverlayRetryVisible(false);
    showBiometricEnrollUi({
        title: title,
        message: message,
        enrollMode: false,
        verifyMode: true,
        scanning: true
    });
}

function showBiometricVerifyFailedOverlay(message, hint) {
    showBiometricEnrollUi({
        title: 'Fingerprint not recognized',
        message: message || 'Fingerprint verification failed.',
        hint: hint || 'Place your finger on the scanner and tap Try again.',
        enrollMode: false,
        verifyMode: true,
        scanning: false,
        fingerState: 'place'
    });
    setBiometricOverlayRetryVisible(true);
}

function hideBiometricProgressOverlay() {
    var overlay = document.getElementById('biometric-progress-overlay');
    if (overlay) overlay.style.display = 'none';
    _setBioFingerAnimState('');
    _biometricEnrollUsername = null;
    _biometricEnrollCancelled = false;
    setBiometricOverlayRetryVisible(false);
    window._biometricVerifyRetryFn = null;
    window._biometricVerifyCancelResolve = null;
    window._biometricVerifyActive = false;
}

function retryBiometricProgress() {
    setBiometricOverlayRetryVisible(false);
    if (typeof window._biometricVerifyRetryFn === 'function') {
        window._biometricVerifyRetryFn();
    }
}

function runBiometricVerifyWithRetry(opts) {
    opts = opts || {};
    var purpose = opts.purpose || 'report';
    var reportType = opts.reportType || null;
    if (window._biometricVerifyActive) {
        return Promise.resolve({ ok: false, error: 'cancelled', message: '' });
    }
    return new Promise(function (resolve) {
        if (!biometricEnabledSetting) {
            resolve({ ok: false, error: 'Biometric verification is disabled by Factory Settings.' });
            return;
        }
        window._biometricVerifyActive = true;
        var cancelled = false;
        var lastError = 'Fingerprint verification failed.';

        function finish(result) {
            window._biometricVerifyActive = false;
            resolve(result);
        }

        function finishCancel() {
            cancelled = true;
            hideBiometricProgressOverlay();
            finish({ ok: false, error: 'cancelled', message: lastError });
        }

        function attempt() {
            if (cancelled) return;
            showBiometricProgressOverlay(
                opts.title || 'Verify Fingerprint',
                opts.message || 'Place your finger on the scanner.'
            );
            var body = { method: 'biometric', purpose: purpose };
            if (purpose === 'report' && reportType) body.reportType = reportType;
            apiRequest(API_BASE + '/api/data/auth/approval-verify', {
                method: 'POST',
                body: body
            }).then(function (data) {
                if (cancelled) return;
                if (data && data.ok && data.token) {
                    hideBiometricProgressOverlay();
                    finish({ ok: true, token: String(data.token) });
                    return;
                }
                lastError = (data && data.error) ? String(data.error) : 'Fingerprint verification failed.';
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            }).catch(function (err) {
                if (cancelled) return;
                lastError = 'Fingerprint verification failed: ' + (err && err.message ? err.message : 'Error');
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            });
        }

        window._biometricVerifyCancelResolve = finishCancel;
        window._biometricVerifyRetryFn = attempt;
        attempt();
    });
}

function _cancelBiometricEnrollSession() {
    var username = _biometricEnrollUsername;
    if (!username) return Promise.resolve();
    return apiRequest(API_BASE + '/api/biometric/enroll/cancel', {
        method: 'POST',
        body: { username: username }
    }).catch(function () {});
}

function cancelBiometricProgress() {
    _biometricEnrollCancelled = true;
    if (typeof window._loginBiometricAbort === 'function') {
        window._loginBiometricAbort();
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
        return;
    }
    if (typeof window._biometricVerifyCancelResolve === 'function') {
        var cancelVerify = window._biometricVerifyCancelResolve;
        window._biometricVerifyCancelResolve = null;
        cancelVerify();
        return;
    }
    _cancelBiometricEnrollSession().finally(function () {
        hideBiometricProgressOverlay();
    });
}

function _delayMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function _biometricEnrollCaptureStep(username, step) {
    return apiRequest(API_BASE + '/api/biometric/enroll/capture', {
        method: 'POST',
        body: { username: username, step: step }
    });
}

function enrollMemberBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric enrollment is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    var username = _getBiometricEnrollUsername();
    if (!username) {
        showAppModal('No member selected for fingerprint enrollment. Save the member first.', 'Register Fingerprint');
        return;
    }
    _biometricEnrollUsername = username;
    _biometricEnrollCancelled = false;
    var returnPage = window._biometricEnrollReturnPage || 'user-profile';
    var successTitle = window._biometricEnrollSuccessTitle || 'Register Fingerprint';
    var successMsg = window._biometricEnrollSuccessMessage || 'Fingerprint enrolled successfully.';

    showBiometricEnrollUi({
        enrollMode: true,
        title: 'Register Fingerprint — Scan 1 of 2',
        message: 'Place your finger flat on the scanner.',
        hint: 'Hold still until the first scan is captured.',
        step: 1,
        fingerState: 'scan',
        scanning: true
    });

    _biometricEnrollCaptureStep(username, 1).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data || !data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'First scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Remove your finger',
            message: 'Lift your finger off the scanner.',
            hint: 'Wait a moment, then you will scan the same finger again.',
            step: 1,
            fingerState: 'remove',
            scanning: false
        });
        return _delayMs(1800);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Register Fingerprint — Scan 2 of 2',
            message: 'Place the same finger on the scanner again.',
            hint: 'Use the same finger as the first scan. Hold still until complete.',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _biometricEnrollCaptureStep(username, 2);
    }).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data) return;
        if (!data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'Second scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Saving fingerprint',
            message: 'Matching scans and saving template…',
            hint: '',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _delayMs(400).then(function () { return data; });
    }).then(function (data) {
        if (_biometricEnrollCancelled || !data || !data.ok) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Fingerprint registered',
            message: 'Both scans captured successfully.',
            hint: '',
            step: 2,
            fingerState: 'done',
            scanning: false
        });
        document.querySelectorAll('#bio-enroll-steps .bio-enroll-step').forEach(function (el) {
            el.classList.add('done');
            el.classList.remove('active');
        });
        return _delayMs(900);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        _addMemberLastSavedId = null;
        window._biometricEnrollReturnPage = null;
        window._biometricEnrollSuccessTitle = null;
        window._biometricEnrollSuccessMessage = null;
        showAppModal(successMsg, successTitle);
        goToPage(returnPage);
    }).catch(function (err) {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        showAppModal('Fingerprint enrollment failed: ' + (err && err.message ? err.message : 'Network error'), 'Register Fingerprint');
    });
}

/**
 * After enable / password change: optional biometric reset (delete old + 2-capture enroll).
 * Cancel / Keep Current leaves the existing template unchanged.
 */
function offerOptionalBiometricReset(opts) {
    opts = opts || {};
    if (!biometricEnabledSetting) {
        if (typeof opts.onSkip === 'function') opts.onSkip();
        return Promise.resolve(false);
    }
    var username = String(opts.username || '').trim();
    if (!username) {
        if (typeof opts.onSkip === 'function') opts.onSkip();
        return Promise.resolve(false);
    }
    var memberId = opts.memberId != null ? opts.memberId : null;
    var returnPage = opts.returnPage || 'manage-members';
    return showConfirmModal(
        'Reset biometric fingerprint for ' + username + '? The old template will be deleted from the sensor and you will capture a new one (2 scans). Choose Keep Current to leave the existing fingerprint unchanged.',
        'Biometric Reset',
        { okLabel: 'Reset Biometric', cancelLabel: 'Keep Current' }
    ).then(function (doReset) {
        if (!doReset) {
            if (typeof opts.onSkip === 'function') opts.onSkip();
            return false;
        }
        var body = { username: username };
        if (memberId != null) body.memberId = memberId;
        return apiRequest(API_BASE + '/api/biometric/delete', {
            method: 'POST',
            body: body
        }).then(function () {
            window._biometricEnrollReturnPage = returnPage;
            window._biometricEnrollSuccessTitle = 'Biometric Reset';
            window._biometricEnrollSuccessMessage = 'Fingerprint re-enrolled successfully.';
            _populateMemberBiometricSummary({
                id: memberId,
                username: username,
                name: opts.name || username
            });
            goToPage('member-biometric');
            // Auto-start capture after page paint
            setTimeout(function () {
                enrollMemberBiometric();
            }, 200);
            return true;
        }).catch(function (err) {
            showAppModal(
                'Failed to clear old fingerprint: ' + (err && err.message ? err.message : 'Unknown error'),
                'Biometric Reset'
            );
            if (typeof opts.onSkip === 'function') opts.onSkip();
            return false;
        });
    });
}

// ===== Post-run full-screen "Releasing pressure" lock (Pi-owned timer) =====
var _releasePressureTimerId = null;
var _releasePressureResolve = null;
/** After a completed leak test: keep the screen on this long, then open the pending-approval report. */
function getReleasePressureLockSec() {
    var sec = 80;
    try {
        var stored = localStorage.getItem('factorySettings');
        if (stored) {
            var s = JSON.parse(stored);
            var r = parseInt(s.calibrationReleaseTimeSec, 10);
            if (!isNaN(r) && r >= 1 && r <= 5999) sec = r;
        }
    } catch (e) { /* ignore */ }
    return sec;
}

function hideReleasePressureLock() {
    if (_releasePressureTimerId != null) {
        clearInterval(_releasePressureTimerId);
        _releasePressureTimerId = null;
    }
    var overlay = document.getElementById('release-pressure-overlay');
    if (overlay) overlay.style.display = 'none';
    var resolve = _releasePressureResolve;
    _releasePressureResolve = null;
    if (typeof resolve === 'function') {
        try { resolve(); } catch (e) { /* ignore */ }
    }
}

/**
 * Lock the full screen for releaseSec while pressure vents.
 * Returns a Promise that resolves when the countdown finishes.
 * Idle auto-logout is suppressed for the whole countdown.
 *
 * ESP vents on #STOP* — send STOP 2–3 times as soon as this timer starts
 * (do not wait until the countdown ends).
 *
 * options.sendStop — default true; set false for calibration (uses STOP_CALIB elsewhere).
 * options.stopBurstCount — how many STOP posts (default 3).
 */
function showReleasePressureLock(releaseSec, options) {
    options = options || {};
    return new Promise(function (resolve) {
        if (_releasePressureTimerId != null) {
            clearInterval(_releasePressureTimerId);
            _releasePressureTimerId = null;
        }
        if (typeof _releasePressureResolve === 'function') {
            try { _releasePressureResolve(); } catch (e) { /* ignore */ }
        }
        _releasePressureResolve = resolve;
        var total = parseInt(releaseSec, 10);
        if (isNaN(total) || total < 1) total = getReleasePressureLockSec();
        var remaining = total;
        var overlay = document.getElementById('release-pressure-overlay');
        var titleEl = document.getElementById('release-pressure-title');
        var msgEl = document.getElementById('release-pressure-message');
        var timerEl = document.getElementById('release-pressure-timer');
        if (titleEl) titleEl.textContent = 'Releasing pressure';
        if (msgEl) msgEl.textContent = 'Please wait. Do not touch the chamber.';
        function paint() {
            if (timerEl) {
                timerEl.textContent = (typeof formatMmSs === 'function')
                    ? formatMmSs(remaining)
                    : String(remaining);
            }
        }
        paint();
        if (overlay) overlay.style.display = 'flex';
        markAutoLogoutActivity();
        syncKioskScreenWakeLock();

        // Vent immediately when the release lock starts (ESP releases on STOP).
        if (options.sendStop !== false && typeof hardwareLeakStopBurst === 'function') {
            hardwareLeakStopBurst(options.stopBurstCount != null ? options.stopBurstCount : 3);
        }

        _releasePressureTimerId = setInterval(function () {
            remaining -= 1;
            markAutoLogoutActivity();
            if (remaining <= 0) {
                hideReleasePressureLock();
                return;
            }
            paint();
        }, 1000);
    });
}
window.showReleasePressureLock = showReleasePressureLock;
window.hideReleasePressureLock = hideReleasePressureLock;
window.getReleasePressureLockSec = getReleasePressureLockSec;

// ===== Generic Loading Overlay (export progress, long ops) =====
var _appLoadingCancelHandler = null;

function showLoadingOverlay(title, message, options) {
    var overlay = document.getElementById('app-loading-overlay');
    var titleEl = document.getElementById('app-loading-title');
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    var cancelBtn = document.getElementById('app-loading-cancel-btn');
    if (titleEl) titleEl.textContent = title || 'Working...';
    if (msgEl) msgEl.textContent = message || 'Please wait.';
    if (detailEl) detailEl.textContent = '';
    var opts = options || {};
    _appLoadingCancelHandler = typeof opts.onCancel === 'function' ? opts.onCancel : null;
    if (cancelBtn) {
        if (opts.cancellable === false) {
            cancelBtn.style.display = 'none';
        } else {
            cancelBtn.style.display = '';
            cancelBtn.disabled = false;
        }
    }
    // Default: spinner shown, progress bar hidden. Caller can switch with setLoadingProgress.
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (opts.progress === true) {
        if (spinner) spinner.style.display = 'none';
        if (pwrap) pwrap.style.display = '';
        if (pbar) pbar.style.width = '0%';
        if (ppct) ppct.textContent = '0%';
    } else {
        if (spinner) spinner.style.display = '';
        if (pwrap) pwrap.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
}

function setLoadingMessage(message, detail) {
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    if (msgEl && message != null) msgEl.textContent = String(message);
    if (detailEl && detail != null) detailEl.textContent = String(detail);
}

function setLoadingProgress(percent, message, detail) {
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (spinner) spinner.style.display = 'none';
    if (pwrap) pwrap.style.display = '';
    var pct = parseFloat(percent);
    if (!isFinite(pct)) pct = 0;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pbar) pbar.style.width = pct.toFixed(1) + '%';
    if (ppct) ppct.textContent = Math.round(pct) + '%';
    if (message != null) setLoadingMessage(message, detail != null ? detail : undefined);
    else if (detail != null) setLoadingMessage(null, detail);
}

// Map any backend / network error into a single short user-facing line.
function _friendlyExportError(err) {
    var raw = '';
    if (err && err.message) raw = String(err.message);
    else if (typeof err === 'string') raw = err;
    var t = raw.toLowerCase();
    if (t.indexOf('no external pendrive') !== -1 || t.indexOf('not detected') !== -1)
        return 'No external pendrive detected. Please connect a USB pendrive and try again.';
    if (t.indexOf('multiple pendrives') !== -1)
        return 'Multiple pendrives detected. Please disconnect extras and try again.';
    if (t.indexOf('could not access') !== -1 || t.indexOf('not authorized') !== -1 || t.indexOf('mount') !== -1)
        return 'Could not access the pendrive. Reconnect it and try again.';
    if (t.indexOf('disk full') !== -1 || t.indexOf('no space') !== -1)
        return 'Pendrive is full. Free space or use a different pendrive.';
    return 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.';
}


var _auditLoadMessageTimers = [];

function showAuditTrailsLoadingOverlay() {
    hideAuditTrailsLoadingOverlay();
    showLoadingOverlay('Audit Trails', 'Fetching audit trails...', { cancellable: false });
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Processing audit trails...', 'Please wait.');
    }, 450));
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Loading audit trails...', 'Please wait.');
    }, 950));
}

function hideAuditTrailsLoadingOverlay() {
    _auditLoadMessageTimers.forEach(function (id) { clearTimeout(id); });
    _auditLoadMessageTimers = [];
    hideLoadingOverlay();
}

var _auditFilterExcludedActions = {
    'Logout': true,
    'Logout (inactivity timeout)': true,
    'Entered screen': true,
    'Exited screen': true,
    'Entered Vacuum Decay validation': true,
    'Entered Pressure Decay validation': true,
    'check adaptor and holder': true
};

function _isAuditFilterExcludedAction(action) {
    var a = String(action || '').trim();
    if (!a) return true;
    if (_auditFilterExcludedActions[a]) return true;
    if (/^Entered /i.test(a) || /^Exited /i.test(a)) return true;
    if (/pressure decay/i.test(a) && /Entered/i.test(a)) return true;
    return false;
}

function _populateAuditFilterDropdowns(userEl, actionEl, fullList) {
    var users = [];
    var actions = [];
    (fullList || []).forEach(function (e) {
        var u = e.user || '--';
        if (users.indexOf(u) === -1) users.push(u);
        var a = e.action || '';
        if (a && !_isAuditFilterExcludedAction(a) && actions.indexOf(a) === -1) actions.push(a);
    });
    var coreActions = [
        'Login', 'User logged in', 'User locked', 'User unlocked', 'User disabled', 'User enabled',
        'Opened Quick Test', 'Opened Load Recipe', 'Opened Manage Recipe',
        'Opened Validation', 'Opened Calibration', 'Opened Settings',
        'Loaded recipe', 'Recipe test loaded', 'Quick test loaded',
        'Opened disabled recipes',
        'Test started', 'Quick test started', 'Recipe test started',
        'Test finished', 'Quick test finished', 'Recipe test finished',
        'Test aborted', 'Quick test aborted', 'Recipe test aborted',
        'Test auto-aborted', 'Quick test auto-aborted', 'Recipe test auto-aborted',
        'Test aborted - leaks found', 'Quick test aborted - leaks found', 'Recipe test aborted - leaks found',
        'Test performed', 'Quick test performed',
        'Validation started', 'Validation finished', 'Validation aborted',
        'Validation aborted - leaks found',
        'Calibration started', 'Calibration completed', 'Calibration aborted', 'Calibration performed',
        'Calibration aborted - leaks found',
        'holder error', 'Holder check error',
        'Validation performed', 'Report saved', 'Report generated', 'Report approved',
        'Report aborted', 'Report aborted (power loss)', 'Report auto-approved (power interruption)', 'Report PDF generated',
        'Report preview viewed', 'Print A4', 'Print thermal', 'Reports exported',
        'Audit log viewed', 'Audit trail exported',
        'Recipe created', 'Recipe edited', 'Recipe approved', 'Power interruption',
        'Approval verification', 'Disable Recipe', 'Recipe disabled',
        'Added new user', 'Password changed', 'Password reset', 'Profile updated',
        'User create', 'User update', 'User permissions updated',
        'System date change', 'Factory settings changed'
    ];
    coreActions.forEach(function (a) {
        if (!_isAuditFilterExcludedAction(a) && actions.indexOf(a) === -1) actions.push(a);
    });
    users.sort();
    actions.sort();
    if (userEl) {
        userEl.innerHTML = '<option value="">All</option>';
        users.forEach(function (u) { userEl.appendChild(new Option(u, u)); });
    }
    if (actionEl) {
        actionEl.innerHTML = '<option value="">All</option>';
        actions.forEach(function (a) { actionEl.appendChild(new Option(a, a)); });
    }
}

function _renderAuditLogRows(tbody, list) {
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!list || !list.length) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="5">No audit entries match the filters.</td>';
        tbody.appendChild(emptyRow);
        return;
    }
    list.forEach(function (entry) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + (entry.dateTime || '') + '</td><td>' + (entry.user || '--') + '</td><td>' + displayRoleLabel(entry.role || '--') + '</td><td>' + (entry.action || '') + '</td><td>' + formatAuditDetailsText(entry.details || '') + '</td>';
        tbody.appendChild(row);
    });
}

function hideLoadingOverlay() {
    var overlay = document.getElementById('app-loading-overlay');
    if (overlay) overlay.style.display = 'none';
    _appLoadingCancelHandler = null;
}

function cancelLoadingOverlay() {
    var fn = _appLoadingCancelHandler;
    _appLoadingCancelHandler = null;
    hideLoadingOverlay();
    if (typeof fn === 'function') {
        try { fn(); } catch (e) { /* ignore */ }
    }
}

// ===== USB Pendrive Picker =====
var _usbPickerResolve = null;

function pickPendrive(devices) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('usb-picker-overlay');
        var list = document.getElementById('usb-picker-list');
        if (!overlay || !list) {
            resolve(null);
            return;
        }
        list.innerHTML = '';
        (devices || []).forEach(function (d) {
            var card = document.createElement('div');
            card.className = 'usb-picker-card';
            var label = d.label || '(no label)';
            var size = d.size_human || '';
            var fs = (d.fs_type || '').toUpperCase();
            var path = d.path || '';
            card.innerHTML =
                '<div class="usb-picker-card-meta">' +
                    '<span class="usb-picker-card-label">' + label + '</span>' +
                    '<span class="usb-picker-card-sub">' + path + ' \u2014 ' + size + (fs ? ' \u2014 ' + fs : '') + '</span>' +
                '</div>' +
                '<button type="button" class="btn btn-primary">Choose</button>';
            card.addEventListener('click', function () {
                hideUsbPicker();
                if (_usbPickerResolve) { _usbPickerResolve(d.path); _usbPickerResolve = null; }
            });
            list.appendChild(card);
        });
        _usbPickerResolve = resolve;
        overlay.style.display = 'flex';
    });
}

function hideUsbPicker() {
    var overlay = document.getElementById('usb-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function cancelUsbPicker() {
    hideUsbPicker();
    if (_usbPickerResolve) {
        _usbPickerResolve(null);
        _usbPickerResolve = null;
    }
}

// ===== Report Preview HTML capture for PDF rendering =====
var _stylesCssCache = null;

function _fetchStylesCss() {
    if (_stylesCssCache != null) return Promise.resolve(_stylesCssCache);
    return fetch('styles.css', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('styles.css HTTP ' + r.status);
        return r.text();
    }).then(function (txt) {
        _stylesCssCache = String(txt || '');
        return _stylesCssCache;
    }).catch(function () {
        _stylesCssCache = '';
        return '';
    });
}

function _wrapPreviewHtmlAsDocument(innerHtml, cssText) {
    var docCss =
        '@page { size: A4; margin: 6mm 5mm; }' +
        'html, body { margin: 0; padding: 0; background: #ffffff; color: #000; }' +
        'body { font-family: Inter, "Segoe UI", Roboto, system-ui, sans-serif; }' +
        '.modal-overlay, .sidebar, .app-header, .header-back-btn, header.app-header, ' +
        '.test-run-controls, .report-preview-actions, #report-approve-panel, #report-pending-lock-banner, ' +
        '#report-legacy-preview { display: none !important; }' +
        '.report-a4-text-preview { display: block !important; font-family: "Courier New", Courier, monospace !important; ' +
            'font-size: 10.5pt !important; line-height: 1.2 !important; white-space: pre !important; ' +
            'width: fit-content !important; max-width: 100% !important; margin: 0 auto !important; ' +
            'color: #000 !important; background: #fff !important; padding: 0 !important; }' +
        '.report-preview-container.report-a4-preview-mode { font-family: "Courier New", Courier, monospace !important; ' +
            'width: fit-content !important; max-width: 100% !important; margin: 0 auto !important; ' +
            'padding: 10mm 8mm !important; min-height: auto !important; box-shadow: none !important; ' +
            'display: flex !important; flex-direction: column !important; align-items: center !important; ' +
            'background: #fff !important; }' +
        'body { display: flex !important; justify-content: center !important; }' +
        '#page-report-preview, .page, .page.active { display: block !important; position: static !important; ' +
            'background: #ffffff !important; color: #000 !important; padding: 0 !important; margin: 0 !important; ' +
            'opacity: 1 !important; overflow: visible !important; height: auto !important; max-height: none !important; }' +
        '#page-report-preview * { color: #000 !important; background: transparent !important; }' +
        '#page-report-preview table { border-collapse: collapse; width: 100%; }' +
        '#page-report-preview th, #page-report-preview td { border: 1px solid #888; padding: 4px 6px; }' +
        '.report-preview-container.report-pdf-compact { min-height: auto !important; max-height: none !important; padding: 3mm 5mm !important; margin: 0 !important; box-shadow: none !important; font-size: 9pt !important; line-height: 1.2 !important; }' +
        '.report-preview-container.report-pdf-compact h1 { font-size: 13pt !important; margin: 2px 0 4px !important; }' +
        '.report-preview-container.report-pdf-compact h2 { font-size: 10pt !important; margin: 2px 0 4px !important; }' +
        '.report-preview-container.report-pdf-compact h3 { font-size: 9.5pt !important; margin: 5px 0 2px !important; }' +
        '.report-preview-container.report-pdf-compact table { margin: 4px 0 !important; }' +
        '.report-preview-container.report-pdf-compact th, .report-preview-container.report-pdf-compact td { padding: 2px 4px !important; font-size: 8.5pt !important; border-width: 1px !important; }' +
        '.report-preview-container.report-pdf-compact .report-remarks-box { min-height: 20px !important; padding: 3px 5px !important; margin: 4px 0 !important; }' +
        '.report-preview-container.report-pdf-compact .report-approval-table { margin-top: 6px !important; }' +
        '.report-preview-container.report-pdf-compact .report-validation-usp-header { background: #e8e8e8 !important; font-weight: bold; }';
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>' +
        '<style>' + (cssText || '') + '</style>' +
        '<style>' + docCss + '</style>' +
        '</head><body>' + (innerHtml || '') + '</body></html>'
    );
}

function buildReportPreviewHtmlById(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.reject(new Error('Invalid report id'));
    return Promise.all([
        apiRequest(API_BASE + '/api/reports/' + id + '/preview'),
        _fetchStylesCss()
    ]).then(function (results) {
        var data = results[0];
        var css = results[1];
        if (!data || !data.preview) throw new Error('No preview for report ' + id);
        // Render into the existing hidden page-report-preview DOM (not navigated to).
        try {
            populateReportPreview(data.preview);
        } catch (e) {
            // populate must not throw; we continue with whatever DOM state.
        }
        var pageEl = document.getElementById('page-report-preview');
        var containerEl = pageEl ? pageEl.querySelector('.report-preview-container') : null;
        if (containerEl) containerEl.classList.add('report-pdf-compact');
        var inner = pageEl ? pageEl.outerHTML : '';
        var doc = _wrapPreviewHtmlAsDocument(inner, css);
        if (containerEl) containerEl.classList.remove('report-pdf-compact');
        return doc;
    });
}

// ===== External-USB report export flow =====
function _summariseExportResult(result) {
    var count = (result && result.count) ? result.count : 0;
    var fails = (result && result.failed && result.failed.length) ? result.failed.length : 0;
    if (count > 0 && !fails) {
        return (count === 1)
            ? 'Report export successful.'
            : count + ' reports exported successfully.';
    }
    if (count > 0 && fails) {
        return count + ' exported, ' + fails + ' failed.';
    }
    return 'Export completed with no files written.';
}

function _ensureExportApprovalToken() {
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory') return Promise.resolve('');
    return openApprovalVerifyModal({
        purpose: 'export',
        titleText: 'Export approval',
        subtitleText: 'Enter credentials of a user with export approval permission.',
        usernameLabelText: 'Verifier username',
        usernamePlaceholder: 'Username',
        emptyCredentialsMessage: 'Enter verifier username and password.'
    }).then(function (token) {
        return token || '';
    });
}

function _exportReportsWithFlow(reportIds, opts) {
    var ids = (reportIds || []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x) && x > 0; });
    if (!ids.length) {
        showAppModal('No reports selected to export.', 'Export');
        return Promise.resolve(null);
    }
    var u = window.currentUser;
    if (!userCanExportToUsb(u)) {
        showAppModal('You do not have permission to export reports to USB.', 'Export');
        return Promise.resolve(null);
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    var titleText = (opts && opts.title) ? opts.title : 'Export';

    return _ensureExportApprovalToken().then(function (token) {
        if (role !== 'factory' && !token) {
            showAppModal('Export cancelled — approval is required.', 'Export');
            return Promise.resolve(null);
        }
        var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};

        // Phase 1: detect USB (spinner, no percentage yet — quick).
        showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false });
        return apiRequest(API_BASE + '/api/usb/list').then(function (data) {
            var devices = (data && data.devices) ? data.devices : [];
            if (!devices.length) {
                hideLoadingOverlay();
                showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                return null;
            }
            var pickPromise;
            if (devices.length === 1) {
                pickPromise = Promise.resolve(devices[0].path);
            } else {
                hideLoadingOverlay();
                pickPromise = pickPendrive(devices);
            }
            return pickPromise.then(function (devicePath) {
                if (!devicePath) return null;
                // Phase 2: build preview HTML for each report (frontend-only step).
                showLoadingOverlay(titleText, 'Preparing report PDFs...', { cancellable: false, progress: true });
                setLoadingProgress(0, 'Preparing report PDFs...', 'Step 1 of 2: rendering previews');
                return _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText).then(function (pdfHtmlByIdNeeded) {
                    // Phase 3: stream the export (real percentage per report).
                    setLoadingProgress(0, 'Starting export...', 'Step 2 of 2: mounting + uploading');
                var payload = { report_ids: ids, device_path: devicePath };
                    if (pdfHtmlByIdNeeded && Object.keys(pdfHtmlByIdNeeded).length) {
                        payload.pdf_html_by_id = pdfHtmlByIdNeeded;
                    }
                return _streamExportReports(payload, titleText, exportHeaders);
                });
            });
        });
}).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _streamExportReports(payload, titleText, exportHeaders) {
    var hdrs = { 'Content-Type': 'application/json' };
    if (exportHeaders && exportHeaders['X-Approval-Verify-Token']) {
        hdrs['X-Approval-Verify-Token'] = exportHeaders['X-Approval-Verify-Token'];
    }
    return fetch(API_BASE + '/api/reports/export/stream', {
        method: 'POST',
        headers: hdrs,
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    }).then(function (resp) {
        if (!resp.ok && resp.status !== 200) {
            return resp.json().catch(function () { return {}; }).then(function (j) {
                throw new Error((j && j.error) || ('HTTP ' + resp.status));
            });
        }
        if (!resp.body || !resp.body.getReader) {
            // Streams unsupported (very old browsers) -> fall back to buffered read.
            return resp.text().then(function (txt) {
                return _consumeNdjsonText(txt, titleText);
            });
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var lastEvent = null;
        function pump() {
            return reader.read().then(function (r) {
                if (r.done) {
                    if (buffer.trim()) {
                        try { lastEvent = JSON.parse(buffer); _handleExportEvent(lastEvent, titleText); }
                        catch (e) { /* trailing partial */ }
                    }
                    return lastEvent;
                }
                buffer += decoder.decode(r.value, { stream: true });
                var idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    var line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        var evt = JSON.parse(line);
                        lastEvent = evt;
                        _handleExportEvent(evt, titleText);
                    } catch (e) { /* skip malformed line */ }
                }
                return pump();
            });
        }
        return pump();
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _consumeNdjsonText(text, titleText) {
    var lines = String(text || '').split('\n');
    var last = null;
    for (var i = 0; i < lines.length; i++) {
        var s = lines[i].trim();
        if (!s) continue;
        try { var evt = JSON.parse(s); last = evt; _handleExportEvent(evt, titleText); } catch (e) {}
    }
    return last;
}

function _handleExportEvent(evt, titleText) {
    if (!evt || typeof evt !== 'object') return;
    var ev = evt.event;
    if (ev === 'start') {
        setLoadingProgress(0, 'Starting export of ' + (evt.total || '?') + ' report(s)...', '');
        return;
    }
    if (ev === 'stage') {
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
                           evt.message || ('Stage: ' + evt.stage),
                           '');
        return;
    }
    if (ev === 'report') {
        var detail = 'Report ' + evt.current + ' of ' + evt.total + ' \u2014 ' + (evt.status || '');
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
                           evt.message || ('Exporting report ' + evt.current + ' of ' + evt.total + '...'),
                           detail);
        return;
    }
    if (ev === 'done') {
        setLoadingProgress(100, 'Export complete', '');
        // Brief flash at 100% so the user sees completion, then hide.
        setTimeout(function () {
            hideLoadingOverlay();
            if (evt.ok) {
                showAppModal(_summariseExportResult(evt), titleText);
            } else {
                showAppModal(
                    (evt.failed && evt.failed.length)
                        ? 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.'
                        : 'Export finished but no files were written.',
                    titleText);
            }
        }, 350);
        return;
    }
    if (ev === 'error') {
        hideLoadingOverlay();
        if (evt.code === 'MULTIPLE_PENDRIVES' && evt.devices && evt.devices.length) {
            // Race: a 2nd pendrive appeared mid-flow. Re-prompt.
            pickPendrive(evt.devices).then(function (devPath) {
                if (!devPath) return;
                // We don't have payload here; tell user to retry.
                showAppModal('Pendrive choice changed. Please tap Export again.', titleText);
            });
            return;
        }
        showAppModal(_friendlyExportError(evt.message || 'Export failed.'), titleText);
        return;
    }
}

function _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText) {
    var collected = {};
    var i = 0;
    var savedReportId = currentReportId;
    var savedReportData = currentReportData;
    function step() {
        if (i >= ids.length) {
            setLoadingProgress(100, 'Previews rendered. Connecting to pendrive...', '');
            if (savedReportId != null) {
                return apiRequest(API_BASE + '/api/reports/' + savedReportId + '/preview').then(function (data) {
                    if (data && data.preview) { try { populateReportPreview(data.preview); } catch (e) {} }
                    currentReportId = savedReportId;
                    currentReportData = savedReportData;
                    return collected;
                }).catch(function () { return collected; });
            }
            return collected;
        }
        var id = ids[i];
        var pct = (i / ids.length) * 100;
        setLoadingProgress(pct, 'Rendering preview ' + (i + 1) + ' of ' + ids.length + '...', 'Report id ' + id);
        return buildReportPreviewHtmlById(id).then(function (html) {
            if (html) collected[String(id)] = html;
        }).catch(function () { /* skip */ }).then(function () {
            i++;
            return step();
        });
    }
    return Promise.resolve().then(step);
}

/** Generate/overwrite report PDF from on-screen preview (approved or aborted reports only). */
function _saveReportPdfSilent(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.resolve(false);
    return apiRequest(API_BASE + '/api/reports/' + id + '/preview').then(function (data) {
        var st = String((data && data.preview && data.preview.reportApprovalStatus) || '').trim().toLowerCase();
        if (st !== 'approved' && st !== 'aborted') return false;
        return buildReportPreviewHtmlById(id);
    }).then(function (html) {
        if (!html) return false;
        return apiRequest(API_BASE + '/api/reports/' + id + '/pdf', {
            method: 'POST',
            body: { html: html }
    }).then(function () { return true; }).catch(function () { return false; });
    }).catch(function () { return false; });
}

function startQuickTest() {
    logAuditEvent('Opened Quick Test', 'Quick Test screen opened', { eventType: 'navigation' });
    goToPage('quick-test');
}

function _refreshQuickStepSummary() {
    var summaryEl = document.getElementById('quick-step-count-summary');
    var subEl = document.getElementById('quick-step-count-summary-sub');
    var n = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : 10;
    if (summaryEl) summaryEl.textContent = String(n);
    if (subEl) {
        if (isUspStandardProcedureMode(getQuickUspMode())) {
            window._quickStepTaps = computeStandardUspTaps(n);
            var totalU = 0;
            for (var u = 0; u < window._quickStepTaps.length; u++) {
                totalU += parseInt(window._quickStepTaps[u], 10) || 0;
            }
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', USP taps (' + totalU + ' total)';
        } else if (window._quickStepTaps && window._quickStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._quickStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps and taps';
        }
    }
}

function goToQuickTestStepsPage() {
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        return;
    }
    var current = (typeof window._quickStepCount === 'number' && window._quickStepCount > 0)
        ? window._quickStepCount
        : USP_DEFAULT_STEP_COUNT;
    goToPage('quick-test-steps');
    setTimeout(function () {
        var radio = document.querySelector('input[name="quick-step-card"][value="' + current + '"]');
        if (radio) radio.checked = true;
        if (isUspStandardProcedureMode(getQuickUspMode())) {
            window._quickStepTaps = computeStandardUspTaps(current);
            _updateQuickStepsPageUspUi();
        } else {
            _renderQuickStepTapInputs(current);
        }
        var cards = document.querySelectorAll('#quick-step-cards-grid label.create-recipe-card');
        cards.forEach(function (label) {
            label.removeEventListener('click', _onQuickStepCardClick);
            label.addEventListener('click', _onQuickStepCardClick);
        });
    }, 60);
}

function _onQuickStepCardClick(ev) {
    var label = ev && ev.currentTarget ? ev.currentTarget : null;
    if (!label) return;
    var input = label.querySelector('input[name="quick-step-card"]');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) return;
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        window._quickStepCount = n;
        window._quickStepTaps = computeStandardUspTaps(n);
        _updateQuickStepsPageUspUi();
        _refreshQuickStepSummary();
        return;
    }
    setTimeout(function () { _renderQuickStepTapInputs(n); }, 0);
}

function _renderQuickStepTapInputs(stepCount) {
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
        window._quickStepTaps = computeStandardUspTaps(n);
        _updateQuickStepsPageUspUi();
        return;
    }
    var container = document.getElementById('quick-step-tap-inputs');
    if (!container) return;
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    var prev = (window._quickStepTaps && window._quickStepTaps.length === n)
        ? window._quickStepTaps.slice()
        : computeStandardUspTaps(n);
    container.innerHTML = '';
    for (var i = 0; i < n; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="quick-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="quick-step-tap-' + stepNum + '" ' +
                'class="input-field quick-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (prev[i] != null ? prev[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">';
        container.appendChild(group);
    }
}

function confirmQuickTestStepSetup() {
    var radio = document.querySelector('input[name="quick-step-card"]:checked');
    if (!radio) {
        showAppModal('Please choose a step count (1\u201310) before continuing.', 'Quick Test');
        return;
    }
    var stepCount = parseInt(radio.value, 10);
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 10) {
        showAppModal('Please choose a valid step count (1\u201310).', 'Quick Test');
        return;
    }
    var taps;
    if (isUspStandardProcedureMode(getQuickUspMode())) {
        taps = computeStandardUspTaps(stepCount);
    } else {
        var inputs = document.querySelectorAll('#quick-step-tap-inputs input.quick-step-tap');
        taps = [];
        for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
            var v = parseInt(inputs[i].value, 10);
            if (isNaN(v) || v < 1) {
                showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Quick Test');
                inputs[i].focus();
                return;
            }
            taps.push(v);
        }
        if (taps.length !== stepCount) {
            showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Quick Test');
            return;
        }
    }
    window._quickStepCount = stepCount;
    window._quickStepTaps = taps;
    _refreshQuickStepSummary();
    goToPage('quick-test');
}


function _refreshCreateStepSummary() {
    var summaryEl = document.getElementById('create-step-count-summary');
    var subEl = document.getElementById('create-step-count-summary-sub');
    var n = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : 10;
    if (summaryEl) summaryEl.textContent = String(n);
    if (subEl) {
        if (isUspStandardProcedureMode(getCreateUspMode())) {
            window._createRecipeStepTaps = computeStandardUspTaps(n);
            var totalU = 0;
            for (var u = 0; u < window._createRecipeStepTaps.length; u++) {
                totalU += parseInt(window._createRecipeStepTaps[u], 10) || 0;
            }
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', USP taps (' + totalU + ' total)';
        } else if (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n) {
            var total = 0;
            for (var i = 0; i < n; i++) total += parseInt(window._createRecipeStepTaps[i], 10) || 0;
            subEl.textContent = n + ' step' + (n === 1 ? '' : 's') + ', total ' + total + ' taps';
        } else {
            subEl.textContent = 'Tap to select steps and taps';
        }
    }
}

function openCreateRecipeStepsPage() {
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        return;
    }
    var current = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : USP_DEFAULT_STEP_COUNT;
    goToPage('create-recipe-step2');
    setTimeout(function () {
        initCreateRecipeStepsPage();
    }, 60);
}

function initCreateRecipeStepsPage() {
    var current = (typeof window._createRecipeStepCount === 'number' && window._createRecipeStepCount > 0)
        ? window._createRecipeStepCount
        : 10;
    var radio = document.querySelector('input[name="create-step-card"][value="' + current + '"]');
    if (radio) radio.checked = true;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        window._createRecipeStepTaps = computeStandardUspTaps(current);
        _updateCreateStepsPageUspUi();
    } else {
        _renderCreateStepTapInputs(current);
    }
    var cards = document.querySelectorAll('#create-step-cards-grid label.create-recipe-card');
    cards.forEach(function (label) {
        label.removeEventListener('click', _onCreateStepCardClick);
        label.addEventListener('click', _onCreateStepCardClick);
    });
}

function _onCreateStepCardClick(ev) {
    var label = ev && ev.currentTarget ? ev.currentTarget : null;
    if (!label) return;
    var input = label.querySelector('input[name="create-step-card"]');
    if (!input) return;
    var n = parseInt(input.value, 10);
    if (isNaN(n) || n < 1) return;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        window._createRecipeStepCount = n;
        window._createRecipeStepTaps = computeStandardUspTaps(n);
        _updateCreateStepsPageUspUi();
        _refreshCreateStepSummary();
        return;
    }
    setTimeout(function () { _renderCreateStepTapInputs(n); }, 0);
}

function _renderCreateStepTapInputs(stepCount) {
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
        window._createRecipeStepTaps = computeStandardUspTaps(n);
        _updateCreateStepsPageUspUi();
        return;
    }
    var container = document.getElementById('create-step-tap-inputs');
    if (!container) return;
    var n = Math.max(1, Math.min(10, parseInt(stepCount, 10) || 10));
    var prev = (window._createRecipeStepTaps && window._createRecipeStepTaps.length === n)
        ? window._createRecipeStepTaps.slice()
        : computeStandardUspTaps(n);
    container.innerHTML = '';
    for (var i = 0; i < n; i++) {
        var stepNum = i + 1;
        var group = document.createElement('div');
        group.className = 'form-group';
        group.innerHTML =
            '<label for="create-step-tap-' + stepNum + '">Step ' + stepNum + ' \u2014 Taps</label>' +
            '<input type="number" id="create-step-tap-' + stepNum + '" ' +
                'class="input-field create-step-tap" ' +
                'min="1" step="1" ' +
                'data-step-index="' + i + '" ' +
                'value="' + (prev[i] != null ? prev[i] : 0) + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">';
        container.appendChild(group);
    }
}

function confirmCreateRecipeStepSetup() {
    var radio = document.querySelector('input[name="create-step-card"]:checked');
    if (!radio) {
        showAppModal('Please choose a step count (1\u201310) before continuing.', 'Create Recipe');
        return;
    }
    var stepCount = parseInt(radio.value, 10);
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 10) {
        showAppModal('Please choose a valid step count (1\u201310).', 'Create Recipe');
        return;
    }
    var taps;
    if (isUspStandardProcedureMode(getCreateUspMode())) {
        taps = computeStandardUspTaps(stepCount);
    } else {
        var inputs = document.querySelectorAll('#create-step-tap-inputs input.create-step-tap');
        taps = [];
        for (var i = 0; i < inputs.length && taps.length < stepCount; i++) {
            var v = parseInt(inputs[i].value, 10);
            if (isNaN(v) || v < 1) {
                showAppModal('Step ' + (i + 1) + ' must have at least 1 tap.', 'Create Recipe');
                inputs[i].focus();
                return;
            }
            taps.push(v);
        }
        if (taps.length !== stepCount) {
            showAppModal('Please configure taps for all ' + stepCount + ' steps before continuing.', 'Create Recipe');
            return;
        }
    }
    window._createRecipeStepCount = stepCount;
    window._createRecipeStepTaps = taps;
    window._createRecipePreserveStep1 = true;
    _refreshCreateStepSummary();
    updateCreateRecipeContinueButton();
    goToPage('create-recipe-step1');
}

function onCreateRecipeContinueClick() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) {
        showAppModal('Enter recipe name, vacuum (mmHg) and time (mm:ss) before saving.', 'Create Recipe');
        return;
    }
    completeRecipeFromStep2();
}

function startRecipeTest() {
    recipeListMode = 'load';
    logAuditEvent('Opened Load Recipe', 'Load Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function manageRecipes() {
    var u = window.currentUser;
    if (u && typeof canAccess === 'function' && !canAccess(u, 'recipe-manage')) {
        if (typeof denyPermission === 'function') denyPermission('manage recipes');
        return;
    }
    recipeListMode = 'manage';
    logAuditEvent('Opened Manage Recipe', 'Manage Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function getSelectedRecipeProductTypeChoice() {
    var typeEl = document.querySelector('input[name="recipe-product-type"]:checked');
    return typeEl ? String(typeEl.value || '').trim() : '';
}

function getResolvedRecipeProductType() {
    var choice = getSelectedRecipeProductTypeChoice();
    if (choice !== 'Other') return choice;
    var otherEl = document.getElementById('recipe-product-type-other');
    return otherEl && otherEl.value ? String(otherEl.value).trim() : '';
}

function onRecipeProductTypeChange() {
    var choice = getSelectedRecipeProductTypeChoice();
    var group = document.getElementById('recipe-product-type-other-group');
    var otherEl = document.getElementById('recipe-product-type-other');
    var showOther = choice === 'Other';
    if (group) group.style.display = showOther ? '' : 'none';
    if (!showOther && otherEl) otherEl.value = '';
    if (showOther && otherEl) {
        setTimeout(function () {
            try { otherEl.focus(); } catch (e) { /* ignore */ }
        }, 40);
    }
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function resetCreateRecipeStep1Form() {
    var nameEl = document.getElementById('recipe-product-name');
    if (nameEl) nameEl.value = '';
    var batchSizeEl = document.getElementById('recipe-batch-size');
    if (batchSizeEl) batchSizeEl.value = '';
    var typeRadios = document.querySelectorAll('input[name="recipe-product-type"]');
    typeRadios.forEach(function (el, idx) {
        el.checked = idx === 0;
    });
    var otherEl = document.getElementById('recipe-product-type-other');
    if (otherEl) otherEl.value = '';
    var otherGroup = document.getElementById('recipe-product-type-other-group');
    if (otherGroup) otherGroup.style.display = 'none';
    var vacEl = document.getElementById('recipe-vacuum-mmhg');
    if (vacEl) vacEl.value = '';
    var timeEl = document.getElementById('recipe-duration');
    if (timeEl) timeEl.value = '';
    var errEl = document.getElementById('create-recipe-input-error');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    if (typeof syncCreateRecipeConsolePresets === 'function') syncCreateRecipeConsolePresets();
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function startRecipeCreation() {
    window.currentEditingRecipeId = null;
    window._createRecipePreserveStep1 = false;
    goToPage('create-recipe-step1');
    setTimeout(resetCreateRecipeStep1Form, 0);
}

function selectOperation(type) {
    if (type === 'validate') {
        if (!userCanRunValidation()) {
            denyPermission('run validation');
            return;
        }
        validationCompletion = { distance: false, load: false };
        validationSessionResults = { distance: null, load: null };
        lastValidationType = 'distance';
        goToPage('vd-validation-input');
    } else if (type === 'calibrate') {
        if (typeof canAccess === 'function' && window.currentUser && !canAccess(window.currentUser, 'calibration-menu')) {
            showAppModal('You do not have permission to run calibration.', 'Permission');
            return;
        }
        goToPage('vacuum-calibration');
    }
}

function startValidationFromType() {
    if (!userCanRunValidation()) {
        denyPermission('run validation');
        return;
    }
    lastValidationType = 'distance';
    goToPage('vd-validation-input');
}

function startUspValidation(type) {
    if (!userCanRunValidation()) {
        denyPermission('run validation');
        return;
    }
    var t = String(type || '').toLowerCase();
    lastValidationType = t === 'usp2' ? 'load' : 'distance';
    goToPage('validation-run');
}

function goBackFromValidationRun() {
    if (isValidationOperationActive()) {
        return abortValidationRun().then(function (result) {
            if (result && (result.openedPreview || result.cancelled || result.inFlight)) return;
            _suppressValidationNavGuardOnce = true;
            goToPage('vd-validation-input');
        });
    }
    _suppressValidationNavGuardOnce = true;
    goToPage('vd-validation-input');
}

/** Stop validation hardware/timer and reset UI (returns a promise). */
function abortValidationRun() {
    if (!isValidationOperationActive()) {
        return Promise.resolve();
    }
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    var btn = document.getElementById('btn-validation-start-abort');
    if (btn) btn.disabled = true;
    validationRunBackendPending = true;
    return stopValidationOnBackend().catch(function () {}).finally(function () {
        validationRunState = 'idle';
        validationRunBackendPending = false;
        _closeValidationRunHardwareEs();
        updateValidationRunTimerUi(VALIDATION_RUN_DURATION_SEC);
        setValRunEl('val-run-status', 'Aborted');
        setValRunEl('val-run-status-sub', 'Tap count: ' + validationRunCurrentCount);
        _setValRunStatusStyle('ready');
        _setValResultVisible(false);
        _resetValidationRunActionButtonToStart();
        logAuditEvent('Validation aborted', validationAdapterLabel() + ' validation aborted by user', {
            eventType: 'lifecycle',
            entityType: 'validation',
            extra: {
                validationType: lastValidationType,
                actualTapCount: validationRunCurrentCount
            }
        });
        if (btn) btn.disabled = false;
        applyValidationRunLockUi(false);
    });
}

function setValRunEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function _setValResultVisible(visible) {
    var el = document.getElementById('val-result-card');
    if (!el) return;
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
}

function _setValRunStatusStyle(kind) {
    var el = document.getElementById('val-run-status');
    if (!el) return;
    el.classList.remove('is-ready', 'is-running');
    if (kind === 'ready') el.classList.add('is-ready');
    else if (kind === 'running') el.classList.add('is-running');
}

function _setValRunResultBadge(isPass) {
    var resultEl = document.getElementById('val-run-result');
    if (!resultEl) return;
    resultEl.textContent = isPass ? 'Pass' : 'Fail';
    resultEl.className = 'val-run-result-badge ' + (isPass ? 'is-pass' : 'is-fail');
}

var VALIDATION_SCROLL_SURFACE = {
    'validate-type-select': '.validation-type-page',
    'usp1-detail': '.validation-type-page',
    'usp2-detail': '.validation-type-page'
};

function getValidationScrollSurface(pageName) {
    var page = document.getElementById('page-' + pageName);
    if (!page) return null;
    var sel = VALIDATION_SCROLL_SURFACE[pageName];
    if (!sel) return page;
    return page.querySelector(sel) || page;
}

function bindTouchPanScroll(el) {
    if (!el || el._touchPanScrollBound) return;
    el._touchPanScrollBound = true;
    var startY = 0;
    var startScroll = 0;
    var tracking = false;
    el.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        tracking = true;
        startY = e.touches[0].clientY;
        startScroll = el.scrollTop;
    }, { passive: true });
    el.addEventListener('touchmove', function (e) {
        if (!tracking || e.touches.length !== 1) return;
        var dy = startY - e.touches[0].clientY;
        var next = startScroll + dy;
        var max = Math.max(0, el.scrollHeight - el.clientHeight);
        if (next < 0) next = 0;
        if (next > max) next = max;
        el.scrollTop = next;
    }, { passive: true });
    el.addEventListener('touchend', function () { tracking = false; }, { passive: true });
    el.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });
}

function ensureValidationPageScroll(pageName) {
    var surface = getValidationScrollSurface(pageName);
    if (!surface) return;
    bindTouchPanScroll(surface);
    surface.scrollTop = 0;
}

function ensureAddMemberPageScroll() {
    var page = document.getElementById('page-add-member');
    if (!page) return;
    bindTouchPanScroll(page);
    page.scrollTop = 0;
}

function initValidationRunPage() {
    var type = lastValidationType || 'distance';
    var usp = type === 'load' ? 'Pressure Decay' : 'Vacuum Decay';
    var tapsMin = type === 'load' ? 250 : 300;
    var dropHeight = type === 'load' ? 3 : 14;
    validationRunTarget = type === 'load' ? 250 : 300;
    validationRunTolerance = 15;
    validationRunMin = validationRunTarget - validationRunTolerance;
    validationRunMax = validationRunTarget + validationRunTolerance;

    setValRunEl('val-run-usp', usp);
    setValRunEl('val-run-taps-min', String(tapsMin));
    setValRunEl('val-run-height', String(dropHeight));
    setValRunEl('val-run-expected', String(validationRunTarget) + ' (+/- ' + String(validationRunTolerance) + ')');
    setValRunEl('val-run-tap-count', '0');
    setValRunEl('val-run-status', 'Ready');
    setValRunEl('val-run-status-sub', 'Press Start to begin');
    _setValRunStatusStyle('ready');
    _setValResultVisible(false);

    validationRunCurrentCount = 0;
    validationRunState = 'idle';
    validationRunBackendPending = false;
    validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC;
    updateValidationRunTimerUi(validationRunSecondsRemaining);
    applyValidationRunLockUi(false);
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }

    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
    }
    if (label) label.textContent = 'Start Validation';
}

function startCalibrationFromType() {
    var radio = document.querySelector('input[name="cal-type"]:checked');
    if (radio && radio.value === 'vacuum') goToPage('vacuum-calibration');
    else goToPage('vacuum-calibration');
}

function viewRecipe() {
    goToPage('view-recipes');
}

// ----- Members: manage, locked, disabled -----
function loadMembersAndRender() {
    apiRequest(API_BASE + '/api/data/members', {
        method: 'GET'
    }).then(function (data) {
        var members = (data && data.members && Array.isArray(data.members)) ? data.members : [];
        membersCache = members;
        renderMembersView();
    }).catch(function (err) {
        console.error('Failed to load members', err);
        renderMembersView(); // still clear tables / empty state
    });
}

function renderMembersView() {
    var members = Array.isArray(membersCache) ? membersCache : [];
    var active = [];
    var locked = [];
    var disabled = [];
    members.forEach(function (m) {
        var status = (m && m.status ? String(m.status) : 'active').toLowerCase();
        if (status === 'locked') locked.push(m);
        else if (status === 'disabled') disabled.push(m);
        else active.push(m);
    });

    function renderTable(bodyId, emptyId, rows, options) {
        options = options || {};
        var tbody = document.getElementById(bodyId);
        var emptyEl = document.getElementById(emptyId);
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!rows || rows.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        var currentRole = (typeof getCurrentRole === 'function') ? getCurrentRole() : ((window.currentUser && window.currentUser.role) ? String(window.currentUser.role).toLowerCase() : null);
        var canUnlock = !(typeof canPerformAction === 'function') || canPerformAction(currentRole, 'user-unlock', 'change');
        var canEnable = !(typeof canPerformAction === 'function') || canPerformAction(currentRole, 'user-enable', 'change');
        var canEdit = typeof canEditMembers === 'function' && canEditMembers();
        // Sort by name for a consistent list
        rows.slice().sort(function (a, b) {
            var an = (a && a.name ? String(a.name) : '').toLowerCase();
            var bn = (b && b.name ? String(b.name) : '').toLowerCase();
            if (an < bn) return -1;
            if (an > bn) return 1;
            return 0;
        }).forEach(function (m) {
            var tr = document.createElement('tr');
            var name = m.name || '';
            var username = m.username || '';
            var role = m.role || '';
            if (options.style === 'active') {
                var roleKey = String(role || '').toLowerCase();
                var roleClass = 'member-role-badge ';
                if (roleKey === 'admin') roleClass += 'member-role-admin';
                else if (roleKey === 'supervisor') roleClass += 'member-role-supervisor';
                else if (roleKey === 'qa') roleClass += 'member-role-qa';
                else roleClass += 'member-role-user';
                var editBtn = canEdit
                    ? '<button class="btn-member-action btn-edit" onclick="openEditMember(' + (m.id || 0) + ')">Edit Profile</button>'
                    : '';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td><span class="' + roleClass + '">' + displayRoleLabel(role) + '</span></td>' +
                    '<td class="member-actions-cell">' +
                    editBtn +
                    '<button class="btn-member-action btn-role" onclick="openRoleModal(' + (m.id || 0) + ')">Change Role</button>' +
                    '<button class="btn-member-action btn-disable" onclick="disableMember(' + (m.id || 0) + ')">Disable</button>' +
                    '</td>';
            } else {
                var actionBtn = '';
                if (options.style === 'locked') {
                    actionBtn = '<button class="btn-member-action btn-unlock" ' + (canUnlock ? '' : 'disabled') + ' onclick="unlockMember(' + (m.id || 0) + ')">Unlock</button>';
                } else if (options.style === 'disabled') {
                    actionBtn = '<button class="btn-member-action btn-enable" ' + (canEnable ? '' : 'disabled') + ' onclick="enableMember(' + (m.id || 0) + ')">Enable</button>';
                }
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td>' + displayRoleLabel(role) + '</td>' +
                    '<td class="member-actions-cell member-actions-cell-single">' + actionBtn + '</td>';
            }
            tbody.appendChild(tr);
        });
    }

    renderTable('members-list-body', 'members-empty-state', active, { style: 'active' });
    renderTable('locked-members-table-body', 'locked-members-empty-state', locked, { style: 'locked' });
    renderTable('disabled-members-table-body', 'disabled-members-empty-state', disabled, { style: 'disabled' });
}

function unlockMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-unlock', 'change')) {
            showAppModal('You do not have permission to unlock accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Unlock this account?', 'Unlock Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/unlock', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account unlocked.', 'Unlock');
            })
            .catch(function (err) {
                showAppModal('Failed to unlock: ' + (err && err.message ? err.message : 'Unknown error'), 'Unlock');
            });
    });
}

function enableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-enable', 'change')) {
            showAppModal('You do not have permission to enable accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Enable this account?', 'Enable Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/enable', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                var member = (res.body && res.body.member) ? res.body.member : null;
                var username = member
                    ? String(member.username || member.name || '').trim()
                    : '';
                showAppModal('Account enabled.', 'Enable');
                if (biometricEnabledSetting && member && typeof canEditMembers === 'function' && canEditMembers()) {
                    _addMemberLastSavedId = id;
                    window._biometricEnrollReturnPage = 'manage-members';
                    _populateMemberBiometricSummary({
                        id: id,
                        username: username,
                        name: member.name || username,
                        role: member.role
                    });
                    goToPage('member-biometric');
                }
            })
            .catch(function (err) {
                showAppModal('Failed to enable: ' + (err && err.message ? err.message : 'Unknown error'), 'Enable');
            });
    });
}

// ----- Reports and audit from API -----
function loadReports(filterType) {
    var canReports = typeof userCanViewReports === 'function' && userCanViewReports();
    var canAudit = typeof canViewAuditLog === 'function' && canViewAuditLog();
    // Audit-only users: always land on Audit Trails (ignore stale filter from prior login).
    if (!canReports && canAudit && filterType !== 'audit') {
        filterType = 'audit';
    }
    currentReportFilter = filterType || null;
    var tbody = document.getElementById('reports-table-body');
    var theadRow = document.getElementById('reports-thead-row');
    var bar = document.getElementById('audit-filters-bar');
    if (!tbody) return;
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
    else if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    tbody.innerHTML = '';

    if (filterType === 'audit') {
        if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
            denyPermission('view audit trails');
            return;
        }
        if (bar) bar.style.display = '';
        if (theadRow) theadRow.innerHTML = '<th>Date & Time</th><th>User</th><th>Role</th><th>Action</th><th>Details</th>';
        var userEl = document.getElementById('audit-filter-user');
        var roleEl = document.getElementById('audit-filter-role');
        var actionEl = document.getElementById('audit-filter-action');
        var fromDate = document.getElementById('audit-filter-from-date');
        var fromTime = document.getElementById('audit-filter-from-time');
        var toDate = document.getElementById('audit-filter-to-date');
        var toTime = document.getElementById('audit-filter-to-time');
        var fromTs = '';
        var toTs = '';
        if (fromDate && fromDate.value) {
            var parts = fromDate.value.split('-');
            var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
            var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
            fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
        }
        if (toDate && toDate.value) {
            var parts2 = toDate.value.split('-');
            var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
            var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
            toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
        }
        var q = [];
        if (userEl && userEl.value) q.push('user=' + encodeURIComponent(userEl.value));
        if (roleEl && roleEl.value) q.push('role=' + encodeURIComponent(roleEl.value));
        if (actionEl && actionEl.value) q.push('action=' + encodeURIComponent(actionEl.value));
        if (fromTs) q.push('from=' + fromTs);
        if (toTs) q.push('to=' + toTs);
        var auditUrl = API_BASE + '/api/data/audit-log' + (q.length ? '?' + q.join('&') : '');
        showAuditTrailsLoadingOverlay();
        apiRequest(auditUrl).then(function (data) {
            var list = (data && data.entries) ? data.entries : [];
            var filterTask = Promise.resolve();
            if (userEl && userEl.options.length <= 1) {
                filterTask = apiRequest(API_BASE + '/api/data/audit-log').then(function (full) {
                    var fullList = (full && full.entries) ? full.entries : [];
                    _populateAuditFilterDropdowns(userEl, actionEl, fullList);
                }).catch(function () {});
            }
            return filterTask.then(function () {
                _renderAuditLogRows(tbody, list);
            });
        }).catch(function () {
            tbody.innerHTML = '';
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="5">Unable to load audit log.</td>';
            tbody.appendChild(emptyRow);
        }).finally(function () {
            hideAuditTrailsLoadingOverlay();
        });
        return;
    }

    if (!userCanViewReports()) {
        denyPermission('view reports');
        return;
    }

    if (bar) bar.style.display = 'none';
    if (theadRow) theadRow.innerHTML = '<th>SL No</th><th>Report Name</th><th>Creation Time</th><th>Action</th>';
    var filter = (filterType === 'test' || filterType === 'validation' || filterType === 'calibration') ? filterType : 'all';
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        if (!list.length) {
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="4">No reports.</td>';
            tbody.appendChild(emptyRow);
        } else {
            list.forEach(function (r, i) {
                var row = document.createElement('tr');
                var name = r.name;
                // Legacy bug: completion saved name as "... Pending Approval"; never show that for approved reports.
                if (r.type === 'validation' && name && /pending\s*approval/i.test(String(name))) {
                    var appr = String(r.reportApprovalStatus || '').trim().toLowerCase();
                    var pf = String(r.approvalPassFail || '').trim().toUpperCase();
                    if (appr === 'approved' && (pf === 'PASS' || pf === 'FAIL')) {
                        name = 'Validation - Vacuum - ' + (pf === 'PASS' ? 'Pass' : 'Fail');
                    } else if (appr === 'aborted') {
                        name = 'Validation - Vacuum - Aborted';
                    } else {
                        name = 'Validation - Vacuum';
                    }
                }
                if (!name && r.type === 'validation') {
                    if (!name) name = 'Validation - ' + (r.validationSubtype === 'load' ? 'Pressure Decay' : 'Vacuum Decay');
                }
                if (!name && r.type === 'calibration') {
                    name = 'Calibration - ' + (r.calibrationSubtype === 'vacuum' ? 'Vacuum' : (r.calibrationSubtype || 'Vacuum'));
                    if (r.setVacuumMmHg != null) name += ' - ' + r.setVacuumMmHg + ' mmHg';
                }
                if (!name) name = (r.recipe && r.recipe.productName) || 'Report ' + (r.id || (i + 1));
                var created = r.createdAt || r.created || '';
                if (created && typeof formatReportDate === 'function') {
                    created = formatReportDate(created);
                } else if (created && created.length > 10) {
                    created = created.slice(0, 10) + ' ' + created.slice(11, 19);
                }
                row.innerHTML = '<td>' + (i + 1) + '</td><td>' + name + '</td><td>' + created + '</td><td><button class="reports-open-btn" onclick="openReportPreview(' + (r.id || 0) + ')">Open</button></td>';
                tbody.appendChild(row);
            });
        }
    }).catch(function () {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="4">Unable to load reports.</td>';
        tbody.appendChild(emptyRow);
    });
}

function isFactorySessionUser(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    var role = (u.role != null ? String(u.role) : '').toLowerCase();
    if (typeof isFactoryLikeRole === 'function') return isFactoryLikeRole(role, u);
    return role === 'factory';
}

function userCanViewReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'reports-view');
}

function userCanRunValidation(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'validation-test');
}

function denyPermission(actionLabel) {
    showAppModal(
        'You do not have permission to ' + (actionLabel || 'perform this action') + '.',
        'Permission'
    );
}

function userCanPrintReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return userCanViewReports(u);
}

function userCanExportToUsb(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    if (typeof userHasInternalKey === 'function' && userHasInternalKey(u, 'export-usb')) return true;
    return false;
}

function refreshReportsActionButtons() {
    var u = window.currentUser;
    var canReports = typeof userCanViewReports === 'function' && userCanViewReports(u);
    var canAudit = typeof canViewAuditLog === 'function' && canViewAuditLog();
    var canRecipes = !!(u && typeof canAccess === 'function' && (
        canAccess(u, 'recipe-list') || canAccess(u, 'recipe-manage') || canAccess(u, 'recipe-test')
    ));
    var expBtn = document.querySelector('.reports-filter-export');
    if (expBtn) {
        expBtn.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
    var audEx = document.querySelector('.audit-filter-export');
    if (audEx) {
        audEx.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) && canAudit ? '' : 'none';
    }
    var testBtn = document.querySelector('.reports-filter-test');
    var valBtn = document.querySelector('.reports-filter-validation');
    var calBtn = document.querySelector('.reports-filter-calibration');
    if (testBtn) testBtn.style.display = canReports ? '' : 'none';
    if (valBtn) valBtn.style.display = canReports ? '' : 'none';
    if (calBtn) calBtn.style.display = canReports ? '' : 'none';
    var recipeBtn = document.querySelector('.reports-filter-recipes');
    if (recipeBtn) recipeBtn.style.display = canRecipes ? '' : 'none';
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    if (typeof updateReportPreviewPrintExportButtons === 'function') {
        updateReportPreviewPrintExportButtons(window._lastReportPreview || null);
    }
}

function canViewAuditLog() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'audit-view');
    }
    return false;
}

function initAuditReportsVisibility() {
    var auditBtn = document.querySelector('.reports-filter-audit');
    if (!auditBtn) return;
    // Must set both show and hide — one-way hide left the button stuck after login swap.
        auditBtn.style.display = canViewAuditLog() ? '' : 'none';
}

function filterReports(type) {
    if (type === 'audit' && typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    loadReports(type);
}

function applyAuditFiltersAndRefresh() {
    loadReports('audit');
}

function exportAuditTrails() {
    if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    var u = window.currentUser;
    if (!userCanExportToUsb(u)) {
        showAppModal('You do not have permission to export audit trails to USB.', 'Export');
        return;
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';

    var userEl = document.getElementById('audit-filter-user');
    var roleEl = document.getElementById('audit-filter-role');
    var actionEl = document.getElementById('audit-filter-action');
    var fromDate = document.getElementById('audit-filter-from-date');
    var fromTime = document.getElementById('audit-filter-from-time');
    var toDate = document.getElementById('audit-filter-to-date');
    var toTime = document.getElementById('audit-filter-to-time');

    var fromTs = '';
    var toTs = '';

    if (fromDate && fromDate.value) {
        var parts = fromDate.value.split('-');
        var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
        var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
        fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
    }
    if (toDate && toDate.value) {
        var parts2 = toDate.value.split('-');
        var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
        var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
        toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
    }

    var filters = {};
    if (userEl && userEl.value) filters.user = userEl.value;
    if (roleEl && roleEl.value) filters.role = roleEl.value;
    if (actionEl && actionEl.value) filters.action = actionEl.value;
    if (fromTs) filters.from = fromTs;
    if (toTs) filters.to = toTs;

    var titleText = 'Export Audit';
    _ensureExportApprovalToken().then(function (token) {
        if (role !== 'factory' && !token) {
            showAppModal('Export cancelled — approval is required.', titleText);
            return;
        }
        var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};
        showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false, progress: true });
        setLoadingProgress(5, 'Detecting external pendrive...', '');
        apiRequest(API_BASE + '/api/usb/list').then(function (data) {
            var devices = (data && data.devices) ? data.devices : [];
            if (!devices.length) {
                hideLoadingOverlay();
                showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                return;
            }
            var pickPromise;
            if (devices.length === 1) {
                pickPromise = Promise.resolve(devices[0].path);
            } else {
                hideLoadingOverlay();
                pickPromise = pickPendrive(devices);
            }
            pickPromise.then(function (devicePath) {
                if (!devicePath) return;
                showLoadingOverlay(titleText, 'Generating audit-trail PDF...', { cancellable: false, progress: true });
                setLoadingProgress(25, 'Mounting pendrive...', devicePath);
                setTimeout(function () { setLoadingProgress(60, 'Rendering audit-trail PDF...', ''); }, 600);
                apiRequest(API_BASE + '/api/audit/export', {
                    method: 'POST',
                    headers: exportHeaders,
                    body: { filters: filters, device_path: devicePath }
                }).then(function (res) {
                    if (res && res.success) {
                        setLoadingProgress(95, 'Writing to pendrive...', '');
                        setTimeout(function () {
                            setLoadingProgress(100, 'Export complete', '');
                            setTimeout(function () {
                                hideLoadingOverlay();
                                showAppModal('Audit trail export successful.', titleText);
                            }, 350);
                        }, 250);
                    } else {
                        hideLoadingOverlay();
                        showAppModal(_friendlyExportError((res && res.error) || 'audit export failed'), titleText);
                    }
                }).catch(function (err) {
                    hideLoadingOverlay();
                    showAppModal(_friendlyExportError(err), titleText);
                });
            });
        }).catch(function (err) {
            hideLoadingOverlay();
            showAppModal(_friendlyExportError(err), titleText);
        });
    });
}

function exportFilteredReports() {
    if (currentReportFilter === 'audit') {
        exportAuditTrails();
        return;
    }
    var filter = (currentReportFilter === 'test' || currentReportFilter === 'validation' || currentReportFilter === 'calibration') ? currentReportFilter : 'all';
    showLoadingOverlay('Export Reports', 'Loading report list...', { cancellable: false });
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        var ids = list.map(function (r) { return r && r.id ? parseInt(r.id, 10) : null; }).filter(function (x) { return x; });
        hideLoadingOverlay();
        if (!ids.length) {
            showAppModal('No reports match the current filter to export.', 'Export Reports');
            return;
        }
        showConfirmModal(
            'Export ' + ids.length + ' report' + (ids.length === 1 ? '' : 's') +
            ' to USB (filter: ' + filter + ')?',
            'Export Reports'
        ).then(function (ok) {
            if (!ok) return;
            _exportReportsWithFlow(ids, { title: 'Export Reports (' + filter + ')' });
        });
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal('Could not load reports: ' + (err && err.message ? err.message : 'Network error'), 'Export Reports');
    });
}

function buildReportPrintPayload(preview, reportId) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (!td || typeof td !== 'object') td = {};
    var recipe = preview.recipe || td.recipe || {};
    return {
        id: reportId != null ? reportId : preview.id,
        type: preview.type || 'test',
        testData: td,
        recipe: recipe,
        factorySettings: preview.factorySettings || {},
        statistics: preview.statistics || td.statistics || {},
        remarks: preview.remarks != null ? preview.remarks : td.remarks,
        reportApprovalStatus: preview.reportApprovalStatus,
        approvalPassFail: preview.approvalPassFail,
        approvalRemarks: preview.approvalRemarks,
        approvedBy: preview.approvedBy,
        approvedByUsername: preview.approvedByUsername,
        approvedByName: preview.approvedByName,
        approvedAt: preview.approvedAt,
        createdAt: preview.createdAt || td.createdAt,
        completedAt: preview.completedAt || td.completedAt,
        operatorName: preview.operatorName || td.operatorName,
        employeeId: preview.employeeId || td.employeeId,
        validationRuns: preview.validationRuns || td.validationRuns,
        reportDerived: preview.reportDerived || buildTestReportDerived(td, recipe, reportId)
    };
}

function resolveReportDataForPrint(callback) {
    var rid = currentReportId;
    if (!rid) {
        callback(null);
        return;
    }
    var fromPreview = typeof buildReportPrintPayload === 'function'
        ? buildReportPrintPayload(window._lastReportPreview, rid) : null;
    if (fromPreview && fromPreview.testData) {
        currentReportData = fromPreview;
        callback(fromPreview);
        return;
    }
    if (currentReportData && currentReportData.testData) {
        callback(currentReportData);
        return;
    }
    apiRequest(API_BASE + '/api/data/reports/' + rid).then(function (data) {
        var reportData = data.report || data;
        if (reportData) {
            reportData.id = reportData.id != null ? reportData.id : rid;
            currentReportData = reportData;
            callback(reportData);
        } else {
            callback(null);
        }
    }).catch(function () { callback(null); });
}

function _printRequestHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        var hdrRole = window.currentUser.role;
        if (!hdrRole && typeof getCurrentRole === 'function') {
            var gr = getCurrentRole();
            if (gr) hdrRole = gr;
        }
        if (hdrRole) headers['X-User-Role'] = hdrRole;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    return headers;
}

/** Shared print POST: maps 401 → session expired login, 403 → server message. */
function _printFetch(url, body, successMsg, failFallback) {
    return fetch((API_BASE || '') + url, {
        method: 'POST',
        headers: _printRequestHeaders(),
        body: JSON.stringify(body || {})
    }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (result) {
            return { status: r.status, ok: r.ok, result: result || {} };
        });
    }).then(function (pack) {
        var result = pack.result || {};
        if (pack.status === 401) {
            showAppModal('Your session has expired. Please log in again.', 'Print');
            if (typeof showLoginScreen === 'function') showLoginScreen();
            return;
        }
        if (pack.status === 403) {
            showAppModal(result.error || 'You do not have permission to print.', 'Print');
            return;
        }
        if (result.success !== false && !result.error) {
            showAppModal(successMsg, 'Print');
        } else {
            showAppModal(result.error || failFallback, 'Print');
        }
    }).catch(function (e) {
        showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
    });
}

function handlePrintReport() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
        _printFetch('/api/print/a4', { report_data: reportData }, 'Sent to A4 printer.', 'A4 print failed. Check printer connection.');
    });
}

function handlePrintThermal() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
        _printFetch('/api/print/thermal', { report_data: reportData }, 'Sent to thermal printer.', 'Thermal print failed. Check printer connection.');
    });
}

function handleExportReport() {
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before export.', 'Export');
        return;
    }
    if (currentReportId == null) {
        showAppModal('No report selected to export.', 'Export');
        return;
    }
    _exportReportsWithFlow([currentReportId], { title: 'Export Report' });
}

function setRecipePrintEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function populateRecipePrintPreview(recipe, factorySettings) {
    if (!recipe) return;
    currentRecipeForPrint = recipe;
    var fs = factorySettings || recipe.factorySettings || {};
    setRecipePrintEl('recipe-print-company-name', fs.companyName || 'N/A');
    setRecipePrintEl('recipe-print-model-no', fs.modelNo || 'N/A');
    setRecipePrintEl('recipe-print-serial-no', fs.serialNo || 'N/A');
    setRecipePrintEl('recipe-print-location', fs.companyLocation || fs.location || 'N/A');
    setRecipePrintEl('recipe-print-instrument-no', fs.instrumentId || 'N/A');
    setRecipePrintEl('recipe-print-previous-val', fs.lastValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-next-validation', fs.nextValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-product', recipe.productName || recipe.name || '--');
    var usp = recipe.usp || (recipe.steps && recipe.steps.length ? (recipe.steps[0].speed === 250 ? 'Pressure Decay' : 'Vacuum Decay') : '');
    setRecipePrintEl('recipe-print-usp', usp || '--');
    var speed = recipe.speed || (recipe.steps && recipe.steps.length ? recipe.steps[0].speed : null);
    setRecipePrintEl('recipe-print-speed', speed != null ? (speed + ' mbar/s') : '--');
    var tbody = document.getElementById('recipe-print-tolerance-body');
    if (tbody) {
        var stepCount = (recipe.stepCount != null) ? recipe.stepCount : (recipe.steps ? recipe.steps.length : '--');
        tbody.innerHTML =
            '<tr><td>Steps</td><td>' + stepCount + '</td><td></td></tr>';
    }
}

function openRecipePrintPreview(recipeIdOrRecipe) {
    var recipeId = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe.id : recipeIdOrRecipe;
    var recipe = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe : null;
    function openWithRecipe(r, fs) {
        populateRecipePrintPreview(r, fs);
        goToPage('recipe-print-preview');
    }
    if (recipe && recipe.id) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            openWithRecipe(recipe, fs);
        }).catch(function () {
            openWithRecipe(recipe, null);
        });
        return;
    }
    if (!recipeId) return;
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'View Recipe');
            return;
        }
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (fsData) {
            var fs = (fsData && fsData.settings) ? fsData.settings : (fsData || {});
            openWithRecipe(r, fs);
        }).catch(function () {
            openWithRecipe(r, null);
        });
    }).catch(function () {
        showAppModal('Recipe not found.', 'View Recipe');
    });
}

function handlePrintRecipeA4() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintA4();
        }).catch(function () { doPrintA4(); });
    } else {
        doPrintA4();
    }
    function doPrintA4() {
        _printFetch('/api/print/a4', payload, 'Sent to A4 printer.', 'A4 print failed. Check printer connection.');
    }
}

function handlePrintRecipeThermal() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintThermal();
        }).catch(function () { doPrintThermal(); });
    } else {
        doPrintThermal();
    }
    function doPrintThermal() {
        _printFetch('/api/print/thermal', payload, 'Sent to thermal printer.', 'Thermal print failed. Check printer connection.');
    }
}
function scrollReportPreviewActionsIntoView() {
    var bar = document.getElementById('report-preview-actions');
    if (!bar) return;
    bar.classList.remove('report-actions-highlight');
    void bar.offsetWidth;
    bar.classList.add('report-actions-highlight');
    try {
        bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
        bar.scrollIntoView(true);
    }
}

function hideReportPreviewLoadingOverlayAfterRender() {
    requestAnimationFrame(function () {
        requestAnimationFrame(function () {
            hideLoadingOverlay();
        });
    });
}

function openReportPreview(reportId, options) {
    if (!reportId) {
        _postRunSessionHold = false;
        return Promise.resolve();
    }
    if (!userCanViewReports()) {
        _postRunSessionHold = false;
        denyPermission('view reports');
        return Promise.resolve();
    }
    options = options || {};
    showLoadingOverlay('Report Preview', 'Loading report preview...', { cancellable: false });
    return apiRequest(API_BASE + '/api/reports/' + reportId + '/preview').then(function (data) {
        if (data.preview) {
            currentReportId = reportId;
            currentReportData = null;
            populateReportPreview(data.preview);
            setReportApprovalGateFromPreview(data.preview, reportId);
            applyReportPreviewLockUi(data.preview);
            goToPage('report-preview');
            startReportApprovalPollIfLocked();
            markAutoLogoutActivity();
            syncKioskScreenWakeLock();
            setTimeout(function () {
                if (isReportPreviewLockedForCurrentUser(data.preview)) {
                    scrollReportPendingBannerIntoView();
                }
                if (isReportPendingApproval(data.preview)) {
                    scrollReportApprovePanelIntoView();
                }
                if (typeof scrollReportPreviewActionsIntoView === 'function') {
                    scrollReportPreviewActionsIntoView();
                }
            }, 250);
            return data.preview;
        }
        showAppModal('Report preview is not available.', 'Reports');
        return null;
    }).catch(function (err) {
        var detail = (err && err.message) ? String(err.message) : '';
        showAppModal(
            'Could not open report preview. Check your connection and try again from Reports.'
                + (detail ? ('\n\n' + detail) : ''),
            'Reports'
        );
        return null;
    }).finally(function () {
        _postRunSessionHold = false;
        hideReportPreviewLoadingOverlayAfterRender();
    });
}

function setReportEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function formatReportDate(isoStr) {
    if (!isoStr) return '--';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '--';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yy = d.getFullYear();
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return dd + '/' + mm + '/' + yy + ' ' + h + ':' + m + ':' + s;
}

/** Rows in TEST DATA table: only steps that actually ran (not recipe stepCount). */
function getReportStepRowCount(td) {
    if (!td || typeof td !== 'object') return 0;
    var results = td.stepResults || [];
    if (results.length > 0) return results.length;
    var cs = td.completedSteps;
    if (cs != null && cs !== '' && !isNaN(parseInt(cs, 10))) {
        return Math.max(0, parseInt(cs, 10));
    }
    return 0;
}

function formatReportDateAndTimeParts(isoOrDateStr) {
    var full = formatReportDate(isoOrDateStr);
    if (!full || full === '--') return { date: '--', time: '--' };
    var parts = full.split(' ');
    if (parts.length >= 2) {
        return { date: parts[0], time: parts.slice(1).join(' ') };
    }
    return { date: full, time: '--' };
}

/** Format seconds as HH:MM:SS for test report duration. */
function formatDurationSeconds(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return '--';
    var total = Math.floor(Number(sec));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function testDurationSecondsFromData(td, preview) {
    if (!td || typeof td !== 'object') return null;
    if (td.durationSeconds != null && !isNaN(td.durationSeconds) && td.durationSeconds >= 0) {
        return Math.floor(Number(td.durationSeconds));
    }
    var startRaw = td.testStartTime || (preview && preview.createdAt);
    var endRaw = td.testEndTime || (preview && (preview.completedAt || preview.createdAt));
    if (startRaw && endRaw) {
        var startMs = new Date(startRaw).getTime();
        var endMs = new Date(endRaw).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
            return Math.floor((endMs - startMs) / 1000);
        }
    }
    return null;
}

function buildTestReportDerived(td, recipe, reportId) {
    td = td && typeof td === 'object' ? td : {};
    recipe = recipe && typeof recipe === 'object' ? recipe : {};
    if (!recipe && td.recipe && typeof td.recipe === 'object') recipe = td.recipe;
    var results = td.stepResults || [];
    var steps = recipe.steps || td.steps || [];
    var weight = parseFloat(td.initialWeightG);
    if (isNaN(weight)) weight = null;
    var initialVol = null;
    var finalVol = null;
    if (results.length) {
        var v0 = parseFloat(results[0].volumeMl);
        var vf = parseFloat(results[results.length - 1].volumeMl);
        if (!isNaN(v0)) initialVol = v0;
        if (!isNaN(vf)) finalVol = vf;
        }
    if (initialVol == null && td.initialVolumeMl != null) {
        var iv = parseFloat(td.initialVolumeMl);
        if (!isNaN(iv)) initialVol = iv;
    }
    var diffLastTwo = null;
    if (results.length >= 2) {
        var v1 = parseFloat(results[results.length - 2].volumeMl);
        var v2 = parseFloat(results[results.length - 1].volumeMl);
        if (!isNaN(v1) && !isNaN(v2)) diffLastTwo = Math.abs(v1 - v2);
    } else if (results.length === 1 && results[0].volumeDeltaMl != null) {
        var dv = parseFloat(results[0].volumeDeltaMl);
        if (!isNaN(dv)) diffLastTwo = dv;
    }
    var initialDensity = null;
    var tappedDensity = null;
    if (weight != null && initialVol != null && initialVol > 0) {
        initialDensity = Math.round((weight / initialVol) * 1000) / 1000;
    }
    if (weight != null && finalVol != null && finalVol > 0) {
        tappedDensity = Math.round((weight / finalVol) * 1000) / 1000;
    }
    var compressibility = null;
    var hausner = null;
    if (initialVol != null && finalVol != null && initialVol > 0 && finalVol > 0) {
        compressibility = Math.round((1 - (finalVol / initialVol)) * 10000) / 100;
        hausner = Math.round((initialVol / finalVol) * 1000) / 1000;
    }
    var testType = typeof recipeUspLabel === 'function' ? recipeUspLabel(recipe) : (recipe.usp || td.usp || '--');
    var cylMl = (recipe.cylinder && (recipe.cylinder.volume || recipe.cylinder.volumeMl)) || td.sampleVolumeMl;
    var testMethod = testType;
    if (cylMl != null && cylMl !== '') testMethod = testType + ', ' + cylMl + ' ml cylinder';
    var speed = recipe.speed;
    if (speed == null && steps[0] && steps[0].speed != null) speed = steps[0].speed;
    var dropH = '--';
    var dh = recipe.dropHeight;
    if (dh == null && steps[0] && steps[0].dropHeight != null) dh = steps[0].dropHeight;
    if (dh == null && td.dropHeight != null) dh = td.dropHeight;
    if (dh != null && dh !== '') {
        var dhn = parseFloat(dh);
        dropH = !isNaN(dhn) ? (Math.round(dhn) + ' mm +/- 0.2 mm') : String(dh);
    }
    var stepTapCounts = [];
    for (var si = 0; si < steps.length; si++) {
        if (steps[si] && steps[si].tapCount != null) stepTapCounts.push(steps[si].tapCount);
    }
    var testNo = '--';
    if (reportId != null) {
        var nid = parseInt(reportId, 10);
        testNo = !isNaN(nid) ? String(nid).padStart(4, '0') : String(reportId);
    }
    var now = new Date();
    return {
        printDate: String(now.getDate()).padStart(2, '0') + '/' +
            String(now.getMonth() + 1).padStart(2, '0') + '/' + now.getFullYear(),
        printTime: String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0'),
        testNumber: testNo,
        testType: testType,
        testMethod: testMethod,
        dropsPerMin: speed != null ? speed : '--',
        dropHeight: dropH,
        totalTaps: (function () {
            var rTaps = Object.assign({}, recipe);
            if (!rTaps.steps && td.steps) rTaps.steps = td.steps;
            if (rTaps.customTotalTaps == null && td.customTotalTaps != null) {
                rTaps.customTotalTaps = td.customTotalTaps;
            }
            return typeof recipeTotalTapCount === 'function' ? recipeTotalTapCount(rTaps) : null;
        })(),
        stepTapCounts: stepTapCounts,
        sampleWeightG: weight,
        initialVolumeMl: initialVol,
        finalVolumeMl: finalVol,
        diffLastTwoVolumesMl: diffLastTwo,
        initialDensityGPerMl: initialDensity,
        tappedDensityGPerMl: tappedDensity,
        compressibilityIndexPct: compressibility,
        hausnerRatio: hausner
    };
}

function _setReportPreviewDisplayMode(mode) {
    var content = document.getElementById('report-content');
    var a4Pre = document.getElementById('report-a4-text-preview');
    var legacy = document.getElementById('report-legacy-preview');
    var useText = mode === 'a4' || mode === 'thermal';
    if (content) {
        content.classList.toggle('report-a4-preview-mode', useText);
        content.classList.toggle('report-thermal-preview-mode', mode === 'thermal');
    }
    if (a4Pre) a4Pre.style.display = useText ? 'block' : 'none';
    if (legacy) legacy.style.display = useText ? 'none' : 'block';
}

function _fmtPreviewVacuum(val) {
    if (val == null || val === '') return '--';
    var n = parseFloat(val);
    if (isNaN(n)) return String(val);
    return n.toFixed(1);
}

function _fmtPreviewTs(iso) {
    if (!iso) return '--';
    if (typeof formatReportDate === 'function') {
        var s = formatReportDate(iso);
        return s || '--';
    }
    return String(iso);
}

function _fmtPreviewDateOnly(iso) {
    var parts = formatReportDateAndTimeParts(iso);
    return parts.date || '--';
}

function _fmtPreviewTimeOnly(iso) {
    var parts = formatReportDateAndTimeParts(iso);
    return parts.time || '--';
}

/** Normalize report display dates to dd/mm/yyyy (slash). */
function normalizeReportDisplayDate(val) {
    var s = String(val == null ? '' : val).trim();
    if (!s || s.toUpperCase() === 'N/A' || s === '--') return s || '--';
    var m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (m) {
        return String(m[1]).padStart(2, '0') + '/' + String(m[2]).padStart(2, '0') + '/' + m[3];
    }
    return s;
}

/** Client fallback compact A4-style monospace (Friability screen look). */
function _releaseDurationSecFromSettings() {
    var sec = 80;
    try {
        var stored = localStorage.getItem('factorySettings');
        if (stored) {
            var s = JSON.parse(stored);
            var r = parseInt(s.calibrationReleaseTimeSec, 10);
            if (!isNaN(r) && r >= 1 && r <= 5999) sec = r;
        }
    } catch (e) { /* ignore */ }
    return sec;
}

/** Resolve sample size (No. of Samples) for report display from testData / recipe. */
function resolveReportSampleSize(td, recipe) {
    td = td || {};
    recipe = recipe || {};
    var nested = (recipe && typeof recipe === 'object') ? recipe : {};
    var candidates = [
        td.noOfSamples,
        td.sampleSize,
        nested.noOfSamples,
        nested.sampleSize
    ];
    for (var i = 0; i < candidates.length; i++) {
        var raw = candidates[i];
        if (raw == null || raw === '') continue;
        var n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 1) return n;
    }
    return null;
}
window.resolveReportSampleSize = resolveReportSampleSize;

function _reportDurationFieldsFromPreview(td, recipe, fs) {
    td = td || {};
    recipe = recipe || {};
    fs = fs || {};
    var hold = td.holdDurationSec != null ? td.holdDurationSec : td.setDurationSec;
    if (hold == null) hold = recipe.durationSec;
    var release = td.releaseDurationSec != null ? td.releaseDurationSec : td.releaseTimeSec;
    if (release == null) release = fs.calibrationReleaseTimeSec;
    if (release == null) release = _releaseDurationSecFromSettings();
    var total = td.totalDurationSec;
    var holdN = parseInt(hold, 10);
    var releaseN = parseInt(release, 10);
    var buildN = parseInt(td.buildDurationSec, 10);
    if (isNaN(buildN)) buildN = 0;
    // Prefer stored total (build + hold + release). Legacy fallback: hold + release.
    if ((total == null || isNaN(parseInt(total, 10))) && !isNaN(holdN) && !isNaN(releaseN)) {
        total = buildN + holdN + releaseN;
    }
    // Aborted / power-cut: show actual wall time performed (never planned hold+release).
    var statusLow = String(td.status || '').trim().toLowerCase();
    var remarksLow = String(td.remarks || '').trim().toLowerCase();
    var isAborted = statusLow === 'aborted' || remarksLow.indexOf('power interruption') >= 0;
    if (isAborted) {
        var actual = td.wallElapsedSec != null ? td.wallElapsedSec : td.actualDurationSec;
        if (actual == null) actual = td.durationSeconds;
        var aN = parseInt(actual, 10);
        if (isNaN(aN) && td.testStartTime && td.testEndTime) {
            try {
                var wMs = new Date(td.testEndTime).getTime() - new Date(td.testStartTime).getTime();
                if (!isNaN(wMs) && wMs >= 0) aN = Math.floor(wMs / 1000);
            } catch (eA) { /* ignore */ }
        }
        var holdStored = parseInt(td.holdDurationSec, 10);
        if (!isNaN(holdStored) && holdStored >= 0) {
            hold = holdStored;
        } else if (!isNaN(aN)) {
            hold = aN;
        }
        release = (td.releaseDurationSec != null && td.releaseDurationSec !== '')
            ? td.releaseDurationSec
            : 0;
        releaseN = parseInt(release, 10);
        if (isNaN(releaseN)) releaseN = 0;
        buildN = parseInt(td.buildDurationSec, 10);
        if (isNaN(buildN)) buildN = 0;
        if (!isNaN(aN)) {
            total = aN;
        } else {
            var tStored = parseInt(td.totalDurationSec, 10);
            if (!isNaN(tStored)) total = tStored;
        }
    }
    // If build was never stored (or frozen to 0 by early checkpoint), prefer Start→End wall clock
    // when it clearly exceeds hold+release (build time missing from total).
    if (!isAborted && td.testStartTime && td.testEndTime) {
        try {
            var wallMs = new Date(td.testEndTime).getTime() - new Date(td.testStartTime).getTime();
            if (!isNaN(wallMs) && wallMs >= 0) {
                var wallSec = Math.floor(wallMs / 1000);
                var totalN = parseInt(total, 10);
                var holdRelease = (!isNaN(holdN) && !isNaN(releaseN)) ? (holdN + releaseN) : null;
                if (total == null || isNaN(totalN)) {
                    total = wallSec;
                } else if (
                    holdRelease != null
                    && totalN <= holdRelease + 2
                    && wallSec > holdRelease + 5
                    && (isNaN(buildN) || buildN <= 0)
                ) {
                    total = wallSec;
                    buildN = Math.max(0, wallSec - holdRelease);
                }
            }
        } catch (eWall) { /* ignore */ }
    }
    function fmt(v) {
        if (v == null || v === '' || isNaN(parseInt(v, 10))) return '--';
        return (typeof formatMmSs === 'function') ? formatMmSs(parseInt(v, 10)) : String(v);
    }
    return { hold: fmt(hold), release: fmt(release), total: fmt(total), buildSec: buildN };
}

function _approverFieldsFromPreview(preview, td) {
    preview = preview || {};
    td = td || {};
    var name = preview.approvedByName || td.approvedByName || '';
    var id = preview.approvedByUsername || td.approvedByUsername || '';
    var by = String(preview.approvedBy || td.approvedBy || '').trim();
    if (!name && by) name = by.split('(')[0].trim() || by;
    if (typeof formatApprovedByLine === 'function' && name) name = formatApprovedByLine(name);
    return { name: name || '--', id: id || '--' };
}

/** Canonical report status label for UI / thermal text (never maps aborted → Completed). */
function reportStatusDisplayLabel(preview, td) {
    preview = preview || {};
    td = td || preview.testData || {};
    var approvalSt = String(preview.reportApprovalStatus || '').trim().toLowerCase();
    var remarks = String(td.remarks || preview.remarks || '').trim().toLowerCase();
    var raw = String(td.status != null && td.status !== '' ? td.status : (preview.status || '')).trim();
    var low = raw.toLowerCase();
    var rtype = String(preview.type || 'test').trim().toLowerCase();
    if (low === 'aborted' || approvalSt === 'aborted' || remarks.indexOf('abort') >= 0) {
        return 'Aborted';
    }
    if (rtype === 'validation') {
        if (low === 'pass') return 'Pass';
        if (low === 'fail') return 'Fail';
        if (low === 'completed') return 'Completed';
        return raw || '--';
    }
    if (rtype === 'calibration') {
        if (!raw || low === 'completed') return 'Completed';
        return raw.charAt(0).toUpperCase() + raw.slice(1);
    }
    return 'Completed';
}
window.reportStatusDisplayLabel = reportStatusDisplayLabel;

function buildClientThermalPreviewText(preview) {
    if (!preview) return '';
    var recipe = preview.recipe || (preview.testData && preview.testData.recipe) || {};
    var td = preview.testData || preview;
    var fs = preview.factorySettings || {};
    var derived = preview.reportDerived || {};
    var statusLabel = reportStatusDisplayLabel(preview, td);
    var arNo = '';
    if (typeof resolveAnalysisReportNo === 'function') {
        arNo = resolveAnalysisReportNo(recipe, td) || '';
    } else {
        arNo = td.analysisReportNo || recipe.analysisReportNo || '';
    }
    var batchSize = (td.batchSize != null && td.batchSize !== '') ? td.batchSize : recipe.batchSize;
    var sampleSize = (typeof resolveReportSampleSize === 'function')
        ? resolveReportSampleSize(td, recipe)
        : ((td.noOfSamples != null && td.noOfSamples !== '') ? td.noOfSamples : recipe.noOfSamples);
    var setVac = (td.setVacuumMmHg != null) ? td.setVacuumMmHg : recipe.vacuumMmHg;
    var durs = _reportDurationFieldsFromPreview(td, recipe, fs);
    var appr = _approverFieldsFromPreview(preview, td);
    function padPair(leftLabel, leftVal, rightLabel, rightVal) {
        var left = (leftLabel + ': ' + (leftVal != null && leftVal !== '' ? leftVal : '--'));
        var right = (rightLabel + ': ' + (rightVal != null && rightVal !== '' ? rightVal : '--'));
        while (left.length < 40) left += ' ';
        return (left + right).slice(0, 80);
    }
    var title = 'LEAK TEST APPARATUS TEST REPORT';
    if (preview.type === 'validation') title = 'LEAK TEST APPARATUS VALIDATION REPORT';
    else if (preview.type === 'calibration') title = 'LEAK TEST APPARATUS CALIBRATION REPORT';
    var sep = '================================================================================';
    var dash = '--------------------------------------------------------------------------------';
    var lines = [
        sep,
        title,
        sep,
        padPair('Company', fs.companyName || 'N/A', 'Model No', fs.modelNo || 'N/A'),
        padPair('Serial No', fs.serialNo || 'N/A', 'Location', fs.companyLocation || fs.location || 'N/A'),
        padPair('Instrument ID', fs.instrumentId || 'N/A', 'Last Val', normalizeReportDisplayDate(fs.lastValidationDate) || 'N/A'),
        padPair('Next Val Due', normalizeReportDisplayDate(fs.nextValidationDate) || 'N/A', '', ''),
        '',
        'TEST INFORMATION',
        dash,
        padPair('Product', recipe.productName || td.productName || 'N/A', 'Batch', recipe.batchNumber || td.batchNumber || 'N/A'),
        padPair('Batch Size', (batchSize != null && batchSize !== '' ? batchSize : 'N/A'), 'Sample Size', (sampleSize != null && sampleSize !== '' ? sampleSize : 'N/A')),
        padPair('A.R. No', arNo || 'N/A', 'Operator', preview.operatorName || td.operatorName || '--'),
        padPair('Test Status', statusLabel, '', ''),
        padPair('Start Date', _fmtPreviewDateOnly(td.testStartTime || preview.createdAt), 'Start Time', _fmtPreviewTimeOnly(td.testStartTime || preview.createdAt)),
        padPair('Test Completed Date', _fmtPreviewDateOnly(td.testEndTime || preview.completedAt || preview.createdAt), 'Test Completed Time', _fmtPreviewTimeOnly(td.testEndTime || preview.completedAt || preview.createdAt)),
        '',
        'TEST RESULT',
        dash,
        padPair('Set Vacuum (mmHg)', setVac != null && setVac !== '' ? setVac : '--', 'Total Duration (mm:ss)', durs.total),
        padPair('Hold Duration (mm:ss)', durs.hold, '', '')
    ];
    var samples = Array.isArray(td.vacuumSamples) ? td.vacuumSamples : [];
    if (samples.length) {
        lines.push('', 'HOLD VACUUM SAMPLES', dash, 'Time (% / mm:ss)                     Vacuum (mmHg)');
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i] || {};
            var pct = s.percent != null ? (s.percent + '%') : '--';
            var tDisp = s.timeDisplay
                || (s.elapsedSec != null && typeof formatMmSs === 'function' ? formatMmSs(s.elapsedSec) : '--');
            var left = (pct + ' / ' + tDisp);
            while (left.length < 40) left += ' ';
            lines.push((left + _fmtPreviewVacuum(s.vacuumMmHg)).slice(0, 80));
        }
    }
    lines.push(
        '',
        'APPROVAL',
        dash,
        padPair('Operated by', preview.operatorName || td.operatorName || '--', 'Employee ID', preview.employeeId || td.employeeId || '--'),
        padPair('Approval Result', preview.approvalPassFail || '--', 'Approver Name', appr.name),
        padPair('Approver User ID', appr.id, 'Approval Remarks', (preview.approvalRemarks != null && String(preview.approvalRemarks).trim() !== '')
            ? preview.approvalRemarks : 'N/A')
    );
    return lines.join('\n');
}

function populateReportPreview(preview) {
    if (!preview) return;
    // Friability screen preview uses A4 monospace text (compact two-column), not thermal double-spacing.
    var a4Text = preview.a4Text;
    var thermalText = preview.thermalText;
    var text = (a4Text && String(a4Text).trim())
        ? String(a4Text)
        : ((thermalText && String(thermalText).trim()) ? String(thermalText) : '');
    var mode = (a4Text && String(a4Text).trim()) ? 'a4' : 'thermal';
    var td = preview.testData || preview;
    var samples = Array.isArray(td.vacuumSamples) ? td.vacuumSamples : [];
    // Prefer client rebuild when hold samples exist but server text is stale/missing that section.
    var serverMissingHoldSamples = samples.length > 0
        && (!text || String(text).indexOf('HOLD VACUUM SAMPLES') < 0);
    if (!text || serverMissingHoldSamples) {
        text = buildClientThermalPreviewText(preview);
        mode = 'a4';
    }

    if (text && String(text).trim()) {
        _setReportPreviewDisplayMode(mode);
        var a4Pre = document.getElementById('report-a4-text-preview');
        if (a4Pre) a4Pre.textContent = text;
        try { _populateLegacyReportPreview(preview); } catch (e) { /* ignore */ }
    } else {
        _setReportPreviewDisplayMode('legacy');
        _populateLegacyReportPreview(preview);
    }

    window._lastReportPreview = preview;
    if (currentReportId != null && typeof buildReportPrintPayload === 'function') {
        currentReportData = buildReportPrintPayload(preview, currentReportId);
    }
    if (typeof updateReportApprovePanelForPreview === 'function') {
        updateReportApprovePanelForPreview(preview);
    }
    applyReportPreviewLockUi(preview);
    if (typeof updateReportPreviewPrintExportButtons === 'function') {
        updateReportPreviewPrintExportButtons(preview);
    }
}

function _populateLegacyReportPreview(preview) {
    if (!preview) return;
    var reportType = preview.type || 'test';
    var isValidationOrCalibration = (reportType === 'validation' || reportType === 'calibration');
    var valCalSection = document.getElementById('report-validation-calibration-section');
    var testSections = document.getElementById('report-test-sections');
    if (valCalSection) valCalSection.style.display = isValidationOrCalibration ? 'block' : 'none';
    if (testSections) testSections.style.display = isValidationOrCalibration ? 'none' : 'block';
    var mainTitleEl = document.getElementById('report-main-title');
    if (mainTitleEl) {
        mainTitleEl.textContent = (reportType === 'validation')
            ? 'LEAK TEST APPARATUS VALIDATION REPORT'
            : (reportType === 'calibration'
                ? 'LEAK TEST APPARATUS CALIBRATION REPORT'
                : 'LEAK TEST APPARATUS TEST REPORT');
    }

    var recipe = preview.recipe || (preview.testData && preview.testData.recipe) || preview.testData || {};
    var fs = preview.factorySettings || {};
    var td = preview.testData || preview;

    setReportEl('report-company-name', fs.companyName);
    setReportEl('report-model-no', fs.modelNo);
    setReportEl('report-serial-no', fs.serialNo);
    setReportEl('report-location', fs.companyLocation || fs.location);
    setReportEl('report-instrument-no', fs.instrumentId);
    setReportEl('report-previous-val', normalizeReportDisplayDate(fs.lastValidationDate));
    setReportEl('report-next-validation', normalizeReportDisplayDate(fs.nextValidationDate));

    if (reportType === 'validation') {
        renderValidationDetailsInPreview(preview);
    } else if (reportType === 'calibration') {
        renderCalibrationDetailsInPreview(preview);
    }

    var derived = preview.reportDerived;
    if (!derived || typeof derived !== 'object') {
        derived = buildTestReportDerived(td, recipe, preview.id != null ? preview.id : currentReportId);
    }
    setReportEl('report-print-date', '');
    setReportEl('report-print-time', '');
    setReportEl('report-test-number', derived.testNumber || '--');
    setReportEl('report-test-operator', preview.operatorName || td.operatorName || '--');
    setReportEl('report-product-name', recipe.productName || td.productName);
    setReportEl('report-batch-no', recipe.batchNumber || td.batchNumber || '--');
    setReportEl('report-test-type', derived.testType || '--');
    setReportEl('report-test-method', derived.testMethod || '--');
    setReportEl('report-drops-per-min', derived.dropsPerMin != null ? String(derived.dropsPerMin) : '--');
    setReportEl('report-drop-height', derived.dropHeight || '--');
    var totalTaps = derived.totalTaps != null ? derived.totalTaps : recipeTotalTapCount(recipe);
    setReportEl('report-total-taps', totalTaps != null ? String(totalTaps) : 'N/A');
    var tapCountBody = document.getElementById('report-tap-count-rows');
    if (tapCountBody) {
        var tapRows = '';
        var stc = derived.stepTapCounts || [];
        for (var ti = 0; ti < stc.length; ti++) {
            tapRows += '<tr><th>TAP COUNT ' + (ti + 1) + '</th><td colspan="3">' + stc[ti] + '</td></tr>';
        }
        tapCountBody.innerHTML = tapRows;
    }

    var startParts = formatReportDateAndTimeParts(td.testStartTime || preview.createdAt);
    var completedParts = formatReportDateAndTimeParts(
        td.testEndTime || preview.completedAt || preview.createdAt
    );
    setReportEl('report-start-date', startParts.date);
    setReportEl('report-start-time', startParts.time);
    setReportEl('report-completed-date', completedParts.date);
    setReportEl('report-completed-time', completedParts.time);

    setReportEl('report-test-duration', formatDurationSeconds(testDurationSecondsFromData(td, preview)));
    var statusLabel = reportStatusDisplayLabel(preview, td);
    setReportEl('report-test-status', statusLabel);

    if (reportType === 'test') {
        var setVac = (td.setVacuumMmHg != null) ? td.setVacuumMmHg : (recipe.vacuumMmHg != null ? recipe.vacuumMmHg : null);
        var durs = _reportDurationFieldsFromPreview(td, recipe, fs);
        setReportEl('report-set-vacuum', setVac != null ? String(setVac) : '');
        setReportEl('report-total-duration', durs.total || '');
        setReportEl('report-hold-duration', durs.hold || '');

        var arDisp = (typeof resolveAnalysisReportNo === 'function')
            ? resolveAnalysisReportNo(recipe, td)
            : '';
        setReportEl('report-analysis-no', arDisp || '--');
        var batchSizeVal = (td.batchSize != null) ? td.batchSize : recipe.batchSize;
        setReportEl('report-batch-size', (batchSizeVal != null && !isNaN(parseInt(batchSizeVal, 10)))
            ? String(parseInt(batchSizeVal, 10)) : '--');
        var sampleSizeVal = (typeof resolveReportSampleSize === 'function')
            ? resolveReportSampleSize(td, recipe)
            : ((td.noOfSamples != null) ? td.noOfSamples : recipe.noOfSamples);
        setReportEl('report-sample-size', (sampleSizeVal != null && !isNaN(parseInt(sampleSizeVal, 10)))
            ? String(parseInt(sampleSizeVal, 10)) : '--');

        var samplesBody = document.getElementById('report-vacuum-samples-body');
        var samplesWrap = document.getElementById('report-vacuum-samples-wrap');
        var samples = Array.isArray(td.vacuumSamples) ? td.vacuumSamples : [];
        if (samplesBody) {
            var sRows = '';
            for (var si = 0; si < samples.length; si++) {
                var s = samples[si] || {};
                var pct = s.percent != null ? s.percent + '%' : '--';
                var tDisp = s.timeDisplay
                    || (s.elapsedSec != null && typeof formatMmSs === 'function' ? formatMmSs(s.elapsedSec) : '--');
                var vacDisp = (s.vacuumMmHg != null && !isNaN(parseFloat(s.vacuumMmHg)))
                    ? parseFloat(s.vacuumMmHg).toFixed(1)
                    : '--';
                sRows += '<tr><td>' + pct + ' / ' + tDisp + '</td><td>' + vacDisp + '</td></tr>';
            }
            samplesBody.innerHTML = sRows;
        }
        if (samplesWrap) samplesWrap.style.display = samples.length ? '' : 'none';
    } else {
        var samplesWrapOff = document.getElementById('report-vacuum-samples-wrap');
        if (samplesWrapOff) samplesWrapOff.style.display = 'none';
    }

    var tbody = document.getElementById('report-test-data-body');
    if (tbody) {
        var rowCount = getReportStepRowCount(td);
        var results = td.stepResults || [];
        var rows = [];

        var steps = recipe.steps || td.steps || [];
        if (rowCount > 0) {
            for (var i = 0; i < rowCount; i++) {
                var r = results[i] || {};
                var cnt = '--';
                if (steps[i] && steps[i].tapCount != null) cnt = steps[i].tapCount;
                var vol = (r.volumeMl != null && r.volumeMl !== '') ? r.volumeMl : '__';
                var dVol = '__';
                if (r.volumeDeltaMl != null && r.volumeDeltaMl !== '' && !isNaN(parseFloat(r.volumeDeltaMl))) {
                    dVol = _formatDensity(parseFloat(r.volumeDeltaMl));
                }
                var bulk = (r.bulkDensity != null && r.bulkDensity !== '') ? r.bulkDensity : '__';
                var tap = (r.tapDensity != null && r.tapDensity !== '') ? r.tapDensity : '__';

                rows.push(
                    '<tr>' +
                        '<td>' + (i + 1) + '</td>' +
                        '<td>' + cnt + '</td>' +
                        '<td>' + vol + '</td>' +
                        '<td>' + dVol + '</td>' +
                        '<td>' + bulk + '</td>' +
                        '<td>' + tap + '</td>' +
                    '</tr>'
                );
            }
            tbody.innerHTML = rows.join('');
        } else {
            tbody.innerHTML = '<tr><td colspan="6">No test data</td></tr>';
        }
    }

    function fmtDerived(n, dec) {
        if (n == null || isNaN(n)) return '--';
        if (dec === 0) return String(Math.round(n));
        return _formatDensity(n);
    }
    setReportEl('report-sample-weight', fmtDerived(derived.sampleWeightG, 2));
    setReportEl('report-total-drops', totalTaps != null ? String(totalTaps) : '--');
    setReportEl('report-initial-volume', fmtDerived(derived.initialVolumeMl, 4));
    setReportEl('report-diff-last-two', fmtDerived(derived.diffLastTwoVolumesMl, 4));
    setReportEl('report-final-volume', fmtDerived(derived.finalVolumeMl, 4));
    setReportEl('report-initial-density', fmtDerived(derived.initialDensityGPerMl, 3));
    setReportEl('report-tapped-density', fmtDerived(derived.tappedDensityGPerMl, 3));
    setReportEl('report-compressibility', fmtDerived(derived.compressibilityIndexPct, 2));
    setReportEl('report-hausner-ratio', fmtDerived(derived.hausnerRatio, 3));

    var statBody = document.getElementById('report-statistics-body');
    if (statBody) {
        var stats = preview.statistics || td.statistics || {};
        if (String(td.status || '').trim().toLowerCase() === 'aborted') {
            statBody.innerHTML = '<tr><td colspan="2">N/A</td></tr>';
        } else if (stats && Object.keys(stats).length) {
            var rows = [];
            for (var k in stats) {
                if (stats.hasOwnProperty(k) && typeof stats[k] === 'object' && stats[k] !== null) {
                    var v = stats[k];
                    var display = v.value != null ? v.value : (v.mean != null ? v.mean : v.Mean);
                    if (display == null) continue;
                    var displayStr = display;
                    var num = parseFloat(display);
                    if (!isNaN(num)) displayStr = _formatDensity(num);
                    rows.push('<tr><th>' + k + '</th><td>' + displayStr + '</td></tr>');
                }
            }
            statBody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="2">N/A</td></tr>';
        } else {
            statBody.innerHTML = '<tr><td colspan="2">N/A</td></tr>';
        }
    }

    var remarksEl = document.getElementById('report-remarks-box');
    if (remarksEl) {
        var abortRemarks = preview.remarks || td.remarks || '';
        remarksEl.textContent = (abortRemarks !== '' && abortRemarks != null)
            ? abortRemarks
            : (String(td.status || '').toLowerCase() === 'aborted' ? '—' : 'N/A');
    }

    setReportEl('report-operated-by', preview.operatorName || td.operatorName || '--');
    setReportEl('report-employee-id', preview.employeeId || td.employeeId || '--');
    var apprFields = _approverFieldsFromPreview(preview, td);
    setReportEl('report-approved-by-name', apprFields.name);
    setReportEl('report-approved-by-id', apprFields.id);
    // Keep legacy id populated if still present in older DOM snapshots.
    setReportEl('report-approved-by', apprFields.name !== '--'
        ? (apprFields.id !== '--' ? (apprFields.name + ' / ' + apprFields.id) : apprFields.name)
        : apprFields.id);
    setReportEl('report-approval-pass-fail', preview.approvalPassFail || '--');
    var apprRem = preview.approvalRemarks;
    setReportEl('report-approval-remarks', (apprRem != null && String(apprRem).trim() !== '') ? apprRem : 'N/A');
}

function updateReportPreviewPrintExportButtons(preview) {
    var peGroup = document.getElementById('report-preview-print-export-group');
    if (!peGroup) return;
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    var blockActions = approvalSt === 'pending' &&
        (reportTypeNorm === 'test' || reportTypeNorm === 'validation' || reportTypeNorm === 'calibration');
    var canPrint = typeof userCanPrintReports === 'function' && userCanPrintReports() && !blockActions;
    var canExport = typeof userCanExportToUsb === 'function' && userCanExportToUsb() && !blockActions;
    peGroup.style.display = (canPrint || canExport) ? 'flex' : 'none';
    peGroup.querySelectorAll('.btn-print, .btn-print-thermal').forEach(function (btn) {
        btn.style.display = canPrint ? '' : 'none';
    });
    var expBtn = peGroup.querySelector('.btn-export');
    if (expBtn) expBtn.style.display = canExport ? '' : 'none';
}

function verifyReportApproverInline(method) {
    method = method === 'biometric' ? 'biometric' : 'credentials';
    clearReportApproveVerifyError();
    var reportType = typeof getReportApprovalType === 'function'
        ? getReportApprovalType(window._lastReportPreview)
        : String((window._lastReportPreview || {}).type || 'test').trim().toLowerCase();
    if (method === 'biometric') {
        var bioMsg = reportType === 'calibration'
            ? 'Place a fingerprint for a user with Calibration report approval permission.'
            : 'Place a fingerprint for a user with Test report approval permission.';
        return runBiometricVerifyWithRetry({
            purpose: 'report',
            reportType: reportType,
            title: 'Verify Fingerprint',
            message: bioMsg,
            failureHint: 'Place your finger on the scanner and tap Try again.'
        }).then(function (result) {
            if (!result || !result.ok) {
                if (result && result.error !== 'cancelled') {
                    setReportApproveVerifyError(
                        result.message || result.error || 'Fingerprint verification failed.',
                        { showBiometricRetry: true }
                    );
                } else if (result && result.error === 'cancelled' && result.message) {
                    setReportApproveVerifyError(result.message, { showBiometricRetry: true });
                }
                return null;
            }
            setReportApproveBiometricRetryVisible(false);
            return result.token;
        });
    }
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var passwordEl = document.getElementById('report-approve-verifier-password');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        setReportApproveVerifyError(
            reportType === 'calibration'
                ? 'Enter User ID and password for a Calibration report approver.'
                : 'Enter Reviewer or Admin User ID and password.'
        );
        return Promise.resolve(null);
    }
    if (typeof isCurrentUserReportOperator === 'function' && isCurrentUserReportOperator(window._lastReportPreview)) {
        var opUser = typeof getReportOperatedByUsername === 'function'
            ? getReportOperatedByUsername(window._lastReportPreview) : '';
        var enteredNorm = typeof normalizeReportUsername === 'function'
            ? normalizeReportUsername(username) : String(username).trim().toLowerCase();
        if (opUser && enteredNorm && enteredNorm === opUser) {
            setReportApproveVerifyError('You cannot approve your own report. A Reviewer or Admin must sign below.');
            return Promise.resolve(null);
        }
    }
    return apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: {
        method: 'credentials',
        username: username,
        password: password,
            purpose: 'report',
            reportType: reportType
        }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            setReportApproveVerifyError((data && data.error) ? String(data.error) : 'Verification failed.');
            return null;
        }
        return String(data.token);
    }).catch(function (err) {
        setReportApproveVerifyError('Verification failed: ' + (err && err.message ? err.message : 'Error'));
        return null;
    });
}

function approveReportWithVerifier(reportId, passFail, remarks, verifyMethod) {
    verifyMethod = verifyMethod === 'biometric' ? 'biometric' : 'credentials';
    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');

    function postReportApprove(extraHeaders) {
        return apiRequest(API_BASE + '/api/data/reports/' + reportId + '/approve', {
            method: 'POST',
            headers: extraHeaders || {},
            body: { passFail: passFail, remarks: remarks }
        }).then(function (data) {
            if (data && data.ok) return data;
            var msg = (data && data.error) ? String(data.error) : 'Approval failed.';
            setReportApproveVerifyError(msg);
            return null;
        });
    }

    if (role === 'factory') {
        return postReportApprove({}).then(function (data) { return data && data.ok; });
    }

    return verifyReportApproverInline(verifyMethod).then(function (token) {
        if (!token) return null;
        return postReportApprove({ 'X-Approval-Verify-Token': token }).then(function (data) {
            return data && data.ok;
        });
    });
}

function submitReportApprove() {
    var id = currentReportId;
    if (id == null) return;
    var preview = window._lastReportPreview;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        setReportApproveVerifyError('Select Pass or Fail.');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    approveReportWithVerifier(id, pf, remarks, 'credentials').then(function (ok) {
        if (ok === true) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                _saveReportPdfSilent(id);
                var row = document.getElementById('report-approved-by');
                if (row) {
                    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
                }
                scrollReportPreviewActionsIntoView();
            }, 600);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}

function submitReportApproveBiometric() {
    var id = currentReportId;
    if (id == null) return;
    var preview = window._lastReportPreview;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        setReportApproveVerifyError('Select Pass or Fail.');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    setReportApproveBiometricRetryVisible(false);
    approveReportWithVerifier(id, pf, remarks, 'biometric').then(function (ok) {
        if (ok === true) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                _saveReportPdfSilent(id);
                var row = document.getElementById('report-approved-by');
                if (row) {
                    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
                }
                scrollReportPreviewActionsIntoView();
            }, 600);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}

var _pendingTestRunReportId = null;

function openTestRunCompletionApprovalModal() {
    var overlay = document.getElementById('test-run-completion-overlay');
    var passEl = document.querySelector('input[name="test-run-completion-pass-fail"][value="PASS"]');
    if (passEl) passEl.checked = true;
    var ta = document.getElementById('test-run-completion-remarks');
    if (ta) ta.value = '';
    var errEl = document.getElementById('test-run-completion-error');
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
}

function confirmTestRunCompletionSaveRemarks() {
    var id = _pendingTestRunReportId;
    closeTestRunCompletionApprovalModal();
    _pendingTestRunReportId = null;
    if (id != null) openReportPreview(id);
}

function closeTestRunCompletionApprovalModal() {
    var overlay = document.getElementById('test-run-completion-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmTestRunCompletionApproval() {
    var id = _pendingTestRunReportId;
    if (id == null) return;
    var pfEl = document.querySelector('input[name="test-run-completion-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        showAppModal('Select Pass or Fail.', 'Test complete');
        return;
    }
    var ta = document.getElementById('test-run-completion-remarks');
    var remarks = ta ? ta.value.trim() : '';
    approveReportWithVerifier(id, pf, remarks).then(function (ok) {
        if (ok === true) {
            closeTestRunCompletionApprovalModal();
            _pendingTestRunReportId = null;
            clearReportApprovalGate();
            showAppModal('Report approved.', 'Report');
            openReportPreview(id, { setGate: true });
            setTimeout(function () {
                scrollReportPreviewActionsIntoView();
            }, 400);
        }
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Report');
    });
}

function skipTestRunCompletionToReport() {
    var id = _pendingTestRunReportId;
    closeTestRunCompletionApprovalModal();
    _pendingTestRunReportId = null;
    if (id != null) openReportPreview(id);
}

var lastTestRunRecipe = null;
/** Simplified vacuum-hold test run state. */
var testRunSetVacuumMmHg = null;
var testRunSetDurationSec = null;
var testRunSetDurationDisplay = '--';
var testRunCurrentVacuumMmHg = null;
var testRunElapsedSec = 0;
var testRunResultText = null;
var testRunHoldStarted = false;
var testRunVacuumSamples = [];
var testRunNextSamplePercent = 10;
/** Set when starting a test from Quick Test; cleared after report save so the form resets. */
var _quickTestRunPendingFormReset = false;
var testRunButtonState = 'start'; // 'start' | 'abort'
/** ISO timestamp when the operator presses START (ESP start / pressure build begins). */
var testRunStartTime = null;
/** ISO timestamp when set vacuum is reached and hold timer starts (end of build). */
var testRunHoldStartTime = null;
/** Frozen build (evacuate) seconds: Start → TARGET_REACHED, or Start → abort if never reached. */
var testRunBuildDurationSec = null;

function _freezeTestRunBuildDurationSec(opts) {
    opts = opts || {};
    // Authoritative: Start → TARGET_REACHED / hold start. Always recompute when both stamps exist
    // so an early checkpoint cannot permanently freeze build to ~0.
    try {
        if (testRunStartTime && testRunHoldStartTime) {
            var bMs = new Date(testRunHoldStartTime).getTime() - new Date(testRunStartTime).getTime();
            if (!isNaN(bMs) && bMs >= 0) {
                testRunBuildDurationSec = Math.floor(bMs / 1000);
                return testRunBuildDurationSec;
            }
        }
    } catch (eHold) { /* fall through */ }

    // Abort / incomplete build: optionally freeze time-until-now once.
    if (opts.finalize && testRunStartTime && !testRunHoldStartTime) {
        try {
            var bMs2 = Date.now() - new Date(testRunStartTime).getTime();
            if (!isNaN(bMs2) && bMs2 >= 0) {
                testRunBuildDurationSec = Math.floor(bMs2 / 1000);
                return testRunBuildDurationSec;
            }
        } catch (eAbort) { /* ignore */ }
    }

    if (testRunBuildDurationSec != null && !isNaN(parseInt(testRunBuildDurationSec, 10))) {
        return parseInt(testRunBuildDurationSec, 10);
    }

    // Mid-build checkpoint: report provisional build so far, but do NOT freeze it.
    if (testRunStartTime && !testRunHoldStarted) {
        try {
            var bMs3 = Date.now() - new Date(testRunStartTime).getTime();
            if (!isNaN(bMs3) && bMs3 >= 0) return Math.floor(bMs3 / 1000);
        } catch (eProv) { /* ignore */ }
    }
    return 0;
}
var testRunIntervalId = null;
var testRunCurrentStepIndex = 0;
var testRunCurrentTapCount = 0;
/** Taps completed in the current step before the latest hardware session (survives adapter pause). */
var testRunStepTapsBase = 0;
var testRunAdapterWaitActive = false;
var testRunAdapterPollTimerId = null;
var _testRunStepResumeInFlight = false;
var _adapterPollOkStreak = 0;
var testRunSteps = [];
var testRunTotalSteps = 0;
var testRunStepResults = []; // { stepIndex, bulkDensity, tapDensity, resultText }
var testRunStepVolumes = [];   // per-step volume entries
var testRunInitialWeightG = null;
var testRunInitialVolumeMl = null;   // first reading at Start (bulk density baseline)
var testRunPreviousVolumeMl = null;  // last reading before current step’s post-tap volume
var testRunLastStepVolumeDeltaMl = null;
var testRunLastStepPreviousMl = null;
var testRunLastStepCurrentMl = null;
var _pendingStepVolumeDeltaMl = null;
var _testRunInitialWeightResolve = null;

/** EventSource for MCU SSE during hardware-backed test run */
var testRunHardwareEs = null;
var _testRunHardwareTapListener = null;

function _getHardwareSseUrl() {
    var base = API_BASE || '';
    var path = '/api/hardware/stream';
    if (base && String(base).indexOf('http') === 0) {
        return String(base).replace(/\/$/, '') + path;
    }
    return path;
}

function _closeTestRunHardwareEs() {
    _stopTestRunPressurePoll();
    if (testRunHardwareEs) {
        if (_testRunHardwareTapListener) {
            try {
                testRunHardwareEs.removeEventListener('message', _testRunHardwareTapListener);
            } catch (e) {}
            _testRunHardwareTapListener = null;
        }
        try {
            testRunHardwareEs.close();
        } catch (e2) {}
        testRunHardwareEs = null;
    }
}

function _applyLiveTestRunPressure(v) {
    if (v == null || isNaN(v)) return;
    testRunCurrentVacuumMmHg = v;
    setRunCard('run-current-vacuum', Number(v).toFixed(1));
    if (testRunHoldStarted || testRunButtonState !== 'abort' || testRunSetVacuumMmHg == null) return;
    if (window._testRunStartPressureMmHg == null) {
        window._testRunStartPressureMmHg = v;
        return;
    }
    var startP = window._testRunStartPressureMmHg;
    var target = testRunSetVacuumMmHg;
    // Support both rising and falling absolute scales: start hold only after crossing target.
    var crossed = (startP > target && v <= target) || (startP < target && v >= target);
    if (crossed) _startTestRunHoldAfterTarget();
}

function _stopTestRunPressurePoll() {
    if (window._testRunPressurePollId != null) {
        clearInterval(window._testRunPressurePollId);
        window._testRunPressurePollId = null;
    }
}

function _startTestRunPressurePoll() {
    _stopTestRunPressurePoll();
    window._testRunPressurePollId = setInterval(function () {
        if (testRunButtonState !== 'abort') return;
        if (typeof apiRequest !== 'function') return;
        apiRequest(API_BASE + '/api/hardware/status', { method: 'GET' }).then(function (res) {
            if (!res || res.ok === false) return;
            var raw = res.pressureMmHg != null ? res.pressureMmHg : res.pressure;
            var v = parseFloat(raw);
            if (!isNaN(v)) _applyLiveTestRunPressure(v);
        }).catch(function () { /* ignore */ });
    }, 1000);
}

function hardwareLeakStopSilently() {
    return apiRequest(API_BASE + '/api/hardware/leak/stop', { method: 'POST' }).catch(function () {});
}

/**
 * Fire leak/stop several times with short gaps (ESP vents on STOP).
 * Used when the release-pressure lock starts — do not wait for the 80s UI to finish.
 */
function hardwareLeakStopBurst(times) {
    var n = parseInt(times, 10);
    if (isNaN(n) || n < 1) n = 3;
    if (n > 5) n = 5;
    var gapMs = 500;
    for (var i = 0; i < n; i++) {
        (function (delay) {
            setTimeout(function () {
                hardwareLeakStopSilently();
            }, delay);
        })(i * gapMs);
    }
}
window.hardwareLeakStopBurst = hardwareLeakStopBurst;

/** Await leak/stop so ESP motor actually stops before UI continues; never rejects. */
function hardwareLeakStopAwait() {
    return apiRequest(API_BASE + '/api/hardware/leak/stop', { method: 'POST' })
        .then(function (res) {
            if (res && res.ok === false) {
                console.error('leak/stop failed', res.error || res);
            }
            return res;
        })
        .catch(function (err) {
            console.error('leak/stop error', err);
            return null;
        });
}
window.hardwareLeakStopAwait = hardwareLeakStopAwait;

/**
 * Keep calling /api/hardware/leak/stop until ESP STOP_ACK (backend also retries).
 * Used with the "Check for leaks" modal so the pump is stopped for sure.
 */
function hardwareLeakStopUntilAck(opts) {
    opts = opts || {};
    // Backend cmd_stop already retries UART until STOP_ACK (up to 15×). Extra HTTP attempts
    // only cover a failed request (e.g. bridge restart), not per-UART retries.
    var maxAttempts = opts.maxAttempts != null ? opts.maxAttempts : 2;
    var gapMs = opts.gapMs != null ? opts.gapMs : 1000;
    var attempt = 0;
    function once() {
        attempt += 1;
        return apiRequest(API_BASE + '/api/hardware/leak/stop', { method: 'POST' })
            .then(function (res) {
                if (res && res.ok) return res;
                if (attempt >= maxAttempts) return res || { ok: false, error: 'No STOP_ACK' };
                return new Promise(function (resolve) {
                    setTimeout(function () { resolve(once()); }, gapMs);
                });
            })
            .catch(function (err) {
                console.error('leak/stop until ACK error', err);
                if (attempt >= maxAttempts) return null;
                return new Promise(function (resolve) {
                    setTimeout(function () { resolve(once()); }, gapMs);
                });
            });
    }
    return once();
}
window.hardwareLeakStopUntilAck = hardwareLeakStopUntilAck;

/** Pressure-build leak guard (test / validation / calibration). Absolute mmHg scale rising toward set. */
var PRESSURE_BUILD_WATCH_MS = 60000;
var PRESSURE_BUILD_DEEP_SETPOINT = 100;
var PRESSURE_BUILD_DEEP_MILESTONE = 95;

function pressureBuildMilestoneReached(setTarget, liveMmHg) {
    var setN = parseFloat(setTarget);
    var liveN = parseFloat(liveMmHg);
    if (isNaN(setN) || isNaN(liveN)) return false;
    if (setN > PRESSURE_BUILD_DEEP_SETPOINT) return liveN >= PRESSURE_BUILD_DEEP_MILESTONE;
    return liveN >= setN;
}

function clearPressureBuildWatchdog() {
    if (window._pressureBuildWatchdogPollId != null) {
        clearInterval(window._pressureBuildWatchdogPollId);
        window._pressureBuildWatchdogPollId = null;
    }
    window._pressureBuildWatchdogOpts = null;
    window._pressureBuildWatchdogStartedAt = null;
}

/**
 * After START: within 60s, live must reach milestone.
 * set > 100 → live >= 95; set <= 100 → live >= set.
 * Clears automatically when hold starts / inactive / milestone reached.
 */
function startPressureBuildWatchdog(opts) {
    clearPressureBuildWatchdog();
    opts = opts || {};
    if (opts.getSetTarget == null || opts.getLive == null || typeof opts.onFail !== 'function') return;
    window._pressureBuildWatchdogOpts = opts;
    window._pressureBuildWatchdogStartedAt = Date.now();
    window._pressureBuildWatchdogPollId = setInterval(function () {
        var o = window._pressureBuildWatchdogOpts;
        if (!o) {
            clearPressureBuildWatchdog();
            return;
        }
        if (typeof o.isActive === 'function' && !o.isActive()) {
            clearPressureBuildWatchdog();
            return;
        }
        var setT = o.getSetTarget();
        var live = o.getLive();
        if (pressureBuildMilestoneReached(setT, live)) {
            clearPressureBuildWatchdog();
            return;
        }
        var started = window._pressureBuildWatchdogStartedAt || 0;
        if (Date.now() - started < PRESSURE_BUILD_WATCH_MS) return;
        clearPressureBuildWatchdog();
        if (typeof o.isActive === 'function' && !o.isActive()) return;
        if (pressureBuildMilestoneReached(o.getSetTarget(), o.getLive())) return;
        try {
            o.onFail();
        } catch (e) {
            console.error('pressure build watchdog onFail', e);
        }
    }, 1000);
}
window.clearPressureBuildWatchdog = clearPressureBuildWatchdog;
window.startPressureBuildWatchdog = startPressureBuildWatchdog;
window.pressureBuildMilestoneReached = pressureBuildMilestoneReached;

function recipeExpectedAdapterKind(recipe) {
    if (!recipe) return null;
    var mode = String(recipe.uspMode || '').toUpperCase();
    if (mode === 'VACUUM_DECAY') return 'usp1';
    if (mode === 'PRESSURE_DECAY') return 'usp2';
    if (mode === 'CUSTOM') {
        var dh = null;
        if (recipe.steps && recipe.steps[0] && recipe.steps[0].dropHeight != null) {
            dh = parseFloat(recipe.steps[0].dropHeight);
        } else if (recipe.dropHeight != null) {
            dh = parseFloat(recipe.dropHeight);
        }
        if (dh == null || isNaN(dh)) return 'usp1';
        return dh <= 5 ? 'usp2' : 'usp1';
    }
    var usp = String(recipe.usp || '').toLowerCase();
    if (usp.indexOf('usp 2') >= 0 || usp.indexOf('usp2') >= 0) return 'usp2';
    if (usp.indexOf('custom') >= 0) {
        var dh2 = null;
        if (recipe.steps && recipe.steps[0] && recipe.steps[0].dropHeight != null) {
            dh2 = parseFloat(recipe.steps[0].dropHeight);
        } else if (recipe.dropHeight != null) {
            dh2 = parseFloat(recipe.dropHeight);
        }
        if (dh2 == null || isNaN(dh2)) return 'usp1';
        return dh2 <= 5 ? 'usp2' : 'usp1';
    }
    return 'usp1';
}


function validationExpectedAdapterKind() {
    return lastValidationType === 'load' ? 'usp2' : 'usp1';
}

function validationAdapterLabel() {
    return lastValidationType === 'load' ? 'Pressure Decay' : 'Vacuum Decay';
}

function validationHolderLabel() {
    return validationAdapterLabel();
}

function testHolderLabelForRecipe(recipe) {
    var expected = recipeExpectedAdapterKind(recipe);
    return expected === 'usp2' ? 'Pressure Decay' : 'Vacuum Decay';
}

function verifyValidationAdapter() {
    var expected = validationExpectedAdapterKind();
    return apiRequest(API_BASE + '/api/hardware/adapter/check', { method: 'POST' }).then(function (checkRes) {
        if (!checkRes || checkRes.ok === false) {
            return { ok: false, expected: expected, detected: null };
        }
        var detected = detectedAdapterKindFromCheckResult(checkRes);
        if (!detected || detected === 'error') {
            return { ok: false, expected: expected, detected: detected || 'none' };
        }
        return { ok: detected === expected, expected: expected, detected: detected };
    }).catch(function () {
        return { ok: false, expected: expected, detected: null };
    });
}

function showValidationAdapterCheckModal(extra) {
    logValidationAdapterError(extra);
    var kind = validationExpectedAdapterKind();
    var title = adapterErrorTitleForValidation();
    var body = kind === 'usp2'
        ? 'Please check the adaptor and holder. Fit the correct Pressure Decay holder on the instrument, then try again.'
        : 'Holder error. Fit the correct Vacuum Decay holder on the instrument, then try again.';
    showAppModal(body, title);
}

function _validationErrorIsAdapterRelated(msg) {
    var s = String(msg || '').toLowerCase();
    return s.indexOf('holder') >= 0 || s.indexOf('adapter') >= 0 || s.indexOf('adapt,') >= 0 || s.indexOf('adapt_') >= 0;
}

function detectedAdapterKindFromCheckResult(result) {
    if (!result || result.ok === false) return null;
    var s = String(result.normalized != null ? result.normalized : (result.response || '')).toLowerCase();
    if (s.indexOf('adapt') >= 0 && s.indexOf('error') >= 0) return 'error';
    if (s.indexOf('usp1') >= 0 && (s.indexOf('ok') >= 0 || s.indexOf('ready') >= 0)) return 'usp1';
    if (s.indexOf('usp2') >= 0 && (s.indexOf('ok') >= 0 || s.indexOf('ready') >= 0)) return 'usp2';
    return null;
}

function stepSpeedToSpdMode(speed) {
    var n = parseInt(speed, 10);
    if (n === 300) return 'spd1';
    if (n === 250) return 'spd2';
    return null;
}

function recipeDropHeightMm(recipe, step) {
    if (step && step.dropHeight != null && step.dropHeight !== '') {
        var d = parseFloat(step.dropHeight);
        if (!isNaN(d)) return d;
    }
    if (recipe && recipe.dropHeight != null && recipe.dropHeight !== '') {
        var d2 = parseFloat(recipe.dropHeight);
        if (!isNaN(d2)) return d2;
    }
    if (recipe && recipe.steps && recipe.steps[0] && recipe.steps[0].dropHeight != null) {
        var d3 = parseFloat(recipe.steps[0].dropHeight);
        if (!isNaN(d3)) return d3;
    }
    return null;
}

/** Custom mode: hardware spd command must match drop-height adapter (3 mm → PRESSURE_DECAY, 14 mm → VACUUM_DECAY). */
function hardwareSpeedModeForRecipeStep(step, recipe) {
    var mode = String(recipe && recipe.uspMode ? recipe.uspMode : '').toUpperCase();
    if (mode !== 'CUSTOM') {
        return stepSpeedToSpdMode(getTestRunStepSpeed(step, recipe));
    }
    var dh = recipeDropHeightMm(recipe, step);
    if (dh != null && !isNaN(dh)) {
        return dh <= 5 ? 'spd2' : 'spd1';
    }
    return stepSpeedToSpdMode(getTestRunStepSpeed(step, recipe));
}

function isCustomRecipeMode(recipe) {
    if (!recipe) return false;
    var mode = String(recipe.uspMode || '').toUpperCase();
    if (mode === 'CUSTOM') return true;
    return String(recipe.usp || '').toLowerCase().indexOf('custom') >= 0;
}

function getTestRunStepSpeed(step, recipe) {
    if (step && step.speed != null && !isNaN(parseInt(step.speed, 10))) {
        return parseInt(step.speed, 10);
    }
    if (recipe && recipe.speed != null && !isNaN(parseInt(recipe.speed, 10))) {
        return parseInt(recipe.speed, 10);
    }
    var mode = String(recipe && recipe.uspMode ? recipe.uspMode : '').toUpperCase();
    if (mode === 'VACUUM_DECAY') return 300;
    if (mode === 'PRESSURE_DECAY') return 250;
    var usp = String(recipe && recipe.usp ? recipe.usp : '').toLowerCase();
    if (usp.indexOf('usp 2') >= 0 || usp.indexOf('usp2') >= 0) return 250;
    return 300;
}

function getTestRunStepTapTarget(stepIndex) {
    var step = testRunSteps[stepIndex];
    if (!step) return 0;
    return parseInt(step.tapCount, 10) || 0;
}

function updateTestRunTapDisplay(sessionCount) {
    var target = getTestRunStepTapTarget(testRunCurrentStepIndex);
    var session = parseInt(sessionCount, 10) || 0;
    var cumulative = (testRunStepTapsBase || 0) + session;
    testRunCurrentTapCount = cumulative;
    setRunCard('run-tap-count-card', String(cumulative));
    setRunCard('run-tap-count-of-card', 'of ' + target);
}

function verifyTestRunAdapter() {
    var recipe = lastTestRunRecipe;
    return apiRequest(API_BASE + '/api/hardware/adapter/check', { method: 'POST' }).then(function (checkRes) {
        if (!checkRes || checkRes.ok === false) return false;
        var expected = recipeExpectedAdapterKind(recipe);
        if (!expected) return true;
        var detected = detectedAdapterKindFromCheckResult(checkRes);
        if (!detected || detected === 'error') return false;
        if (detected === expected) return true;
        /* Custom: adapter must match drop height only (not VACUUM_DECAY/PRESSURE_DECAY procedure mode). */
        if (isCustomRecipeMode(recipe)) return false;
        return false;
    }).catch(function () {
        return false;
    });
}

function stopTestRunAdapterPoll() {
    if (testRunAdapterPollTimerId != null) {
        clearInterval(testRunAdapterPollTimerId);
        testRunAdapterPollTimerId = null;
    }
    testRunAdapterWaitActive = false;
    _adapterPollOkStreak = 0;
}

function pauseTestRunForAdapterInterrupt() {
    testRunStepTapsBase = Math.max(testRunStepTapsBase || 0, testRunCurrentTapCount || 0);
    testRunCurrentTapCount = testRunStepTapsBase;
    updateTestRunTapDisplay(0);

    if (_testRunHardwareTapListener && testRunHardwareEs) {
        try {
            testRunHardwareEs.removeEventListener('message', _testRunHardwareTapListener);
        } catch (e) {}
        _testRunHardwareTapListener = null;
    }
    hardwareLeakStopSilently();

    var holderKind = recipeExpectedAdapterKind(lastTestRunRecipe);
    setRunCard('run-status-text', adapterErrorTitleForKind(holderKind));
    setRunCard('run-status-subtext', holderKind === 'usp2'
        ? 'Check the adaptor and holder, then wait to resume'
        : 'Fit the correct Vacuum Decay holder to continue');

    if (testRunAdapterWaitActive) return;

    if (!_testRunAdapterInterruptAudited) {
        _testRunAdapterInterruptAudited = true;
        auditTestRunAutoAborted('Holder removed during test run', testRunCurrentStepIndex);
    }

    testRunAdapterWaitActive = true;
    _adapterPollOkStreak = 0;
    testRunAdapterPollTimerId = setInterval(function () {
        if (testRunButtonState !== 'abort' || _testRunStepResumeInFlight) return;
        verifyTestRunAdapter().then(function (ok) {
            if (ok) {
                _adapterPollOkStreak++;
                if (_adapterPollOkStreak >= 2) {
                    resumeTestRunAfterAdapter();
                }
            } else {
                _adapterPollOkStreak = 0;
            }
        });
    }, 1500);
}

function resumeTestRunAfterAdapter() {
    if (_testRunStepResumeInFlight) return;
    _testRunStepResumeInFlight = true;
    stopTestRunAdapterPoll();

    setRunCard('run-status-text', 'Running');
    setRunCard('run-status-subtext', 'Resuming taps…');

    verifyTestRunAdapter().then(function (ok) {
        if (!ok) {
            _testRunStepResumeInFlight = false;
            pauseTestRunForAdapterInterrupt();
            return;
        }
        return runTestRunHardwareStep(testRunCurrentStepIndex, { resume: true });
    }).catch(function (err) {
        if (err && err.message === 'adapter_interrupt') return;
        var msg = err && err.message ? String(err.message) : 'Hardware error';
        auditTestRunAutoAborted(msg, testRunCurrentStepIndex);
        showAppModal('Test run failed: ' + msg, 'Test Run');
        hardwareLeakStopSilently();
        _closeTestRunHardwareEs();
        _testRunRevertUiToStartAfterHardwareFail();
    }).finally(function () {
        _testRunStepResumeInFlight = false;
    });
}

function _testRunFinishStepVolumeAndResults(stepIndex) {
    return askVolumeForStep(stepIndex).then(function (vol) {
        if (vol === null || vol === '') {
            showAppModal('Enter the volume in ml to record results for this step.', 'Volume');
            return _testRunFinishStepVolumeAndResults(stepIndex);
        }
        var curr = parseFloat(vol);
        if (isNaN(curr) || curr <= 0) {
            showAppModal('Please enter a valid volume in ml greater than 0.', 'Volume');
            return _testRunFinishStepVolumeAndResults(stepIndex);
        }
        var volDecreaseCheck = validateTestRunVolumeNotIncreasing(curr);
        if (!volDecreaseCheck.ok) {
            showAppModal(volDecreaseCheck.message, 'Volume');
            return _testRunFinishStepVolumeAndResults(stepIndex);
        }

        var prev = testRunPreviousVolumeMl;
        testRunLastStepPreviousMl = prev;
        testRunLastStepCurrentMl = curr;
        if (prev != null && !isNaN(prev)) {
            testRunLastStepVolumeDeltaMl = prev - curr;
        } else {
            testRunLastStepVolumeDeltaMl = null;
        }
        testRunPreviousVolumeMl = curr;

        var initialVol = (testRunInitialVolumeMl != null && !isNaN(testRunInitialVolumeMl))
            ? testRunInitialVolumeMl
            : parseFloat(testRunStepVolumes[0]);
        var bulkD = computeBulkDensityGPerMl(testRunInitialWeightG, initialVol);
        var tapD = computeTapDensityGPerMl(testRunInitialWeightG, testRunStepVolumes[testRunCurrentStepIndex]);
        setRunCard('run-bulk-density', _formatDensity(bulkD));
        setRunCard('run-tap-density', _formatDensity(tapD));
        _pendingStepVolumeDeltaMl = testRunLastStepVolumeDeltaMl;
        recordCurrentStepResult();
        _pendingStepVolumeDeltaMl = null;
        testRunStepTapsBase = 0;
        return true;
    }).then(function (ok) {
        if (!ok) return;
        var isLastStep = (stepIndex + 1) >= testRunTotalSteps;
        showTestRunStepCompleteModal(isLastStep);
    });
}

function _testRunRevertUiToStartAfterHardwareFail() {
    stopTestRunAdapterPoll();
    testRunStepTapsBase = 0;
    testRunButtonState = 'start';
    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.disabled = false;
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }
    var statusText = document.getElementById('run-status-text');
    var statusSubtext = document.getElementById('run-status-subtext');
    if (statusText) statusText.textContent = 'Ready';
    if (statusSubtext) statusSubtext.textContent = 'Waiting to start';
    _closeTestRunHardwareEs();
}

function waitForHardwareTapSequence(remainingTaps, speedMode, opts) {
    opts = opts || {};
    var baseCompleted = opts.baseCompleted != null ? opts.baseCompleted : (testRunStepTapsBase || 0);
    return new Promise(function (resolve, reject) {
        if (!testRunHardwareEs) {
            reject(new Error('Hardware stream not connected.'));
            return;
        }
        var tapGoal = Math.max(1, parseInt(remainingTaps, 10) || 1);
        var handler = function (ev) {
            try {
                var raw = ev.data;
                if (raw == null || raw === '') return;
                var data = JSON.parse(raw);
                if (data.ping) return;
                var kind = String(data.kind || '');
                var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
                var lineStr = String(data.line != null ? data.line : '').trim();
                if (kind === 'ok' || norm === 'ok') return;
                if (kind === 'progress' || /^\d+$/.test(norm)) {
                    var n = parseInt(norm || lineStr, 10);
                    if (!isNaN(n) && n >= 0) {
                        updateTestRunTapDisplay(n);
                    }
                }
                if (kind === 'completed' || norm === 'completed' || norm === 'complete.') {
                    if (testRunHardwareEs) {
                        testRunHardwareEs.removeEventListener('message', handler);
                    }
                    if (_testRunHardwareTapListener === handler) {
                        _testRunHardwareTapListener = null;
                    }
                    testRunCurrentTapCount = baseCompleted + tapGoal;
                    updateTestRunTapDisplay(tapGoal);
                    resolve();
                    return;
                }
                if (kind === 'adapter_error') {
                    if (testRunHardwareEs) {
                        testRunHardwareEs.removeEventListener('message', handler);
                    }
                    if (_testRunHardwareTapListener === handler) {
                        _testRunHardwareTapListener = null;
                    }
                    reject(new Error('adapter_interrupt'));
                    return;
                }
                if (kind === 'error') {
                    if (testRunHardwareEs) {
                        testRunHardwareEs.removeEventListener('message', handler);
                    }
                    if (_testRunHardwareTapListener === handler) {
                        _testRunHardwareTapListener = null;
                    }
                    reject(new Error(lineStr || norm || 'Hardware reported an error.'));
                }
            } catch (ex) {
                // ignore malformed SSE payloads
            }
        };
        _testRunHardwareTapListener = handler;
        testRunHardwareEs.addEventListener('message', handler);
        apiRequest(API_BASE + '/api/hardware/leak/start', {
            method: 'POST',
            body: { speedMode: speedMode, tapCount: tapGoal }
        }).then(function (res) {
            if (!res || res.ok === false) {
                if (testRunHardwareEs) {
                    testRunHardwareEs.removeEventListener('message', handler);
                }
                if (_testRunHardwareTapListener === handler) {
                    _testRunHardwareTapListener = null;
                }
                reject(new Error((res && res.error) ? String(res.error) : 'Tap start rejected by device.'));
            }
        }).catch(function (err) {
            if (testRunHardwareEs) {
                testRunHardwareEs.removeEventListener('message', handler);
            }
            if (_testRunHardwareTapListener === handler) {
                _testRunHardwareTapListener = null;
            }
            reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
}

function runTestRunHardwareStep(stepIndex, opts) {
    opts = opts || {};
    if (stepIndex < 0 || stepIndex >= testRunTotalSteps) return Promise.resolve();
    var recipe = lastTestRunRecipe;
    var step = testRunSteps[stepIndex];
    if (!step) return Promise.reject(new Error('Invalid step.'));

    testRunCurrentStepIndex = stepIndex;
    var speedMode = hardwareSpeedModeForRecipeStep(step, recipe);
    var target = getTestRunStepTapTarget(stepIndex);
    if (!speedMode) {
        return Promise.reject(new Error('Unsupported step speed for hardware (use 300 or 250 taps/min).'));
    }
    if (target < 1) {
        return Promise.reject(new Error('Invalid hold time for this step.'));
    }

    if (!opts.resume) {
        testRunStepTapsBase = 0;
    }

    var remaining = target - (testRunStepTapsBase || 0);

    setRunCard('run-current-step-card', String(stepIndex + 1));
    setRunCard('run-tap-count-of-card', 'of ' + target);
    updateTestRunTapDisplay(0);

    if (opts.resume) {
        setRunCard('run-status-text', 'Running');
        setRunCard('run-status-subtext', 'Test in progress');
    }

    if (remaining <= 0) {
        return _testRunFinishStepVolumeAndResults(stepIndex);
    }

    return waitForHardwareTapSequence(remaining, speedMode, { baseCompleted: testRunStepTapsBase })
        .then(function () {
            return _testRunFinishStepVolumeAndResults(stepIndex);
        })
        .catch(function (err) {
            if (err && err.message === 'adapter_interrupt') {
                pauseTestRunForAdapterInterrupt();
                return;
            }
            return Promise.reject(err);
        });
}

function runTestRunHardwareOrchestration() {
    var steps = getTestRunSteps();
    if (!steps || steps.length === 0) return;
    testRunSteps = steps;
    testRunTotalSteps = steps.length;
    testRunCurrentStepIndex = 0;
    testRunCurrentTapCount = 0;
    testRunStepTapsBase = 0;
    stopTestRunAdapterPoll();
    testRunStepResults = [];
    renderTestRunResultsTable();

    _closeTestRunHardwareEs();
    try {
        testRunHardwareEs = new EventSource(_getHardwareSseUrl());
    } catch (esErr) {
        showAppModal('Could not connect to the hardware stream. Check the server and try again.', 'Test Run');
        _testRunRevertUiToStartAfterHardwareFail();
        return;
    }

    runTestRunHardwareStep(0).catch(function (err) {
        if (err && err.message === 'adapter_interrupt') return;
        hardwareLeakStopSilently();
        _closeTestRunHardwareEs();
        if (err && err.message === 'adapter') return;
        var msg = err && err.message ? String(err.message) : 'Hardware error';
        auditTestRunAutoAborted(msg, testRunCurrentStepIndex);
        showAppModal('Test run failed: ' + msg, 'Test Run');
        _testRunRevertUiToStartAfterHardwareFail();
    });
}

function getMaxSampleVolumeMl(recipe) {
    if (!recipe) return null;
    if (recipe.sampleVolumeMl != null && recipe.sampleVolumeMl !== '') {
        var n = parseFloat(recipe.sampleVolumeMl);
        return isNaN(n) ? null : n;
    }
    if (recipe.cylinder && (recipe.cylinder.volume != null || recipe.cylinder.volumeMl != null)) {
        var v = recipe.cylinder.volume != null ? recipe.cylinder.volume : recipe.cylinder.volumeMl;
        var n2 = parseFloat(v);
        return isNaN(n2) ? null : n2;
    }
    return null;
}

/** Allow digits and a single decimal point while the operator is typing (e.g. "12."). */
function sanitizeDecimalInputString(raw) {
    var s = String(raw == null ? '' : raw).replace(/,/g, '.');
    var cleaned = '';
    var seenDot = false;
    for (var i = 0; i < s.length; i++) {
        var c = s[i];
        if (c >= '0' && c <= '9') {
            cleaned += c;
        } else if (c === '.' && !seenDot) {
            cleaned += '.';
            seenDot = true;
        }
    }
    return cleaned;
}

function attachDecimalInputHandlers(input) {
    if (!input || input._decimalInputBound) return;
    input._decimalInputBound = true;
    input.addEventListener('input', function () {
        var el = input;
        var before = el.value;
        var after = sanitizeDecimalInputString(before);
        if (after === before) return;
        var pos = (typeof el.selectionStart === 'number') ? el.selectionStart : after.length;
        el.value = after;
        var nextPos = Math.min(pos, after.length);
        try {
            el.setSelectionRange(nextPos, nextPos);
        } catch (e) {}
    });
}

function bindTestRunDecimalInputs() {
    ['test-run-volume-input', 'test-run-initial-weight-input'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) attachDecimalInputHandlers(el);
    });
}

function _formatDensity(n) {
    if (n == null || isNaN(n)) return '--';
    return String(Math.round(n * 1000) / 1000);
}

function computeBulkDensityGPerMl(weightG, initialVolMl) {
    var w = parseFloat(weightG);
    var v = parseFloat(initialVolMl);
    if (isNaN(w) || isNaN(v) || v <= 0) return null;
    return w / v;
}

function computeTapDensityGPerMl(weightG, finalTappedVolMl) {
    var w = parseFloat(weightG);
    var v = parseFloat(finalTappedVolMl);
    if (isNaN(w) || isNaN(v) || v <= 0) return null;
    return w / v;
}

function _parseReportDensityNumber(val) {
    if (val == null || val === '' || val === '--') return null;
    var n = parseFloat(String(val).replace(/,/g, ''));
    return isNaN(n) ? null : n;
}

function _aggMeanMinMax(values) {
    if (!values || !values.length) return null;
    var sum = 0;
    var min = values[0];
    var max = values[0];
    for (var i = 0; i < values.length; i++) {
        sum += values[i];
        if (values[i] < min) min = values[i];
        if (values[i] > max) max = values[i];
    }
    return {
        mean: Math.round((sum / values.length) * 1000) / 1000,
        min: Math.round(min * 1000) / 1000,
        max: Math.round(max * 1000) / 1000
    };
}

/** Option A statistics for completed test reports; null if aborted or no step data. */
function computeTestReportStatistics(testData) {
    if (!testData || typeof testData !== 'object') return null;
    if (String(testData.status || '').trim().toLowerCase() === 'aborted') return null;
    var results = testData.stepResults || [];
    if (!results.length) return null;

    var bulkVals = [];
    var tapVals = [];
    for (var i = 0; i < results.length; i++) {
        var r = results[i] || {};
        var b = _parseReportDensityNumber(r.bulkDensity);
        var t = _parseReportDensityNumber(r.tapDensity);
        if (b != null) bulkVals.push(b);
        if (t != null) tapVals.push(t);
    }

    var stats = {};
    var bulkAgg = _aggMeanMinMax(bulkVals);
    var tapAgg = _aggMeanMinMax(tapVals);
    if (bulkAgg) stats['Bulk density (g/mL)'] = bulkAgg;
    if (tapAgg) stats['Tap density (g/mL)'] = tapAgg;

    var last = results[results.length - 1] || {};
    var bulkF = _parseReportDensityNumber(last.bulkDensity);
    var tapF = _parseReportDensityNumber(last.tapDensity);
    if (bulkF == null && bulkVals.length) bulkF = bulkVals[0];
    if (tapF == null && tapVals.length) tapF = tapVals[tapVals.length - 1];
    if (bulkF != null && tapF != null && tapF > 0 && bulkF > 0) {
        stats['Compressibility index (%)'] = {
            value: Math.round(((tapF - bulkF) / tapF) * 10000) / 100
        };
        stats['Hausner ratio'] = { value: Math.round((tapF / bulkF) * 1000) / 1000 };
    }
    return Object.keys(stats).length ? stats : null;
}

function isTestRunInitialVolumeEntry() {
    return testRunButtonState === 'start';
}

function validateTestRunVolumeNotIncreasing(volumeMl) {
    if (isTestRunInitialVolumeEntry()) {
        return { ok: true };
    }
    var prev = testRunPreviousVolumeMl;
    if (prev == null || isNaN(prev)) {
        return { ok: true };
    }
    var num = parseFloat(volumeMl);
    if (isNaN(num)) {
        return { ok: true };
    }
    if (num > prev) {
        return {
            ok: false,
            message: 'Please check the value entered. The volume cannot increase.'
        };
    }
    return { ok: true };
}

function askVolumeForStep(stepIndex) {
    return openTestRunVolumeModal(stepIndex).then(function (vol) {
        if (vol === null || vol === '') return null;
        var num = parseFloat(vol);
        if (!isNaN(num)) testRunStepVolumes[stepIndex] = num;
        else testRunStepVolumes[stepIndex] = vol;
        return vol;
    });
}

function openTestRunInitialWeightModal() {
    return new Promise(function (resolve) {
        _testRunInitialWeightResolve = resolve;
        var overlay = document.getElementById('test-run-initial-weight-overlay');
        var input = document.getElementById('test-run-initial-weight-input');

        if (!overlay || !input) {
            while (true) {
                var w = window.prompt('Enter initial weight in before starting the test:', '');
                if (w === null || String(w).trim() === '') {
                    resolve(null);
                    return;
                }
                var n = parseFloat(w);
                if (isNaN(n) || n <= 0) {
                    window.alert('Please enter a valid initial weight greater than 0.');
                    continue;
                }
                resolve(String(w).trim());
                return;
            }
        }

        input.value = '';
        attachDecimalInputHandlers(input);
        overlay.style.display = 'flex';
        setTimeout(function () {
            try {
                input.focus();
                if (typeof window.openOSKForInput === 'function') window.openOSKForInput(input);
            } catch (e) {}
        }, 0);

        if (!input._initialWeightKeydownHandler) {
            input._initialWeightKeydownHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmTestRunInitialWeight();
                }
            };
            input.addEventListener('keydown', input._initialWeightKeydownHandler);
        }
    });
}

function confirmTestRunInitialWeight() {
    var overlay = document.getElementById('test-run-initial-weight-overlay');
    var input = document.getElementById('test-run-initial-weight-input');
    var val = input ? String(input.value || '').trim() : '';

    if (val === '') {
        if (overlay) overlay.style.display = 'none';
        if (typeof window.closeOSK === 'function') window.closeOSK();
        if (!_testRunInitialWeightResolve) return;
        var r0 = _testRunInitialWeightResolve;
        _testRunInitialWeightResolve = null;
        r0(null);
        return;
    }

    var num = parseFloat(val);
    if (isNaN(num) || num <= 0) {
        showAppModal('Please enter a valid initial weight greater than 0.', 'Sample ID (gm)');
        if (input) input.select();
        return;
    }

    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunInitialWeightResolve) return;
    var r = _testRunInitialWeightResolve;
    _testRunInitialWeightResolve = null;
    r(val);
}

function cancelTestRunInitialWeight() {
    var overlay = document.getElementById('test-run-initial-weight-overlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunInitialWeightResolve) return;
    var r = _testRunInitialWeightResolve;
    _testRunInitialWeightResolve = null;
    r(null);
}

var _testRunVolumeResolve = null;
var _testRunVolumeStepIndex = 0;

function openTestRunVolumeModal(stepIndex) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('test-run-volume-overlay');
        var titleEl = document.getElementById('test-run-volume-title');
        var msgEl = document.getElementById('test-run-volume-message');
        var input = document.getElementById('test-run-volume-input');

        _testRunVolumeResolve = resolve;
        _testRunVolumeStepIndex = stepIndex;

        var displayStep = stepIndex + 1;
        var maxMl = getMaxSampleVolumeMl(lastTestRunRecipe);
        var message = 'Enter volume in ml for step ' + displayStep + ':';
        if (maxMl != null) {
            message = 'Enter volume in ml for step ' + displayStep + ' (max ' + maxMl + ' ml):';
        }

        if (!overlay || !titleEl || !msgEl || !input) {
            // Fallback if modal markup not available
            while (true) {
                var vol = window.prompt(message, '');
                if (vol === null || String(vol).trim() === '') {
                    resolve(null);
                    return;
                }
                var num = parseFloat(vol);
                if (isNaN(num) || num <= 0) {
                    window.alert('Please enter a valid volume in ml greater than 0.');
                    continue;
                }
                if (maxMl != null && num > maxMl) {
                    window.alert('Volume in ml cannot exceed cylinder size (' + maxMl + ' ml).');
                    continue;
                }
                var volCheck = validateTestRunVolumeNotIncreasing(num);
                if (!volCheck.ok) {
                    window.alert(volCheck.message);
                    continue;
                }
                resolve(String(vol).trim());
                return;
            }
        }

        titleEl.textContent = 'VOLUME IN ML - STEP ' + (stepIndex + 1);
        msgEl.textContent = message;
        input.value = '';
        attachDecimalInputHandlers(input);
        overlay.style.display = 'flex';

        setTimeout(function () {
            try {
                input.focus();
                if (typeof window.openOSKForInput === 'function') window.openOSKForInput(input);
            } catch (e) {}
        }, 0);

        if (!input._volumeKeydownHandler) {
            input._volumeKeydownHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    confirmTestRunVolume();
                }
            };
            input.addEventListener('keydown', input._volumeKeydownHandler);
        }
    });
}

function confirmTestRunVolume() {
    var overlay = document.getElementById('test-run-volume-overlay');
    var input = document.getElementById('test-run-volume-input');
    var val = input ? String(input.value || '').trim() : '';

    if (val === '') {
        showAppModal('Enter the volume in ml to record results for this step.', 'Volume');
        if (input) input.focus();
        return;
    }

    var num = parseFloat(val);
    if (isNaN(num)) {
        showAppModal('Please enter a valid number for volume in ml.', 'Volume');
        if (input) input.select();
        return;
    }
    if (num <= 0) {
        showAppModal('Volume in ml must be greater than 0.', 'Volume');
        if (input) input.select();
        return;
    }

    var maxMl = getMaxSampleVolumeMl(lastTestRunRecipe);
    if (maxMl != null && num > maxMl) {
        showAppModal('Volume in ml cannot exceed cylinder size (' + maxMl + ' ml).', 'Volume');
        if (input) input.select();
        return;
    }

    var decreasingCheck = validateTestRunVolumeNotIncreasing(num);
    if (!decreasingCheck.ok) {
        showAppModal(decreasingCheck.message, 'Volume');
        if (input) input.select();
        return;
    }

    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunVolumeResolve) return;
    var r = _testRunVolumeResolve;
    _testRunVolumeResolve = null;
    r(val);
}

function cancelTestRunVolume() {
    var overlay = document.getElementById('test-run-volume-overlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof window.closeOSK === 'function') window.closeOSK();
    if (!_testRunVolumeResolve) return;
    var r = _testRunVolumeResolve;
    _testRunVolumeResolve = null;
    r(null);
}

function startTestRun(recipe) {
    if (!recipe) return;
    lastTestRunRecipe = recipe;
    var recipeId = recipe.id || recipe.recipeId || '';
    var isQuick = isQuickTestRecipe(recipe);
    logAuditEvent(
        isQuick ? 'Quick test loaded' : 'Recipe test loaded',
        formatTestAuditDetails(recipe),
        {
        eventType: 'lifecycle',
        entityType: 'recipe',
        entityName: recipe.productName || '',
        entityId: recipeId,
            extra: testAuditExtra(recipe)
        }
    );

    var vacuumMmHg = parseFloat(recipe.vacuumMmHg);
    if (isNaN(vacuumMmHg)) vacuumMmHg = null;
    var durationSec = parseInt(recipe.durationSec, 10);
    if (isNaN(durationSec) || durationSec <= 0) durationSec = null;
    var durationDisplay = recipe.durationDisplay
        || (durationSec != null && typeof formatMmSs === 'function' ? formatMmSs(durationSec) : '--');

    testRunSetVacuumMmHg = vacuumMmHg;
    testRunSetDurationSec = durationSec;
    testRunSetDurationDisplay = durationDisplay;
    testRunCurrentVacuumMmHg = null;
    testRunElapsedSec = 0;
    testRunResultText = null;
    testRunHoldStarted = false;
    testRunVacuumSamples = [];
    testRunNextSamplePercent = 10;
    testRunStartTime = null;
    testRunHoldStartTime = null;
    testRunBuildDurationSec = null;
    testRunButtonState = 'start';

    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    _closeTestRunHardwareEs();

    function setText(id, value) {
        var el = document.getElementById(id);
        if (el) el.textContent = value;
    }
    setText('run-product-name', recipe.productName || '--');
    setText('run-batch-no', recipe.batchNumber || '--');
    setText('run-product-type', recipe.productType || '--');
    setText('run-no-of-samples',
        (recipe.noOfSamples != null && !isNaN(parseInt(recipe.noOfSamples, 10)))
            ? String(parseInt(recipe.noOfSamples, 10))
            : '--');
    var arEl = document.getElementById('run-analysis-no');
    var arWrap = document.getElementById('run-analysis-no-wrap');
    var arDot = document.getElementById('run-analysis-no-dot');
    var arNo = (typeof resolveAnalysisReportNo === 'function')
        ? resolveAnalysisReportNo(recipe, null)
        : (recipe.analysisReportNo ? String(recipe.analysisReportNo) : '');
    if (arEl) arEl.textContent = arNo || '--';
    if (arWrap) arWrap.style.display = arNo ? '' : 'none';
    if (arDot) arDot.style.display = arNo ? '' : 'none';
    setText('run-set-vacuum', vacuumMmHg != null ? String(vacuumMmHg) : '--');
    setText('run-set-vacuum-live', vacuumMmHg != null ? String(vacuumMmHg) : '--');
    setText('run-set-time', durationDisplay);
    setText('run-set-time-live', durationDisplay);
    setText('run-current-vacuum', '--');
    setText('run-elapsed-time', '00:00');
    setText('run-status-text', 'Ready');
    setText('run-status-subtext', 'Press Start to begin');

    var resultCard = document.getElementById('test-run-result-card');
    if (resultCard) resultCard.hidden = true;
    _resetTestRunButtonToStart();

    goToPage('test-run');
}

function _resetTestRunButtonToStart() {
    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-test-run-label">Start</span>';
    }
    testRunButtonState = 'start';
}

function _testRunSseUrl() {
    return (typeof _getHardwareSseUrl === 'function') ? _getHardwareSseUrl() : (API_BASE + '/api/hardware/stream');
}

function _parseTestRunSseLine(data) {
    var raw = String(data.normalized != null ? data.normalized : data.line || '');
    var norm = raw.replace(/^#/, '').replace(/\*$/, '');
    var out = {};
    if (norm.indexOf(':') >= 0 && norm.indexOf(',') < 0) {
        var head = norm.split(':');
        out[head[0].trim().toLowerCase()] = head.slice(1).join(':').trim();
    }
    norm.split(',').forEach(function (part) {
        var kv = part.split(':');
        if (kv.length >= 2) out[kv[0].trim().toLowerCase()] = kv.slice(1).join(':').trim();
    });
    return out;
}

function _startTestRunHoldAfterTarget() {
    if (testRunHoldStarted || testRunButtonState !== 'abort') return;
    if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
    testRunHoldStarted = true;
    if (!testRunHoldStartTime) testRunHoldStartTime = new Date().toISOString();
    _freezeTestRunBuildDurationSec();
    testRunElapsedSec = 0;
    testRunVacuumSamples = [];
    testRunNextSamplePercent = 10;
    setRunCard('run-status-text', 'Holding vacuum');
    setRunCard('run-status-subtext', 'Hold in progress');
    setRunCard('run-elapsed-time', '00:00');
    if (testRunIntervalId != null) clearInterval(testRunIntervalId);
    testRunIntervalId = setInterval(_testRunTimerTick, 1000);
}

function _openTestRunHardwareStream() {
    _closeTestRunHardwareEs();
    try {
        testRunHardwareEs = new EventSource(_testRunSseUrl());
    } catch (e) {
        testRunHardwareEs = null;
        _startTestRunPressurePoll();
        return;
    }
    _testRunHardwareTapListener = function (ev) {
        if (testRunButtonState !== 'abort') return;
        try {
            var raw = ev.data;
            if (raw == null || raw === '') return;
            var data = JSON.parse(raw);
            if (data.ping) return;
            var kind = String(data.kind || '');
            var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/^#/, '').replace(/\*$/, '');
            var parsed = _parseTestRunSseLine(data);
            if (norm === 'target_reached' || norm.indexOf('target_reached') >= 0) {
                _startTestRunHoldAfterTarget();
            }
            var vac = parsed.su != null ? parsed.su : (parsed.vacuum != null ? parsed.vacuum : parsed.pressure);
            if (vac != null) {
                var v = parseFloat(vac);
                if (!isNaN(v)) _applyLiveTestRunPressure(v);
            }
            // Hold is owned by the Pi timer; ignore ESP idle/auto-complete.
            if (kind === 'error' || kind === 'adapter_error') {
                _abortTestRunVacuumHoldWithError(norm || 'Unknown');
            }
        } catch (ex) { /* ignore */ }
    };
    testRunHardwareEs.addEventListener('message', _testRunHardwareTapListener);
    _startTestRunPressurePoll();
}

function _maybeRecordHoldVacuumSample(force) {
    if ((!testRunHoldStarted && !force) || testRunSetDurationSec == null || testRunSetDurationSec <= 0) return;
    while (testRunNextSamplePercent <= 100) {
        var neededSec = (testRunNextSamplePercent / 100) * testRunSetDurationSec;
        if (testRunElapsedSec + 1e-6 < neededSec) break;
        var vac = (testRunCurrentVacuumMmHg != null && !isNaN(testRunCurrentVacuumMmHg))
            ? testRunCurrentVacuumMmHg
            : null;
        var elapsedAtSample = Math.min(Math.max(testRunElapsedSec, Math.round(neededSec)), testRunSetDurationSec);
        testRunVacuumSamples.push({
            percent: testRunNextSamplePercent,
            elapsedSec: elapsedAtSample,
            timeDisplay: (typeof formatMmSs === 'function')
                ? formatMmSs(elapsedAtSample)
                : String(elapsedAtSample),
            vacuumMmHg: vac
        });
        testRunNextSamplePercent += 10;
    }
}

/** Ensure hold time is divided into 10 points (10% … 100%) for the report. */
function _ensureFinalHoldVacuumSample() {
    if (testRunSetDurationSec == null || testRunSetDurationSec <= 0) return;
    if (testRunElapsedSec < testRunSetDurationSec) {
        testRunElapsedSec = testRunSetDurationSec;
    }
    testRunNextSamplePercent = 10;
    var byPct = {};
    for (var i = 0; i < testRunVacuumSamples.length; i++) {
        var existing = testRunVacuumSamples[i];
        if (existing && existing.percent != null) byPct[existing.percent] = existing;
    }
    var filled = [];
    var lastVac = null;
    for (var pct = 10; pct <= 100; pct += 10) {
        if (byPct[pct]) {
            filled.push(byPct[pct]);
            if (byPct[pct].vacuumMmHg != null && !isNaN(byPct[pct].vacuumMmHg)) {
                lastVac = byPct[pct].vacuumMmHg;
            }
            continue;
        }
        var neededSec = Math.min(
            testRunSetDurationSec,
            Math.max(0, Math.round((pct / 100) * testRunSetDurationSec))
        );
        var vac = (testRunCurrentVacuumMmHg != null && !isNaN(testRunCurrentVacuumMmHg))
            ? testRunCurrentVacuumMmHg
            : lastVac;
        filled.push({
            percent: pct,
            elapsedSec: neededSec,
            timeDisplay: (typeof formatMmSs === 'function') ? formatMmSs(neededSec) : String(neededSec),
            vacuumMmHg: vac
        });
    }
    testRunVacuumSamples = filled;
    testRunNextSamplePercent = 110;
}

function _testRunTimerTick() {
    if (testRunButtonState !== 'abort' || !testRunHoldStarted) return;
    testRunElapsedSec++;
    setRunCard('run-elapsed-time', formatMmSs(testRunElapsedSec));
    _maybeRecordHoldVacuumSample();
    // 1s checkpoint heartbeat covers power-cut recovery; no extra 5s sync needed.
    if (testRunSetDurationSec != null && testRunElapsedSec >= testRunSetDurationSec) {
        _finishTestRunVacuumHold();
    }
}

function _computeTestRunResult() {
    if (testRunSetVacuumMmHg == null || testRunCurrentVacuumMmHg == null) return 'PASS';
    var tolerance = Math.max(5, testRunSetVacuumMmHg * 0.1);
    return (Math.abs(testRunCurrentVacuumMmHg - testRunSetVacuumMmHg) <= tolerance) ? 'PASS' : 'FAIL';
}

function _abortTestRunVacuumHoldWithError(msg) {
    if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
    if (typeof clearTestRunCheckpointHeartbeat === 'function') clearTestRunCheckpointHeartbeat();
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    testRunButtonState = 'start';
    testRunHoldStarted = false;
    hardwareLeakStopSilently();
    _closeTestRunHardwareEs();
    setRunCard('run-status-text', 'Error');
    setRunCard('run-status-subtext', 'Hardware error');
    _resetTestRunButtonToStart();
    showAppModal('Hardware error during test: ' + msg, 'Test Run');
}

function _abortTestRunPressureNotBuilding() {
    if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
    if (typeof clearTestRunCheckpointHeartbeat === 'function') clearTestRunCheckpointHeartbeat();
    // Idempotent: watchdog / STOP path must not spam audits if called twice.
    if (window._testRunLeakAbortInFlight) {
        var stopFnEarly = (typeof hardwareLeakStopUntilAck === 'function')
            ? hardwareLeakStopUntilAck
            : hardwareLeakStopAwait;
        return Promise.resolve(stopFnEarly()).catch(function () { return null; });
    }
    window._testRunLeakAbortInFlight = true;
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    testRunButtonState = 'start';
    testRunHoldStarted = false;
    _closeTestRunHardwareEs();
    if (typeof clearTestRunCheckpoint === 'function') clearTestRunCheckpoint();
    setRunCard('run-status-text', 'Error');
    setRunCard('run-status-subtext', 'Pressure not building');
    _resetTestRunButtonToStart();
    // Show modal immediately and keep sending STOP until ESP STOP_ACK.
    showAppModal('Check for leaks. Pressure not building', 'Test Run');
    try {
        if (typeof auditTestRunAbortedLeaksFound === 'function') {
            auditTestRunAbortedLeaksFound({
                setVacuumMmHg: testRunSetVacuumMmHg,
                liveVacuumMmHg: testRunCurrentVacuumMmHg
            });
        }
    } catch (auditErr) {
        console.error('leak abort audit failed', auditErr);
    }
    var stopFn = (typeof hardwareLeakStopUntilAck === 'function')
        ? hardwareLeakStopUntilAck
        : hardwareLeakStopAwait;
    return Promise.resolve(stopFn()).catch(function () { return null; }).finally(function () {
        window._testRunLeakAbortInFlight = false;
    });
}

function _finishTestRunVacuumHold() {
    if (testRunButtonState !== 'abort') return;
    if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
    if (typeof clearTestRunCheckpointHeartbeat === 'function') clearTestRunCheckpointHeartbeat();
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    var wasHolding = !!testRunHoldStarted;
    if (wasHolding) {
        _ensureFinalHoldVacuumSample();
    }
    testRunButtonState = 'start';
    testRunHoldStarted = false;
    // STOP is sent when the release lock starts (ESP vents on STOP) — not after the 80s UI ends.
    _closeTestRunHardwareEs();

    testRunResultText = _computeTestRunResult();
    setRunCard('run-status-text', 'Completed');
    setRunCard('run-status-subtext', 'Releasing pressure');
    var resultCard = document.getElementById('test-run-result-card');
    if (resultCard) resultCard.hidden = false;
    setRunCard('run-result', testRunResultText);
    var detailEl = document.getElementById('run-result-detail');
    if (detailEl) {
        detailEl.textContent = 'Vacuum ' + (testRunCurrentVacuumMmHg != null ? testRunCurrentVacuumMmHg.toFixed(1) : '--')
            + ' / ' + (testRunSetVacuumMmHg != null ? testRunSetVacuumMmHg : '--') + ' mmHg';
    }
    _resetTestRunButtonToStart();
    _postRunSessionHold = true;
    markAutoLogoutActivity();
    syncKioskScreenWakeLock();
    var releaseSec = (typeof getReleasePressureLockSec === 'function') ? getReleasePressureLockSec() : 80;
    showReleasePressureLock(releaseSec).then(function () {
        setRunCard('run-status-subtext', 'Saving report');
        saveTestRunReportAndGoToReportPreview();
    });
}

function applyQuickVacuumPreset(mmHg) {
    var vacEl = document.getElementById('quick-vacuum-mmhg');
    if (vacEl) vacEl.value = String(mmHg);
    syncQuickVacuumPreset();
}

function applyQuickTimePreset(mmss) {
    var timeEl = document.getElementById('quick-duration');
    if (timeEl) timeEl.value = String(mmss || '');
    syncQuickTimePreset();
}

function syncQuickVacuumPreset() {
    var vacEl = document.getElementById('quick-vacuum-mmhg');
    var val = vacEl ? parseFloat(vacEl.value) : NaN;
    document.querySelectorAll('.qt-preset-btn[data-vacuum]').forEach(function (btn) {
        var preset = parseFloat(btn.getAttribute('data-vacuum'));
        btn.classList.toggle('is-active', !isNaN(val) && val === preset);
    });
}

function syncQuickTimePreset() {
    var timeEl = document.getElementById('quick-duration');
    var val = timeEl ? String(timeEl.value || '').trim() : '';
    document.querySelectorAll('.qt-preset-btn[data-time]').forEach(function (btn) {
        btn.classList.toggle('is-active', val === String(btn.getAttribute('data-time') || ''));
    });
}

function applyRecipeVacuumPreset(mmHg) {
    var vacEl = document.getElementById('recipe-vacuum-mmhg');
    if (vacEl) vacEl.value = String(mmHg);
    syncRecipeVacuumPreset();
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function applyRecipeTimePreset(mmss) {
    var timeEl = document.getElementById('recipe-duration');
    if (timeEl) timeEl.value = String(mmss || '');
    syncRecipeTimePreset();
    if (typeof updateCreateRecipeContinueButton === 'function') updateCreateRecipeContinueButton();
}

function syncRecipeVacuumPreset() {
    var vacEl = document.getElementById('recipe-vacuum-mmhg');
    var val = vacEl ? parseFloat(vacEl.value) : NaN;
    document.querySelectorAll('.qt-preset-btn[data-recipe-vacuum]').forEach(function (btn) {
        var preset = parseFloat(btn.getAttribute('data-recipe-vacuum'));
        btn.classList.toggle('is-active', !isNaN(val) && val === preset);
    });
}

function syncRecipeTimePreset() {
    var timeEl = document.getElementById('recipe-duration');
    var val = timeEl ? String(timeEl.value || '').trim() : '';
    document.querySelectorAll('.qt-preset-btn[data-recipe-time]').forEach(function (btn) {
        btn.classList.toggle('is-active', val === String(btn.getAttribute('data-recipe-time') || ''));
    });
}

function syncCreateRecipeConsolePresets() {
    if (typeof syncRecipeVacuumPreset === 'function') syncRecipeVacuumPreset();
    if (typeof syncRecipeTimePreset === 'function') syncRecipeTimePreset();
}

function applyCreateRecipeFactoryPresets(settings) {
    var s = settings || {};
    var vacuumPresets = Array.isArray(s.recipeVacuumPresets) && s.recipeVacuumPresets.length === 3
        ? s.recipeVacuumPresets
        : [200, 400, 600];
    var timePresetsSec = Array.isArray(s.recipeTimePresetsSec) && s.recipeTimePresetsSec.length === 3
        ? s.recipeTimePresetsSec
        : [30, 60, 90];

    var vacuumButtons = document.querySelectorAll('.qt-preset-btn[data-recipe-vacuum]');
    vacuumButtons.forEach(function (btn, index) {
        var value = parseInt(vacuumPresets[index], 10);
        if (isNaN(value) || value < 1 || value > 650) value = [200, 400, 600][index];
        btn.setAttribute('data-recipe-vacuum', String(value));
        btn.textContent = String(value);
    });

    var quickVacuumButtons = document.querySelectorAll('.qt-preset-btn[data-vacuum]');
    quickVacuumButtons.forEach(function (btn, index) {
        var value = parseInt(vacuumPresets[index], 10);
        if (isNaN(value) || value < 1 || value > 650) value = [200, 400, 600][index];
        btn.setAttribute('data-vacuum', String(value));
        btn.textContent = String(value);
    });

    var timeButtons = document.querySelectorAll('.qt-preset-btn[data-recipe-time]');
    timeButtons.forEach(function (btn, index) {
        var seconds = parseInt(timePresetsSec[index], 10);
        if (isNaN(seconds) || seconds < 1) seconds = [30, 60, 90][index];
        var display = (typeof formatMmSs === 'function')
            ? formatMmSs(seconds)
            : String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        btn.setAttribute('data-recipe-time', display);
        btn.textContent = display;
    });

    var quickTimeButtons = document.querySelectorAll('.qt-preset-btn[data-time]');
    quickTimeButtons.forEach(function (btn, index) {
        var seconds = parseInt(timePresetsSec[index], 10);
        if (isNaN(seconds) || seconds < 1) seconds = [30, 60, 90][index];
        var display = (typeof formatMmSs === 'function')
            ? formatMmSs(seconds)
            : String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        btn.setAttribute('data-time', display);
        btn.textContent = display;
    });

    syncCreateRecipeConsolePresets();
    if (typeof syncQuickVacuumPreset === 'function') syncQuickVacuumPreset();
    if (typeof syncQuickTimePreset === 'function') syncQuickTimePreset();
}

function loadCreateRecipeFactoryPresets() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        if (!settings || typeof settings !== 'object') settings = {};
        // Preserve locally saved presets if API response is incomplete.
        try {
            var stored = localStorage.getItem('factorySettings');
            var local = stored ? JSON.parse(stored) : null;
            if (local && typeof local === 'object') {
                if (!Array.isArray(settings.recipeVacuumPresets) || settings.recipeVacuumPresets.length !== 3) {
                    if (Array.isArray(local.recipeVacuumPresets) && local.recipeVacuumPresets.length === 3) {
                        settings.recipeVacuumPresets = local.recipeVacuumPresets;
                    }
                }
                if (!Array.isArray(settings.recipeTimePresetsSec) || settings.recipeTimePresetsSec.length !== 3) {
                    if (Array.isArray(local.recipeTimePresetsSec) && local.recipeTimePresetsSec.length === 3) {
                        settings.recipeTimePresetsSec = local.recipeTimePresetsSec;
                    }
                }
            }
        } catch (e) {}
        try { localStorage.setItem('factorySettings', JSON.stringify(settings)); } catch (e) {}
        applyCreateRecipeFactoryPresets(settings);
    }).catch(function () {
        var settings = {};
        try {
            var stored = localStorage.getItem('factorySettings');
            settings = stored ? JSON.parse(stored) : {};
        } catch (e) {}
        applyCreateRecipeFactoryPresets(settings);
    });
}

function startQuickTestRun() {
    var productName = (document.getElementById('quick-product-name') && document.getElementById('quick-product-name').value) || '';
    var vacEl = document.getElementById('quick-vacuum-mmhg');
    var timeEl = document.getElementById('quick-duration');
    var errEl = document.getElementById('quick-test-input-error');
    function setQuickError(msg) {
        if (!errEl) { if (msg) showAppModal(msg, 'Quick Test'); return; }
        if (msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
        else { errEl.textContent = ''; errEl.style.display = 'none'; }
    }

    var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
    var vacuumMmHg = parseFloat(vacEl && vacEl.value ? vacEl.value : '');
    var durationSec = (typeof parseMmSs === 'function') ? parseMmSs(timeEl && timeEl.value ? timeEl.value : '') : null;

    if (!String(productName).trim()) {
        setQuickError('Product name is required before starting a quick test.');
        return;
    }
    if (isNaN(vacuumMmHg) || vacuumMmHg < 1) {
        setQuickError('Enter a valid vacuum value (mmHg).');
        return;
    }
    if (vacuumMmHg > maxVac) {
        setQuickError('Vacuum cannot exceed factory maximum of ' + maxVac + ' mmHg.');
        return;
    }
    if (!durationSec) {
        setQuickError('Enter a valid time in mm:ss format (e.g. 01:30).');
        return;
    }
    setQuickError('');

    pendingRecipeToLoad = {
        testSource: 'quick',
        productName: String(productName).trim(),
        vacuumMmHg: vacuumMmHg,
        durationSec: durationSec,
        durationDisplay: (typeof formatMmSs === 'function') ? formatMmSs(durationSec) : ''
    };
    _quickTestRunPendingFormReset = true;
    openBatchNumberModal();
}

function resetQuickTestFormAfterRunIfPending() {
    if (!_quickTestRunPendingFormReset) return;
    _quickTestRunPendingFormReset = false;
    var pn = document.getElementById('quick-product-name');
    var vac = document.getElementById('quick-vacuum-mmhg');
    var dur = document.getElementById('quick-duration');
    if (pn) pn.value = '';
    if (vac) vac.value = '';
    if (dur) dur.value = '';
    var errEl = document.getElementById('quick-test-input-error');
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    if (typeof syncQuickVacuumPreset === 'function') syncQuickVacuumPreset();
    if (typeof syncQuickTimePreset === 'function') syncQuickTimePreset();
}

function getTestRunSteps() {
    var recipe = lastTestRunRecipe;
    if (!recipe) return null;
    if (recipe.steps && recipe.steps.length > 0) return recipe.steps;
    var n = Math.max(1, parseInt(recipe.stepCount, 10) || 10);
    var steps = [];
    for (var i = 0; i < n; i++) {
        steps.push({ tapCount: (i === 0) ? 10 : (i === 1) ? 500 : 1250 });
    }
    return steps;
}


function resetTestRunPageForNewLoad() {
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    stopTestRunAdapterPoll();
    if (typeof hardwareLeakStopSilently === 'function') hardwareLeakStopSilently();
    if (typeof _closeTestRunHardwareEs === 'function') _closeTestRunHardwareEs();

    testRunButtonState = 'start';
    testRunStartTime = null;
    testRunHoldStartTime = null;
    testRunBuildDurationSec = null;
    testRunCurrentStepIndex = 0;
    testRunCurrentTapCount = 0;
    testRunStepTapsBase = 0;
    testRunSteps = [];
    testRunTotalSteps = 0;
    testRunStepResults = [];
    testRunStepVolumes = [];
    testRunInitialWeightG = null;
    testRunInitialVolumeMl = null;
    testRunPreviousVolumeMl = null;
    testRunLastStepVolumeDeltaMl = null;
    testRunLastStepPreviousMl = null;
    testRunLastStepCurrentMl = null;
    _pendingStepVolumeDeltaMl = null;
    _testRunStepResumeInFlight = false;
    _adapterPollOkStreak = 0;
    _testRunAdapterInterruptAudited = false;

    if (_testRunVolumeResolve) {
        var rv = _testRunVolumeResolve;
        _testRunVolumeResolve = null;
        try { rv(null); } catch (e) {}
    }
    if (_testRunInitialWeightResolve) {
        var rw = _testRunInitialWeightResolve;
        _testRunInitialWeightResolve = null;
        try { rw(null); } catch (e) {}
    }

    if (typeof closeTestRunStepCompleteModal === 'function') closeTestRunStepCompleteModal();
    if (typeof closeTestRunCompletionApprovalModal === 'function') closeTestRunCompletionApprovalModal();
    ['test-run-volume-overlay', 'test-run-initial-weight-overlay', 'test-run-completion-overlay', 'test-run-abort-overlay'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    if (typeof window.closeOSK === 'function') window.closeOSK();

    setRunCard('run-sample-volume', '--');
    setRunCard('run-initial-weight', '--');
    setRunCard('run-bulk-density', '--');
    setRunCard('run-tap-density', '--');
    setRunCard('run-result', '--');
    setRunCard('run-tap-count-card', '0');
    setRunCard('run-tap-count-of-card', 'of --');
    setRunCard('run-current-step-card', '1');
    setRunCard('run-status-text', 'Ready');
    setRunCard('run-status-subtext', 'Waiting to start');

    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.disabled = false;
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }

    if (typeof renderTestRunResultsTable === 'function') renderTestRunResultsTable();
}

function setRunCard(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function showTestRunStepCompleteModal(isFinalStep) {
    var stepNum = testRunCurrentStepIndex + 1;
    var total = testRunTotalSteps;
    var finalStep = !!isFinalStep;

    var heading = document.getElementById('test-run-step-complete-heading');
    if (heading) heading.textContent = finalStep ? 'Final step complete' : 'Step complete';

    var msg = document.getElementById('test-run-step-complete-message');
    if (msg) {
        msg.textContent = finalStep
            ? ('Step ' + stepNum + ' of ' + total + ' finished. Review the volume change below, then continue to save the report or save and complete to reports.')
            : ('Step ' + stepNum + ' of ' + total + ' finished. Review the volume change below, then continue to the next step or save and complete to reports.');
    }

    var detail = document.getElementById('test-run-step-complete-volume-detail');
    if (detail) {
        var prev = testRunLastStepPreviousMl;
        var curr = testRunLastStepCurrentMl;
        var delta = testRunLastStepVolumeDeltaMl;
        var lines = [];
        if (prev != null && !isNaN(prev)) lines.push('Previous reading: ' + _formatDensity(prev) + ' ml');
        if (curr != null && !isNaN(curr)) lines.push('Current reading: ' + _formatDensity(curr) + ' ml');
        if (delta != null && !isNaN(delta)) {
            lines.push('Δ Volume (previous − current): ' + _formatDensity(delta) + ' ml');
        } else if (lines.length) {
            lines.push('Δ Volume: —');
        } else {
            lines.push('Δ Volume: —');
        }
        detail.textContent = lines.join('\n');
    }

    var contBtn = document.getElementById('test-run-step-continue-btn');
    if (contBtn) contBtn.textContent = finalStep ? 'Finish test' : 'Continue';

    var overlay = document.getElementById('test-run-step-complete-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeTestRunStepCompleteModal() {
    var overlay = document.getElementById('test-run-step-complete-overlay');
    if (overlay) overlay.style.display = 'none';
}

function recordCurrentStepResult() {
    var bulkEl = document.getElementById('run-bulk-density');
    var tapEl = document.getElementById('run-tap-density');
    var resultEl = document.getElementById('run-result');

    var bulkDensity = bulkEl ? bulkEl.textContent : '--';
    var tapDensity = tapEl ? tapEl.textContent : '--';
    var resultText = resultEl ? resultEl.textContent : '--';
    var vol = (testRunStepVolumes && testRunStepVolumes[testRunCurrentStepIndex] != null) ? testRunStepVolumes[testRunCurrentStepIndex] : '';

    var entry = {
        stepIndex: testRunCurrentStepIndex,
        volumeMl: vol,
        volumeDeltaMl: _pendingStepVolumeDeltaMl,
        bulkDensity: bulkDensity,
        tapDensity: tapDensity,
        resultText: resultText
    };
    testRunStepResults.push(entry);
    renderTestRunResultsTable();
    syncTestRunCheckpoint();
}

function renderTestRunResultsTable() {
    var tbody = document.getElementById('test-run-results-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!testRunStepResults || testRunStepResults.length === 0) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="6">No step data yet.</td>';
        tbody.appendChild(emptyRow);
        return;
    }

    testRunStepResults.forEach(function (entry) {
        var tr = document.createElement('tr');
        var stepNumber = entry.stepIndex + 1;
        var vol = (entry.volumeMl != null && entry.volumeMl !== '') ? entry.volumeMl : '__';
        var dVol = '__';
        if (entry.volumeDeltaMl != null && !isNaN(entry.volumeDeltaMl)) dVol = _formatDensity(entry.volumeDeltaMl);
        tr.innerHTML =
            '<td>' + stepNumber + '</td>' +
            '<td>' + vol + '</td>' +
            '<td>' + dVol + '</td>' +
            '<td>' + entry.bulkDensity + '</td>' +
            '<td>' + entry.tapDensity + '</td>' +
            '<td>' + entry.resultText + '</td>';
        tbody.appendChild(tr);
    });
}

function buildTestRunCheckpointPayload() {
    var payload = buildTestRunReportPayload();
    if (!payload) return null;
    payload.testData = payload.testData || {};
    var now = new Date().toISOString();
    var startIso = testRunStartTime || payload.testData.testStartTime || now;
    var wallElapsed = 0;
    try {
        var wallMs = Date.now() - new Date(startIso).getTime();
        if (!isNaN(wallMs) && wallMs >= 0) wallElapsed = Math.floor(wallMs / 1000);
    } catch (eWall) {
        wallElapsed = 0;
    }
    var holdElapsed = 0;
    if (testRunHoldStarted) {
        holdElapsed = (testRunElapsedSec != null && !isNaN(parseInt(testRunElapsedSec, 10)))
            ? Math.max(0, parseInt(testRunElapsedSec, 10))
            : 0;
    }
    var buildSoFar = (typeof _freezeTestRunBuildDurationSec === 'function')
        ? _freezeTestRunBuildDurationSec()
        : 0;
    if (!testRunHoldStarted) {
        // Still evacuating: entire wall clock so far is build.
        buildSoFar = wallElapsed;
        holdElapsed = 0;
    } else if (buildSoFar + holdElapsed > wallElapsed + 2) {
        buildSoFar = Math.max(0, wallElapsed - holdElapsed);
    }

    payload.testData.status = 'running';
    payload.testData.testStartTime = startIso;
    payload.testData.testEndTime = now;
    payload.testData.durationSeconds = wallElapsed;
    payload.testData.actualDurationSec = wallElapsed;
    payload.testData.wallElapsedSec = wallElapsed;
    payload.testData.buildDurationSec = buildSoFar;
    payload.testData.holdDurationSec = holdElapsed;
    // Release never started while mid-run — do not stamp planned RL_TM into checkpoint.
    payload.testData.releaseDurationSec = 0;
    payload.testData.releaseTimeSec = 0;
    payload.testData.totalDurationSec = wallElapsed;
    payload.testData.completedAt = now;
    payload.testStartTime = startIso;
    payload.testEndTime = now;
    payload.durationSeconds = wallElapsed;
    payload.wallElapsedSec = wallElapsed;
    payload._wallElapsedSec = wallElapsed;
    payload._checkpointAt = now;
    payload.createdAt = startIso;
    payload.completedAt = now;

    var u = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : null;
    if (u) {
        var un = (u.username || u.name || '').trim();
        payload.operatedByUsername = un;
        payload.operatorName = (u.name || u.username || '').trim();
        payload.employeeId = un;
        payload.testData.operatedByUsername = un;
        payload.testData.operatorName = payload.operatorName;
        payload.testData.employeeId = un;
    }
    return payload;
}

function clearTestRunCheckpointHeartbeat() {
    if (window._testRunCheckpointHeartbeatId != null) {
        clearInterval(window._testRunCheckpointHeartbeatId);
        window._testRunCheckpointHeartbeatId = null;
    }
}

/** Persist mid-test timing every 1s so power-cut recovery has Start≠End and real elapsed. */
function startTestRunCheckpointHeartbeat() {
    clearTestRunCheckpointHeartbeat();
    window._testRunCheckpointHeartbeatId = setInterval(function () {
        if (testRunButtonState !== 'abort') {
            clearTestRunCheckpointHeartbeat();
            return;
        }
        syncTestRunCheckpoint();
    }, 1000);
}
window.startTestRunCheckpointHeartbeat = startTestRunCheckpointHeartbeat;
window.clearTestRunCheckpointHeartbeat = clearTestRunCheckpointHeartbeat;

function syncTestRunCheckpoint() {
    if (testRunButtonState !== 'abort') return Promise.resolve();
    var body = buildTestRunCheckpointPayload();
    if (!body) return Promise.resolve();
    body.type = 'test';
    body._checkpointPhase = 'running';
    if (!body._checkpointAt) body._checkpointAt = new Date().toISOString();
    return apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'PUT', body: body }).catch(function () {});
}

function clearTestRunCheckpoint() {
    clearTestRunCheckpointHeartbeat();
    return apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'DELETE' }).catch(function () {});
}

function syncOperationCheckpoint(payload) {
    if (!payload || typeof payload !== 'object') return Promise.resolve();
    return apiRequest(API_BASE + '/api/data/test-run/checkpoint', { method: 'PUT', body: payload }).catch(function () {});
}

function buildValidationCheckpointPayload() {
    var u = window.currentUser || {};
    var un = (u.username || u.name || '').trim();
    var now = new Date().toISOString();
    return {
        type: 'validation',
        name: 'Validation - ' + (typeof validationAdapterLabel === 'function' ? validationAdapterLabel() : (lastValidationType || 'run')),
        operatedByUsername: un,
        operatorName: (u.name || u.username || '').trim(),
        employeeId: un,
        startedAt: now,
        createdAt: now,
        testData: {
            status: 'running',
            validationType: lastValidationType || '',
            operatedByUsername: un,
            operatorName: (u.name || u.username || '').trim(),
            employeeId: un,
            createdAt: now
        }
    };
}

function buildTestRunReportPayload() {
    var recipe = lastTestRunRecipe;
    if (!recipe) return null;
    // End stamp is after release lock finishes (caller saves after showReleasePressureLock).
    var now = new Date().toISOString();
    var startIso = testRunStartTime || now;
    var elapsedSec = (testRunElapsedSec != null) ? testRunElapsedSec : null;
    if (elapsedSec == null && testRunStartTime) {
        var durMs = new Date(now).getTime() - new Date(testRunStartTime).getTime();
        if (durMs >= 0) elapsedSec = Math.floor(durMs / 1000);
    }
    var elapsedDisplay = (elapsedSec != null && typeof formatMmSs === 'function') ? formatMmSs(elapsedSec) : '--';
    var resultText = testRunResultText || _computeTestRunResult();

    var releaseSec = (typeof getReleasePressureLockSec === 'function')
        ? getReleasePressureLockSec()
        : _releaseDurationSecFromSettings();
    var holdSec = (testRunSetDurationSec != null) ? testRunSetDurationSec : null;

    // Build = Start → TARGET_REACHED (pressure build). Hold = set hold. Release = factory RL_TM.
    // TOTAL = build + hold + release.
    var buildSec = (typeof _freezeTestRunBuildDurationSec === 'function')
        ? _freezeTestRunBuildDurationSec()
        : 0;
    var holdPart = (holdSec != null && !isNaN(parseInt(holdSec, 10))) ? parseInt(holdSec, 10) : 0;
    var releasePart = (!isNaN(parseInt(releaseSec, 10))) ? parseInt(releaseSec, 10) : 0;
    var totalSec = buildSec + holdPart + releasePart;

    var testData = {
        recipe: recipe,
        productName: recipe.productName,
        batchNumber: recipe.batchNumber || null,
        batchSize: recipe.batchSize != null ? recipe.batchSize : null,
        productType: recipe.productType || null,
        noOfSamples: recipe.noOfSamples != null ? recipe.noOfSamples : null,
        analysisReportNo: recipe.analysisReportNo || null,
        testSource: recipe.testSource || (isQuickTestRecipe(recipe) ? 'quick' : 'recipe'),
        status: 'completed',
        usp: 'Vacuum',
        setVacuumMmHg: testRunSetVacuumMmHg,
        actualVacuumMmHg: testRunCurrentVacuumMmHg,
        setDurationSec: testRunSetDurationSec,
        setDurationDisplay: testRunSetDurationDisplay,
        buildDurationSec: buildSec,
        holdDurationSec: holdSec,
        releaseDurationSec: releaseSec,
        releaseTimeSec: releaseSec,
        totalDurationSec: totalSec,
        actualDurationSec: elapsedSec,
        actualDurationDisplay: elapsedDisplay,
        vacuumSamples: Array.isArray(testRunVacuumSamples) ? testRunVacuumSamples.slice() : [],
        result: resultText,
        testStartTime: startIso,
        testEndTime: now,
        durationSeconds: elapsedSec,
        createdAt: now,
        completedAt: now
    };

    var payload = {
        name: 'Test Report - ' + (recipe.productName || 'Leak Test'),
        type: 'test',
        recipe: recipe,
        testData: testData,
        createdAt: now,
        completedAt: now
    };
    return stampOperatorOnTestReportPayload(payload);
}

var _abortSaveInFlight = false;
var _testRunAbortRemarksResolve = null;

function closeTestRunAbortRemarksModal() {
    var overlay = document.getElementById('test-run-abort-overlay');
    if (overlay) overlay.style.display = 'none';
    var err = document.getElementById('test-run-abort-error');
    if (err) {
        err.style.display = 'none';
        err.textContent = '';
    }
    if (typeof window.closeOSK === 'function') window.closeOSK();
}

function openTestRunAbortRemarksModal() {
    return new Promise(function (resolve) {
        _testRunAbortRemarksResolve = resolve;
        var overlay = document.getElementById('test-run-abort-overlay');
        var ta = document.getElementById('test-run-abort-remarks');
        var err = document.getElementById('test-run-abort-error');
        if (!overlay || !ta) {
            _testRunAbortRemarksResolve = null;
            resolve('Test aborted');
            return;
        }
        ta.value = '';
        if (err) {
            err.style.display = 'none';
            err.textContent = '';
        }
        overlay.style.display = 'flex';
        setTimeout(function () {
            try {
                ta.focus();
                if (typeof openOSKForInput === 'function') openOSKForInput(ta);
            } catch (e) {}
        }, 0);
    });
}

function confirmTestRunAbortRemarks() {
    var ta = document.getElementById('test-run-abort-remarks');
    var err = document.getElementById('test-run-abort-error');
    var remarks = ta ? String(ta.value || '').trim() : '';
    if (!remarks) {
        if (err) {
            err.textContent = 'Abort remarks are required.';
            err.style.display = 'block';
        } else if (typeof showAppModal === 'function') {
            showAppModal('Abort remarks are required.', 'Abort Test');
        }
        if (ta) ta.focus();
        return;
    }
    closeTestRunAbortRemarksModal();
    if (!_testRunAbortRemarksResolve) return;
    var r = _testRunAbortRemarksResolve;
    _testRunAbortRemarksResolve = null;
    r(remarks);
}

function abortTestRunAndSave() {
    if (_abortSaveInFlight) return Promise.resolve();

    // Freeze build seconds before clearing hold flags / release lock (release must not inflate build).
    if (typeof _freezeTestRunBuildDurationSec === 'function') {
        _freezeTestRunBuildDurationSec({ finalize: true });
    }

    if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
    if (typeof clearTestRunCheckpointHeartbeat === 'function') clearTestRunCheckpointHeartbeat();
    if (testRunIntervalId != null) {
        clearInterval(testRunIntervalId);
        testRunIntervalId = null;
    }
    testRunHoldStarted = false;
    stopTestRunAdapterPoll();
    testRunStepTapsBase = 0;
    var stopP = (typeof hardwareLeakStopAwait === 'function')
        ? hardwareLeakStopAwait()
        : hardwareLeakStopSilently();
    _closeTestRunHardwareEs();
    closeTestRunStepCompleteModal();
    cancelTestRunVolume();

    return Promise.resolve(stopP).then(function () {
        return openTestRunAbortRemarksModal();
    }).then(function (remarks) {
        if (!remarks || !String(remarks).trim()) return Promise.resolve();
        _postRunSessionHold = true;
        markAutoLogoutActivity();
        setRunCard('run-status-text', 'Aborted');
        setRunCard('run-status-subtext', 'Releasing pressure');
        var releaseSec = (typeof getReleasePressureLockSec === 'function')
            ? getReleasePressureLockSec()
            : 80;
        var lockFn = (typeof showReleasePressureLock === 'function')
            ? showReleasePressureLock
            : function () { return Promise.resolve(); };
        return lockFn(releaseSec).then(function () {
            setRunCard('run-status-subtext', 'Saving report');
        return _abortTestRunAndSaveWithRemarks(String(remarks).trim());
        });
    });
}

function _abortTestRunAndSaveWithRemarks(remarks) {
    if (_abortSaveInFlight) return Promise.resolve();
    _abortSaveInFlight = true;
    auditTestRunAborted('User aborted test run: ' + remarks);

    // Set UI to aborted
    setRunCard('run-status-text', 'Aborted');
    setRunCard('run-status-subtext', 'Test stopped');

    var btn = document.getElementById('btn-test-start-abort');
    if (btn) {
        btn.className = 'btn-ctrl start';
        btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
        btn.classList.remove('danger');
    }
    testRunButtonState = 'start';

    var payload = buildTestRunReportPayload();
    if (!payload) {
        _abortSaveInFlight = false;
        _postRunSessionHold = false;
        goToPage('reports');
        return Promise.resolve();
    }

    // Override status + completed steps to reflect actual recorded steps
    var completedSteps = (testRunStepResults && testRunStepResults.length) ? testRunStepResults.length : 0;
    payload.testData = payload.testData || {};
    payload.status = 'aborted';
    payload.testData.status = 'aborted';
    payload.testData.completedSteps = completedSteps;
    payload.testData.stepCount = completedSteps;
    payload.testData.remarks = remarks;
    payload.remarks = remarks;
    payload.completedAt = new Date().toISOString();
    payload.testData.completedAt = payload.completedAt;
    payload.createdAt = payload.completedAt;
    payload.testData.createdAt = payload.completedAt;
    // Aborted: Hold = actual hold elapsed; Total = build + hold + release
    var buildA = parseInt(payload.testData.buildDurationSec, 10);
    if (isNaN(buildA)) buildA = 0;
    var holdA = payload.testData.actualDurationSec != null
        ? parseInt(payload.testData.actualDurationSec, 10)
        : 0;
    if (isNaN(holdA)) holdA = 0;
    var releaseA = parseInt(payload.testData.releaseDurationSec != null
        ? payload.testData.releaseDurationSec
        : payload.testData.releaseTimeSec, 10);
    if (isNaN(releaseA)) releaseA = 0;
    payload.testData.holdDurationSec = holdA;
    payload.testData.totalDurationSec = buildA + holdA + releaseA;
    payload.testData.durationSeconds = holdA;
    stampOperatorOnTestReportPayload(payload);

    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            _abortSaveInFlight = false;
            clearTestRunCheckpoint();
            resetQuickTestFormAfterRunIfPending();
            var reportId = (result && result.id) ? result.id : null;
            if (reportId) {
                _saveReportPdfSilent(reportId);
                return openReportPreview(reportId).then(function (preview) {
                    return { openedPreview: !!preview, reportId: reportId };
                });
            }
            _postRunSessionHold = false;
                goToPage('reports');
                if (typeof loadReports === 'function') loadReports();
            return { openedPreview: false };
        })
        .catch(function (err) {
            _abortSaveInFlight = false;
            _postRunSessionHold = false;
            console.error('Abort save report failed', err);
            showAppModal(
                'Failed to save aborted report.'
                    + ((err && err.message) ? ('\n\n' + err.message) : ''),
                'Report'
            );
            goToPage('reports');
            return { openedPreview: false };
        });
}

function saveTestRunReportAndGoToReportPreview() {
    _postRunSessionHold = true;
    markAutoLogoutActivity();
    var payload = buildTestRunReportPayload();
    if (!payload) {
        _postRunSessionHold = false;
        if (testRunIntervalId != null) {
            clearInterval(testRunIntervalId);
            testRunIntervalId = null;
        }
        _closeTestRunHardwareEs();
        testRunButtonState = 'start';
        goToPage('reports');
        return;
    }
    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            closeTestRunStepCompleteModal();
            clearTestRunCheckpoint();
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            hardwareLeakStopSilently();
            _closeTestRunHardwareEs();
            setRunCard('run-status-text', 'Completed');
            setRunCard('run-status-subtext', 'Report saved');
            var btn = document.getElementById('btn-test-start-abort');
            if (btn) {
                btn.className = 'btn-ctrl start';
                btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
                btn.classList.remove('danger');
            }
            testRunButtonState = 'start';
            var reportId = (result && result.id) ? result.id : null;
            auditTestRunFinished(reportId);
            finishTestRunReportSaved(reportId);
        })
        .catch(function (err) {
            _postRunSessionHold = false;
            console.error('Save report failed', err);
            showAppModal('Failed to save report.', 'Report');
        });
}

function saveTestRunReportAndGoToReports() {
    _postRunSessionHold = true;
    markAutoLogoutActivity();
    var payload = buildTestRunReportPayload();
    if (!payload) {
        _postRunSessionHold = false;
        closeTestRunStepCompleteModal();
        if (testRunIntervalId != null) {
            clearInterval(testRunIntervalId);
            testRunIntervalId = null;
        }
        _closeTestRunHardwareEs();
        testRunButtonState = 'start';
        goToPage('reports');
        return;
    }
    apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            closeTestRunStepCompleteModal();
            clearTestRunCheckpoint();
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            hardwareLeakStopSilently();
            _closeTestRunHardwareEs();
            setRunCard('run-status-text', 'Saved');
            setRunCard('run-status-subtext', 'Report saved');
            var btn = document.getElementById('btn-test-start-abort');
            if (btn) {
                btn.className = 'btn-ctrl start';
                btn.innerHTML = '<span class="ctrl-icon">&#9654;</span><span>START</span>';
                btn.classList.remove('danger');
            }
            testRunButtonState = 'start';
            var reportId = (result && result.id) ? result.id : null;
            auditTestRunFinished(reportId);
            finishTestRunReportSaved(reportId);
        })
        .catch(function (err) {
            _postRunSessionHold = false;
            console.error('Save report failed', err);
            showAppModal('Failed to save report.', 'Report');
        });
}

function confirmTestRunStepContinue() {
    var isFinal = (testRunCurrentStepIndex + 1) >= testRunTotalSteps;
    if (isFinal) {
        closeTestRunStepCompleteModal();
        saveTestRunReportAndGoToReportPreview();
        return;
    }
    closeTestRunStepCompleteModal();
    stopTestRunAdapterPoll();
    var volInput = document.getElementById('test-run-volume-input');
    if (volInput) volInput.value = '';
    // Move to next step (fresh tap base for new step)
    testRunCurrentStepIndex++;
    if (testRunButtonState === 'abort') {
        runTestRunHardwareStep(testRunCurrentStepIndex);
    }
}

function confirmTestRunStepSave() {
    closeTestRunStepCompleteModal();
    saveTestRunReportAndGoToReports();
}

function toggleTestRunState() {
    var btn = document.getElementById('btn-test-start-abort');
    var statusText = document.getElementById('run-status-text');
    var statusSubtext = document.getElementById('run-status-subtext');
    if (testRunButtonState === 'start') {
        if (testRunSetVacuumMmHg == null || testRunSetDurationSec == null) {
            showAppModal('This test has no vacuum/time configured. Load a recipe or start a quick test.', 'Test Run');
            return;
        }
        if (btn) btn.disabled = true;
        auditTestRunStarted(lastTestRunRecipe);
        testRunStartTime = new Date().toISOString();
        testRunHoldStartTime = null;
        testRunBuildDurationSec = null;
        testRunElapsedSec = 0;
        testRunCurrentVacuumMmHg = null;
        testRunResultText = null;
        testRunHoldStarted = false;
        testRunVacuumSamples = [];
        testRunNextSamplePercent = 10;
        window._testRunStartPressureMmHg = null;
        window._testRunLeakAbortInFlight = false;
        setRunCard('run-current-vacuum', '--');
        setRunCard('run-elapsed-time', '00:00');
        var resultCard = document.getElementById('test-run-result-card');
        if (resultCard) resultCard.hidden = true;

        apiRequest(API_BASE + '/api/hardware/leak/start', {
            method: 'POST',
            body: {
                vacuumMmHg: testRunSetVacuumMmHg,
                durationSec: testRunSetDurationSec,
                cycles: [{ holdSeconds: testRunSetDurationSec }]
                }
            }).then(function () {
                testRunButtonState = 'abort';
                if (btn) {
                    btn.disabled = false;
                btn.className = 'btn btn-primary val-run-start-btn danger';
                btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9726;</span><span id="btn-test-run-label">Stop</span>';
            }
            if (statusText) statusText.textContent = 'Evacuating';
            if (statusSubtext) statusSubtext.textContent = 'Waiting for set vacuum';
            _openTestRunHardwareStream();
            if (typeof startPressureBuildWatchdog === 'function') {
                startPressureBuildWatchdog({
                    getSetTarget: function () { return testRunSetVacuumMmHg; },
                    getLive: function () { return testRunCurrentVacuumMmHg; },
                    isActive: function () {
                        return testRunButtonState === 'abort' && !testRunHoldStarted;
                    },
                    onFail: function () {
                        _abortTestRunPressureNotBuilding();
                    }
                });
            }
            if (testRunIntervalId != null) {
                clearInterval(testRunIntervalId);
                testRunIntervalId = null;
            }
            // Persist in-progress run immediately + every 1s for power-cut recovery.
            syncTestRunCheckpoint();
            if (typeof startTestRunCheckpointHeartbeat === 'function') {
                startTestRunCheckpointHeartbeat();
            }
        }).catch(function (err) {
            if (typeof clearPressureBuildWatchdog === 'function') clearPressureBuildWatchdog();
            if (typeof clearTestRunCheckpointHeartbeat === 'function') clearTestRunCheckpointHeartbeat();
            if (btn) btn.disabled = false;
            _resetTestRunButtonToStart();
            showAppModal('Test run failed to start: ' + (err && err.message ? err.message : 'Error'), 'Test Run');
        });
    } else {
        showConfirmModal('Test is running. Do you want to stop and save the report?', 'Operation in progress').then(function (ok) {
            if (!ok) return;
            abortTestRunAndSave();
        });
    }
}

function openRecipeActionsModal(recipeId) {
    window._recipeActionsId = recipeId;
    var recipe = lastDisplayedRecipes && lastDisplayedRecipes.find(function (r) { return r.id === recipeId; });
    var titleEl = document.getElementById('recipe-actions-modal-title');
    if (titleEl) titleEl.textContent = (recipe && (recipe.productName || recipe.name)) ? (recipe.productName || recipe.name) : 'Recipe';
    var apprBtn = document.getElementById('recipe-action-approve-btn');
    if (apprBtn) {
        var st = recipe ? recipe.recipeApprovalStatus : null;
        var showAppr = !!(recipe && st === 'pending' && userCanApproveByQaRule());
        apprBtn.style.display = showAppr ? '' : 'none';
    }
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeActionsModal() {
    window._recipeActionsId = null;
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmRecipeAction(action) {
    var id = window._recipeActionsId;
    closeRecipeActionsModal();
    if (id == null) return;
    if (action === 'edit') {
        editRecipe(id);
    } else if (action === 'disable') {
        disableRecipe(id);
    } else if (action === 'load') {
        loadRecipeById(id);
    } else if (action === 'approve') {
        openRecipeApproveModal(id);
    }
}

function openRecipeApproveModal(recipeId) {
    window._recipeApproveId = recipeId;
    var ta = document.getElementById('recipe-approve-remarks');
    if (ta) ta.value = '';
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeApproveModal() {
    window._recipeApproveId = null;
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'none';
}

function submitRecipeApprove() {
    var id = window._recipeApproveId;
    if (id == null) return;
    var ta = document.getElementById('recipe-approve-remarks');
    var remarks = ta ? ta.value.trim() : '';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return;
            return apiRequest(API_BASE + '/api/data/recipes/' + id + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarks, approverName: name }
            }).then(function (data) {
                closeRecipeApproveModal();
                if (data && data.ok) {
                    showAppModal('Recipe approved.', 'Recipes');
                    loadManageRecipes();
                } else {
                    showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', 'Recipes');
                }
            });
        });
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Recipes');
    });
}

/** Opens credential modal and approves recipe; resolves { ok }, { cancelled: true }, or { ok: false }. */
function approveSavedRecipeWithCredentials(recipeId, modalTitle, remarks) {
    var title = modalTitle || 'Recipes';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    var remarksStr = remarks != null ? String(remarks).trim() : '';
    var rid = parseInt(recipeId, 10);
    if (isNaN(rid) || rid < 1) {
        showAppModal('Invalid recipe id for approval.', title);
        return Promise.resolve({ ok: false });
    }
    return refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return { cancelled: true };
            return apiRequest(API_BASE + '/api/data/recipes/' + rid + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarksStr, approverName: name }
            }).then(function (data) {
                if (data && data.ok) {
                    showAppModal('Recipe approved.', title);
                    loadManageRecipes();
                    return { ok: true };
                }
                showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', title);
                return { ok: false };
            });
        });
    }).catch(function (err) {
        var msg = err && err.message ? String(err.message) : 'Error';
        if (msg.toLowerCase() === 'forbidden') {
            msg += ' — restart the Leak Test Apparatus server after updating, or hard-refresh the page (cached UI).';
        }
        showAppModal('Approval failed: ' + msg, title);
        return { ok: false };
    });
}

function editRecipe(id) {
    window.currentEditingRecipeId = id;
    goToPage('create-recipe-step1');
}

function loadRecipeForEdit() {
    var id = window.currentEditingRecipeId;
    if (!id) return;
    apiRequest(API_BASE + '/api/data/recipes/' + id).then(function (data) {
        var r = data.recipe || data;
        if (!r) return;
        var nameEl = document.getElementById('recipe-product-name');
        if (nameEl) nameEl.value = r.productName || r.name || '';
        var batchSizeEl = document.getElementById('recipe-batch-size');
        if (batchSizeEl) {
            batchSizeEl.value = (r.batchSize != null && !isNaN(parseInt(r.batchSize, 10)))
                ? String(parseInt(r.batchSize, 10))
                : '';
        }
        var productType = String(r.productType || 'Blister').trim();
        var typeRadios = document.querySelectorAll('input[name="recipe-product-type"]');
        var matched = false;
        var standardTypes = { Blister: 1, Bottle: 1, Pouch: 1, Vial: 1, Ampoule: 1, Sachet: 1 };
        typeRadios.forEach(function (el) {
            var on = el.value === productType;
            el.checked = on;
            if (on) matched = true;
        });
        var otherEl = document.getElementById('recipe-product-type-other');
        if (!matched || !standardTypes[productType]) {
            var otherRadio = Array.prototype.find.call(typeRadios, function (el) { return el.value === 'Other'; });
            if (otherRadio) otherRadio.checked = true;
            if (otherEl) otherEl.value = productType && productType !== 'Other' ? productType : '';
        } else if (otherEl) {
            otherEl.value = '';
        }
        if (typeof onRecipeProductTypeChange === 'function') onRecipeProductTypeChange();
        var vacEl = document.getElementById('recipe-vacuum-mmhg');
        if (vacEl) vacEl.value = (r.vacuumMmHg != null && !isNaN(parseFloat(r.vacuumMmHg))) ? String(r.vacuumMmHg) : '';
        var timeEl = document.getElementById('recipe-duration');
        if (timeEl) {
            var durSec = parseInt(r.durationSec, 10);
            timeEl.value = (!isNaN(durSec) && durSec > 0 && typeof formatMmSs === 'function') ? formatMmSs(durSec) : (r.durationDisplay || '');
        }
        updateCreateRecipeContinueButton();
        if (typeof syncCreateRecipeConsolePresets === 'function') syncCreateRecipeConsolePresets();
    }).catch(function () {});
}

function disableRecipe(id) {
    apiRequest(API_BASE + '/api/data/recipes/' + id, { method: 'DELETE' }).then(function () {
        try {
            // Keep a local list of disabled recipes so the Disable page only shows those
            var disabled = [];
            try {
                var raw = localStorage.getItem('disabledRecipes');
                if (raw) disabled = JSON.parse(raw) || [];
            } catch (e) {}

            var recipe = null;
            if (Array.isArray(lastDisplayedRecipes)) {
                recipe = lastDisplayedRecipes.find(function (r) { return r.id === id; }) || null;
            }

            if (recipe) {
                var entry = {
                    id: recipe.id,
                    name: recipe.productName || recipe.name || '--',
                    cylinderVolume: (recipe.cylinder && (recipe.cylinder.volume || recipe.cylinder.volumeMl)) || null,
                    stepsCount: recipe.stepCount || (recipe.steps && recipe.steps.length) || null
                };
                // Avoid duplicates
                disabled = disabled.filter(function (d) { return d.id !== entry.id; });
                disabled.push(entry);
                localStorage.setItem('disabledRecipes', JSON.stringify(disabled));
            }
        } catch (e) {}

        loadManageRecipes();
        showAppModal('Recipe disabled.', 'Disable Recipe');
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Failed to disable recipe.';
        showAppModal(msg, 'Disable Recipe');
    });
}

function loadRecipeById(recipeId) {
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'Load Recipe');
            return;
        }
        pendingRecipeToLoad = r;
        openBatchNumberModal();
    }).catch(function (err) {
        showAppModal('Recipe not found or failed to load.', 'Load Recipe');
    });
}

function resolveAnalysisReportNo(recipe, td) {
    var fromTd = td && td.analysisReportNo != null ? String(td.analysisReportNo).trim() : '';
    if (fromTd) return fromTd;
    var fromRecipe = recipe && recipe.analysisReportNo != null ? String(recipe.analysisReportNo).trim() : '';
    if (fromRecipe) return fromRecipe;
    var list = (td && Array.isArray(td.arNumbers) && td.arNumbers.length)
        ? td.arNumbers
        : (recipe && Array.isArray(recipe.arNumbers) ? recipe.arNumbers : []);
    if (list && list.length) {
        var first = String(list[0] || '').trim();
        if (first) return first;
    }
    return '';
}

function openBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    var input = document.getElementById('load-recipe-batch-input');
    var batchSizeEl = document.getElementById('load-recipe-batch-size-input');
    var samplesEl = document.getElementById('load-recipe-samples-input');
    var arEl = document.getElementById('load-recipe-analysis-no');
    var errEl = document.getElementById('load-recipe-batch-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    // Samples mandatory — leave blank so operator must enter 1–100.
    if (samplesEl) samplesEl.value = '';
    if (arEl) arEl.value = '';
    if (batchSizeEl) {
        var pref = pendingRecipeToLoad && pendingRecipeToLoad.batchSize != null
            ? parseInt(pendingRecipeToLoad.batchSize, 10) : NaN;
        batchSizeEl.value = (!isNaN(pref) && pref >= 1) ? String(pref) : '';
    }
    if (overlay) overlay.style.display = 'flex';
    if (input) {
        input.value = '';
        input.focus();
    }
}

function closeBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    var input = document.getElementById('load-recipe-batch-input');
    if (input) input.value = '';
    var batchSizeEl = document.getElementById('load-recipe-batch-size-input');
    if (batchSizeEl) batchSizeEl.value = '';
    var samplesEl = document.getElementById('load-recipe-samples-input');
    if (samplesEl) samplesEl.value = '';
    var arEl = document.getElementById('load-recipe-analysis-no');
    if (arEl) arEl.value = '';
    var errEl = document.getElementById('load-recipe-batch-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    // Cancelled before start: drop pending quick-test form reset
    if (pendingRecipeToLoad && pendingRecipeToLoad.testSource === 'quick') {
        _quickTestRunPendingFormReset = false;
    }
    pendingRecipeToLoad = null;
}

function confirmBatchNumberAndLoad() {
    var input = document.getElementById('load-recipe-batch-input');
    var batchSizeEl = document.getElementById('load-recipe-batch-size-input');
    var samplesEl = document.getElementById('load-recipe-samples-input');
    var arEl = document.getElementById('load-recipe-analysis-no');
    var errEl = document.getElementById('load-recipe-batch-error');
    var batch = input ? input.value.trim() : '';
    if (!pendingRecipeToLoad) {
        closeBatchNumberModal();
        return;
    }
    function setBatchErr(msg) {
        if (errEl) {
            errEl.textContent = msg || '';
            errEl.style.display = msg ? 'block' : 'none';
        } else if (msg) {
            showAppModal(msg, 'Start Test');
        }
    }
    if (!batch) {
        setBatchErr('Enter a batch number to continue.');
        if (input) input.focus();
        return;
    }
    var samples = parseInt(samplesEl && samplesEl.value ? samplesEl.value : '', 10);
    if (isNaN(samples) || samples < 1 || samples > 100) {
        setBatchErr('Enter number of samples (1–100).');
        if (samplesEl) samplesEl.focus();
        return;
    }
    var batchSizeRaw = batchSizeEl ? String(batchSizeEl.value || '').trim() : '';
    var batchSize = batchSizeRaw === '' ? null : parseInt(batchSizeRaw, 10);
    if (batchSizeRaw !== '' && (isNaN(batchSize) || batchSize < 1)) {
        setBatchErr('Batch size must be a whole number of 1 or more, or leave blank.');
        if (batchSizeEl) batchSizeEl.focus();
        return;
    }
    // Analysis Report No. / PR is optional
    var analysisReportNo = arEl ? String(arEl.value || '').trim() : '';
    var isQuick = pendingRecipeToLoad.testSource === 'quick';
    if (!isQuick && getEffectiveRecipeApprovalStatus(pendingRecipeToLoad) === 'pending') {
        showAppModal('This recipe is pending QA approval and cannot be loaded for testing.', 'Load Recipe');
        return;
    }
    setBatchErr('');
    var recipe = Object.assign({}, pendingRecipeToLoad);
    recipe.testSource = isQuick ? 'quick' : 'recipe';
    recipe.batchNumber = batch;
    recipe.batchSize = batchSize;
    recipe.noOfSamples = samples;
    recipe.analysisReportNo = analysisReportNo;
    pendingRecipeToLoad = null;
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    if (input) input.value = '';
    if (batchSizeEl) batchSizeEl.value = '';
    if (arEl) arEl.value = '';
    if (samplesEl) samplesEl.value = '';
    startTestRun(recipe);
}

function updateCreateRecipeContinueButton() {
    var nameEl = document.getElementById('recipe-product-name');
    var batchSizeEl = document.getElementById('recipe-batch-size');
    var vacEl = document.getElementById('recipe-vacuum-mmhg');
    var timeEl = document.getElementById('recipe-duration');
    var btn = document.getElementById('create-recipe-continue-btn');

    var recipeName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var productType = (typeof getResolvedRecipeProductType === 'function')
        ? getResolvedRecipeProductType()
        : '';
    var batchSize = parseInt(batchSizeEl && batchSizeEl.value ? batchSizeEl.value : '', 10);
    var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
    var vacuum = parseFloat(vacEl && vacEl.value ? vacEl.value : '');
    var durationSec = (typeof parseMmSs === 'function') ? parseMmSs(timeEl && timeEl.value ? timeEl.value : '') : null;

    var vacuumOk = !isNaN(vacuum) && vacuum >= 1 && vacuum <= maxVac;
    var batchSizeRaw = batchSizeEl ? String(batchSizeEl.value || '').trim() : '';
    var batchSizeOk = batchSizeRaw === '' || (!isNaN(batchSize) && batchSize >= 1);
    var canContinue = !!(recipeName && productType && batchSizeOk && vacuumOk && durationSec);
    if (btn) {
        btn.disabled = !canContinue;
    }
}

function openCreateRecipeContinueModal() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) return;
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeCreateRecipeContinueModal() {
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'none';
}

function getRecipes() {
    return apiRequest(API_BASE + '/api/data/recipes', {
        method: 'GET'
    }).then(function (data) {
        return (data && data.recipes) ? data.recipes : [];
    });
}

function loadViewRecipes() {
    var tbody = document.getElementById('view-recipes-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    getRecipes().then(function (recipes) {
        if (!recipes.length) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="2">No recipes.</td>';
            tbody.appendChild(tr);
            return;
        }
        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            tr.innerHTML =
                '<td>' + name + '</td>' +
                '<td class="view-col"><button class="reports-open-btn view-recipe-btn" onclick="openRecipePrintPreview(' + (r.id || 0) + ')" title="View">View</button></td>';
            tbody.appendChild(tr);
        });
    }).catch(function () {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="2">Unable to load recipes.</td>';
        tbody.appendChild(tr);
    });
}

function recipeDropHeightMm(r) {
    if (!r) return null;
    if (r.dropHeight != null && r.dropHeight !== '') {
        var d = parseFloat(r.dropHeight);
        return isNaN(d) ? null : d;
    }
    if (r.steps && r.steps[0] && r.steps[0].dropHeight != null && r.steps[0].dropHeight !== '') {
        var d2 = parseFloat(r.steps[0].dropHeight);
        return isNaN(d2) ? null : d2;
    }
    return null;
}

function recipeTotalTapCount(r) {
    if (!r) return null;
    if (r.customTotalTaps != null && r.customTotalTaps !== '') {
        var ct = parseInt(r.customTotalTaps, 10);
        if (!isNaN(ct) && ct > 0) return ct;
    }
    if (!r.steps || !r.steps.length) return null;
    var total = 0;
    for (var i = 0; i < r.steps.length; i++) {
        total += parseInt(r.steps[i].tapCount, 10) || 0;
    }
    return total > 0 ? total : null;
}

function recipeTapSpeed(r) {
    if (!r) return null;
    if (r.speed != null && r.speed !== '') {
        var s = parseInt(r.speed, 10);
        return isNaN(s) ? null : s;
    }
    if (r.steps && r.steps[0] && r.steps[0].speed != null && r.steps[0].speed !== '') {
        var s2 = parseInt(r.steps[0].speed, 10);
        return isNaN(s2) ? null : s2;
    }
    return null;
}

/** Display label for recipe procedure: Vacuum Decay, Pressure Decay, or Custom. */
function recipeUspLabel(r) {
    if (!r) return '--';
    var mode = String(r.uspMode || '').trim().toUpperCase();
    if (mode === 'VACUUM_DECAY') return 'Vacuum Decay';
    if (mode === 'PRESSURE_DECAY') return 'Pressure Decay';
    if (mode === 'CUSTOM') return 'Custom';
    var usp = String(r.usp || '').trim();
    if (!usp) return '--';
    var u = usp.toUpperCase().replace(/\s+/g, ' ');
    if (u === 'VACUUM_DECAY' || u === 'Vacuum Decay') return 'Vacuum Decay';
    if (u === 'PRESSURE_DECAY' || u === 'Pressure Decay') return 'Pressure Decay';
    if (u.indexOf('CUSTOM') >= 0) return 'Custom';
    return usp;
}

var _manageRecipesLoadGen = 0;

function loadManageRecipes() {
    var msgEl = document.getElementById('manage-recipes-message');
    // Scope to this page — disable-recipes also uses .manage-recipes-table.
    var tableEl = document.querySelector('#page-manage-recipes .manage-recipes-table');
    var tbody = document.getElementById('manage-recipes-table-body');
    if (!tbody) return;

    var loadGen = ++_manageRecipesLoadGen;
    // Capture mode at request start so a later Load↔Manage switch cannot mis-filter a stale reply.
    var mode = recipeListMode === 'load' ? 'load' : 'manage';

    tbody.innerHTML = '';
    if (msgEl) {
        msgEl.textContent = 'Loading recipes…';
        msgEl.style.display = '';
    }
    if (tableEl) tableEl.style.display = 'none';

    // Fire-and-forget QA count; do not let it gate or race the recipe list render.
    try { refreshActiveQaCount(); } catch (eQa) { /* ignore */ }

    getRecipes().then(function (recipes) {
        if (loadGen !== _manageRecipesLoadGen) return; // stale response — ignore

        var createBtn = document.querySelector('#page-manage-recipes .btn-create-recipe');
        var u = window.currentUser;
        var canManage = u && typeof canAccess === 'function' && canAccess(u, 'recipe-manage');
        if (createBtn) createBtn.style.display = (mode === 'load' || !canManage) ? 'none' : '';

        // Adjust header to match mode (Actions vs Load).
        if (tableEl) {
            var headRow = tableEl.querySelector('thead tr');
            if (headRow) {
                if (mode === 'load') {
                    headRow.innerHTML =
                        '<th>Product</th>' +
                        '<th>Type</th>' +
                        '<th>Batch Size</th>' +
                        '<th>Vacuum</th>' +
                        '<th>Time</th>' +
                        '<th class="actions-col">Load</th>';
                } else {
                    headRow.innerHTML =
                        '<th>Product</th>' +
                        '<th>Type</th>' +
                        '<th>Batch Size</th>' +
                        '<th>Vacuum</th>' +
                        '<th>Time</th>' +
                        '<th>Approval</th>' +
                        '<th class="actions-col">Actions</th>';
                }
            }
        }

        if (mode === 'load') {
            recipes = (recipes || []).filter(function (r) { return getEffectiveRecipeApprovalStatus(r) === 'approved'; });
        }

        if (!recipes.length) {
            if (msgEl) {
                msgEl.textContent = (mode === 'load')
                    ? 'No approved recipes available.'
                    : 'No recipes created yet.';
                msgEl.style.display = '';
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
            var pType = r.productType || '--';
            var batchSize = (r.batchSize != null && !isNaN(parseInt(r.batchSize, 10)))
                ? String(parseInt(r.batchSize, 10))
                : '--';
            var vacStr = (r.vacuumMmHg != null && !isNaN(parseFloat(r.vacuumMmHg))) ? String(r.vacuumMmHg) : '--';
            var durSec = parseInt(r.durationSec, 10);
            var timeStr = (!isNaN(durSec) && durSec > 0 && typeof formatMmSs === 'function')
                ? formatMmSs(durSec)
                : (r.durationDisplay || '--');

            if (mode === 'load') {
                var loadBtnHtml = '<button type="button" class="btn-action btn-load" onclick="loadRecipeById(' + (r.id || 0) + ')" title="Load">Load</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + pType + '</td>' +
                    '<td>' + batchSize + '</td>' +
                    '<td>' + vacStr + '</td>' +
                    '<td>' + timeStr + '</td>' +
                    '<td class="actions-cell actions-col">' + loadBtnHtml + '</td>';
            } else {
                var appr = getEffectiveRecipeApprovalStatus(r);
                var apprLabel = appr === 'pending' ? 'Pending' : 'Approved';
                var actionsBtnHtml = '<button type="button" class="btn-action btn-actions" onclick="openRecipeActionsModal(' + (r.id || 0) + ')" title="Edit / Delete / Load">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg> Actions</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + pType + '</td>' +
                    '<td>' + batchSize + '</td>' +
                    '<td>' + vacStr + '</td>' +
                    '<td>' + timeStr + '</td>' +
                    '<td>' + apprLabel + '</td>' +
                    '<td class="actions-cell">' +
                        actionsBtnHtml +
                    '</td>';
            }

            tbody.appendChild(tr);
        });
    }).catch(function (err) {
        if (loadGen !== _manageRecipesLoadGen) return;
        console.error('Failed to fetch recipes:', err);
        if (msgEl) {
            msgEl.textContent = 'Unable to load recipes. Go back and try again.';
            msgEl.style.display = '';
        }
        if (tableEl) tableEl.style.display = 'none';
    });
}

function loadDisableRecipes() {
    var msgEl = document.getElementById('disable-recipes-message');
    var tableEl = document.querySelector('#page-disable-recipes .manage-recipes-table');
    var tbody = document.getElementById('disable-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    var disabled = [];
    try {
        var raw = localStorage.getItem('disabledRecipes');
        if (raw) disabled = JSON.parse(raw) || [];
    } catch (e) {}

        if (!disabled || !disabled.length) {
            if (msgEl) {
                msgEl.textContent = 'No disabled recipes.';
                msgEl.style.display = '';
            }
            if (tableEl) tableEl.style.display = 'none';
            return;
        }

        if (msgEl) msgEl.style.display = 'none';
        if (tableEl) tableEl.style.display = '';

        disabled.forEach(function (r) {
            var tr = document.createElement('tr');
        var name = r.name || '--';
        var cylVol = r.cylinderVolume != null ? (r.cylinderVolume + ' ml') : '--';
        var stepsCount = r.stepsCount || '--';
            tr.innerHTML =
                '<td>' + name + '</td>' +
                '<td>' + cylVol + '</td>' +
            '<td>' + stepsCount + '</td>';

            tbody.appendChild(tr);
    });
}

function completeRecipeFromStep2() {
    if (window._recipeSaveInFlight) return;

    // Read from the simplified recipe form
    var nameEl = document.getElementById('recipe-product-name');
    var batchSizeEl = document.getElementById('recipe-batch-size');
    var vacEl = document.getElementById('recipe-vacuum-mmhg');
    var timeEl = document.getElementById('recipe-duration');
    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var typeChoice = (typeof getSelectedRecipeProductTypeChoice === 'function')
        ? getSelectedRecipeProductTypeChoice()
        : '';
    var productType = (typeof getResolvedRecipeProductType === 'function')
        ? getResolvedRecipeProductType()
        : '';
    var batchSizeRaw = batchSizeEl ? String(batchSizeEl.value || '').trim() : '';
    var batchSize = batchSizeRaw === '' ? null : parseInt(batchSizeRaw, 10);
    var maxVac = (typeof getFactoryMaxVacuumMmHg === 'function') ? getFactoryMaxVacuumMmHg() : 650;
    var vacuumMmHg = parseFloat(vacEl && vacEl.value ? vacEl.value : '');
    var durationSec = (typeof parseMmSs === 'function') ? parseMmSs(timeEl && timeEl.value ? timeEl.value : '') : null;

    var errEl = document.getElementById('create-recipe-input-error');
    function setRecipeInputError(msg) {
        if (!errEl) { if (msg) showAppModal(msg, 'Save Recipe'); return; }
        if (msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
        else { errEl.textContent = ''; errEl.style.display = 'none'; }
    }

    if (!productName) {
        setRecipeInputError('Product name is required.');
        return;
    }
    if (!typeChoice) {
        setRecipeInputError('Select a product type.');
        return;
    }
    if (typeChoice === 'Other' && !productType) {
        setRecipeInputError('Enter the product type.');
        var otherFocus = document.getElementById('recipe-product-type-other');
        if (otherFocus) otherFocus.focus();
        return;
    }
    if (!productType) {
        setRecipeInputError('Select a product type.');
        return;
    }
    if (batchSizeRaw !== '' && (isNaN(batchSize) || batchSize < 1)) {
        setRecipeInputError('Batch size must be a whole number of 1 or more, or leave blank.');
        return;
    }
    if (isNaN(vacuumMmHg) || vacuumMmHg < 1) {
        setRecipeInputError('Enter a valid vacuum value (mmHg).');
        return;
    }
    if (vacuumMmHg > maxVac) {
        setRecipeInputError('Vacuum cannot exceed factory maximum of ' + maxVac + ' mmHg.');
        return;
    }
    if (!durationSec) {
        setRecipeInputError('Enter a valid time in mm:ss format (e.g. 01:30).');
        return;
    }
    setRecipeInputError('');

    var recipe = {
        productName: productName,
        name: productName,
        productType: productType,
        batchSize: batchSize,
        vacuumMmHg: vacuumMmHg,
        durationSec: durationSec,
        durationDisplay: (typeof formatMmSs === 'function') ? formatMmSs(durationSec) : '',
        createdAt: new Date().toISOString()
    };
    var editId = window.currentEditingRecipeId;
    if (editId) {
        recipe.id = editId;
    }

    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');
    var continueBtn = document.getElementById('create-recipe-continue-btn');

    function setRecipeSaveUiActive(active) {
        window._recipeSaveInFlight = !!active;
        if (continueBtn) continueBtn.disabled = !!active;
    }

    function persistRecipe(approvalToken) {
        setRecipeSaveUiActive(true);
        var headers = {};
        if (approvalToken) headers['X-Approval-Verify-Token'] = approvalToken;
        var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
        var method = editId ? 'PUT' : 'POST';
        return apiRequest(url, {
            method: method,
            headers: headers,
            body: recipe
        }).then(function (result) {
            window.currentEditingRecipeId = null;
            setRecipeSaveUiActive(false);
            if (typeof resetCreateRecipeStep1Form === 'function') resetCreateRecipeStep1Form();
            goToPage('manage-recipes');
            loadManageRecipes();
            var saved = (result && result.recipe) ? result.recipe : null;
            var st = saved ? getEffectiveRecipeApprovalStatus(saved) : 'approved';
            if (role === 'factory' || st === 'approved') {
                showAppModal('Recipe saved and approved.', 'Save Recipe');
            } else {
                showAppModal('Recipe saved. It is pending approval.', 'Save Recipe');
            }
            return result;
        }).catch(function (err) {
            setRecipeSaveUiActive(false);
            console.error('Failed to save recipe:', err);
            var msg = (err && err.message) ? String(err.message) : 'Unknown error';
            showAppModal('Failed to save recipe: ' + msg, 'Save Recipe');
            throw err;
        });
    }

    openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
        if (!token) {
            showAppModal('Recipe not saved. Recipe approval credentials are required.', 'Save Recipe');
            return;
        }
        return persistRecipe(token);
    }).catch(function (err) {
        if (err && err.message && err.message.indexOf('QA verification UI') >= 0) {
            showAppModal(err.message, 'Save Recipe');
        }
    });
}

function _closeValidationRunHardwareEs() {
    if (typeof window._stopVdPressurePoll === 'function') {
        window._stopVdPressurePoll();
    }
    if (validationRunHardwareEs) {
        if (validationRunSseListener) {
            try {
                validationRunHardwareEs.removeEventListener('message', validationRunSseListener);
            } catch (e) {}
            validationRunSseListener = null;
        }
        try {
            validationRunHardwareEs.close();
        } catch (e2) {}
        validationRunHardwareEs = null;
    }
}

function updateValidationRunTimerUi(secondsRemaining) {
    var total = VALIDATION_RUN_DURATION_SEC;
    var sec = Math.max(0, Math.min(total, parseInt(secondsRemaining, 10) || 0));
    setValRunEl('val-run-timer-digital', String(sec));
    var fill = document.getElementById('val-run-timer-fill');
    if (fill && fill.style) {
        var deg = total > 0 ? (sec / total) * 360 : 0;
        fill.style.setProperty('--val-timer-sweep-deg', String(deg) + 'deg');
    }
}

function _resetValidationRunActionButtonToStart() {
    var btn = document.getElementById('btn-validation-start-abort');
    var label = document.getElementById('btn-validation-label');
    if (btn) {
        btn.className = 'btn btn-primary val-run-start-btn';
        btn.disabled = false;
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
    }
    if (label) label.textContent = 'Start Validation';
}

function validationRunHardwareMessage(ev) {
    if (validationRunState !== 'running') return;
    try {
        var raw = ev.data;
        if (raw == null || raw === '') return;
        var data = JSON.parse(raw);
        if (data.ping) return;
        var kind = String(data.kind || '');
        var norm = String(data.normalized != null ? data.normalized : '').toLowerCase().replace(/\*$/, '');
        var lineStr = String(data.line != null ? data.line : '').trim();
        if (kind === 'ok' || norm === 'ok') return;
        if (kind === 'stopped' || norm === 'stopped') return;
        if (kind === 'progress' || /^\d+$/.test(norm)) {
            var n = parseInt(norm || lineStr, 10);
            if (!isNaN(n) && n >= 0) {
                validationRunCurrentCount = n;
                setValRunEl('val-run-tap-count', String(n));
            }
            return;
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
            updateValidationRunTimerUi(VALIDATION_RUN_DURATION_SEC);
            if (kind === 'adapter_error' || _validationErrorIsAdapterRelated(lineStr) || _validationErrorIsAdapterRelated(norm)) {
                showValidationAdapterCheckModal({
                    source: 'sse',
                    line: lineStr,
                    normalized: norm
                });
            } else {
                showAppModal(
                    'Hardware error during validation: ' + (lineStr || norm || 'Unknown'),
                    'Validation'
                );
            }
        }
    } catch (ex) {
        // ignore malformed SSE payloads
    }
}

function validationRunTimerTick() {
    validationRunSecondsRemaining--;
    if (validationRunSecondsRemaining < 0) validationRunSecondsRemaining = 0;
    updateValidationRunTimerUi(validationRunSecondsRemaining);
    if (validationRunSecondsRemaining <= 0) {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        completeValidationRunAfterDuration();
    }
}



function buildValidationRunSnapshot(isPass) {
    var usp = lastValidationType === 'load' ? 'Pressure Decay' : 'Vacuum Decay';
    var tapsMin = lastValidationType === 'load' ? 250 : 300;
    var dropHeight = lastValidationType === 'load' ? 3 : 14;
    var now = new Date().toISOString();
    return {
        validationSubtype: lastValidationType,
        usp: usp,
        tapsMin: tapsMin,
        dropHeight: dropHeight,
        expectedTapCount: validationRunTarget,
        expectedTolerance: validationRunTolerance,
        expectedTapCountMin: validationRunMin,
        expectedTapCountMax: validationRunMax,
        actualTapCount: validationRunCurrentCount,
        validationDurationSec: VALIDATION_RUN_DURATION_SEC,
        status: isPass ? 'Pass' : 'Fail',
        completedAt: now
    };
}

function getOrderedValidationSessionRuns() {
    var runs = [];
    if (validationSessionResults.distance) runs.push(validationSessionResults.distance);
    if (validationSessionResults.load) runs.push(validationSessionResults.load);
    return runs;
}

function buildCombinedValidationReportPayload() {
    var runs = getOrderedValidationSessionRuns();
    if (!runs.length) return null;
    var overallPass = true;
    var hasAborted = false;
    var hasPassFail = false;
    for (var i = 0; i < runs.length; i++) {
        var st = String(runs[i].status || '').toLowerCase();
        if (st === 'aborted') hasAborted = true;
        else if (st === 'pass') hasPassFail = true;
        else if (st === 'fail') {
            hasPassFail = true;
            overallPass = false;
        }
    }
    // Without operator Pass/Fail (approval decides later), keep status completed.
    // Do NOT bake "Pending Approval" into the report name — that is reportApprovalStatus only.
    // Otherwise approved reports keep showing as "Pending Approval" in the list.
    var overallStatus = hasAborted
        ? 'aborted'
        : (hasPassFail ? (overallPass ? 'Pass' : 'Fail') : 'completed');
    var reportName = 'Validation - Vacuum';
    if (hasAborted) reportName = 'Validation - Vacuum - Aborted';
    else if (hasPassFail) reportName = 'Validation - Vacuum - ' + overallStatus;
    var user = window.currentUser || {};
    var now = new Date().toISOString();
    var first = runs[0] || {};
    var setVac = first.setVacuumMmHg;
    var actVac = first.actualVacuumMmHg;
    var setDur = first.setDurationSec != null ? first.setDurationSec : first.validationDurationSec;
    var setDurDisp = first.setDurationDisplay
        || (setDur != null && typeof formatMmSs === 'function' ? formatMmSs(setDur) : null);
    var actDur = first.actualDurationSec;
    return {
        name: reportName,
        type: 'validation',
        validationSubtype: 'distance',
        validationRuns: runs,
        status: overallStatus,
        usp: first.usp || 'Vacuum',
        setVacuumMmHg: setVac,
        actualVacuumMmHg: actVac,
        setDurationSec: setDur,
        setDurationDisplay: setDurDisp,
        actualDurationSec: actDur,
        validationDurationSec: setDur,
        createdAt: now,
        completedAt: now,
        operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
        operatorName: user.name || user.username || '--',
        employeeId: user.username || '--',
        testData: {
            validationRuns: runs,
            validationSubtype: 'distance',
            usp: first.usp || 'Vacuum',
            status: overallStatus,
            setVacuumMmHg: setVac,
            actualVacuumMmHg: actVac,
            setDurationSec: setDur,
            setDurationDisplay: setDurDisp,
            actualDurationSec: actDur,
            validationDurationSec: setDur,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatedByUsername: normalizeReportUsername(user.username || user.name || ''),
            createdAt: now,
            completedAt: now
        }
    };
}

function saveCombinedValidationReport() {
    var reportPayload = buildCombinedValidationReportPayload();
    if (!reportPayload) return Promise.resolve();
    var isAborted = String(reportPayload.status || '').toLowerCase() === 'aborted'
        || String((reportPayload.testData && reportPayload.testData.status) || '').toLowerCase() === 'aborted';
    _postRunSessionHold = true;
    markAutoLogoutActivity();
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: reportPayload })
        .then(function (result) {
            if (typeof clearTestRunCheckpoint === 'function') clearTestRunCheckpoint();
            validationSessionResults = { distance: null, load: null };
            validationCompletion = { distance: false, load: false };
            var reportId = result && result.id;
            currentReportFilter = 'validation';
            if (reportId) {
                if (typeof openReportPreview === 'function') {
                    openReportPreview(reportId, isAborted ? {} : { setGate: true });
            } else {
                    _postRunSessionHold = false;
                    goToPage('reports');
                }
            } else {
                _postRunSessionHold = false;
                goToPage('reports');
            }
        })
        .catch(function (err) {
            _postRunSessionHold = false;
            console.error('Failed to save validation report', err);
            currentReportFilter = 'validation';
            goToPage('reports');
        });
}

function validationRunsFromPreview(preview) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (preview.validationRuns && preview.validationRuns.length) return preview.validationRuns;
    if (td && td.validationRuns && td.validationRuns.length) return td.validationRuns;
    return null;
}

function renderValidationDetailsInPreview(preview) {
    var titleEl = document.getElementById('report-validation-calibration-title');
    var bodyEl = document.getElementById('report-validation-calibration-body');
    if (!bodyEl) return;
    var fmtTime = (typeof window.formatMmSs === 'function') ? window.formatMmSs : function (sec) {
        var t = Math.max(0, parseInt(sec, 10) || 0);
        var m = Math.floor(t / 60);
        var s = t % 60;
        return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    };
    if (titleEl) titleEl.textContent = 'VALIDATION RESULTS';
    var td = preview.testData || preview;
    var runs = validationRunsFromPreview(preview);
    if ((!runs || !runs.length) && (td.setVacuumMmHg != null || preview.setVacuumMmHg != null || td.actualVacuumMmHg != null)) {
        runs = [{
            usp: td.usp || preview.usp || 'Vacuum',
            validationSubtype: td.validationSubtype || preview.validationSubtype || 'distance',
            setVacuumMmHg: td.setVacuumMmHg != null ? td.setVacuumMmHg : preview.setVacuumMmHg,
            actualVacuumMmHg: td.actualVacuumMmHg != null ? td.actualVacuumMmHg : preview.actualVacuumMmHg,
            setDurationSec: td.setDurationSec != null ? td.setDurationSec : preview.setDurationSec,
            setDurationDisplay: td.setDurationDisplay || preview.setDurationDisplay,
            actualDurationSec: td.actualDurationSec != null ? td.actualDurationSec : preview.actualDurationSec,
            validationDurationSec: td.validationDurationSec != null ? td.validationDurationSec : preview.validationDurationSec,
            status: td.status || preview.status,
            completedAt: td.completedAt || preview.completedAt || preview.createdAt
        }];
    }
    var rows = [];
    if (runs && runs.length) {
        runs.forEach(function (run) {
            var dateStr = formatReportDate(run.completedAt || preview.completedAt || preview.createdAt);
            var method = run.usp || (run.validationSubtype === 'load' ? 'Pressure Decay' : 'Vacuum Decay');
            var status = run.status || '--';
            if (String(status).toLowerCase() === 'aborted') status = 'Aborted';
            var setVac = run.setVacuumMmHg != null ? run.setVacuumMmHg : '--';
            var actualVac = run.actualVacuumMmHg != null ? run.actualVacuumMmHg : '--';
            var setTime = run.setDurationDisplay
                || (run.setDurationSec != null ? fmtTime(run.setDurationSec)
                    : (run.validationDurationSec != null ? fmtTime(run.validationDurationSec) : '--'));
            var actualTime = run.actualDurationSec != null ? fmtTime(run.actualDurationSec) : '--';
            rows.push('<tr><th colspan="4" class="report-validation-usp-header">' + method + ' validation</th></tr>');
            rows.push('<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>');
            rows.push('<tr><th>Method</th><td>' + method + '</td><th>Status</th><td>' + status + '</td></tr>');
            rows.push('<tr><th>Set Vacuum (mmHg)</th><td>' + setVac + '</td><th>Actual Vacuum (mmHg)</th><td>' + actualVac + '</td></tr>');
            rows.push('<tr><th>Set Time</th><td>' + setTime + '</td><th>Actual Time</th><td>' + actualTime + '</td></tr>');
        });
    } else {
        rows.push('<tr><td colspan="4">No validation data</td></tr>');
    }
    bodyEl.innerHTML = rows.join('');
}

function renderCalibrationDetailsInPreview(preview) {
    var titleEl = document.getElementById('report-validation-calibration-title');
    var bodyEl = document.getElementById('report-validation-calibration-body');
    if (!bodyEl) return;
    if (titleEl) titleEl.textContent = 'CALIBRATION DETAILS';
    var td = preview.testData || preview;
    var dateStr = formatReportDate(td.completedAt || preview.completedAt || preview.createdAt);
    var setVac = td.setVacuumMmHg != null ? td.setVacuumMmHg : (preview.setVacuumMmHg != null ? preview.setVacuumMmHg : '--');
    var actualVac = td.actualVacuumMmHg != null ? td.actualVacuumMmHg : (preview.actualVacuumMmHg != null ? preview.actualVacuumMmHg : '--');
    var gaugeVac = td.calibValue != null ? td.calibValue : actualVac;
    var statusRaw = td.status || preview.status || 'Completed';
    var status = (String(statusRaw).toLowerCase() === 'aborted')
        ? 'Aborted'
        : (typeof reportStatusDisplayLabel === 'function'
            ? reportStatusDisplayLabel(preview, td)
            : statusRaw);
    var rows = [
        '<tr><th colspan="4" class="report-validation-usp-header">Vacuum pressure calibration</th></tr>',
        '<tr><th>Date / Time</th><td colspan="3">' + dateStr + '</td></tr>',
        '<tr><th>Target Vacuum (mmHg)</th><td>' + setVac + '</td><th>Status</th><td>' + status + '</td></tr>',
        '<tr><th>External Gauge (mmHg)</th><td>' + gaugeVac + '</td><th>CALIBVALUE</th><td>' + gaugeVac + '</td></tr>'
    ];
    bodyEl.innerHTML = rows.join('');
}

function completeValidationRunAfterDuration() {
    validationRunState = 'idle';
    validationRunBackendPending = false;
    applyValidationRunLockUi(false);
    stopValidationOnBackend().catch(function () {});
    _closeValidationRunHardwareEs();
    setValRunEl('val-run-status', 'Completed');
    setValRunEl('val-run-status-sub', 'Validation run finished');
    var detailEl = document.getElementById('val-run-result-detail');
    var isPass = validationRunCurrentCount >= validationRunMin && validationRunCurrentCount <= validationRunMax;
    _setValResultVisible(true);
    _setValRunResultBadge(isPass);
    if (detailEl) {
        detailEl.textContent =
            'After ' +
            String(VALIDATION_RUN_DURATION_SEC) +
            ' s: expected ' +
            validationRunTarget +
            ' (\u00b1' +
            validationRunTolerance +
            '), actual ' +
            validationRunCurrentCount +
            '.';
    }
    _resetValidationRunActionButtonToStart();

    logAuditEvent('Validation finished', (lastValidationType === 'load' ? 'Pressure Decay' : 'Vacuum Decay') + ' validation: ' + (isPass ? 'Pass' : 'Fail'), {
        eventType: 'lifecycle',
        entityType: 'validation',
        extra: {
            validationType: lastValidationType,
            status: isPass ? 'Pass' : 'Fail',
            actualTapCount: validationRunCurrentCount,
            expectedTapCount: validationRunTarget
        }
    });

    if (lastValidationType === 'distance') {
        validationSessionResults.distance = buildValidationRunSnapshot(isPass);
        validationCompletion.distance = true;
    }

    saveCombinedValidationReport();
}

function startValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    var mode = lastValidationType === 'load' ? 'usp2' : 'usp1';
    return apiRequest(API_BASE + '/api/hardware/validation/load/start', { method: 'POST', body: { mode: mode } });
}

function stopValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    return apiRequest(API_BASE + '/api/hardware/validation/load/stop', { method: 'POST' });
}

function toggleValidationRunState() {
    if (validationRunBackendPending) return;
    if (validationRunState === 'idle') {
        var btn = document.getElementById('btn-validation-start-abort');
        var label = document.getElementById('btn-validation-label');
        validationRunBackendPending = true;
        applyValidationRunLockUi(true);
        if (btn) btn.disabled = true;
        setValRunEl('val-run-status', 'Starting');
        setValRunEl('val-run-status-sub', validationHardwareEnabled ? 'Checking holder…' : 'Starting');

        function _validationRunStartFailed(err) {
            validationRunState = 'idle';
            applyValidationRunLockUi(false);
            _closeValidationRunHardwareEs();
            stopValidationOnBackend().catch(function () {});
            setValRunEl('val-run-status', 'Ready');
            setValRunEl('val-run-status-sub', 'Press Start to begin');
            _setValRunStatusStyle('ready');
            if (err && err.message === 'adapter_check') {
                showValidationAdapterCheckModal({ source: 'start' });
            } else {
                showAppModal('Failed to start validation: ' + (err && err.message ? err.message : 'Unknown error'), 'Validation');
            }
        }

        function _runValidationHardwareStart() {
            _closeValidationRunHardwareEs();
            return startValidationOnBackend().then(function (res) {
                if (!res || res.ok !== true) {
                    var errText = (res && (res.error || res.response || res.message)) || 'Hardware did not acknowledge start';
                    if (_validationErrorIsAdapterRelated(errText) || (res && res.error === 'adapter_mismatch')) {
                        return Promise.reject(new Error('adapter_check'));
                    }
                    return Promise.reject(new Error(errText));
                }
                try {
                    validationRunHardwareEs = new EventSource(_getHardwareSseUrl());
                } catch (esErr) {
                    return Promise.reject(new Error('Could not connect to the hardware stream'));
                }
                validationRunSseListener = validationRunHardwareMessage;
                validationRunHardwareEs.addEventListener('message', validationRunSseListener);
                validationRunState = 'running';
                applyValidationRunLockUi(true);
                logAuditEvent('Validation started', validationAdapterLabel() + ' validation run started', {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: { validationType: lastValidationType }
                });
                syncOperationCheckpoint(buildValidationCheckpointPayload());
                validationRunCurrentCount = 0;
                setValRunEl('val-run-tap-count', '0');
                validationRunSecondsRemaining = VALIDATION_RUN_DURATION_SEC;
                updateValidationRunTimerUi(validationRunSecondsRemaining);
                setValRunEl('val-run-status', 'Running');
                setValRunEl('val-run-status-sub', String(VALIDATION_RUN_DURATION_SEC) + 's run — hold time from device');
                _setValRunStatusStyle('running');
                _setValResultVisible(false);
                if (btn) {
                    btn.className = 'btn btn-primary val-run-start-btn is-abort';
                    btn.disabled = false;
                    btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9726;</span><span id="btn-validation-label">Abort</span>';
                }
                if (label) label.textContent = 'Abort';
                validationRunIntervalId = setInterval(validationRunTimerTick, 1000);
            });
        }

        var startPromise;
        if (!validationHardwareEnabled) {
            startPromise = _runValidationHardwareStart();
        } else {
            startPromise = verifyValidationAdapter().then(function (adapterResult) {
                if (!adapterResult || !adapterResult.ok) {
                    return Promise.reject(new Error('adapter_check'));
                }
                setValRunEl('val-run-status-sub', 'Holder OK — starting…');
                return _runValidationHardwareStart();
            });
        }

        startPromise.catch(_validationRunStartFailed).finally(function () {
            validationRunBackendPending = false;
            if (btn) btn.disabled = false;
        });
    } else {
        abortValidationRun();
    }
}


function selectRole(roleName) {
    var hidden = document.getElementById('selected-role');
    if (hidden) {
        hidden.value = roleName;
    }
    var container = document.querySelector('.role-selection-container .role-options');
    if (container) {
        var buttons = container.querySelectorAll('.role-btn');
        var roleNorm = String(roleName || '').trim();
        buttons.forEach(function (btn) {
            btn.classList.remove('active');
            var btnRole = (btn.getAttribute('data-role') || '').trim();
            if (btnRole && btnRole === roleNorm) {
                btn.classList.add('active');
            }
        });
    }
    var permPanel = document.getElementById('add-member-permissions-panel');
    if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    } else if (permPanel && !permPanel.classList.contains('is-hidden') && typeof renderAddMemberPermissionCards === 'function') {
        renderAddMemberPermissionCards();
    }
    if (typeof ensureAddMemberPageScroll === 'function') {
        ensureAddMemberPageScroll();
    }
}

function getStrongPasswordError(password) {
    var pwd = String(password || '');
    if (
        pwd.length >= 8 &&
        /[A-Z]/.test(pwd) &&
        /[a-z]/.test(pwd) &&
        /[0-9]/.test(pwd) &&
        /[^A-Za-z0-9]/.test(pwd)
    ) {
        return '';
    }
    return (
        'Password must meet all of the following:\n\n' +
        '• At least 8 characters long.\n' +
        '• At least one uppercase letter (A–Z).\n' +
        '• At least one lowercase letter (a–z).\n' +
        '• At least one number (0–9).\n' +
        '• At least one symbol (not only letters and digits).\n\n' +
        'Update your password to satisfy every item, then try again.'
    );
}

function sessionCanAssignFeatureOverrides() {
    var u = window.currentUser;
    var role = (typeof getCurrentRole === 'function') ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory' || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, u))) {
        return true;
    }
    if (u && typeof canPerformAction === 'function') {
        return canPerformAction(u, 'user-add', 'create');
    }
    return false;
}

function canEditMembers() {
    var u = (typeof window !== 'undefined' && window.currentUser) ? window.currentUser : null;
    var role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
    if (role === 'factory' || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, u))) {
        return true;
    }
    if (u && typeof canPerformAction === 'function') {
        return canPerformAction(u, 'user-manage', 'edit');
    }
    return false;
}

function _isEditingOwnMemberProfile(memberId) {
    if (memberId == null) return false;
    var u = window.currentUser;
    if (!u) return false;
    if (u.id != null && Number(u.id) === Number(memberId)) return true;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var target = members.find(function (m) { return Number(m.id) === Number(memberId); });
    if (!target) return false;
    var curUn = String(u.username || '').trim().toLowerCase();
    var tgtUn = String(target.username || '').trim().toLowerCase();
    return !!(curUn && tgtUn && curUn === tgtUn);
}

function _setAddMemberPageMode(isEdit, isSelfEdit) {
    var titleEl = document.getElementById('add-member-page-title');
    var saveBtn = document.getElementById('add-member-save-btn');
    var userIdEl = document.getElementById('add-userid');
    var pwdLabel = document.getElementById('add-password-label');
    var confirmPwdLabel = document.getElementById('add-confirm-password-label');
    var roleContainer = document.querySelector('#page-add-member .role-selection-container');
    var headerTitle = document.getElementById('header-title');
    if (titleEl) titleEl.textContent = isEdit ? 'Edit Profile' : 'Add New Member';
    if (saveBtn) saveBtn.textContent = isEdit ? 'Update Profile' : 'Save Profile';
    if (headerTitle) headerTitle.textContent = isEdit ? 'Edit Profile' : (PAGE_TITLES['add-member'] || 'Add New Member');
    if (userIdEl) {
        userIdEl.readOnly = !!isEdit;
        userIdEl.disabled = !!isEdit;
        if (isEdit) userIdEl.classList.add('input-readonly');
        else userIdEl.classList.remove('input-readonly');
    }
    if (pwdLabel) pwdLabel.textContent = isEdit ? 'New Password (optional)' : 'Password';
    if (confirmPwdLabel) confirmPwdLabel.textContent = isEdit ? 'Confirm New Password (optional)' : 'Confirm Password';
    if (roleContainer) roleContainer.style.display = isSelfEdit ? 'none' : '';
    if (isSelfEdit) {
        var panel = document.getElementById('add-member-permissions-panel');
        if (panel) {
            panel.classList.add('is-hidden');
            panel.setAttribute('aria-hidden', 'true');
        }
    } else if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    }
}

function _loadMemberOverridesIntoPanel(overrides) {
    var norm = (typeof normalizeFeatureOverrides === 'function')
        ? normalizeFeatureOverrides(overrides)
        : { allow: [], deny: [] };
    _addMemberFeatureOverrides = {
        allow: (norm.allow || []).slice(),
        deny: []
    };
}

function openEditMember(id) {
    if (!id) return;
    if (typeof canEditMembers === 'function' && !canEditMembers()) {
        showAppModal('You do not have permission to edit profiles.', 'Permission');
        return;
    }
    apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member || member.id == null) throw new Error('Member not found');
            var uname = String(member.username || '').trim().toUpperCase();
            if (uname === FACTORY_USERNAME) {
                showAppModal('The factory account cannot be edited here.', 'Edit Profile');
                return;
            }
            editingMemberId = member.id;
            var isSelf = _isEditingOwnMemberProfile(member.id);
            ['add-password', 'add-confirm-password'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });
            var fullNameEl = document.getElementById('add-fullname');
            var userIdEl = document.getElementById('add-userid');
            if (fullNameEl) fullNameEl.value = member.name || '';
            if (userIdEl) userIdEl.value = member.username || '';
            if (!isSelf && typeof selectRole === 'function') {
                selectRole(member.role || 'User');
            }
            if (!isSelf) _loadMemberOverridesIntoPanel(member.featureOverrides);
            _setAddMemberPageMode(true, isSelf);
            goToPage('add-member');
            setTimeout(function () {
                if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
                if (fullNameEl) fullNameEl.focus();
            }, 60);
        })
        .catch(function (err) {
            showAppModal('Failed to load profile: ' + (err && err.message ? err.message : 'Unknown error'), 'Edit Profile');
        });
}

function saveMemberForm() {
    if (editingMemberId != null) {
        saveEditedMember();
        return;
    }
    saveNewMember();
}

function saveEditedMember() {
    var memberId = editingMemberId;
    if (memberId == null) return;
    var modalTitle = 'Edit Profile';
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');

    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';
    var isSelf = _isEditingOwnMemberProfile(memberId);

    if (!fullName || !username) {
        showAppModal('Full name and User ID are required.', modalTitle);
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account.', modalTitle);
        return;
    }
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            showAppModal('Password and Confirm Password do not match.', modalTitle);
            return;
        }
        var pwdErr = getStrongPasswordError(password);
        if (pwdErr) {
            showAppModal(pwdErr, modalTitle);
            return;
        }
    }

    apiRequest(API_BASE + '/api/data/members/' + memberId, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member) throw new Error('Member not found');
            member.name = fullName;
            member.username = username;
            if (!isSelf) {
                member.role = role;
            }
            if (password) {
                member.password = password;
            }
            if (!isSelf && typeof _addMemberPermissionsPanelShouldShow === 'function' && _addMemberPermissionsPanelShouldShow()) {
                var overrides = _addMemberFeatureOverrides || { allow: [], deny: [] };
                var allowList = (overrides.allow || []).slice();
                if (allowList.length < 1) {
                    showAppModal('Select at least one user functionality to continue.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                if (!sessionCanAssignFeatureOverrides()) {
                    showAppModal('You do not have permission to change permission cards.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                member.featureOverrides = { allow: allowList, deny: [] };
            }
            return apiRequest(API_BASE + '/api/data/members/' + memberId, {
                method: 'PUT',
                body: member
            }).then(function () {
                return {
                    username: username,
                    name: fullName,
                    memberId: memberId,
                    role: role,
                    isSelf: isSelf
                };
            });
        })
        .then(function (info) {
            editingMemberId = null;
            _clearAddMemberForm();
            loadMembersAndRender();
            var canManage = typeof canEditMembers === 'function' && canEditMembers();
            if (info && biometricEnabledSetting && canManage && !info.isSelf) {
                _addMemberLastSavedId = info.memberId;
                window._biometricEnrollReturnPage = 'manage-members';
                _populateMemberBiometricSummary({
                    id: info.memberId,
                    username: info.username,
                    name: info.name,
                    role: info.role
                });
                goToPage('member-biometric');
                return;
            }
            showAppModal('Profile updated successfully.', modalTitle);
            goToPage(info && info.isSelf ? 'user-profile' : 'manage-members');
        })
        .catch(function (err) {
            if (err && err.message === 'permissions') return;
            showAppModal('Failed to update profile: ' + (err && err.message ? err.message : 'Unknown error'), modalTitle);
        });
}

function saveNewMember() {
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');

    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';

    if (!fullName || !username || !password || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Add Member');
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account and cannot be used.', 'Add Member');
        return;
    }
    if (password !== confirmPassword) {
        showAppModal('Password and Confirm Password do not match.', 'Add Member');
        return;
    }
    var passwordError = getStrongPasswordError(password);
    if (passwordError) {
        showAppModal(passwordError, 'Add Member');
        return;
    }

    var overrides = _addMemberFeatureOverrides || { allow: [], deny: [] };
    var hasOverrides = (overrides.allow && overrides.allow.length) || (overrides.deny && overrides.deny.length);
    if (hasOverrides && !sessionCanAssignFeatureOverrides()) {
        showAppModal('You do not have permission to assign permission cards when creating a member.', 'Add Member');
        return;
    }
    if (typeof _addMemberPermissionsPanelShouldShow === 'function' && _addMemberPermissionsPanelShouldShow()) {
        var allowList = (overrides.allow && overrides.allow.length) ? overrides.allow : [];
        if (allowList.length < 1) {
            showAppModal('Select at least one user functionality to continue.', 'Add Member');
            return;
        }
    }

    var payload = {
        name: fullName,
        username: username,
        password: password,
        role: role,
        featureOverrides: {
            allow: (overrides.allow || []).slice(),
            deny: []
        }
    };

    apiRequest(API_BASE + '/api/data/members', {
        method: 'POST',
        body: payload
    }).then(function (data) {
        if (data && data.id) {
            _addMemberLastSavedId = data.id;
            var savedMember = (data && data.member) ? data.member : {
                id: data.id, name: fullName, username: username, role: role
            };
            _clearAddMemberForm();
            if (biometricEnabledSetting) {
                _populateMemberBiometricSummary(savedMember);
                goToPage('member-biometric');
            } else {
                showAppModal('Member saved successfully.', 'Add Member');
                goToPage('user-profile');
            }
        } else {
            showAppModal((data && data.error) || 'Failed to save member.', 'Add Member');
        }
    }).catch(function (err) {
        showAppModal('Failed to save member: ' + (err && err.message ? err.message : 'Network error'), 'Add Member');
    });
}
function closeRoleModal() {
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    currentMemberIdForRoleEdit = null;
}

function openRoleModal(id) {
    if (!id) return;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var member = members.find(function (m) { return m.id === id; });
    if (!member) return;
    currentMemberIdForRoleEdit = id;
    var titleEl = document.getElementById('role-modal-title');
    var currentEl = document.getElementById('role-modal-current');
    if (titleEl) titleEl.textContent = 'Change Role for ' + (member.name || member.username || '');
    if (currentEl) currentEl.textContent = 'Current Role: ' + displayRoleLabel(member.role);
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function confirmRoleChange(newRole) {
    if (!currentMemberIdForRoleEdit) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-change-role', 'change')) {
            showAppModal('You do not have permission to change user roles.', 'Permission');
            closeRoleModal();
            return;
        }
    }
    var id = currentMemberIdForRoleEdit;
    apiRequest(API_BASE + '/api/data/members/' + id, {
        method: 'GET'
    }).then(function (data) {
        var member = data && data.member ? data.member : null;
        if (!member) throw new Error('Member not found');
        member.role = newRole;
        return apiRequest(API_BASE + '/api/data/members/' + id, {
            method: 'PUT',
            body: JSON.stringify(member)
        });
    }).then(function () {
        closeRoleModal();
        loadMembersAndRender();
    }).catch(function (err) {
        console.error('Failed to update member role', err);
        showAppModal('Failed to update role: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
    });
}

function _approvalVerifyModalOptionsForUserAdmin() {
    return {
        purpose: 'user_admin',
        titleText: 'Admin verification required',
        subtitleText: 'Enter credentials for a user with profile management permission.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Admin username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

function disableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-delete', 'delete')) {
            showAppModal('You do not have permission to disable members.', 'Permission');
            return;
        }
    }
    showConfirmModal('Are you sure you want to disable this member?', 'Disable Member').then(function (ok) {
        if (!ok) return;
        return apiRequest(API_BASE + '/api/data/members/' + id, {
            method: 'DELETE'
        }).then(function () {
                loadMembersAndRender();
            showAppModal('Member disabled.', 'Members');
        });
    }).catch(function (err) {
                console.error('Failed to disable member', err);
                showAppModal('Failed to disable member: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
    });
}

// ----- Add Member: form, permission overrides, biometric enrollment -----
var _addMemberFeatureOverrides = { allow: [], deny: [] };
var _addMemberLastSavedId = null;
var editingMemberId = null;

function _isProtectedFeatureKey(key) {
    return key === 'dashboard' || key === 'factory-settings' || key === 'factory-reset';
}

function _addMemberPermissionsPanelShouldShow() {
    return typeof sessionCanAssignFeatureOverrides === 'function' && sessionCanAssignFeatureOverrides();
}

function _refreshAddMemberPermissionsPanelVisibility() {
    var panel = document.getElementById('add-member-permissions-panel');
    if (!panel) return;
    var show = _addMemberPermissionsPanelShouldShow();
    panel.classList.toggle('is-hidden', !show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) renderAddMemberPermissionCards();
    if (show && typeof ensureAddMemberPageScroll === 'function') {
        setTimeout(ensureAddMemberPageScroll, 0);
    }
}

function renderAddMemberPermissionCards() {
    var grid = document.getElementById('permission-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var catalog = (typeof getPermissionCardCatalog === 'function')
        ? getPermissionCardCatalog()
        : ((typeof getFeatureCatalog === 'function') ? getFeatureCatalog() : []);
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    _addMemberFeatureOverrides.deny = [];
    catalog.forEach(function (feature) {
        var key = feature.key;
        if (_isProtectedFeatureKey(key)) return;
        var selected = _addMemberFeatureOverrides.allow.indexOf(key) !== -1;
        var accent = feature.accent != null ? feature.accent : 0;
        var card = document.createElement('div');
        card.className = 'permission-card' + (selected ? ' is-selected permission-card--accent-' + accent : '');
        card.setAttribute('data-feature-key', key);
        card.setAttribute('title', 'Select or clear this functionality');
        card.innerHTML =
            '<div class="permission-card-title">' + feature.label + '</div>' +
            '<div class="permission-card-desc">' + (feature.description || '') + '</div>';
        card.addEventListener('click', function () { togglePermissionCardAllow(key); });
        grid.appendChild(card);
    });
}

function togglePermissionCardAllow(featureKey) {
    if (!featureKey || _isProtectedFeatureKey(featureKey)) return;
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    var i = _addMemberFeatureOverrides.allow.indexOf(featureKey);
    if (i === -1) _addMemberFeatureOverrides.allow.push(featureKey);
    else _addMemberFeatureOverrides.allow.splice(i, 1);
    _addMemberFeatureOverrides.deny = [];
    renderAddMemberPermissionCards();
}

function cyclePermissionCardState(featureKey) {
    togglePermissionCardAllow(featureKey);
}

function resetPermissionOverrides() {
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    renderAddMemberPermissionCards();
}

function setAllPermissionOverrides() {
    renderAddMemberPermissionCards();
}

function _clearAddMemberForm() {
    editingMemberId = null;
    ['add-fullname', 'add-userid', 'add-password', 'add-confirm-password'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var userIdEl = document.getElementById('add-userid');
    if (userIdEl) {
        userIdEl.readOnly = false;
        userIdEl.disabled = false;
        userIdEl.classList.remove('input-readonly');
    }
    if (typeof selectRole === 'function') selectRole('User');
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    _setAddMemberPageMode(false, false);
}

function openAddMember() {
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        var who = (typeof window !== 'undefined' && window.currentUser) ? window.currentUser : role;
        if (!canPerformAction(who, 'user-add', 'create')) {
            showAppModal('You do not have permission to add new members.', 'Permission');
            return;
        }
    }
    editingMemberId = null;
    _clearAddMemberForm();
    _refreshAddMemberPermissionsPanelVisibility();
    goToPage('add-member');
    setTimeout(function () {
        if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
        var f = document.getElementById('add-fullname');
        if (f) f.focus();
    }, 60);
}

function cancelAddMemberEdit() {
    var returnToManage = editingMemberId != null;
    _clearAddMemberForm();
    goToPage(returnToManage ? 'manage-members' : 'user-profile');
}

function _populateMemberBiometricSummary(member) {
    if (!member) return;
    var nameEl = document.getElementById('member-biometric-name');
    var userEl = document.getElementById('member-biometric-username');
    var roleEl = document.getElementById('member-biometric-role');
    if (nameEl) nameEl.textContent = member.name || '--';
    if (userEl) userEl.textContent = member.username || '--';
    if (roleEl) {
        var roleLabel = (typeof displayRoleLabel === 'function')
            ? displayRoleLabel(member.role)
            : (member.role || '--');
        roleEl.textContent = roleLabel;
    }
}

function skipMemberBiometricEnrollment() {
    var returnPage = window._biometricEnrollReturnPage || 'user-profile';
    _addMemberLastSavedId = null;
    window._biometricEnrollReturnPage = null;
    goToPage(returnPage);
}

function backToMemberAfterBiometric() {
    var returnPage = window._biometricEnrollReturnPage || 'user-profile';
    _addMemberLastSavedId = null;
    window._biometricEnrollReturnPage = null;
    goToPage(returnPage);
}

function initializeDatetime() {
    var dateInput = document.getElementById('edit-date');
    var timeInput = document.getElementById('edit-time');
    if (!dateInput || !timeInput) return;
    function applyToInputs(now) {
        if (!dateInput.value) {
            var day = String(now.getDate()).padStart(2, '0');
            var month = String(now.getMonth() + 1).padStart(2, '0');
            var year = now.getFullYear();
            dateInput.value = day + '-' + month + '-' + year;
        }
        if (!timeInput.value) {
            var hours = String(now.getHours()).padStart(2, '0');
            var minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = hours + ':' + minutes;
        }
    }
    fetchDateTimeFromBackend().then(function (data) {
        var now = null;
        if (data && data.datetime) {
            var wall = parseWallDatetimeIso(data.datetime);
            if (wall) {
                now = new Date(wall.y, wall.mo - 1, wall.d, wall.h, wall.mi, wall.sec);
            }
        }
        if (!now || isNaN(now.getTime())) {
            if (data && data.date && data.time) {
                var parts = (data.date || '').split('-');
                var tparts = (data.time || '').split(':');
                if (parts.length >= 3 && tparts.length >= 2) {
                    var d = parseInt(parts[0], 10);
                    var m = parseInt(parts[1], 10) - 1;
                    var y = parseInt(parts[2], 10);
                    var h = parseInt(tparts[0], 10) || 0;
                    var min = parseInt(tparts[1], 10) || 0;
                    now = new Date(y, m, d, h, min, 0);
                }
            }
        }
        if (!now || isNaN(now.getTime())) now = new Date();
        applyToInputs(now);
    }).catch(function () {
        applyToInputs(new Date());
    });
}

function openDatePickerForEditDate() {
    var textInput = document.getElementById('edit-date');
    var hiddenInput = document.getElementById('edit-date-picker-hidden');
    if (!textInput || !hiddenInput) return;
    var val = (textInput.value || '').trim();
    if (val) {
        var parts = val.split('-');
        if (parts.length === 3) {
            var d = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            var y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y) && d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
                hiddenInput.value = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            }
        }
    }
    if (!hiddenInput.value) {
        var now = new Date();
        hiddenInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }
    function onDateChange() {
        var v = hiddenInput.value;
        if (!v) return;
        var ymd = v.split('-');
        if (ymd.length >= 3) {
            textInput.value = String(parseInt(ymd[2], 10)).padStart(2, '0') + '-' + String(parseInt(ymd[1], 10)).padStart(2, '0') + '-' + ymd[0];
        }
        hiddenInput.removeEventListener('change', onDateChange);
    }
    hiddenInput.addEventListener('change', onDateChange);
    hiddenInput.focus();
    if (typeof hiddenInput.showPicker === 'function') {
        try { hiddenInput.showPicker(); } catch (e) { hiddenInput.click(); }
    } else {
        hiddenInput.click();
    }
}

function applyDateTime() {
    var dateVal = (document.getElementById('edit-date').value || '').trim();
    var timeVal = (document.getElementById('edit-time').value || '').trim();
    if (!dateVal || !timeVal) {
        showAppModal('Please enter both date and time.', 'Error');
        return;
    }
    var dateParts = dateVal.split('-').map(Number);
    if (dateParts.length !== 3) {
        showAppModal('Enter date as DD-MM-YYYY.', 'Error');
        return;
    }
    var day = dateParts[0];
    var month = dateParts[1];
    var year = dateParts[2];
    var timeParts = timeVal.split(':');
    var hours = parseInt(timeParts[0], 10);
    var minutes = timeParts.length >= 2 ? parseInt(timeParts[1], 10) : 0;
    if (isNaN(hours)) hours = 0;
    if (isNaN(minutes)) minutes = 0;
    hours = Math.max(0, Math.min(23, hours));
    minutes = Math.max(0, Math.min(59, minutes));
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dtStr = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hours) + ':' + pad(minutes) + ':00';
    apiRequest((API_BASE || '') + '/api/set_datetime', {
        method: 'POST',
        body: { datetime: dtStr }
    }).then(function (data) {
        if (data && data.datetime) {
            var parts = parseWallDatetimeIso(data.datetime);
            if (parts) {
                _wallClockAnchor = { parts: parts, at: Date.now() };
                applyWallClockToTopBar(parts);
            }
        }
        updateDateTime();
        // Compare to WiFi/network clock (diagnostic only — does not change RTC).
        fetchDateTimeFromBackendCompare().then(function (cmp) {
            var msg = 'Date and time updated. Top bar and RTC now match what you set.';
            if (cmp && cmp.networkOffsetSec != null && !isNaN(cmp.networkOffsetSec)) {
                var off = parseInt(cmp.networkOffsetSec, 10);
                if (Math.abs(off) > 5) {
                    msg += ' WiFi/network clock differs by about ' + Math.abs(off) + 's'
                        + (off > 0 ? ' (network ahead).' : ' (device ahead).')
                        + ' Device keeps your set time (NTP stays off).';
                } else {
                    msg += ' Matches WiFi/network clock.';
                }
            }
            showAppModal(msg, 'Success', function () {
            goBack();
            });
        }).catch(function () {
            showAppModal('Date and time updated. Top bar and RTC now match what you set.', 'Success', function () {
                goBack();
            });
        });
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Network error';
        showAppModal('Failed to update date and time: ' + msg, 'Error');
    });
}

function openDatePicker(inputId) {
    var el = document.getElementById(inputId);
    if (el) {
        el.focus();
        try { el.showPicker && el.showPicker(); } catch (e) {}
    }
}

function updateLoginFactorySettingsDisplay(settings) {
    var s = settings || {};
    var model = s.modelNo && String(s.modelNo).trim() ? String(s.modelNo).trim() : '';
    var serial = s.serialNo && String(s.serialNo).trim() ? String(s.serialNo).trim() : '';
    var company = s.companyName && String(s.companyName).trim() ? String(s.companyName).trim() : '';

    var modelEl = document.getElementById('login-footer-model-no');
    var serialEl = document.getElementById('login-footer-serial-no');
    var footerInfo = document.getElementById('login-footer-info');
    if (modelEl) modelEl.textContent = model || '—';
    if (serialEl) serialEl.textContent = serial || '—';

    var show = !!(model || serial || company);
    if (footerInfo) footerInfo.style.display = show ? 'block' : 'none';
}

function _escapeIpConfigureText(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderIpConfigureList(payload) {
    var listEl = document.getElementById('ip-configure-list');
    if (!listEl) return;
    if (!payload || payload.ok === false) {
        var errMsg = (payload && (payload.error || payload.message)) ? (payload.error || payload.message) : 'Could not load network information.';
        listEl.innerHTML = '<div class="ip-configure-error">' + _escapeIpConfigureText(errMsg) + '</div>';
        return;
    }
    var wlan = payload.wlan != null && payload.wlan !== '' ? String(payload.wlan) : null;
    var lan = payload.lan != null && payload.lan !== '' ? String(payload.lan) : null;
    if (!wlan && !lan) {
        listEl.innerHTML = '<div class="ip-configure-empty">No IP address found. Check that this device is connected to the LAN or WLAN.</div>';
        return;
    }
    var rows = [
        { label: 'WLAN', address: wlan || '—' },
        { label: 'LAN', address: lan || '—' }
    ];
    var html = '';
    rows.forEach(function (row) {
        html += '<div class="ip-configure-row">' +
            '<span class="ip-configure-iface">' + _escapeIpConfigureText(row.label) + '</span>' +
            '<span class="ip-configure-address">' + _escapeIpConfigureText(row.address) + '</span>' +
            '</div>';
    });
    listEl.innerHTML = html;
}

function refreshIpConfigureAddresses() {
    var listEl = document.getElementById('ip-configure-list');
    var refreshBtn = document.querySelector('.btn-refresh-ip-configure');
    if (listEl) {
        listEl.innerHTML = '<div class="ip-configure-loading">Loading addresses…</div>';
    }
    if (refreshBtn) refreshBtn.disabled = true;
    var base = (typeof API_BASE !== 'undefined' ? API_BASE : '');
    var headers = { 'Accept': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        if (window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    fetch(base + '/api/system/network-addresses', { method: 'GET', headers: headers })
        .then(function (res) {
            return res.text().then(function (text) {
                var data = null;
                if (text) {
                    try {
                        data = JSON.parse(text);
                    } catch (parseErr) {
                        data = {
                            ok: false,
                            error: res.ok
                                ? 'Invalid response from server.'
                                : ('Request failed (' + res.status + ').')
                        };
                    }
                } else {
                    data = { ok: false, error: 'Empty response from server.' };
                }
                if (!res.ok && data && !data.error) {
                    data.ok = false;
                    data.error = data.error || ('Request failed (' + res.status + ').');
                }
                return data;
            });
        })
        .then(function (data) {
            if (typeof data !== 'object' || data === null) {
                _renderIpConfigureList({ ok: false, error: 'Invalid response from server.' });
                return;
            }
            _renderIpConfigureList(data);
        })
        .catch(function () {
            _renderIpConfigureList({ ok: false, error: 'Could not reach the device network service.' });
        })
        .finally(function () {
            if (refreshBtn) refreshBtn.disabled = false;
        });
}

function loadLoginFactorySettingsDisplay() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        updateLoginFactorySettingsDisplay(settings);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            updateLoginFactorySettingsDisplay(settings);
        } catch (e) {
            updateLoginFactorySettingsDisplay({});
        }
    });
}

function initFactorySettings() {
    var screen = document.getElementById('page-factory-settings');
    if (!screen) return;
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        setFactorySettingsForm(settings);
        applyFactoryAutoLogoutSetting(settings);
        try { localStorage.setItem('factorySettings', JSON.stringify(settings)); } catch (e) {}
    }).catch(function () {
        var stored = null;
        try { stored = localStorage.getItem('factorySettings'); } catch (e) {}
        var settings = stored ? JSON.parse(stored) : {};
        setFactorySettingsForm(settings);
        applyFactoryAutoLogoutSetting(settings);
    });
}

function setFactorySettingsForm(settings) {
    var idMap = [
        ['factory-company-name', 'companyName'],
        ['factory-company-location', 'companyLocation'],
        ['factory-serial-no', 'serialNo'],
        ['factory-model-no', 'modelNo'],
        ['factory-instrument-id', 'instrumentId'],
        ['factory-installation-date', 'installationDate'],
        ['factory-firmware', null],
        ['factory-installed-by', 'installedBy'],
        ['factory-max-recipes', 'maxRecipes'],
        ['factory-max-users', 'maxUsers'],
        ['factory-max-admins', 'maxAdmins'],
        ['factory-max-qa', 'maxQa'],
        ['factory-max-supervisors', 'maxSupervisors'],
        ['factory-password-reset-days', 'passwordResetPeriodDays'],
        ['factory-auto-logout-minutes', 'autoLogoutMinutes'],
        ['factory-max-vacuum-mmhg', 'maxVacuumMmHg'],
        ['factory-cal-target-vacuum', 'calibrationTargetVacuumMmHg'],
        ['factory-cal-release-time', 'calibrationReleaseTimeSec']
    ];
    idMap.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (!el) return;
        if (pair[1] === null) {
            if (pair[0] === 'factory-firmware') el.value = 'RDA -LT v1.0.0';
            return;
        }
        var val = settings[pair[1]];
        if (pair[1] === 'maxRecipes') el.value = String(val || 150);
        else if (pair[1] === 'maxUsers') el.value = String(val || 10);
        else if (pair[1] === 'maxAdmins') el.value = String(val || 2);
        else if (pair[1] === 'maxQa') el.value = String(val || 3);
        else if (pair[1] === 'maxSupervisors') el.value = String(val || 3);
        else if (pair[1] === 'passwordResetPeriodDays') el.value = String(val != null ? val : 30);
        else if (pair[1] === 'autoLogoutMinutes') el.value = String(val != null ? val : 0);
        else if (pair[1] === 'maxVacuumMmHg') el.value = String(val != null ? val : 650);
        else if (pair[1] === 'calibrationTargetVacuumMmHg') el.value = String(val != null ? val : 400);
        else if (pair[1] === 'calibrationReleaseTimeSec') el.value = String(val != null ? val : 80);
        else el.value = val || '';
    });
    var biometricEl = document.getElementById('factory-biometric-enabled');
    var biometricEnabled = normalizeBiometricEnabled(settings.biometricEnabled);
    if (biometricEl) biometricEl.value = biometricEnabled ? 'enabled' : 'disabled';
    var vacuumPresets = Array.isArray(settings.recipeVacuumPresets) && settings.recipeVacuumPresets.length === 3
        ? settings.recipeVacuumPresets
        : [200, 400, 600];
    var timePresetsSec = Array.isArray(settings.recipeTimePresetsSec) && settings.recipeTimePresetsSec.length === 3
        ? settings.recipeTimePresetsSec
        : [30, 60, 90];
    for (var presetIndex = 0; presetIndex < 3; presetIndex++) {
        var vacuumPresetEl = document.getElementById('factory-recipe-vacuum-preset-' + (presetIndex + 1));
        if (vacuumPresetEl) vacuumPresetEl.value = String(parseInt(vacuumPresets[presetIndex], 10) || [200, 400, 600][presetIndex]);
        var timePresetEl = document.getElementById('factory-recipe-time-preset-' + (presetIndex + 1));
        if (timePresetEl) {
            var presetSeconds = parseInt(timePresetsSec[presetIndex], 10) || [30, 60, 90][presetIndex];
            timePresetEl.value = (typeof formatMmSs === 'function')
                ? formatMmSs(presetSeconds)
                : String(Math.floor(presetSeconds / 60)).padStart(2, '0') + ':' + String(presetSeconds % 60).padStart(2, '0');
        }
    }
    applyBiometricSetting(biometricEnabled);
    updateLoginFactorySettingsDisplay(settings);
}

function saveFactorySettings() {
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'factory-settings', 'save')) {
            showAppModal('You do not have permission to save factory settings.', 'Permission');
            return;
        }
    }
    var companyNameEl = document.getElementById('factory-company-name');
    var companyLocationEl = document.getElementById('factory-company-location');
    var serialNoEl = document.getElementById('factory-serial-no');
    var modelNoEl = document.getElementById('factory-model-no');
    var instrumentIdEl = document.getElementById('factory-instrument-id');
    var installationDateEl = document.getElementById('factory-installation-date');
    var installedByEl = document.getElementById('factory-installed-by');
    var maxRecipesEl = document.getElementById('factory-max-recipes');
    var maxUsersEl = document.getElementById('factory-max-users');
    var maxAdminsEl = document.getElementById('factory-max-admins');
    var maxQaEl = document.getElementById('factory-max-qa');
    var maxSupervisorsEl = document.getElementById('factory-max-supervisors');
    var passwordResetDaysEl = document.getElementById('factory-password-reset-days');
    var autoLogoutEl = document.getElementById('factory-auto-logout-minutes');
    var biometricEnabledEl = document.getElementById('factory-biometric-enabled');
    var maxVacuumEl = document.getElementById('factory-max-vacuum-mmhg');
    var calTargetEl = document.getElementById('factory-cal-target-vacuum');
    var calReleaseEl = document.getElementById('factory-cal-release-time');

    var companyName = companyNameEl && companyNameEl.value ? companyNameEl.value.trim() : '';
    var companyLocation = companyLocationEl && companyLocationEl.value ? companyLocationEl.value.trim() : '';
    if (!companyName || !companyLocation) {
        showAppModal('Company Name and Company Location are required.', 'Factory Settings');
        return;
    }
    var maxRecipes = Math.max(1, Math.min(999, parseInt(maxRecipesEl && maxRecipesEl.value ? maxRecipesEl.value : 150, 10)));
    var maxUsers = Math.max(1, Math.min(999, parseInt(maxUsersEl && maxUsersEl.value ? maxUsersEl.value : 10, 10)));
    var maxAdmins = Math.max(1, Math.min(99, parseInt(maxAdminsEl && maxAdminsEl.value ? maxAdminsEl.value : 2, 10)));
    var maxQa = Math.max(1, Math.min(99, parseInt(maxQaEl && maxQaEl.value ? maxQaEl.value : 3, 10)));
    var maxSupervisors = Math.max(1, Math.min(99, parseInt(maxSupervisorsEl && maxSupervisorsEl.value ? maxSupervisorsEl.value : 3, 10)));
    var passwordResetPeriodDays = Math.max(1, Math.min(3650, parseInt(passwordResetDaysEl && passwordResetDaysEl.value ? passwordResetDaysEl.value : 30, 10)));
    var autoLogoutMinutes = Math.max(0, Math.min(10080, parseInt(autoLogoutEl && autoLogoutEl.value !== '' ? autoLogoutEl.value : '0', 10)));
    if (isNaN(autoLogoutMinutes)) autoLogoutMinutes = 0;
    var maxVacuumRaw = parseInt(maxVacuumEl && maxVacuumEl.value ? maxVacuumEl.value : 650, 10);
    if (!isNaN(maxVacuumRaw) && maxVacuumRaw > 650) {
        showAppModal('Maximum vacuum cannot exceed 650 mmHg.', 'Factory Settings');
        return;
    }
    var maxVacuumMmHg = Math.max(1, Math.min(650, isNaN(maxVacuumRaw) ? 650 : maxVacuumRaw));
    var calTargetRaw = parseInt(calTargetEl && calTargetEl.value ? calTargetEl.value : 400, 10);
    if (!Number.isInteger(calTargetRaw) || calTargetRaw < 1 || calTargetRaw > maxVacuumMmHg) {
        showAppModal(
            'Calibration target vacuum must be a whole number from 1 to ' + maxVacuumMmHg + ' mmHg.',
            'Factory Settings'
        );
        return;
    }
    var calReleaseRaw = parseInt(calReleaseEl && calReleaseEl.value ? calReleaseEl.value : 80, 10);
    if (!Number.isInteger(calReleaseRaw) || calReleaseRaw < 1 || calReleaseRaw > 5999) {
        showAppModal('Calibration release time (RL_TM) must be a whole number from 1 to 5999 seconds.', 'Factory Settings');
        return;
    }
    var recipeVacuumPresets = [];
    var recipeTimePresetsSec = [];
    for (var presetIndex = 1; presetIndex <= 3; presetIndex++) {
        var vacuumPresetEl = document.getElementById('factory-recipe-vacuum-preset-' + presetIndex);
        var vacuumPreset = Number(vacuumPresetEl && vacuumPresetEl.value ? vacuumPresetEl.value : '');
        if (!Number.isInteger(vacuumPreset) || vacuumPreset < 1 || vacuumPreset > maxVacuumMmHg) {
            showAppModal(
                'Vacuum preset ' + presetIndex + ' must be a whole number from 1 to ' + maxVacuumMmHg + ' mmHg.',
                'Factory Settings'
            );
            return;
        }
        recipeVacuumPresets.push(vacuumPreset);

        var timePresetEl = document.getElementById('factory-recipe-time-preset-' + presetIndex);
        var timePresetValue = timePresetEl && timePresetEl.value ? timePresetEl.value.trim() : '';
        var timePresetSeconds = (typeof parseMmSs === 'function') ? parseMmSs(timePresetValue) : null;
        if (!timePresetSeconds || timePresetSeconds > 5999) {
            showAppModal(
                'Time preset ' + presetIndex + ' must use mm:ss format and be between 00:01 and 99:59.',
                'Factory Settings'
            );
            return;
        }
        recipeTimePresetsSec.push(timePresetSeconds);
    }

    var data = {
        companyName: companyName,
        companyLocation: companyLocation,
        serialNo: serialNoEl && serialNoEl.value ? serialNoEl.value.trim() : '',
        modelNo: modelNoEl && modelNoEl.value ? modelNoEl.value.trim() : '',
        instrumentId: instrumentIdEl && instrumentIdEl.value ? instrumentIdEl.value.trim() : '',
        installationDate: installationDateEl && installationDateEl.value ? installationDateEl.value : '',
        firmware: 'RDA -LT v1.0.0',
        installedBy: installedByEl && installedByEl.value ? installedByEl.value.trim() : '',
        maxRecipes: maxRecipes,
        maxUsers: maxUsers,
        maxAdmins: maxAdmins,
        maxQa: maxQa,
        maxSupervisors: maxSupervisors,
        passwordResetPeriodDays: passwordResetPeriodDays,
        autoLogoutMinutes: autoLogoutMinutes,
        maxVacuumMmHg: maxVacuumMmHg,
        calibrationTargetVacuumMmHg: calTargetRaw,
        calibrationReleaseTimeSec: calReleaseRaw,
        recipeVacuumPresets: recipeVacuumPresets,
        recipeTimePresetsSec: recipeTimePresetsSec,
        biometricEnabled: normalizeBiometricEnabled(biometricEnabledEl ? biometricEnabledEl.value : true)
    };
    showConfirmModal('Save factory settings?', 'Factory Settings').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/factory-settings', { method: 'POST', body: data }).then(function () {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            applyFactoryAutoLogoutSetting(data);
            if (typeof applyCreateRecipeFactoryPresets === 'function') applyCreateRecipeFactoryPresets(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved successfully.', 'Factory Settings');
        }).catch(function (err) {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            applyFactoryAutoLogoutSetting(data);
            if (typeof applyCreateRecipeFactoryPresets === 'function') applyCreateRecipeFactoryPresets(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved locally.', 'Factory Settings');
        });
    });
}

function clearClientStateAfterFactoryReset() {
    window.currentUser = null;
    if (typeof currentUser !== 'undefined') currentUser = null;
    try {
        localStorage.removeItem('currentUser');
        localStorage.removeItem('disabledRecipes');
    } catch (e) {}
    validationCompletion = { distance: false, load: false };
    validationSessionResults = { distance: null, load: null };
    if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
}

function showFactoryResetConfirm() {
    showConfirmModal(
        'Are you sure you want to factory reset? This will permanently delete all reports, recipes, users, audit trails, and fingerprint enrollments. Factory settings (company/model/serial) are kept. This cannot be undone.',
        'Factory Reset'
    ).then(function (ok) {
        if (!ok) return;
        apiRequest((API_BASE || '') + '/api/data/factory-reset', { method: 'POST', body: {} })
            .then(function (result) {
                clearClientStateAfterFactoryReset();
                var kept = (result && result.settings) ? result.settings : null;
                if (kept && typeof kept === 'object') {
                    try { localStorage.setItem('factorySettings', JSON.stringify(kept)); } catch (e) {}
                    if (typeof updateLoginFactorySettingsDisplay === 'function') {
                        updateLoginFactorySettingsDisplay(kept);
                    }
                }
                showAppModal(
                    'Factory reset completed. All reports, recipes, users, and audit trails have been erased. Company name, serial, and other factory details were kept.',
                    'Factory Reset'
                );
                if (typeof showLoginScreen === 'function') showLoginScreen();
            })
            .catch(function (err) {
                var msg = (err && err.message) ? err.message : 'Factory reset failed.';
                showAppModal(msg, 'Factory Reset');
            });
    });
}

function loadBiometricSetting() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        applyBiometricSetting(settings.biometricEnabled);
        applyFactoryAutoLogoutSetting(settings);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            applyBiometricSetting(settings.biometricEnabled);
            applyFactoryAutoLogoutSetting(settings);
        } catch (e) {
        applyBiometricSetting(true);
        applyFactoryAutoLogoutSetting({});
        }
    });
}

// ----- On-Screen Keyboard: attach to text-like inputs on focus / click -----
function attachKeyboardToInputs() {
    if (typeof window.openOSKForInput !== 'function') return;
    var selectors = [
        'input[type="text"]',
        'input[type="number"]',
        'input[type="password"]',
        'input[type="email"]',
        'input[type="tel"]',
        'input[type="search"]',
        'input[type="url"]',
        'textarea'
    ].join(', ');
    document.querySelectorAll(selectors).forEach(function (input) {
        if (!input || input.closest('#keyboard-root')) return;
        if (input.readOnly || input.disabled) return;
        if (input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio' || input.type === 'file' || input.type === 'range' || input.type === 'color') return;

        if (input._keyboardFocusHandler) {
            input.removeEventListener('focus', input._keyboardFocusHandler);
        }
        input._keyboardFocusHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('focus', input._keyboardFocusHandler);

        if (input._keyboardClickHandler) {
            input.removeEventListener('click', input._keyboardClickHandler);
        }
        input._keyboardClickHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('click', input._keyboardClickHandler);
    });
}

document.addEventListener('DOMContentLoaded', function () {
    bindTestRunDecimalInputs();
    attachKeyboardToInputs();
    loadBiometricSetting();
    loadLoginFactorySettingsDisplay();

    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var page = btn.getAttribute('data-page');
            if (page) goToPage(page);
        });
    });

    var originalGoToPage = goToPage;
    goToPage = function (pageName) {
        if (typeof markAutoLogoutActivity === 'function') markAutoLogoutActivity();
        if (originalGoToPage) originalGoToPage(pageName);
        setTimeout(function () {
            attachKeyboardToInputs();
        }, 200);
    };

    // Wire up Create Recipe Step 1 inputs to enable Continue button
    var recipeNameEl = document.getElementById('recipe-product-name');
    if (recipeNameEl) {
        recipeNameEl.addEventListener('input', updateCreateRecipeContinueButton);
    }
    ['recipe-vacuum-mmhg', 'recipe-duration'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', updateCreateRecipeContinueButton);
    });
    var recipeBatchSizeEl = document.getElementById('recipe-batch-size');
    if (recipeBatchSizeEl) {
        recipeBatchSizeEl.addEventListener('input', updateCreateRecipeContinueButton);
    }
    document.querySelectorAll('input[name="recipe-product-type"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof onRecipeProductTypeChange === 'function') onRecipeProductTypeChange();
            else updateCreateRecipeContinueButton();
        });
    });
    var otherTypeEl = document.getElementById('recipe-product-type-other');
    if (otherTypeEl) {
        otherTypeEl.addEventListener('input', updateCreateRecipeContinueButton);
    }
    document.querySelectorAll('input[name="create-speed"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-height"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-cylinder"]').forEach(function (el) {
        el.addEventListener('change', updateCreateRecipeContinueButton);
    });
    document.querySelectorAll('input[name="create-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
        });
    });
    document.querySelectorAll('input[name="quick-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', function () {
            if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();
        });
    });
    if (typeof applyCreateUspModeToSpeedHeight === 'function') applyCreateUspModeToSpeedHeight();
    if (typeof applyQuickUspModeToSpeedHeight === 'function') applyQuickUspModeToSpeedHeight();

    function resetKioskSessionAndShowLogin() {
    try { localStorage.removeItem('currentUser'); } catch (e) {}
    window.currentUser = null;
    if (typeof currentUser !== 'undefined') currentUser = null;
    if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
    window._lastReportPreview = null;
    var app = document.querySelector('.app-container');
    if (app) app.classList.remove('report-approval-locked');
    var resetUrl = (API_BASE || '') + '/api/data/auth/session-ui-reset';
    fetch(resetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .catch(function () {})
        .finally(function () {
            showLoginScreen();
        });
}
    resetKioskSessionAndShowLogin();
});             

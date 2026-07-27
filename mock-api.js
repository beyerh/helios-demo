/* ═══════════════════════════════════════════════════════════════════════════
 * Helios Mock API — browser-side simulation of the firmware backend.
 *
 * Intercepts all fetch() calls to /api/* and returns simulated responses.
 * State is persisted to localStorage so presets/calibration/settings survive
 * page reloads.  The WebSocket constructor is replaced with a stub that fails
 * immediately so app.js falls back to HTTP polling (which we serve).
 *
 * Loaded BEFORE app.js so the interceptors are in place before any API call.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ── localStorage persistence ──────────────────────────────────────────────
    const STORE_KEY = 'helios_mock_data';
    const MAX_PRESETS = 20;

    function defaultCal() {
        function ds(side, unit) {
            const scales = {
                "top.umol":    { ch1: 150, ch2: 200, ch3: 80 },
                "top.uwcm2":   { ch1: 3300, ch2: 4400, ch3: 1760 },
                "bottom.umol": { ch1: 120, ch2: 170, ch3: 60 },
                "bottom.uwcm2":{ ch1: 2640, ch2: 3740, ch3: 1320 },
            };
            const key = side + "." + unit;
            const s = scales[key] || scales["top.umol"];
            const ramp = (max) => [[0, 0], [1024, Math.round(max * 0.25)], [2048, Math.round(max * 0.5)], [3072, Math.round(max * 0.75)], [4095, max]];
            return {
                mode: 'linear',
                points: { ch1: ramp(s.ch1), ch2: ramp(s.ch2), ch3: ramp(s.ch3) },
                coeffs: { ch1: null, ch2: null, ch3: null },
                isDummy: true,
            };
        }
        return {
            version: 3,
            active: 'top',
            sides: {
                top:    { umol: ds("top", "umol"),    uwcm2: ds("top", "uwcm2") },
                bottom: { umol: ds("bottom", "umol"), uwcm2: ds("bottom", "uwcm2") },
            },
        };
    }

    function defaultSettings() {
        return {
            wifi: { ssid: 'Helios001', password: 'Helios001', configured: false },
            autostart: { enabled: false, presetSlot: -1 },
            deviceName: 'Helios',
        };
    }

    function loadStore() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (raw) {
                const d = JSON.parse(raw);
                d.presets = d.presets || {};
                // Migrate: if stored calibration lacks isDummy flags, it's from
                // an older version with identical dummy data for all 4 combos.
                // Replace with new differentiated defaults.
                if (d.calibration) {
                    const t = d.calibration.sides && d.calibration.sides.top;
                    const hasDummyFlag = t && t.umol && typeof t.umol.isDummy === 'boolean';
                    if (!hasDummyFlag) {
                        d.calibration = defaultCal();
                    }
                } else {
                    d.calibration = defaultCal();
                }
                d.settings = d.settings || defaultSettings();
                d.tempOffset = d.tempOffset || 0;
                d.runCounter = d.runCounter || 0;
                d.engineState = d.engineState || null;
                d.tempLog = d.tempLog || [];
                d.runLogs = d.runLogs || [];
                d.activeRun = d.activeRun || null;
                return d;
            }
        } catch (e) { /* ignore */ }
        return {
            presets: {},
            calibration: defaultCal(),
            settings: defaultSettings(),
            tempOffset: 0,
            runCounter: 0,
            engineState: null,
            tempLog: [],
            runLogs: [],
            activeRun: null,
        };
    }

    function saveStore() {
        try {
            // Cap run logs to avoid exceeding localStorage limits (~5 MB)
            var cappedLogs = data.runLogs;
            var totalSize = cappedLogs.reduce(function (s, r) { return s + (r.csv || '').length; }, 0);
            while (cappedLogs.length > 0 && totalSize > 2_000_000) {
                var removed = cappedLogs.shift();
                totalSize -= (removed.csv || '').length;
            }
            localStorage.setItem(STORE_KEY, JSON.stringify({
                presets: data.presets,
                calibration: data.calibration,
                settings: data.settings,
                tempOffset: data.tempOffset,
                runCounter: data.runCounter,
                engineState: data.engineState,
                tempLog: (data.tempLog || []).slice(-360),  // last 6 h
                runLogs: cappedLogs,
                activeRun: data.activeRun,
            }));
        } catch (e) { /* ignore quota errors */ }
    }

    const data = loadStore();

    // ── Engine state (mirrors firmware IllumState) ────────────────────────────
    const state = {
        running: false,
        mode: 'off',
        ch1: 0, ch2: 0, ch3: 0,
        currentCh1: 0, currentCh2: 0, currentCh3: 0,
        elapsed: 0,
        duration: 0,
        expired: false,
        leadTime: 0,
        inLead: false,
        leadRemainingMs: 0,
        pulseOnMs: 10000,
        pulseOffMs: 10000,
        seqPhase: 0,
        numPhases: 0,
    };

    // ── Temperature & fan state ───────────────────────────────────────────────
    const tempState = {
        hasSensor: true,
        current: 37.0,
        fanMode: 'auto',
        fanSpeed: 100,
        fanRunning: false,
    };
    let tempLog = data.tempLog || [];  // [{t, c}]
    let tempBase = 37.0;
    let lastLoggedMinute = tempLog.length > 0 ? tempLog[tempLog.length - 1].t : -1;

    // ── Run logs (in-memory, not persisted) ───────────────────────────────────
    let runLogs = data.runLogs || [];   // [{name, csv, size}]
    let activeRun = data.activeRun || null;  // {name, lines}

    // ── Engine timing ─────────────────────────────────────────────────────────
    let startTime = 0;

    // ── Persist engine state for refresh survival ─────────────────────────────
    function saveEngineState() {
        if (state.running) {
            data.engineState = {
                running: true,
                mode: state.mode,
                ch1: state.ch1, ch2: state.ch2, ch3: state.ch3,
                duration: state.duration,
                pulseOnMs: state.pulseOnMs,
                pulseOffMs: state.pulseOffMs,
                leadTime: state.leadTime,
                inLead: state.inLead,
                elapsed: state.elapsed,
                phases: state.phases || null,
                numPhases: state.numPhases,
                presetName: state.presetName || null,
                presetSlot: state.presetSlot !== undefined ? state.presetSlot : null,
                illum: state.illum || null,
                savedAt: Date.now(),
            };
        } else {
            data.engineState = null;
        }
        data.tempLog = tempLog;
        data.activeRun = activeRun;
        saveStore();
    }

    // ── Restore running state from previous session ───────────────────────────
    function restoreEngineState() {
        var es = data.engineState;
        if (!es || !es.running) return false;

        // Check if the run has expired while the page was closed
        if (es.duration > 0) {
            var elapsedAtSave = es.elapsed || 0;
            var wallElapsed = Date.now() - es.savedAt + elapsedAtSave;
            if (wallElapsed >= es.duration * 1000) {
                // Run finished while away — finalize the log
                state.expired = true;
                data.engineState = null;
                saveStore();
                return false;
            }
        }

        state.running = true;
        state.expired = false;
        state.mode = es.mode || 'constant';
        state.ch1 = es.ch1 || 0;
        state.ch2 = es.ch2 || 0;
        state.ch3 = es.ch3 || 0;
        state.duration = es.duration || 0;
        state.pulseOnMs = es.pulseOnMs || 10000;
        state.pulseOffMs = es.pulseOffMs || 10000;
        state.leadTime = es.leadTime || 0;
        state.inLead = es.inLead || false;
        state.elapsed = es.elapsed || 0;

        if (es.phases) {
            state.phases = es.phases;
            state.numPhases = es.numPhases || es.phases.length;
            state.seqPhase = 0;
        }

        if (es.presetName) state.presetName = es.presetName;
        if (es.presetSlot !== null) state.presetSlot = es.presetSlot;

        // Recalculate startTime so elapsed continues from where it left off
        startTime = Date.now() - state.elapsed;

        // Restore current channel outputs
        if (state.inLead) {
            state.currentCh1 = 0;
            state.currentCh2 = 0;
            state.currentCh3 = 0;
        } else if (state.mode === 'sequential' && state.phases) {
            var totalCycle = state.phases.reduce(function (s, p) { return s + p.dur; }, 0);
            if (totalCycle > 0) {
                var cyclePos = state.elapsed % totalCycle;
                var accum = 0;
                for (var i = 0; i < state.phases.length; i++) {
                    accum += state.phases[i].dur;
                    if (cyclePos < accum) {
                        state.seqPhase = i;
                        state.currentCh1 = state.phases[i].ch1 || 0;
                        state.currentCh2 = state.phases[i].ch2 || 0;
                        state.currentCh3 = state.phases[i].ch3 || 0;
                        break;
                    }
                }
            }
        } else {
            state.currentCh1 = state.ch1;
            state.currentCh2 = state.ch2;
            state.currentCh3 = state.ch3;
        }

        return true;
    }

    // ── Engine simulation (100 ms tick) ───────────────────────────────────────
    function engineTick() {
        if (!state.running) return;

        // Lead-in delay: hold LEDs off until it elapses
        if (state.inLead) {
            const leadMs = Date.now() - startTime;
            const totalMs = state.leadTime * 1000;
            if (leadMs >= totalMs) {
                state.inLead = false;
                state.leadRemainingMs = 0;
                startTime = Date.now();
                if (state.mode === 'sequential' && state.phases) {
                    const p0 = state.phases[0];
                    state.currentCh1 = p0.ch1 || 0;
                    state.currentCh2 = p0.ch2 || 0;
                    state.currentCh3 = p0.ch3 || 0;
                } else {
                    state.currentCh1 = state.ch1;
                    state.currentCh2 = state.ch2;
                    state.currentCh3 = state.ch3;
                }
            } else {
                state.leadRemainingMs = Math.max(0, totalMs - leadMs);
            }
            return;
        }

        const elapsedMs = Date.now() - startTime;
        state.elapsed = elapsedMs;

        // Duration expiry
        if (state.duration > 0 && elapsedMs >= state.duration * 1000) {
            state.running = false;
            state.expired = true;
            state.currentCh1 = 0;
            state.currentCh2 = 0;
            state.currentCh3 = 0;
            finalizeRunLog();
            return;
        }

        // Pulsed mode: toggle channels on/off within each cycle
        if (state.mode === 'pulsed') {
            const onMs = state.pulseOnMs;
            const offMs = state.pulseOffMs;
            const periodMs = onMs + offMs || 1;
            const phasePos = elapsedMs % periodMs;
            if (phasePos < onMs) {
                state.currentCh1 = state.ch1;
                state.currentCh2 = state.ch2;
                state.currentCh3 = state.ch3;
            } else {
                state.currentCh1 = 0;
                state.currentCh2 = 0;
                state.currentCh3 = 0;
            }
        }

        // Sequential mode: cycle through phases
        else if (state.mode === 'sequential' && state.phases) {
            const phases = state.phases;
            const totalCycle = phases.reduce(function (s, p) { return s + p.dur; }, 0);
            if (totalCycle > 0) {
                const cyclePos = elapsedMs % totalCycle;
                let accum = 0;
                for (let i = 0; i < phases.length; i++) {
                    accum += phases[i].dur;
                    if (cyclePos < accum) {
                        state.seqPhase = i;
                        state.currentCh1 = phases[i].ch1 || 0;
                        state.currentCh2 = phases[i].ch2 || 0;
                        state.currentCh3 = phases[i].ch3 || 0;
                        break;
                    }
                }
            }
        }
    }

    // ── Temperature simulation (2 s tick) ─────────────────────────────────────
    function tempTick() {
        // Equilibrium temperature depends on total LED output (PWM sum).
        // Low intensity (~10-20 µmol) → ~37.0-37.2 °C, high intensity → ~38 °C.
        // The fan keeps things from going higher.
        if (state.running) {
            var pwmSum = state.currentCh1 + state.currentCh2 + state.currentCh3;
            var pwmFrac = Math.min(1, pwmSum / (3 * 4095));
            var equilibrium = 37.0 + pwmFrac * 1.0;  // 37.0 → 38.0
            tempBase += (equilibrium - tempBase) * 0.08;
        } else {
            tempBase += (37.0 - tempBase) * 0.05;
        }
        const noise = (Math.random() - 0.5) * 0.3;
        tempState.current = Math.round((tempBase + noise) * 10) / 10;

        // Auto fan logic
        if (tempState.fanMode === 'auto') {
            tempState.fanRunning = tempState.current >= 37.5;
            if (tempState.current <= 37.0) tempState.fanRunning = false;
        } else if (tempState.fanMode === 'on') {
            tempState.fanRunning = true;
        } else {
            tempState.fanRunning = false;
        }

        // Log one sample per elapsed minute (synced to engine elapsed time,
        // not wall-clock, so the chart x-axis matches the elapsed display)
        if (state.running) {
            const elapsedMin = Math.floor(state.elapsed / 60000);
            if (elapsedMin !== lastLoggedMinute) {
                lastLoggedMinute = elapsedMin;
                tempLog.push({ t: elapsedMin, c: tempState.current });
                if (tempLog.length > 720) tempLog.shift();

                // Also append to active run log
                if (activeRun) {
                    activeRun.lines.push(elapsedMin + ',' + tempState.current.toFixed(2));
                }
            }
        }

        // Persist state every temp tick (2 s) so a page refresh
        // retains elapsed time, temp log, and active run data.
        saveEngineState();
    }

    setInterval(engineTick, 100);
    setInterval(tempTick, 2000);

    // ── WebSocket stub (fail immediately → app.js falls back to polling) ──────
    function FakeWebSocket() {
        var self = this;
        self.readyState = 0;
        self.onopen = null;
        self.onclose = null;
        self.onmessage = null;
        self.onerror = null;
        setTimeout(function () {
            self.readyState = 3;
            if (self.onerror) self.onerror(new Event('error'));
            if (self.onclose) self.onclose(new Event('close'));
        }, 10);
    }
    FakeWebSocket.OPEN = 1;
    FakeWebSocket.CONNECTING = 0;
    FakeWebSocket.CLOSING = 2;
    FakeWebSocket.CLOSED = 3;
    FakeWebSocket.prototype.close = function () { this.readyState = 3; };
    FakeWebSocket.prototype.send = function () {};
    window.WebSocket = FakeWebSocket;

    // ── fetch() interceptor ───────────────────────────────────────────────────
    var realFetch = window.fetch;
    window.fetch = async function (url, opts) {
        var cleanUrl = String(url).split('?')[0];
        var method = ((opts && opts.method) || 'GET').toUpperCase();

        // Only intercept API calls; pass everything else through
        if (cleanUrl.indexOf('/api/') !== 0) {
            return realFetch.call(window, url, opts);
        }

        var body = {};
        if (opts && opts.body) {
            try { body = JSON.parse(opts.body); } catch (e) { /* ignore */ }
        }

        var result = handleRoute(cleanUrl, method, body);
        return new Response(JSON.stringify(result.data), {
            status: result.status || 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };

    // ── Route dispatcher ──────────────────────────────────────────────────────
    function handleRoute(url, method, body) {
        // ── GET ──
        if (method === 'GET') {
            if (url === '/api/status') return { data: getStatus() };
            if (url === '/api/calibration') return { data: data.calibration };
            if (url === '/api/temperature') return { data: {
                hasSensor: tempState.hasSensor,
                current: tempState.current,
                log: tempLog.slice(-200),
            }};
            if (url === '/api/presets' || url === '/api/presets/') return { data: presetList() };
            if (url.indexOf('/api/presets/') === 0) return getPreset(url);
            if (url === '/api/wifi') return { data: data.settings.wifi };
            if (url === '/api/autostart') return { data: data.settings.autostart };
            if (url === '/api/devicename') return { data: { name: data.settings.deviceName } };
            if (url === '/api/tempcal') return { data: getTempCal() };
            if (url === '/api/runs' || url === '/api/runs/') return { data: runLogList() };
            return { status: 404, data: { error: 'not found' } };
        }

        // ── POST ──
        if (method === 'POST') {
            if (url === '/api/start') return { data: handleStart(body) };
            if (url === '/api/stop') return { data: handleStop() };
            if (url === '/api/live') return { data: handleLive(body) };
            if (url === '/api/presets') return savePreset(body);
            if (url === '/api/calibration') {
                data.calibration = body;
                saveStore();
                return { data: { ok: true } };
            }
            if (url === '/api/fan') return { data: handleFan(body) };
            if (url === '/api/wifi') return { data: handleWifi(body) };
            if (url === '/api/autostart') return { data: handleAutoStart(body) };
            if (url === '/api/devicename') return handleDeviceName(body);
            if (url === '/api/tempcal') return handleTempCal(body);
            if (url === '/api/restart') return { data: { ok: true, message: 'Restarting...' } };
            return { status: 404, data: { error: 'not found' } };
        }

        // ── DELETE ──
        if (method === 'DELETE') {
            if (url.indexOf('/api/presets/') === 0) return { data: deletePreset(url) };
            if (url === '/api/runs' || url === '/api/runs/') {
                runLogs = [];
                data.runLogs = runLogs;
                saveStore();
                return { data: { ok: true } };
            }
            if (url.indexOf('/api/runs/') === 0) return { data: deleteRunLog(url) };
            return { status: 404, data: { error: 'not found' } };
        }

        return { status: 405, data: { error: 'method not allowed' } };
    }

    // ── Status ────────────────────────────────────────────────────────────────
    function getStatus() {
        var s = Object.assign({}, state);
        s.hasTempSensor = tempState.hasSensor;
        s.tempC = tempState.current;
        s.fanMode = tempState.fanMode;
        s.fanSpeed = tempState.fanSpeed;
        s.fanRunning = tempState.fanRunning;
        s.deviceName = data.settings.deviceName;
        if (state.presetName) s.presetName = state.presetName;
        return s;
    }

    // ── Presets ───────────────────────────────────────────────────────────────
    function presetList() {
        return Object.keys(data.presets).map(function (k) {
            return {
                slot: +k,
                name: data.presets[k].name || '',
                notes: data.presets[k].notes || '',
            };
        }).sort(function (a, b) { return a.slot - b.slot; });
    }

    function getPreset(url) {
        var slot = parseInt(url.split('/').pop(), 10);
        if (data.presets[slot]) {
            var p = Object.assign({}, data.presets[slot]);
            p.slot = slot;
            return { data: p };
        }
        return { status: 404, data: { error: 'not found' } };
    }

    function savePreset(body) {
        var slot = body.slot;
        if (slot === undefined || slot === null) {
            for (var i = 0; i < MAX_PRESETS; i++) {
                if (!data.presets[i]) { slot = i; break; }
            }
        }
        if (slot === undefined || slot === null) {
            return { status: 409, data: { error: 'no free slot' } };
        }
        data.presets[slot] = body;
        data.presets[slot].slot = slot;
        saveStore();
        return { data: { ok: true, slot: slot } };
    }

    function deletePreset(url) {
        var slot = parseInt(url.split('/').pop(), 10);
        delete data.presets[slot];
        saveStore();
        return { ok: true };
    }

    // ── Start / Stop / Live ───────────────────────────────────────────────────
    function handleStart(body) {
        if (activeRun) finalizeRunLog();

        state.running = true;
        state.expired = false;
        state.mode = body.mode || 'constant';
        // Clamp to the 12-bit PWM range, matching the firmware's PulseEngine.
        state.ch1 = Math.min(4095, body.ch1 || 0);
        state.ch2 = Math.min(4095, body.ch2 || 0);
        state.ch3 = Math.min(4095, body.ch3 || 0);
        state.currentCh1 = state.ch1;
        state.currentCh2 = state.ch2;
        state.currentCh3 = state.ch3;
        state.duration = body.duration || 0;
        state.pulseOnMs = body.pulseOnMs || 10000;
        state.pulseOffMs = body.pulseOffMs || 10000;
        state.elapsed = 0;

        var lead = parseInt(body.leadTime || 0, 10);
        state.leadTime = lead;
        state.inLead = lead > 0;
        state.leadRemainingMs = lead * 1000;
        if (lead > 0) {
            state.currentCh1 = 0;
            state.currentCh2 = 0;
            state.currentCh3 = 0;
        }

        if (body.phases && body.phases.length) {
            state.phases = body.phases;
            state.numPhases = body.phases.length;
            state.seqPhase = 0;
            if (!state.inLead) {
                var p0 = body.phases[0];
                state.currentCh1 = p0.ch1 || 0;
                state.currentCh2 = p0.ch2 || 0;
                state.currentCh3 = p0.ch3 || 0;
            }
        } else {
            delete state.phases;
            state.numPhases = 0;
            state.seqPhase = 0;
        }

        delete state.presetName;
        delete state.presetSlot;

        tempLog = [];
        lastLoggedMinute = -1;
        startTime = Date.now();

        startRunLog(body);
        saveEngineState();
        return { ok: true };
    }

    function handleStop() {
        state.running = false;
        state.mode = 'off';
        state.inLead = false;
        state.leadRemainingMs = 0;
        state.currentCh1 = 0;
        state.currentCh2 = 0;
        state.currentCh3 = 0;
        finalizeRunLog();
        saveEngineState();
        return { ok: true };
    }

    function handleLive(body) {
        // Live preview is not logged. If a recorded run is active, end it
        // first so the run log doesn't keep collecting samples that no longer
        // match the LED output.
        if (activeRun) handleStop();

        state.inLead = false;
        state.leadRemainingMs = 0;
        if (!body.on) {
            state.running = false;
            state.mode = 'off';
            state.currentCh1 = 0;
            state.currentCh2 = 0;
            state.currentCh3 = 0;
        } else {
            state.running = true;
            state.expired = false;
            state.mode = 'constant';
            state.ch1 = Math.min(4095, body.ch1 || 0);
            state.ch2 = Math.min(4095, body.ch2 || 0);
            state.ch3 = Math.min(4095, body.ch3 || 0);
            state.currentCh1 = state.ch1;
            state.currentCh2 = state.ch2;
            state.currentCh3 = state.ch3;
            state.duration = 0;
            startTime = Date.now();
        }
        saveEngineState();
        return { ok: true };
    }

    // ── Fan ───────────────────────────────────────────────────────────────────
    function handleFan(body) {
        if (body.mode !== undefined) tempState.fanMode = body.mode;
        if (body.speed !== undefined) tempState.fanSpeed = Math.max(0, Math.min(100, body.speed));
        return { ok: true };
    }

    // ── WiFi ──────────────────────────────────────────────────────────────────
    function handleWifi(body) {
        data.settings.wifi = {
            ssid: body.ssid || 'Helios',
            password: body.password || 'helios001',
            configured: true,
        };
        saveStore();
        return { ok: true, message: 'WiFi settings saved. Restart required.' };
    }

    // ── Auto-start ────────────────────────────────────────────────────────────
    function handleAutoStart(body) {
        data.settings.autostart = {
            enabled: body.enabled || false,
            presetSlot: body.presetSlot !== undefined ? body.presetSlot : -1,
        };
        saveStore();
        return { ok: true };
    }

    // ── Device name ───────────────────────────────────────────────────────────
    function handleDeviceName(body) {
        var name = String(body.name || '').trim();
        if (!name || name.length > 32) {
            return { status: 400, data: { error: 'name must be 1-32 chars' } };
        }
        data.settings.deviceName = name;
        saveStore();
        return { data: { ok: true, name: name } };
    }

    // ── Temperature calibration ───────────────────────────────────────────────
    function getTempCal() {
        var raw = tempState.current;
        var calibrated = raw + data.tempOffset;
        return {
            offsetC: data.tempOffset,
            rawC: parseFloat(raw.toFixed(2)),
            calibratedC: parseFloat(calibrated.toFixed(2)),
        };
    }

    function handleTempCal(body) {
        var off = parseFloat(body.offsetC);
        if (isNaN(off)) off = 0;
        off = Math.max(-5, Math.min(5, off));
        data.tempOffset = off;
        saveStore();
        return { data: { ok: true, offsetC: off } };
    }

    // ── Run logs ──────────────────────────────────────────────────────────────
    function startRunLog(body) {
        data.runCounter = (data.runCounter || 0) + 1;
        // 8-digit zero-padding to match the firmware's run_%08u.csv naming.
        var num = String(data.runCounter).padStart(8, '0');
        var name = 'run_' + num + '.csv';
        var lines = [
            '# Helios Run Log',
            '# Run: ' + num,
            '# Mode: ' + (body.mode || 'constant'),
            '# Channels: ch1=' + (body.ch1 || 0) + ', ch2=' + (body.ch2 || 0) + ', ch3=' + (body.ch3 || 0),
            '# Pulse: on=' + (body.pulseOnMs || 10000) + 'ms, off=' + (body.pulseOffMs || 10000) + 'ms',
            '# Duration: ' + (body.duration || 0) + 's',
            '# LeadTime: ' + (body.leadTime || 0) + 's',
            '# Illumination: ' + (body.illum || 'top'),
            '# TempOffset: ' + (data.tempOffset || 0).toFixed(2),
            'minutes,temperature_C',
        ];
        activeRun = { name: name, lines: lines };
        data.activeRun = activeRun;
        saveStore();
    }

    function finalizeRunLog() {
        if (!activeRun) return;
        var csv = activeRun.lines.join('\n') + '\n';
        runLogs.push({ name: activeRun.name, csv: csv, size: csv.length });
        if (runLogs.length > 30) runLogs.shift();
        activeRun = null;
        data.activeRun = null;
        data.runLogs = runLogs;
        saveStore();
    }

    function runLogList() {
        return runLogs.map(function (r) { return { name: r.name, size: r.size }; });
    }

    function deleteRunLog(url) {
        var name = decodeURIComponent(url.split('/api/runs/')[1]);
        runLogs = runLogs.filter(function (r) { return r.name !== name; });
        data.runLogs = runLogs;
        saveStore();
        return { ok: true };
    }

    // ── Run log download interceptor ──────────────────────────────────────────
    //  <a href="/api/runs/run_0001.csv" download> bypasses fetch(), so we
    //  intercept the click and serve a Blob from our in-memory CSV.
    document.addEventListener('click', function (e) {
        var a = e.target.closest('a[href^="/api/runs/"]');
        if (!a) return;
        e.preventDefault();
        var href = a.getAttribute('href');
        var name = decodeURIComponent(href.split('/api/runs/')[1].split('?')[0]);
        var log = runLogs.find(function (r) { return r.name === name; });
        if (log) {
            var blob = new Blob([log.csv], { type: 'text/csv' });
            var blobUrl = URL.createObjectURL(blob);
            var tmp = document.createElement('a');
            tmp.href = blobUrl;
            tmp.download = name;
            document.body.appendChild(tmp);
            tmp.click();
            document.body.removeChild(tmp);
            URL.revokeObjectURL(blobUrl);
        }
    });

    // ── Restore running state from previous page load ─────────────────────────
    var restored = restoreEngineState();

    // ── Auto-start on page load (simulates power-on autostart) ────────────────
    if (!restored && data.settings.autostart && data.settings.autostart.enabled) {
        var slot = data.settings.autostart.presetSlot;
        if (slot !== undefined && slot >= 0 && data.presets[slot]) {
            var p = data.presets[slot];
            // Simulate the firmware loading the preset and starting it
            setTimeout(function () {
                handleStart({
                    mode: p.mode || 'constant',
                    ch1: p.ch1 || 0,
                    ch2: p.ch2 || 0,
                    ch3: p.ch3 || 0,
                    pulseOnMs: p.pulseOnMs || 10000,
                    pulseOffMs: p.pulseOffMs || 10000,
                    duration: p.totalDuration_s || 0,
                    leadTime: p.leadTime_s || 0,
                    phases: p.phases || null,
                    illum: p.illum || 'top',
                });
                state.presetName = p.name || '';
                state.presetSlot = slot;
                saveEngineState();
            }, 500);  // small delay so app.js has time to initialise
        }
    }

    // Persist state on page unload
    window.addEventListener('beforeunload', saveEngineState);

    console.log('%c Helios Mock API ', 'background:#4fc3f7;color:#111;font-weight:bold;padding:2px 6px;border-radius:3px;',
        'Demo mode active — all API calls simulated in-browser.' +
        (restored ? ' Running experiment restored.' : ''));
})();

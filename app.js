/* ═══════════════════════════════════════════════════════════════════════════
   Helios — app.js
   Client-side logic for the Cell Culture Plate Illuminator
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Calibration (multi-point with piecewise-linear or power law fitting) ───
// PWM values are 12-bit (0–4095) to match firmware LEDC resolution.
const PWM_MAX = 4095;
const UMOL_UNIT = "\u00B5mol m\u207B\u00B2 s\u207B\u00B9";
const UPCM_UNIT = "\u03BCW cm\u207B\u00B2";

// Global display unit: "umol" or "uwcm2". Stored per-browser.
let displayUnit = localStorage.getItem("helios_display_unit") || "umol";

// Upper limit for the intensity sliders (1–PWM_MAX). Stored per-browser.
const DEFAULT_INTENSITY_MAX = 2000;
let intensityMax = Math.min(PWM_MAX, Math.max(1, +(localStorage.getItem("helios_intensity_max") || DEFAULT_INTENSITY_MAX)));

function getUnitLabel() { return displayUnit === "uwcm2" ? UPCM_UNIT : UMOL_UNIT; }

// Per-channel wavelength (nm) — used for µmol ↔ μW/cm² conversion.
// 1 µmol m⁻² s⁻¹ at λ nm  ≈  (11960 / λ)  μW cm⁻²  (E = hc/λ · N_A).
// NOTE: this conversion is only used if the user switches display units after
// calibration; the calibration itself is always stored in the chosen unit.
function uwPerUmolFactor(wavelengthNm) {
    if (!wavelengthNm || wavelengthNm <= 0) return 0;
    return 11960 / wavelengthNm;   // μW·cm⁻² per µmol·m⁻²·s⁻¹
}
// DUMMY placeholder calibration — distinct values per side/unit so the user
// can see numerical differences when toggling settings. These are NOT real
// measurements; the user must recalibrate every dataset (top/bottom × µmol /
// µW·cm⁻²) on the Calibration tab. An `isDummy` flag marks uncalibrated data.
// ── Illumination geometry (Top vs Bottom) ──────────────────────────────────
//  The light box can be used two ways and the LED-to-sample distance differs
//  slightly between them, so each geometry keeps its OWN calibration:
//    • "top"    — base fitted, LEDs above the sample
//    • "bottom" — box flipped onto the inlay adapter, illuminated from below
//  `illumSide`   = the ACTIVE geometry (header toggle). It drives every µmol
//                  display, is saved with presets, and logged with each run.
//  `calEditSide` = which geometry the Calibration tab is currently editing —
//                  independent of the active side.
function dummyCalPoints(side, unit) {
    // Distinct dummy data per side/unit so differences are visible.
    // All are clearly fake (round numbers, linear ramps) but differ enough
    // that switching side or unit shows a change.
    const scales = {
        "top.umol":    { ch1: 150, ch2: 200, ch3: 80 },
        "top.uwcm2":   { ch1: 3300, ch2: 4400, ch3: 1760 },
        "bottom.umol": { ch1: 120, ch2: 170, ch3: 60 },
        "bottom.uwcm2":{ ch1: 2640, ch2: 3740, ch3: 1320 },
    };
    const key = side + "." + unit;
    const s = scales[key] || scales["top.umol"];
    const ramp = (max) => [[0, 0], [1024, Math.round(max * 0.25)], [2048, Math.round(max * 0.5)], [3072, Math.round(max * 0.75)], [4095, max]];
    return { ch1: ramp(s.ch1), ch2: ramp(s.ch2), ch3: ramp(s.ch3) };
}
function defaultCalUnitData(side, unit) {
    return { mode: "linear", points: dummyCalPoints(side, unit), coeffs: { ch1: null, ch2: null, ch3: null }, isDummy: true };
}
function defaultCalSide(side) {
    return { umol: defaultCalUnitData(side, "umol"), uwcm2: defaultCalUnitData(side, "uwcm2") };
}
// Per-geometry, per-unit calibration store.
// calStore[side][unit]  where side = "top"|"bottom", unit = "umol"|"uwcm2"
let calStore = {
    top:    defaultCalSide("top"),
    bottom: defaultCalSide("bottom"),
};

// Check if the current side+unit calibration is still dummy (uncalibrated).
function isCalDummy(side = illumSide, unit = displayUnit) {
    const c = calStore[side][unit];
    return !c || c.isDummy === true;
}

// Show/hide the uncalibrated warning banner on the Calibration tab.
function updateCalWarning() {
    const warn = $("#calWarning");
    if (!warn) return;
    const dummy = isCalDummy(calEditSide);
    warn.classList.toggle("hidden", !dummy);
    if (dummy) {
        const sideEl = $("#calWarningSide");
        const unitEl = $("#calWarningUnit");
        if (sideEl) sideEl.textContent = calEditSide === "top" ? "top" : "bottom";
        if (unitEl) unitEl.textContent = getUnitLabel();
    }
}

// Get the calibration data object for the given side and current display unit.
function getCurrentCal(side) { return calStore[side][displayUnit]; }
let illumSide   = localStorage.getItem("helios_illum_side") || "top";
let calEditSide = illumSide;
let calDirty    = false;   // true when calibration edits haven't been saved to ESP32

// Power law fit: irradiance = a * PWM^b
// Linear in log-log space: ln(y) = ln(a) + b*ln(x)
function fitPowerLaw(points) {
    const valid = points.filter(p => p[0] > 0 && p[1] > 0); // need positive values for log
    if (valid.length < 2) return null;
    const n = valid.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const [pwm, irr] of valid) {
        const lx = Math.log(pwm);
        const ly = Math.log(irr);
        sumX += lx; sumY += ly; sumXY += lx * ly; sumX2 += lx * lx;
    }
    const b = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const a = Math.exp((sumY - b * sumX) / n);
    return { a, b };
}

function computeCalCoeffs(side, unit = displayUnit) {
    const c = calStore[side][unit];
    if (c.mode === "power") {
        c.coeffs = {
            ch1: fitPowerLaw(c.points.ch1),
            ch2: fitPowerLaw(c.points.ch2),
            ch3: fitPowerLaw(c.points.ch3),
        };
    } else {
        c.coeffs = { ch1: null, ch2: null, ch3: null };
    }
}

// Get the numeric irradiance value for a PWM in the current DISPLAY unit.
// The displayed value always comes from the calibration dataset for the
// selected unit (µmol → µmol data, µW/cm² → µW/cm² data). No cross-unit
// conversion: an uncalibrated unit reads 0 until the user calibrates it.
function pwmToCalValue(channel, pwm, side = illumSide) {
    const c = getCurrentCal(side);
    const pts = c.points[channel];
    if (!pts || pts.length === 0) return NaN;

    // Power law mode
    if (c.mode === "power" && c.coeffs[channel]) {
        const { a, b } = c.coeffs[channel];
        if (pwm <= 0) return 0;
        return a * Math.pow(pwm, b);
    }

    // Piecewise linear mode (default)
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    if (sorted.length === 1) return sorted[0][1];
    for (let i = 0; i < sorted.length - 1; i++) {
        const [p0, v0] = sorted[i];
        const [p1, v1] = sorted[i + 1];
        if (pwm >= p0 && pwm <= p1) {
            const t = (pwm - p0) / (p1 - p0);
            return v0 + t * (v1 - v0);
        }
    }
    // Extrapolate using last segment slope
    const [p0, v0] = sorted[sorted.length - 2];
    const [p1, v1] = sorted[sorted.length - 1];
    const slope = (v1 - v0) / (p1 - p0);
    return v1 + slope * (pwm - p1);
}

// Convenience: PWM → numeric value in the current DISPLAY unit.
// (Same as pwmToCalValue since calibration unit == display unit.)
function pwmToDisplayValue(channel, pwm, side = illumSide) {
    return pwmToCalValue(channel, pwm, side);
}

// Convenience: PWM → formatted display string with unit label.
function pwmToDisplayString(channel, pwm, side = illumSide) {
    const val = pwmToCalValue(channel, pwm, side);
    if (isNaN(val)) return "--";
    return val.toFixed(2) + " " + getUnitLabel();
}

// Inverse: irradiance → PWM using the calibration data for the current display unit.
// Used by the Setup tab so the user can type an intensity value and get the
// corresponding PWM.  Returns NaN if no calibration is available.
function calValueToPwm(channel, irradiance, side = illumSide) {
    const c = getCurrentCal(side);
    const pts = c.points[channel];
    if (!pts || pts.length === 0) return NaN;

    if (irradiance <= 0) return 0;

    // Power law mode: irradiance = a * PWM^b  →  PWM = (irradiance / a)^(1/b)
    if (c.mode === "power" && c.coeffs[channel]) {
        const { a, b } = c.coeffs[channel];
        if (a <= 0 || b === 0) return NaN;
        const pwm = Math.pow(irradiance / a, 1 / b);
        return Math.max(0, Math.min(PWM_MAX, Math.round(pwm)));
    }

    // Piecewise-linear mode — invert the interpolation.
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    if (sorted.length === 1) return sorted[0][0];

    for (let i = 0; i < sorted.length - 1; i++) {
        const [p0, v0] = sorted[i];
        const [p1, v1] = sorted[i + 1];
        const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
        if (irradiance >= lo && irradiance <= hi) {
            if (v1 === v0) return p0;
            const t = (irradiance - v0) / (v1 - v0);
            return Math.round(p0 + t * (p1 - p0));
        }
    }

    // Extrapolate using last segment slope
    const [lp0, lv0] = sorted[sorted.length - 2];
    const [lp1, lv1] = sorted[sorted.length - 1];
    if (lv1 === lv0) return PWM_MAX;
    const slope = (lp1 - lp0) / (lv1 - lv0);
    const pwm = lp1 + slope * (irradiance - lv1);
    return Math.max(0, Math.min(PWM_MAX, Math.round(pwm)));
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const slider1 = $("#slider1"), num1 = $("#num1"), sci1 = $("#sci1");
const slider2 = $("#slider2"), num2 = $("#num2"), sci2 = $("#sci2");
const slider3 = $("#slider3"), num3 = $("#num3"), sci3 = $("#sci3");
const sciLabel1 = $("#sciLabel1"), sciConverted1 = $("#sciConverted1");
const sciLabel2 = $("#sciLabel2"), sciConverted2 = $("#sciConverted2");
const sciLabel3 = $("#sciLabel3"), sciConverted3 = $("#sciConverted3");

const pulseOnH   = $("#pulseOnH"),  pulseOnM   = $("#pulseOnM");
const pulseOnS   = $("#pulseOnS"),  pulseOnMsF = $("#pulseOnMs");
const pulseOffH  = $("#pulseOffH"), pulseOffM  = $("#pulseOffM");
const pulseOffS  = $("#pulseOffS"), pulseOffMsF= $("#pulseOffMs");
const pulseHint  = $("#pulseHint");
const colorPrev  = $("#colorPreview");

const btnStart   = $("#btnStart"),  btnStop  = $("#btnStop");
const statusDot  = $("#statusDot"), statusTx = $("#statusText");
const elapsedCard= $("#elapsedCard"), elapsedDisp = $("#elapsedDisplay");
const progressCt = $("#progressContainer"), progressBar = $("#progressBar");

const chkTimed   = $("#chkTimed"),  durInputs = $("#durationInputs");
const durH = $("#durH"), durM = $("#durM"), durS = $("#durS");

const chkLead    = $("#chkLead"),   leadInputs = $("#leadInputs");
const leadH = $("#leadH"), leadM = $("#leadM"), leadS = $("#leadS");
const elapsedHeading = $("#elapsedHeading");

// Brightness cap removed: each channel now spans the full 12-bit PWM range,
// and a global multiplier would only duplicate what the user already controls
// per channel. Hardware safety is enforced by PWM_MAX_DUTY_PCT in firmware.

// ── Channel Definitions (hoisted) ───────────────────────────────────────────
//  Defined here — not down near the Settings tab handlers — because
//  previewBackground() reads channelDefs.*.color, and previewBackground is
//  called from onColorUpdate() during top-level init. Declaring channelDefs
//  further down would leave it in the temporal dead zone and break the
//  entire bottom half of the script (lock buttons, presets, calibration,
//  channel-def listeners, etc).
//  Defaults match the tri-spectrum panel we ship with; the user can override
//  both label and colour per channel via Settings → Channel Definitions.
const DEFAULT_CHANNEL_DEFS = {
    ch1: { label: "450 nm", color: "#2196f3", enabled: true, wavelength: 450 },
    ch2: { label: "660 nm", color: "#e53935", enabled: true, wavelength: 660 },
    ch3: { label: "730 nm", color: "#7e1010", enabled: true, wavelength: 730 },
};
let channelDefs = JSON.parse(JSON.stringify(DEFAULT_CHANNEL_DEFS));

// ── State ───────────────────────────────────────────────────────────────────
let currentMode = "constant";
let isRunning   = false;
// Defaults use intensityMax (not PWM_MAX) so a fresh program never starts out
// above the user's configured slider range.
let seqPhases   = [
    { ch1: intensityMax, ch2: 0,            ch3: 0, dur: 1000 },
    { ch1: 0,            ch2: intensityMax, ch3: 0, dur: 1000 },
    { ch1: 0,            ch2: 0,            ch3: 0, dur: 500  },
];

// ── Tabs ────────────────────────────────────────────────────────────────────
$$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
        $$(".tab").forEach((x) => x.classList.remove("active"));
        $$(".tab-content").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        $(`#tab-${t.dataset.tab}`).classList.add("active");
        if (t.dataset.tab === "presets") loadPresets();
        // Canvases report zero size while their tab is hidden, so redraw the
        // calibration graphs at their real (crisp) size once the tab is shown.
        if (t.dataset.tab === "calibration") drawAllCalGraphs();
    })
);

// Re-render canvas graphs after a resize so the backing store is re-scaled to
// the new CSS size (otherwise a 100%-width canvas re-blurs on window resize).
let _graphResizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(_graphResizeTimer);
    _graphResizeTimer = setTimeout(() => {
        const calTab = $("#tab-calibration");
        if (calTab && calTab.classList.contains("active")) drawAllCalGraphs();
        drawTempChart();
    }, 150);
});

// ── Mode selector ───────────────────────────────────────────────────────────
$$(".mode-btn").forEach((b) =>
    b.addEventListener("click", () => {
        $$(".mode-btn").forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected");
        currentMode = b.dataset.mode;
        updateModeVisibility();
    })
);

function updateModeVisibility() {
    const isPulse = currentMode === "pulsed";
    const isSeq   = currentMode === "sequential";
    $("#colorCard").classList.toggle("hidden", isSeq);
    $("#pulseCard").classList.toggle("hidden", !isPulse);
    $("#seqCard").classList.toggle("hidden", !isSeq);
}

// ── Colour sliders + number inputs (12-bit, 0–intensityMax) ────────────────────────
function clamp12(v) { return Math.max(0, Math.min(intensityMax, +v || 0)); }

function applyIntensityMax() {
    const ids = ["slider1", "slider2", "slider3", "num1", "num2", "num3",
                 "liveCh1", "liveCh2", "liveCh3", "liveCh1Num", "liveCh2Num", "liveCh3Num"];
    ids.forEach(id => {
        const el = $(`#${id}`);
        if (!el) return;
        el.max = intensityMax;
        const v = Math.min(+el.value, intensityMax);
        if (+el.value !== v) el.value = v;
    });
    onColorUpdate();
    // Sequential phases keep their PWM values in JS state, so clamp them too —
    // otherwise a lowered range would silently send out-of-range values.
    if (typeof seqPhases !== "undefined" && Array.isArray(seqPhases)) {
        let changed = false;
        seqPhases.forEach(p => {
            ["ch1", "ch2", "ch3"].forEach(ch => {
                const v = Math.min(p[ch] | 0, intensityMax);
                if (p[ch] !== v) { p[ch] = v; changed = true; }
            });
        });
        // Always re-render: the max attribute and title of every PWM input change.
        if (typeof renderSeqPhases === "function") renderSeqPhases();
        if (changed) toast(`Sequential steps clamped to ${intensityMax}`);
    }
    // Mirror the clamped values to the live-preview read-outs and send if live mode is on.
    ids.filter(id => id.startsWith("liveCh")).forEach(id => {
        const el = $(`#${id}`);
        if (el) el.dispatchEvent(new Event("input", { bubbles: true }));
    });
}

// Map 0–4095 → 0–255 for HTML colour preview only.
function toCssByte(v) { return Math.round(v * 255 / PWM_MAX); }

// Build a colour preview string driven by the user-defined channel colours
// (set in Settings → Channel Definitions). When a channel is at zero its colour
// contributes nothing; otherwise its display colour is mixed proportionally.
function previewBackground(r, g, b) {
    const intR = r / PWM_MAX, intG = g / PWM_MAX, intB = b / PWM_MAX;
    const c1 = hexToRgb(channelDefs.ch1.color);
    const c2 = hexToRgb(channelDefs.ch2.color);
    const c3 = hexToRgb(channelDefs.ch3.color);
    const mix = (a, b, c) => Math.min(255, Math.round(a*intR + b*intG + c*intB));
    return `rgb(${mix(c1.r,c2.r,c3.r)},${mix(c1.g,c2.g,c3.g)},${mix(c1.b,c2.b,c3.b)})`;
}
function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) }
             : { r: 255, g: 255, b: 255 };
}

function onColorUpdate() {
    const r = clamp12(slider1.value), g = clamp12(slider2.value), b = clamp12(slider3.value);
    // Don't clobber PWM num fields if the user is typing in a sci field
    const activeEl = document.activeElement;
    const sciFocused = activeEl === sci1 || activeEl === sci2 || activeEl === sci3;
    if (!sciFocused) {
        num1.value = r;
        num2.value = g;
        num3.value = b;
    }

    const unitLbl = getUnitLabel();
    const otherUnitLabel = displayUnit === "umol" ? UPCM_UNIT : UMOL_UNIT;

    const setSci = (sciEl, labelEl, convEl, ch, pwm) => {
        // Don't overwrite the field the user is actively typing in
        if (document.activeElement === sciEl) return;
        const dispVal = pwmToDisplayValue(ch, pwm);
        sciEl.value = isNaN(dispVal) ? 0 : dispVal.toFixed(2);
        labelEl.textContent = unitLbl;
        // Show converted value in parentheses using physical wavelength factor
        const wl = channelDefs[ch]?.wavelength || 0;
        if (wl && !isNaN(dispVal)) {
            const f = uwPerUmolFactor(wl);
            const otherVal = displayUnit === "umol" ? dispVal * f : dispVal / f;
            convEl.textContent = `(${otherVal.toFixed(2)} ${otherUnitLabel})`;
        } else {
            convEl.textContent = "";
        }
    };
    setSci(sci1, sciLabel1, sciConverted1, "ch1", r);
    setSci(sci2, sciLabel2, sciConverted2, "ch2", g);
    setSci(sci3, sciLabel3, sciConverted3, "ch3", b);

    // High-intensity warning (PWM > 3000)
    num1.classList.toggle("high-intensity", r > 3000);
    num2.classList.toggle("high-intensity", g > 3000);
    num3.classList.toggle("high-intensity", b > 3000);

    colorPrev.style.background = previewBackground(r, g, b);
}
function onNumInput() {
    slider1.value = clamp12(num1.value);
    slider2.value = clamp12(num2.value);
    slider3.value = clamp12(num3.value);
    onColorUpdate();
}

slider1.addEventListener("input", onColorUpdate);
slider2.addEventListener("input", onColorUpdate);
slider3.addEventListener("input", onColorUpdate);
num1.addEventListener("input", onNumInput);
num2.addEventListener("input", onNumInput);
num3.addEventListener("input", onNumInput);

// ── Intensity (sci) field edits → back-calculate PWM ─────────────────────
//  When the user types an irradiance value, convert it to PWM via the
//  calibration data and update the slider + PWM number field.  The converted
//  display (parentheses) is also refreshed.  onColorUpdate() skips the sci
//  field that has focus so it doesn't fight the caret.
function onSciInput(sciEl, numEl, sliderEl, ch, convEl) {
    const irradiance = parseFloat(sciEl.value);
    if (isNaN(irradiance) || irradiance < 0) return;
    const pwm = calValueToPwm(ch, irradiance);
    if (isNaN(pwm)) return;
    const clampedPwm = clamp12(pwm);
    sliderEl.value = clampedPwm;
    numEl.value = clampedPwm;
    // Refresh converted display + high-intensity warning + colour preview
    const dispVal = pwmToDisplayValue(ch, clampedPwm);
    const wl = channelDefs[ch]?.wavelength || 0;
    const otherUnitLabel = displayUnit === "umol" ? UPCM_UNIT : UMOL_UNIT;
    if (wl && !isNaN(dispVal)) {
        const f = uwPerUmolFactor(wl);
        const otherVal = displayUnit === "umol" ? dispVal * f : dispVal / f;
        convEl.textContent = `(${otherVal.toFixed(2)} ${otherUnitLabel})`;
    }
    const r = clamp12(slider1.value), g = clamp12(slider2.value), b = clamp12(slider3.value);
    num1.classList.toggle("high-intensity", r > 3000);
    num2.classList.toggle("high-intensity", g > 3000);
    num3.classList.toggle("high-intensity", b > 3000);
    colorPrev.style.background = previewBackground(r, g, b);
}
// On blur: normalise the typed value to the exact PWM-derived irradiance
function onSciBlur(sciEl, ch) {
    const pwm = ch === "ch1" ? +slider1.value : ch === "ch2" ? +slider2.value : +slider3.value;
    const clampedPwm = clamp12(pwm);
    const dispVal = pwmToDisplayValue(ch, clampedPwm);
    sciEl.value = isNaN(dispVal) ? 0 : dispVal.toFixed(2);
}
sci1.addEventListener("input", () => onSciInput(sci1, num1, slider1, "ch1", sciConverted1));
sci2.addEventListener("input", () => onSciInput(sci2, num2, slider2, "ch2", sciConverted2));
sci3.addEventListener("input", () => onSciInput(sci3, num3, slider3, "ch3", sciConverted3));
sci1.addEventListener("blur", () => onSciBlur(sci1, "ch1"));
sci2.addEventListener("blur", () => onSciBlur(sci2, "ch2"));
sci3.addEventListener("blur", () => onSciBlur(sci3, "ch3"));

onColorUpdate();

// ── Pulse ON/OFF time fields (h/m/s/ms → total milliseconds) ────────────────
function getPulseOnMs() {
    return (+pulseOnH.value||0)*3600000 + (+pulseOnM.value||0)*60000
         + (+pulseOnS.value||0)*1000 + (+pulseOnMsF.value||0);
}
function getPulseOffMs() {
    return (+pulseOffH.value||0)*3600000 + (+pulseOffM.value||0)*60000
         + (+pulseOffS.value||0)*1000 + (+pulseOffMsF.value||0);
}
function onPulseChange() {
    const on = getPulseOnMs(), off = getPulseOffMs();
    pulseHint.textContent =
        `Cycle: ${fmtDurMs(on)} ON \u2192 ${fmtDurMs(off)} OFF (${fmtDurMs(on+off)} period)`;
}
function fmtDurMs(ms) {
    if (ms >= 3600000) return `${(ms/3600000).toFixed(1)} h`;
    if (ms >= 60000) return `${(ms/60000).toFixed(1)} min`;
    if (ms >= 1000) return `${(ms/1000).toFixed(1)} s`;
    return `${ms} ms`;
}
[pulseOnH, pulseOnM, pulseOnS, pulseOnMsF,
 pulseOffH, pulseOffM, pulseOffS, pulseOffMsF].forEach((el) =>
    el.addEventListener("input", onPulseChange)
);
onPulseChange();

// ── Duration toggle ─────────────────────────────────────────────────────────
chkTimed.addEventListener("change", () => {
    durInputs.classList.toggle("hidden", !chkTimed.checked);
});
chkLead.addEventListener("change", () => {
    leadInputs.classList.toggle("hidden", !chkLead.checked);
});

function getDurationSeconds() {
    if (!chkTimed.checked) return 0;
    return (+durH.value||0)*3600 + (+durM.value||0)*60 + (+durS.value||0);
}

// Lead time (pre-timer): seconds to wait, LEDs off, before the program starts.
function getLeadSeconds() {
    if (!chkLead.checked) return 0;
    return (+leadH.value||0)*3600 + (+leadM.value||0)*60 + (+leadS.value||0);
}

// Reflect a lead-time value (seconds) into the checkbox + h/m/s inputs.
function setLeadFields(seconds) {
    if (seconds > 0) {
        chkLead.checked = true;
        leadInputs.classList.remove("hidden");
        leadH.value = Math.floor(seconds / 3600);
        leadM.value = Math.floor((seconds % 3600) / 60);
        leadS.value = seconds % 60;
    } else {
        chkLead.checked = false;
        leadInputs.classList.add("hidden");
    }
}

// ── Sequential / Program phase editor ──────────────────────────────────────
function durToHmsMs(ms) {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const rem = ms % 1000;
    return { h, m, s, ms: rem };
}
function hmsMsToDur(h, m, s, ms) {
    return h * 3600000 + m * 60000 + s * 1000 + ms;
}

function renderSeqPhases() {
    const container = $("#seqPhases");
    container.innerHTML = "";
    const unitLbl = getUnitLabel();
    seqPhases.forEach((p, i) => {
        const d = durToHmsMs(p.dur);
        const div = document.createElement("div");
        div.className = "seq-phase";
        const lbl1 = channelDefs.ch1.label, lbl2 = channelDefs.ch2.label, lbl3 = channelDefs.ch3.label;

        // Per-channel cell: channel label, then PWM and intensity inputs stacked vertically.
        // Editing either one updates the other via the calibration data.
        const cell = (chKey, lbl, val) => {
            if (!channelDefs[chKey].enabled) return "";
            const irradVal = pwmToDisplayValue(chKey, val);
            const irradStr = isNaN(irradVal) ? "0.00" : irradVal.toFixed(2);
            return `<div class="seq-ch-cell">
                <span class="lbl ch-${chKey.slice(-1)}">${esc(lbl)}</span>
                <div class="seq-ch-inputs">
                    <input type="number" min="0" max="${intensityMax}" value="${val}" data-i="${i}" data-ch="${chKey}" data-field="pwm" class="seq-rgb" title="PWM (0–${intensityMax})">
                    <span class="seq-field-label">PWM</span>
                    <input type="number" min="0" step="0.01" value="${irradStr}" data-i="${i}" data-ch="${chKey}" data-field="irrad" class="seq-irrad-input" title="Irradiance (${unitLbl})">
                    <span class="seq-field-label">${esc(unitLbl)}</span>
                </div>
            </div>`;
        };

        const swCh1 = channelDefs.ch1.enabled ? p.ch1 : 0;
        const swCh2 = channelDefs.ch2.enabled ? p.ch2 : 0;
        const swCh3 = channelDefs.ch3.enabled ? p.ch3 : 0;
        div.innerHTML = `
            <span class="phase-num">${i + 1}</span>
            <div class="seq-channels">
                ${cell("ch1", lbl1, p.ch1)}
                ${cell("ch2", lbl2, p.ch2)}
                ${cell("ch3", lbl3, p.ch3)}
            </div>
            <div class="phase-swatch" style="background:${previewBackground(swCh1, swCh2, swCh3)}"></div>
            <button class="btn-remove-phase" data-i="${i}">&times;</button>
            <div class="seq-phase-dur">
                <input type="number" min="0" max="999" value="${d.h}" data-i="${i}" data-u="h" class="dur-input"> h
                <input type="number" min="0" max="59"  value="${d.m}" data-i="${i}" data-u="m" class="dur-input"> m
                <input type="number" min="0" max="59"  value="${d.s}" data-i="${i}" data-u="s" class="dur-input"> s
                <input type="number" min="0" max="999" value="${d.ms}" data-i="${i}" data-u="ms" class="dur-input"> ms
            </div>
        `;
        container.appendChild(div);
    });

    // Helper: update the swatch for a phase row
    function updateSwatch(row, idx) {
        const sw = row.querySelector(".phase-swatch");
        const s1 = seqPhases[idx].ch1 || 0, s2 = seqPhases[idx].ch2 || 0, s3 = seqPhases[idx].ch3 || 0;
        sw.style.background = previewBackground(s1, s2, s3);
    }

    // PWM inputs → update intensity field + swatch (no full re-render)
    container.querySelectorAll('.seq-rgb[data-field="pwm"]').forEach((inp) =>
        inp.addEventListener("input", () => {
            const idx = +inp.dataset.i;
            const ch = inp.dataset.ch;
            const pwm = clamp12(inp.value);
            seqPhases[idx][ch] = pwm;
            // Reflect the clamp back into the field so the shown value always
            // matches what will actually be sent to the device.
            if (inp.value !== "" && +inp.value !== pwm) inp.value = pwm;
            const irradInp = inp.closest(".seq-ch-inputs").querySelector('.seq-irrad-input[data-field="irrad"]');
            if (irradInp && document.activeElement !== irradInp) {
                const v = pwmToDisplayValue(ch, pwm);
                irradInp.value = isNaN(v) ? "0.00" : v.toFixed(2);
            }
            updateSwatch(inp.closest(".seq-phase"), idx);
        })
    );

    // Intensity inputs → back-calculate PWM, update PWM field + swatch
    container.querySelectorAll('.seq-irrad-input[data-field="irrad"]').forEach((inp) =>
        inp.addEventListener("input", () => {
            const idx = +inp.dataset.i;
            const ch = inp.dataset.ch;
            const irradiance = parseFloat(inp.value);
            if (isNaN(irradiance) || irradiance < 0) return;
            const pwm = calValueToPwm(ch, irradiance);
            if (isNaN(pwm)) return;
            const clampedPwm = clamp12(pwm);
            seqPhases[idx][ch] = clampedPwm;
            const pwmInp = inp.closest(".seq-ch-inputs").querySelector('.seq-rgb[data-field="pwm"]');
            if (pwmInp && document.activeElement !== pwmInp) {
                pwmInp.value = clampedPwm;
            }
            updateSwatch(inp.closest(".seq-phase"), idx);
        })
    );

    // On blur: normalise the typed irrad value to the exact PWM-derived value
    container.querySelectorAll('.seq-irrad-input[data-field="irrad"]').forEach((inp) =>
        inp.addEventListener("blur", () => {
            const idx = +inp.dataset.i;
            const ch = inp.dataset.ch;
            const v = pwmToDisplayValue(ch, seqPhases[idx][ch]);
            inp.value = isNaN(v) ? "0.00" : v.toFixed(2);
        })
    );

    // Duration h/m/s/ms inputs
    container.querySelectorAll(".seq-phase-dur input").forEach((inp) =>
        inp.addEventListener("change", () => {
            const idx = +inp.dataset.i;
            const row = inp.closest(".seq-phase");
            const vals = {};
            row.querySelectorAll(".seq-phase-dur input").forEach(el => {
                vals[el.dataset.u] = +el.value || 0;
            });
            seqPhases[idx].dur = hmsMsToDur(vals.h, vals.m, vals.s, vals.ms);
        })
    );
    container.querySelectorAll(".btn-remove-phase").forEach((btn) =>
        btn.addEventListener("click", () => {
            seqPhases.splice(+btn.dataset.i, 1);
            renderSeqPhases();
        })
    );
}
$("#btnAddPhase").addEventListener("click", () => {
    if (seqPhases.length >= 16) { toast("Max 16 steps"); return; }
    seqPhases.push({ ch1: 0, ch2: 0, ch3: 0, dur: 60000 });
    renderSeqPhases();
});

// Re-render phases whenever channel labels/colours change so the labels and
// swatches stay in sync.
window.addEventListener("helios:channelDefs", () => renderSeqPhases());
// Recolour the calibration curves whenever a channel's display colour changes.
window.addEventListener("helios:channelDefs", () => drawAllCalGraphs());
renderSeqPhases();

// ── START / STOP ────────────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
    const res = await apiPost("/api/start", buildStartPayload());
    if (res && res.ok) {
        window.dispatchEvent(new Event("helios:runStarted"));
        toast("Illumination started");
    }
});
btnStop.addEventListener("click", async () => {
    if (!confirm("Stop the running experiment?")) return;
    const res = await apiPost("/api/stop", {});
    if (res && res.ok) toast("Illumination stopped");
});

function buildStartPayload() {
    const payload = {
        mode:       currentMode,
        duration:   getDurationSeconds(),
        leadTime:   getLeadSeconds(),   // optional pre-timer before the program starts
        illum:      illumSide,   // active geometry → saved with presets & run logs
    };
    if (currentMode === "sequential") {
        payload.ch1 = 0; payload.ch2 = 0; payload.ch3 = 0;
        // Strip disabled channels from each phase before sending.
        payload.phases = seqPhases.map(p => ({
            ch1: channelDefs.ch1.enabled ? (p.ch1 | 0) : 0,
            ch2: channelDefs.ch2.enabled ? (p.ch2 | 0) : 0,
            ch3: channelDefs.ch3.enabled ? (p.ch3 | 0) : 0,
            dur: p.dur,
        }));
    } else {
        payload.ch1 = channelDefs.ch1.enabled ? clamp12(slider1.value) : 0;
        payload.ch2 = channelDefs.ch2.enabled ? clamp12(slider2.value) : 0;
        payload.ch3 = channelDefs.ch3.enabled ? clamp12(slider3.value) : 0;
    }
    if (currentMode === "pulsed") {
        payload.pulseOnMs  = getPulseOnMs();
        payload.pulseOffMs = getPulseOffMs();
    }
    return payload;
}

// ── Presets ──────────────────────────────────────────────────────────────────
async function loadPresets() {
    const list = await apiGet("/api/presets");
    const container = $("#presetList");
    if (!list || list.length === 0) {
        container.innerHTML = '<p class="hint">No presets yet.</p>';
        return;
    }
    container.innerHTML = "";
    list.forEach((p) => {
        const div = document.createElement("div");
        div.className = "preset-item";
        div.innerHTML = `
            <div class="preset-info">
                <div class="preset-name">${esc(p.name)}</div>
                <div class="preset-notes">${esc(p.notes || "")}</div>
            </div>
            <div class="preset-actions">
                <button data-slot="${p.slot}" class="load-preset">Load</button>
                <button data-slot="${p.slot}" class="del">Delete</button>
            </div>
        `;
        container.appendChild(div);
    });
    container.querySelectorAll(".load-preset").forEach((b) =>
        b.addEventListener("click", () => loadPreset(+b.dataset.slot))
    );
    container.querySelectorAll(".del").forEach((b) =>
        b.addEventListener("click", () => deletePreset(+b.dataset.slot))
    );
}

async function loadPreset(slot) {
    const p = await apiGet(`/api/presets/${slot}`);
    if (!p) return;

    currentMode = p.mode || "constant";
    $$(".mode-btn").forEach((b) => {
        b.classList.toggle("selected", b.dataset.mode === currentMode);
    });
    updateModeVisibility();

    setIllumSide(p.illum || "top");

    slider1.value = clamp12(p.ch1 || 0);
    slider2.value = clamp12(p.ch2 || 0);
    slider3.value = clamp12(p.ch3 || 0);
    onColorUpdate();

    setTimeMsFields(p.pulseOnMs  || 10000, pulseOnH, pulseOnM, pulseOnS, pulseOnMsF);
    setTimeMsFields(p.pulseOffMs || 10000, pulseOffH, pulseOffM, pulseOffS, pulseOffMsF);
    onPulseChange();

    if (p.phases && p.phases.length) {
        seqPhases = p.phases.map(ph => ({
            ch1: clamp12(ph.ch1 || 0),
            ch2: clamp12(ph.ch2 || 0),
            ch3: clamp12(ph.ch3 || 0),
            dur: ph.dur || 1000,
        }));
    } else {
        seqPhases = [{ ch1: intensityMax, ch2: 0, ch3: 0, dur: 1000 }];
    }
    renderSeqPhases();

    if (p.duration > 0) {
        chkTimed.checked = true;
        durInputs.classList.remove("hidden");
        durH.value = Math.floor(p.duration / 3600);
        durM.value = Math.floor((p.duration % 3600) / 60);
        durS.value = p.duration % 60;
    } else {
        chkTimed.checked = false;
        durInputs.classList.add("hidden");
    }

    setLeadFields(p.leadTime || 0);

    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".tab-content").forEach((t) => t.classList.remove("active"));
    document.querySelector('.tab[data-tab="setup"]').classList.add("active");
    $("#tab-setup").classList.add("active");
    toast(`Loaded: ${p.name}`);
}

async function deletePreset(slot) {
    if (!confirm("Delete this preset?")) return;
    try {
        const r = await fetch(`/api/presets/${slot}`, { method: "DELETE" });
        if (!r.ok) { toast("Failed to delete preset"); return; }
        loadPresets();
        populateAutoStartPresets();  // Also update auto-start dropdown
        toast("Preset deleted");
    } catch (e) {
        toast("Connection error");
    }
}

$("#btnSavePreset").addEventListener("click", async () => {
    const name = $("#presetName").value.trim() || "Unnamed";
    const notes = $("#presetNotes").value.trim();
    const payload = { ...buildStartPayload(), name, notes };
    const res = await apiPost("/api/presets", payload);
    if (res && res.ok) {
        toast(`Saved: ${name}`);
        $("#presetName").value = "";
        $("#presetNotes").value = "";
        loadPresets();
        populateAutoStartPresets();  // Also update auto-start dropdown
    } else {
        toast("Failed to save preset");
    }
});

// ── WebSocket + HTTP polling fallback ────────────────────────────────────────
//  Robustness considerations:
//   - The ESP32 may restart at any time (power cycle, manual reboot, brownout).
//     A WebSocket on the browser side does not always fire `onclose` in that
//     case — it can sit in a half-open state for many seconds. A watchdog
//     based on "last message received" gives us a reliable liveness signal.
//   - When the tab is hidden (phone screen off, switched away), the browser
//     suspends timers and may silently drop the WS. On `visibilitychange` we
//     proactively force a reconnect and an immediate status refresh.
//   - On `pagehide`/`beforeunload` we close the WS cleanly so the ESP32 is
//     not left juggling a stale client slot when the user navigates away.
let ws = null, wsReconnectTimer = null, wsConnected = false, pollTimer = null;
let wsLastMessageMs = 0, wsWatchdogTimer = null;
const WS_STALE_MS = 4000;     // no message in this long → assume dead

function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return; // already trying / connected
    }
    clearTimeout(wsReconnectTimer);
    const host = location.hostname || "192.168.4.1";
    try { ws = new WebSocket(`ws://${host}/ws`); }
    catch (e) {
        wsReconnectTimer = setTimeout(connectWs, 2000);
        return;
    }

    ws.onopen = () => {
        wsConnected = true;
        wsLastMessageMs = Date.now();
        stopPolling();
    };
    ws.onmessage = (ev) => {
        wsLastMessageMs = Date.now();
        try { handleStatus(JSON.parse(ev.data)); } catch (e) {}
    };
    ws.onclose = () => {
        ws = null; wsConnected = false;
        startPolling();                        // keep UI alive in the meantime
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(connectWs, 1500);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
}
function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
        const s = await apiGet("/api/status");
        if (s) handleStatus(s);
    }, 600);
}
function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Watchdog: if the ESP32 reboots, the WS may not signal `close` for many
// seconds. Force-close it as soon as messages stop flowing so the reconnect
// loop kicks in quickly.
function startWsWatchdog() {
    if (wsWatchdogTimer) return;
    wsWatchdogTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - wsLastMessageMs > WS_STALE_MS) {
            try { ws.close(); } catch (e) {}
            // onclose handler will schedule the reconnect + start polling.
        }
    }, 1500);
}

// Reconnect immediately when the tab becomes visible again — browsers throttle
// timers in background tabs, so the watchdog above may not have fired yet.
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWs();
    } else {
        // Force a sanity check; if the socket is half-open, the next watchdog
        // tick will close it. Also refresh the status synchronously.
        apiGet("/api/status").then(s => { if (s) handleStatus(s); });
    }
});

// Clean shutdown so the server doesn't hold onto a dead client slot.
window.addEventListener("pagehide", () => {
    try { if (ws) ws.close(); } catch (e) {}
});

// Start polling immediately, WebSocket will take over if available
startPolling();
connectWs();
startWsWatchdog();

function handleStatus(s) {
    const wasRunning = isRunning;
    isRunning = s.running;
    statusDot.className = s.running ? "dot dot-on" : "dot dot-off";
    statusTx.textContent = s.inLead
        ? "WAITING"
        : s.running
        ? s.mode.toUpperCase()
        : s.expired ? "DONE" : "OFF";

    btnStart.classList.toggle("hidden", s.running);
    btnStop.classList.toggle("hidden", !s.running);

    if (s.inLead) {
        // Lead-in countdown: show remaining time until the program starts.
        elapsedCard.style.display = "";
        if (elapsedHeading) elapsedHeading.textContent = "Starting in";
        elapsedDisp.textContent = formatMs(s.leadRemainingMs || 0);
        if (s.leadTime > 0) {
            progressCt.style.display = "";
            const pct = Math.min(100, Math.max(0,
                (1 - (s.leadRemainingMs || 0) / (s.leadTime * 1000)) * 100));
            progressBar.style.width = pct + "%";
        } else {
            progressCt.style.display = "none";
        }
    } else if (s.running || s.expired) {
        elapsedCard.style.display = "";
        if (elapsedHeading) elapsedHeading.textContent = "Elapsed";
        elapsedDisp.textContent = formatMs(s.elapsed);
        if (s.duration > 0) {
            progressCt.style.display = "";
            const pct = Math.min(100, (s.elapsed / (s.duration * 1000)) * 100);
            progressBar.style.width = pct + "%";
        } else {
            progressCt.style.display = "none";
        }
    } else {
        elapsedCard.style.display = "none";
    }
    // Temperature
    if (s.hasTempSensor) {
        $("#tempCard").classList.remove("hidden");
        $("#tempValue").textContent = s.tempC !== undefined ? s.tempC : "--";
    }
    // Fan indicator
    if (s.fanRunning) {
        $("#fanIndicator").classList.remove("hidden");
    } else {
        $("#fanIndicator").classList.add("hidden");
    }
    // Sync fan speed slider + number input with the persisted value, unless the
    // user is mid-edit (fanSpeedDirty) — otherwise the 500 ms status push would
    // revert their change before they press Apply.
    if (s.fanSpeed !== undefined && !fanSpeedDirty) {
        const fsSlider = $("#sliderFanSpeed");
        const fsNum    = $("#numFanSpeed");
        if (fsSlider) {
            fsSlider.value = s.fanSpeed;
            if (fsNum) fsNum.value = s.fanSpeed;
        }
    }

    // Sync Setup tab with running program settings
    if (s.running) {
        syncSetupFromStatus(s);
    }

    // Live colour preview — animate with actual output (currentCh1/2/3).
    // In pulsed mode this blinks; in sequential it follows the active phase.
    if (s.running && s.currentCh1 !== undefined && s.currentCh2 !== undefined && s.currentCh3 !== undefined) {
        colorPrev.style.background = previewBackground(s.currentCh1, s.currentCh2, s.currentCh3);
    } else if (!s.running) {
        // When stopped, revert to slider-configured preview
        onColorUpdate();
    }
}

// True when the user is currently typing inside the given container. The status
// push arrives ~2×/s while a run is active; without this guard it would wipe
// out whatever the user is in the middle of entering.
function isEditingWithin(sel) {
    const root = $(sel);
    const el = document.activeElement;
    if (!root || !el) return false;
    return root.contains(el) && (el.tagName === "INPUT" || el.tagName === "SELECT");
}

// Shallow value comparison so we only rebuild the sequential DOM on a real
// change (renderSeqPhases() replaces innerHTML and would drop focus).
function seqPhasesEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].ch1 !== b[i].ch1 || a[i].ch2 !== b[i].ch2 ||
            a[i].ch3 !== b[i].ch3 || a[i].dur !== b[i].dur) return false;
    }
    return true;
}

// Sync Setup tab controls to match running program status
function syncSetupFromStatus(s) {
    // Update mode buttons
    if (s.mode && s.mode !== currentMode) {
        currentMode = s.mode;
        $$(".mode-btn").forEach((b) => {
            b.classList.toggle("selected", b.dataset.mode === currentMode);
        });
        updateModeVisibility();
    }

    // Update color sliders (for constant/pulsed modes)
    if (s.ch1 !== undefined && s.ch2 !== undefined && s.ch3 !== undefined &&
        !isEditingWithin("#colorCard")) {
        slider1.value = clamp12(s.ch1);
        slider2.value = clamp12(s.ch2);
        slider3.value = clamp12(s.ch3);
        onColorUpdate();
    }

    // Update pulse timing fields
    if (!isEditingWithin("#pulseCard")) {
        if (s.pulseOnMs !== undefined) {
            setTimeMsFields(s.pulseOnMs, pulseOnH, pulseOnM, pulseOnS, pulseOnMsF);
        }
        if (s.pulseOffMs !== undefined) {
            setTimeMsFields(s.pulseOffMs, pulseOffH, pulseOffM, pulseOffS, pulseOffMsF);
        }
        onPulseChange();
    }

    // Update sequential phases — ONLY when the device actually reports them.
    // buildStatusJson() omits `phases` entirely outside sequential mode, so
    // treating a missing field as "no phases" would wipe the user's program
    // the moment a constant/pulsed run starts. Re-render only on a real change
    // and never while the user is typing in one of the fields.
    if (Array.isArray(s.phases) && s.phases.length > 0) {
        const incoming = s.phases.map(p => ({
            ch1: clamp12(p.ch1 || 0),
            ch2: clamp12(p.ch2 || 0),
            ch3: clamp12(p.ch3 || 0),
            dur: p.dur || 1000
        }));
        if (!seqPhasesEqual(incoming, seqPhases) && !isEditingWithin("#seqPhases")) {
            seqPhases = incoming;
            renderSeqPhases();
        }
    }

    // Update duration
    if (!isEditingWithin("#durationInputs")) {
        if (s.duration > 0) {
            chkTimed.checked = true;
            durInputs.classList.remove("hidden");
            durH.value = Math.floor(s.duration / 3600);
            durM.value = Math.floor((s.duration % 3600) / 60);
            durS.value = s.duration % 60;
        } else {
            chkTimed.checked = false;
            durInputs.classList.add("hidden");
        }
    }

    // Update lead time
    if (!isEditingWithin("#leadInputs")) setLeadFields(s.leadTime || 0);

    // Keep the header name in sync (e.g. if changed from another client).
    if (s.deviceName) applyDeviceName(s.deviceName);

    // Show/hide preset name
    const presetLabel = $("#runningPresetLabel");
    if (presetLabel) {
        if (s.presetName) {
            presetLabel.textContent = `Preset: ${s.presetName}`;
            presetLabel.style.display = "";
        } else {
            presetLabel.style.display = "none";
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function apiPost(url, body) {
    try {
        const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
            cache: "no-store",
            body: JSON.stringify(body),
        });
        return await r.json();
    } catch (e) { toast("Connection error"); return null; }
}

async function apiGet(url) {
    try {
        // Append a cache-busting query param so a stale browser cache (after
        // a device restart) can never feed us back old JSON.
        const sep = url.includes("?") ? "&" : "?";
        const r = await fetch(url + sep + "_=" + Date.now(), {
            headers: { "Cache-Control": "no-store" },
            cache: "no-store",
        });
        return await r.json();
    } catch (e) { toast("Connection error"); return null; }
}

function formatMs(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function pad(n) { return n.toString().padStart(2, "0"); }

function esc(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    t.classList.add("show");
    setTimeout(() => { t.classList.remove("show"); }, 2000);
    setTimeout(() => { t.classList.add("hidden"); }, 2300);
}

function setTimeMsFields(totalMs, hEl, mEl, sEl, msEl) {
    const totalSec = Math.floor(totalMs / 1000);
    msEl.value = totalMs % 1000;
    hEl.value = Math.floor(totalSec / 3600);
    mEl.value = Math.floor((totalSec % 3600) / 60);
    sEl.value = totalSec % 60;
}

// ── Multi-point Calibration (piecewise linear, persisted to ESP32) ──────────

function renderCalChannel(ch) {
    const container = $(`#calPoints${ch.slice(2)}`);
    const c = getCurrentCal(calEditSide);
    const pts = c.points[ch];
    const unitLabel = getUnitLabel();
    container.innerHTML = "";
    pts.forEach((pt, i) => {
        const row = document.createElement("div");
        row.className = "cal-point-row";
        row.innerHTML = `
            <label>PWM<input type="number" min="0" max="4095" value="${pt[0]}" class="cal-input" data-ch="${ch}" data-i="${i}" data-f="0"></label>
            <label>${unitLabel}<input type="number" min="0" step="0.01" value="${pt[1].toFixed(2)}" class="cal-input" data-ch="${ch}" data-i="${i}" data-f="1"></label>
            ${pts.length > 2 ? `<button class="cal-remove" data-ch="${ch}" data-i="${i}">\u00D7</button>` : ""}
        `;
        container.appendChild(row);
    });
    // bind edits
    container.querySelectorAll(".cal-input").forEach((inp) =>
        inp.addEventListener("change", () => {
            const idx = +inp.dataset.i, field = +inp.dataset.f;
            const val = +inp.value;
            getCurrentCal(calEditSide).points[inp.dataset.ch][idx][field] = val;
            getCurrentCal(calEditSide).isDummy = false;
            calDirty = true;
            drawCalGraph(inp.dataset.ch, `#calGraph${inp.dataset.ch.slice(2)}`);
            onColorUpdate();
            updateCalWarning();
        })
    );
    // bind remove
    container.querySelectorAll(".cal-remove").forEach((btn) =>
        btn.addEventListener("click", () => {
            getCurrentCal(calEditSide).points[btn.dataset.ch].splice(+btn.dataset.i, 1);
            getCurrentCal(calEditSide).isDummy = false;
            calDirty = true;
            renderCalChannel(btn.dataset.ch);
            drawCalGraph(btn.dataset.ch, `#calGraph${btn.dataset.ch.slice(2)}`);
            onColorUpdate();
            updateCalWarning();
        })
    );

    // Nudge the user to anchor the curve at the origin. Without a PWM=0 point
    // every value below the lowest measurement is extrapolated, which can even
    // produce negative irradiance readings.
    if (!pts.some(p => p[0] === 0)) {
        const note = document.createElement("div");
        note.className = "cal-origin-note";
        note.innerHTML = `&#9888; No <strong>0, 0</strong> point &mdash; add one so the curve starts at the origin.`;
        container.appendChild(note);
    }
}

function renderAllCal() {
    ["ch1", "ch2", "ch3"].forEach(renderCalChannel);
    drawAllCalGraphs();
}

// Prepare a canvas for crisp rendering on HiDPI/Retina displays: size the
// backing store to the rendered CSS size × devicePixelRatio and scale the
// context so drawing code works in CSS pixels. Returns {ctx, width, height}
// in CSS pixels. Falls back to the declared width/height attributes when the
// canvas is in a hidden tab (getBoundingClientRect reports 0 for display:none).
function setupCanvasDPI(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.round(rect.width)  || canvas.width;
    const cssH = Math.round(rect.height) || canvas.height;
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw)  canvas.width  = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: cssW, height: cssH };
}

// Draw calibration graph for a channel (data points + regression curve)
function drawCalGraph(ch, canvasId) {
    const canvas = $(canvasId);
    if (!canvas) return;
    const { ctx, width, height } = setupCanvasDPI(canvas);

    // Always clear so an empty dataset doesn't leave the previous graph visible.
    ctx.clearRect(0, 0, width, height);

    // Graphs always show the geometry currently being EDITED on this tab.
    const cSide = getCurrentCal(calEditSide);
    // Use all valid points for drawing (including PWM=0), but filter for power law calculation
    const allPts = cSide.points[ch].filter(p => p[0] >= 0 && p[1] >= 0);
    const pts = allPts.filter(p => p[0] > 0 && p[1] >= 0); // for power law fitting only
    if (allPts.length < 2) return;

    const padding = { top: 12, right: 28, bottom: 36, left: 58 };
    const graphW = width - padding.left - padding.right;
    const graphH = height - padding.top - padding.bottom;

    // Find ranges (Y in display/calibration units — they are the same)
    const maxX = PWM_MAX;
    const maxY = Math.max(...allPts.map(p => p[1])) * 1.1 || 1; // 10% margin, avoid 0
    const unitLabel = getUnitLabel();

    // Helper to map data to canvas coords
    const mapX = (x) => padding.left + (x / maxX) * graphW;
    const mapY = (y) => padding.top + graphH - (y / maxY) * graphH;

    // Draw axes
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Y axis
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + graphH);
    // X axis
    ctx.lineTo(padding.left + graphW, padding.top + graphH);
    ctx.stroke();

    // Draw grid lines
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 4]);
    // Horizontal grid
    for (let i = 1; i <= 4; i++) {
        const y = padding.top + graphH - (i / 4) * graphH;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(padding.left + graphW, y);
        ctx.stroke();
    }
    // Vertical grid
    for (let i = 1; i <= 4; i++) {
        const x = padding.left + (i / 4) * graphW;
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, padding.top + graphH);
        ctx.stroke();
    }
    ctx.setLineDash([]);

    // Draw labels
    ctx.fillStyle = '#888';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    // Y-axis labels (irradiance in calibration units)
    for (let i = 0; i <= 4; i++) {
        const val = (i / 4) * maxY;
        ctx.fillText(val.toFixed(1), padding.left - 8, padding.top + graphH - (i / 4) * graphH + 3);
    }
    // X-axis labels (PWM)
    ctx.textAlign = 'center';
    for (let i = 0; i <= 4; i++) {
        const val = Math.round((i / 4) * maxX);
        ctx.fillText(val.toString(), padding.left + (i / 4) * graphW, padding.top + graphH + 15);
    }

    // Axis titles
    ctx.save();
    ctx.translate(14, padding.top + graphH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#aaa';
    ctx.fillText(unitLabel, 0, 0);
    ctx.restore();
    ctx.fillText('PWM', padding.left + graphW / 2, height - 4);

    // Draw regression curve — use the channel's configured display colour so
    // the calibration curve matches the colour picked for that channel.
    const lineColor = (channelDefs[ch] && channelDefs[ch].color) || '#4fc3f7';
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.beginPath();

    if (cSide.mode === 'power' && cSide.coeffs[ch]) {
        // Power law curve (values are already in cal unit)
        const { a, b } = cSide.coeffs[ch];
        // Sample 256 evenly-spaced points across the 12-bit PWM range.
        for (let i = 1; i <= 256; i++) {
            const x = i * PWM_MAX / 256;
            const y = a * Math.pow(x, b);
            const px = mapX(x);
            const py = mapY(y);
            if (i === 1) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
    } else {
        // Piecewise linear - draw segments between all calibration points
        const sorted = [...allPts].sort((a, b) => a[0] - b[0]);
        sorted.forEach((pt, i) => {
            const px = mapX(pt[0]);
            const py = mapY(pt[1]);
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        });
    }
    ctx.stroke();

    // Draw data points (all points including PWM=0)
    allPts.forEach(pt => {
        const px = mapX(pt[0]);
        const py = mapY(pt[1]);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 2;
        ctx.stroke();
    });
}

function drawAllCalGraphs() {
    computeCalCoeffs(calEditSide);
    drawCalGraph('ch1', '#calGraph1');
    drawCalGraph('ch2', '#calGraph2');
    drawCalGraph('ch3', '#calGraph3');
}

// Add-point buttons
["1", "2", "3"].forEach((n) => {
    $(`#btnAddCal${n}`).addEventListener("click", () => {
        const key = `ch${n}`;
        const pts = getCurrentCal(calEditSide).points[key];
        if (pts.length >= 16) { toast("Max 16 points"); return; }
        const lastPwm = pts.length > 0 ? pts[pts.length - 1][0] : 0;
        pts.push([Math.min(PWM_MAX, lastPwm + 256), 0]);
        getCurrentCal(calEditSide).isDummy = false;
        calDirty = true;
        renderCalChannel(key);
        drawCalGraph(key, `#calGraph${n}`);
        updateCalWarning();
    });
});

// Calibration mode radio buttons — apply to the (side, current display unit) dataset.
$$('input[name="calMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        getCurrentCal(calEditSide).mode = radio.value;
        calDirty = true;
        computeCalCoeffs(calEditSide, displayUnit);
        drawAllCalGraphs();
        onColorUpdate();
        toast(`${calEditSide === "top" ? "Top" : "Bottom"} calibration: ${radio.value === "power" ? "Power law" : "Piecewise-linear"}`);
    });
});

// ── Illumination side selectors ─────────────────────────────────────────────
//  Header toggle = the ACTIVE geometry used for every µmol display, saved with
//  presets and logged with runs. The Calibration tab has its OWN toggle so a
//  user can edit one geometry's calibration while another is active.
function reflectCalModeRadio() {
    const radio = $(`input[name="calMode"][value="${getCurrentCal(calEditSide).mode}"]`);
    if (radio) radio.checked = true;
}
function setIllumSide(side, opts = {}) {
    if (side !== "top" && side !== "bottom") return;
    illumSide = side;
    localStorage.setItem("helios_illum_side", side);
    $$("#illumToggle .illum-btn").forEach(b => b.classList.toggle("selected", b.dataset.illum === side));
    // Every active-side irradiance display must refresh.
    if (typeof onColorUpdate === "function") onColorUpdate();
    if (typeof renderSeqPhases === "function") renderSeqPhases();
    window.dispatchEvent(new Event("helios:calDisplayChanged"));
    if (!opts.silent) toast(`Active illumination: ${side === "top" ? "Top" : "Bottom"}`);
}
function setCalEditSide(side) {
    if (side !== "top" && side !== "bottom") return;
    calEditSide = side;
    $$("#calSideToggle .calside-btn").forEach(b => b.classList.toggle("selected", b.dataset.calside === side));
    reflectCalModeRadio();
    renderAllCal();
    updateCalWarning();
}
$$("#illumToggle .illum-btn").forEach(b =>
    b.addEventListener("click", () => setIllumSide(b.dataset.illum))
);
$$("#calSideToggle .calside-btn").forEach(b =>
    b.addEventListener("click", () => setCalEditSide(b.dataset.calside))
);

// Save calibration — persists all 4 datasets (top/bottom × umol/uwcm2) plus active side.
// Format v3: { version:3, active:"top", sides:{ top:{ umol:{…}, uwcm2:{…} }, bottom:{…} } }
async function saveCalibration() {
    computeCalCoeffs("top", "umol");
    computeCalCoeffs("top", "uwcm2");
    computeCalCoeffs("bottom", "umol");
    computeCalCoeffs("bottom", "uwcm2");
    const payload = {
        version: 3,
        active: illumSide,
        sides: {
            top:    { umol: calStore.top.umol,    uwcm2: calStore.top.uwcm2 },
            bottom: { umol: calStore.bottom.umol, uwcm2: calStore.bottom.uwcm2 },
        },
    };
    const res = await apiPost("/api/calibration", payload);
    if (res && res.ok) {
        calDirty = false;
        toast("Calibration saved (all units)");
    }
    return res;
}
$("#btnSaveCal").addEventListener("click", () => saveCalibration());

// Export calibration to a JSON file (save to ESP32 first, then download).
$("#btnExportCal").addEventListener("click", async () => {
    await saveCalibration();
    const blob = new Blob([JSON.stringify(calStore, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `helios-calibration-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast("Calibration exported");
});

// Import calibration from a JSON file.
$("#btnImportCal").addEventListener("click", () => {
    if (calLocked) return;
    $("#calImportFile").click();
});
$("#calImportFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        // Validate basic shape: should have top/bottom with umol/uwcm2
        if (!data.top || !data.bottom) {
            toast("Invalid calibration file: missing top or bottom");
            return;
        }
        applyCalSideData("top", data.top);
        applyCalSideData("bottom", data.bottom);
        computeCalCoeffs("top", "umol");
        computeCalCoeffs("top", "uwcm2");
        computeCalCoeffs("bottom", "umol");
        computeCalCoeffs("bottom", "uwcm2");
        calDirty = true;
        renderAllCal();
        onColorUpdate();
        updateCalWarning();
        toast("Calibration imported (remember to save)");
    } catch (err) {
        toast("Failed to import calibration: " + err.message);
    }
    e.target.value = "";   // reset so same file can be re-selected
});

// Warn before leaving if calibration edits are unsaved.
window.addEventListener("beforeunload", (e) => {
    if (calDirty) {
        e.preventDefault();
        e.returnValue = "";
    }
});

// Apply one side's stored blob into calStore, validating shape.
// Storage format v3: { umol: {mode,points,coeffs}, uwcm2: {mode,points,coeffs} }.
function applyCalSideData(side, s) {
    if (!s) return;

    function copyChannelPoints(src, dst) {
        ["ch1", "ch2", "ch3"].forEach((ch) => {
            const arr = src[ch];
            if (!Array.isArray(arr) || arr.length < 2) return;
            const clean = [];
            for (let i = 0; i < arr.length; i++) {
                const pt = arr[i];
                if (Array.isArray(pt) && pt.length === 2 &&
                    typeof pt[0] === "number" && Number.isFinite(pt[0]) &&
                    typeof pt[1] === "number" && Number.isFinite(pt[1])) {
                    clean.push([pt[0], pt[1]]);
                }
            }
            if (clean.length >= 2) dst[ch] = clean;
        });
    }

    if (s.umol) {
        if (s.umol.mode === "power" || s.umol.mode === "linear") calStore[side].umol.mode = s.umol.mode;
        if (s.umol.points) { copyChannelPoints(s.umol.points, calStore[side].umol.points); calStore[side].umol.isDummy = s.umol.isDummy === true; }
        if (s.umol.coeffs) calStore[side].umol.coeffs = s.umol.coeffs;
    }
    if (s.uwcm2) {
        if (s.uwcm2.mode === "power" || s.uwcm2.mode === "linear") calStore[side].uwcm2.mode = s.uwcm2.mode;
        if (s.uwcm2.points) { copyChannelPoints(s.uwcm2.points, calStore[side].uwcm2.points); calStore[side].uwcm2.isDummy = s.uwcm2.isDummy === true; }
        if (s.uwcm2.coeffs) calStore[side].uwcm2.coeffs = s.uwcm2.coeffs;
    }
}

// Load calibration on startup. Storage format v3 (per-side, per-unit).
async function loadCalibration() {
    const cal = await apiGet("/api/calibration");
    if (cal && cal.sides && typeof cal.sides === "object") {
        applyCalSideData("top", cal.sides.top);
        applyCalSideData("bottom", cal.sides.bottom);
        if (cal.active === "top" || cal.active === "bottom") illumSide = cal.active;
        calDirty = false;   // freshly loaded data is the saved state
    } else {
        toast("No saved calibration on device — using defaults");
        calDirty = false;   // defaults are the starting point; edits will set dirty
    }
    computeCalCoeffs("top", "umol");
    computeCalCoeffs("top", "uwcm2");
    computeCalCoeffs("bottom", "umol");
    computeCalCoeffs("bottom", "uwcm2");
    // Reflect the active side (header) and the edit side (calibration tab).
    calEditSide = illumSide;
    setIllumSide(illumSide, { silent: true });
    setCalEditSide(calEditSide);
}
loadCalibration();

// ── Live preview (Calibration tab) ──────────────────────────────────────────
//  Drives the LEDs in constant mode via /api/live (no run log) so the user can
//  sweep PWM values with a spectroradiometer pointed at the box without
//  pressing Start/Stop for every measurement.
(function setupLivePreview() {
    const chk     = $("#chkLiveMode");
    const wrap    = $("#liveSliders");
    if (!chk || !wrap) return;

    const sliders = [1, 2, 3].map(i => $(`#liveCh${i}`));
    const nums    = [1, 2, 3].map(i => $(`#liveCh${i}Num`));
    const sciVals = [1, 2, 3].map(i => $(`#liveCh${i}Sci`));

    let liveOn = false;
    let pendingSend = false;
    let lastSendMs  = 0;
    const MIN_INTERVAL_MS = 80;   // throttle slider updates

    function values() {
        return {
            ch1: channelDefs.ch1.enabled ? (+sliders[0].value | 0) : 0,
            ch2: channelDefs.ch2.enabled ? (+sliders[1].value | 0) : 0,
            ch3: channelDefs.ch3.enabled ? (+sliders[2].value | 0) : 0,
        };
    }

    async function send(extra = {}) {
        lastSendMs = Date.now();
        await apiPost("/api/live", Object.assign({ on: true }, values(), extra));
    }

    function scheduleSend() {
        if (!liveOn) return;
        const dt = Date.now() - lastSendMs;
        if (dt >= MIN_INTERVAL_MS) {
            send();
        } else if (!pendingSend) {
            pendingSend = true;
            setTimeout(() => { pendingSend = false; send(); }, MIN_INTERVAL_MS - dt);
        }
    }

    function clampPwm(v) {
        v = parseInt(v, 10);
        if (isNaN(v) || v < 0) v = 0;
        if (v > intensityMax) v = intensityMax;
        return v;
    }

    // Sync slider + number input + irradiance read-out for one channel.
    // `fromNum` = true when the user is typing, so we leave the number field
    // untouched (don't fight the caret) and only mirror the slider.
    function reflectLive(i, pwm, fromNum) {
        if (sliders[i]) sliders[i].value = pwm;
        if (nums[i] && !fromNum) nums[i].value = pwm;
        if (sciVals[i]) sciVals[i].textContent = " " + pwmToDisplayString(`ch${i + 1}`, pwm);
    }

    sliders.forEach((s, i) => {
        if (!s) return;
        s.addEventListener("input", () => {
            reflectLive(i, +s.value, false);
            scheduleSend();
        });
    });
    nums.forEach((n, i) => {
        if (!n) return;
        n.addEventListener("input", () => {
            reflectLive(i, clampPwm(n.value), true);
            scheduleSend();
        });
        // Normalise the typed value on blur / Enter (write back the clamped int).
        n.addEventListener("change", () => {
            const v = clampPwm(n.value);
            n.value = v;
            reflectLive(i, v, false);
            scheduleSend();
        });
    });

    chk.addEventListener("change", async () => {
        if (chk.checked) {
            // Refuse to enable if a real run is active — would clobber it.
            if (isRunning) {
                chk.checked = false;
                toast("Stop the running experiment first");
                return;
            }
            liveOn = true;
            wrap.style.opacity = "1";
            wrap.style.pointerEvents = "auto";
            await send();
        } else {
            liveOn = false;
            wrap.style.opacity = ".4";
            wrap.style.pointerEvents = "none";
            await apiPost("/api/live", { on: false });
        }
    });

    // The irradiance read-outs are derived from the calibration data for the
    // active side + display unit, so they go stale when either changes.
    window.addEventListener("helios:calDisplayChanged", () => {
        sliders.forEach((s, i) => {
            if (s && sciVals[i]) sciVals[i].textContent = " " + pwmToDisplayString(`ch${i + 1}`, +s.value);
        });
    });

    // When the user navigates away from the Calibration tab, switch live off
    // automatically — leaving LEDs on after the user moves on is surprising.
    $$(".tab").forEach(t => t.addEventListener("click", () => {
        if (liveOn && t.dataset.tab !== "calibration") {
            chk.checked = false;
            chk.dispatchEvent(new Event("change"));
        }
    }));

    // If a /api/start happens elsewhere (Setup tab), drop live mode and clear
    // the temperature chart so the x-axis starts at 0 with the new run.
    window.addEventListener("helios:runStarted", () => {
        if (liveOn) { chk.checked = false; chk.dispatchEvent(new Event("change")); }
        tempLog = [];
        drawTempChart();
    });
})();

// ── Temperature chart (mini sparkline on canvas) ────────────────────────────
let tempLog = [];  // [{t, c}]

async function loadTempLog() {
    const data = await apiGet("/api/temperature");
    if (!data || !data.log) return;
    tempLog = data.log;
    drawTempChart();
}

function drawTempChart() {
    const canvas = $("#tempChart");
    if (!canvas) return;
    const { ctx, width: W, height: H } = setupCanvasDPI(canvas);
    ctx.clearRect(0, 0, W, H);
    if (tempLog.length < 2) return;

    const temps = tempLog.map(e => +e.c);
    const times = tempLog.map(e => +e.t);
    const minT = Math.min(...temps) - 1;
    const maxT = Math.max(...temps) + 1;
    const range = maxT - minT || 1;
    const padTop = 14, padBot = 18, padLeft = 36, padRight = 6;
    const plotW = W - padLeft - padRight;
    const plotH = H - padTop - padBot;

    // Gridlines
    ctx.strokeStyle = '#1f3050';
    ctx.lineWidth = 0.5;
    const nGrid = 4;
    for (let i = 0; i <= nGrid; i++) {
        const y = padTop + (i / nGrid) * plotH;
        ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(W - padRight, y); ctx.stroke();
    }

    // Data line
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#4fc3f7';
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < temps.length; i++) {
        const x = padLeft + (i / (temps.length - 1)) * plotW;
        const y = padTop + plotH - ((temps[i] - minT) / range) * plotH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Y-axis labels (temperature)
    ctx.fillStyle = '#8892a4';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= nGrid; i++) {
        const val = maxT - (i / nGrid) * (maxT - minT);
        const y = padTop + (i / nGrid) * plotH + 3;
        ctx.fillText(val.toFixed(1) + '\u00b0', padLeft - 3, y);
    }

    // X-axis time labels (minutes since start)
    ctx.textAlign = 'center';
    const nTicks = Math.min(5, temps.length);
    const tickStep = Math.max(1, Math.ceil((temps.length - 1) / nTicks));
    for (let i = 0; i < temps.length; i += tickStep) {
        const t = times[i];
        const x = padLeft + (i / (temps.length - 1)) * plotW;
        ctx.fillText(t + 'm', x, H - 3);
    }

    // Time range display
    const rangeEl = $("#tempTimeRange");
    if (rangeEl) {
        const tMin = Math.min(...times);
        const tMax = Math.max(...times);
        const spanMin = tMax - tMin;
        rangeEl.textContent = spanMin > 0 ? `Minutes ${tMin}-${tMax} (${tempLog.length} points)` : `Showing ${tempLog.length} points`;
    }
}

// Refresh temp log periodically
setInterval(loadTempLog, 10000);
loadTempLog();

// ── Fan controls ────────────────────────────────────────────────────────────
// A single speed slider drives the fan: 0 % = off, >0 % = on. The separate
// ON/OFF mode buttons were removed because FAN_OFF and FAN_ON@0% are identical.
// `fanSpeedDirty` guards the value from being clobbered by the 500 ms status
// push while the user is editing but hasn't pressed Apply yet.
let fanSpeedDirty = false;

const sliderFanSpeed = $("#sliderFanSpeed"), numFanSpeed = $("#numFanSpeed");
// Keep slider and number input in sync. Clamp the typed value to 0-100.
function setFanSpeedUI(val, fromSlider) {
    let v = parseFloat(val);
    if (isNaN(v)) return;
    if (v < 0) v = 0;
    if (v > 100) v = 100;
    v = Math.round(v * 10) / 10;   // 0.1 % resolution
    if (sliderFanSpeed) sliderFanSpeed.value = v;
    if (numFanSpeed && !fromSlider) numFanSpeed.value = v;
}
if (sliderFanSpeed) {
    sliderFanSpeed.addEventListener("input", () => {
        fanSpeedDirty = true;
        if (numFanSpeed) numFanSpeed.value = sliderFanSpeed.value;
    });
}
if (numFanSpeed) {
    // Update the slider live as the user types; clamp on change/blur.
    numFanSpeed.addEventListener("input", () => {
        fanSpeedDirty = true;
        if (sliderFanSpeed && numFanSpeed.value !== "") sliderFanSpeed.value = numFanSpeed.value;
    });
    numFanSpeed.addEventListener("change", () => setFanSpeedUI(numFanSpeed.value, false));
}

// ── Temperature calibration (Settings tab) ──────────────────────────────────
(function setupTempCal() {
    const tcRaw    = $("#tcRaw");
    const tcCal    = $("#tcCal");
    const tcOffset = $("#tcOffset");
    const tcRef    = $("#tcReference");
    const btnSave  = $("#btnSaveTempOffset");
    const btnComp  = $("#btnComputeTempOffset");
    if (!tcOffset) return;
    let lastRaw = null;

    async function refresh() {
        const d = await apiGet("/api/tempcal");
        if (!d) return;
        if (typeof d.offsetC === "number") {
            tcOffset.value = d.offsetC.toFixed(2);
        }
        if (typeof d.rawC === "number") {
            lastRaw = d.rawC;
            tcRaw.textContent = `${d.rawC.toFixed(2)} °C`;
            tcCal.textContent = `${(d.calibratedC).toFixed(2)} °C`;
        } else {
            lastRaw = null;
            tcRaw.textContent = "no sensor";
            tcCal.textContent = "no sensor";
        }
    }
    refresh();
    // Light polling so the displayed values stay fresh while the user is on
    // this tab; cheap (single small GET every 3 s).
    setInterval(() => {
        if (document.visibilityState === "visible" &&
            $("#tab-settings").classList.contains("active")) {
            refresh();
        }
    }, 3000);

    async function saveOffset(value) {
        if (!isFinite(value)) { toast("Invalid offset"); return; }
        if (value < -5 || value > 5) {
            if (!confirm(`Offset of ${value.toFixed(2)} °C is outside ±5 °C and will be clamped. Continue?`)) return;
        }
        const r = await apiPost("/api/tempcal", { offsetC: value });
        if (r && r.ok) {
            toast(`Temperature offset set to ${(+r.offsetC).toFixed(2)} °C`);
            refresh();
        } else {
            toast("Failed to save offset");
        }
    }

    btnSave.addEventListener("click", () => saveOffset(parseFloat(tcOffset.value)));

    btnComp.addEventListener("click", () => {
        const ref = parseFloat(tcRef.value);
        if (!isFinite(ref)) { toast("Enter a reference temperature first"); return; }
        if (lastRaw === null) { toast("No sensor reading yet — wait a moment"); return; }
        const newOffset = ref - lastRaw;
        saveOffset(newOffset);
    });
})();

$("#btnApplyFan").addEventListener("click", async () => {
    // Prefer the typed value; fall back to the slider. Clamp to 0-100.
    setFanSpeedUI(numFanSpeed ? numFanSpeed.value : sliderFanSpeed.value, false);
    const pct = +sliderFanSpeed.value;
    // Mode is derived from the speed: 0 % = off, anything above = on.
    const mode = pct > 0 ? "on" : "off";
    if (!confirm(`Set fan speed to ${pct}\u202f%${pct > 0 ? "" : " (off)"}?`)) return;
    // API contract: speed is a percent (0–100, fractional). Firmware maps to its
    // internal 10-bit PWM duty cycle.
    const res = await apiPost("/api/fan", { mode, speed: pct });
    if (res && res.ok) {
        fanSpeedDirty = false;
        toast("Fan settings updated");
    }
});

// ── Safety lock for calibration ─────────────────────────────────────────
let calLocked = true;
function setCalLock(locked) {
    calLocked = locked;
    const card = $("#calCard");
    $("#calLockBar").classList.toggle("hidden", !locked);
    $("#calUnlockedBar").classList.toggle("hidden", locked);
    card.classList.toggle("cal-locked", locked);
}
// Note: we intentionally don't use confirm() here. Embedded webviews (e.g.
// IDE browser previews running with a `sandbox` attribute that lacks
// `allow-modals`) silently drop confirm() and the button appears dead.
// The explicit click on "Unlock" is intent enough — the lock is a UX guard,
// not a security boundary, and the user can always re-lock immediately.
$("#btnUnlockCal").addEventListener("click", () => setCalLock(false));
$("#btnLockCal").addEventListener("click", () => setCalLock(true));
setCalLock(true);

// ── Global Settings Lock ────────────────────────────────────────────────
let settingsLocked = true;

function setSettingsLock(locked) {
    settingsLocked = locked;
    const settingsTab = $("#tab-settings");
    $("#globalLockBar").classList.toggle("hidden", !locked);
    $("#globalUnlockedBar").classList.toggle("hidden", locked);
    settingsTab.classList.toggle("settings-locked", locked);
    // Also sync cal lock
    if (locked) setCalLock(true);
}

$("#btnUnlockSettings").addEventListener("click", () => setSettingsLock(false));

$("#btnLockSettings").addEventListener("click", () => setSettingsLock(true));
setSettingsLock(true);

// (Default-Pattern feature removed: irrelevant on tri-spectrum hardware.)

// ── Channel Definitions (display label + colour, persisted in localStorage) ─
//  Channels 1–3 drive LEDs (channel 4 is the fan, configured separately).
//  Whatever the user enters here propagates to the Setup and Calibration tabs;
//  the firmware itself does not interpret the label strings.
//  NOTE: DEFAULT_CHANNEL_DEFS and channelDefs themselves are hoisted to the
//  top of the file — see the comment there for the reasoning.
function applyChannelDefs() {
    // Push the colours into CSS custom properties used throughout the UI.
    document.documentElement.style.setProperty("--ch1", channelDefs.ch1.color);
    document.documentElement.style.setProperty("--ch2", channelDefs.ch2.color);
    document.documentElement.style.setProperty("--ch3", channelDefs.ch3.color);
    // Update label spans on the Setup and Calibration tabs.
    const setLbl = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    setLbl("#label1",    channelDefs.ch1.label);
    setLbl("#label2",    channelDefs.ch2.label);
    setLbl("#label3",    channelDefs.ch3.label);
    setLbl("#calLabel1",  channelDefs.ch1.label);
    setLbl("#calLabel2",  channelDefs.ch2.label);
    setLbl("#calLabel3",  channelDefs.ch3.label);
    setLbl("#liveLabel1", channelDefs.ch1.label);
    setLbl("#liveLabel2", channelDefs.ch2.label);
    setLbl("#liveLabel3", channelDefs.ch3.label);
    // Sync the form inputs in Settings.
    const sync = (id, v) => { const el = $(id); if (el) el.value = v; };
    sync("#ch1Label", channelDefs.ch1.label);
    sync("#ch2Label", channelDefs.ch2.label);
    sync("#ch3Label", channelDefs.ch3.label);
    sync("#ch1Color", channelDefs.ch1.color);
    sync("#ch2Color", channelDefs.ch2.color);
    sync("#ch3Color", channelDefs.ch3.color);
    sync("#ch1Wavelength", channelDefs.ch1.wavelength);
    sync("#ch2Wavelength", channelDefs.ch2.wavelength);
    sync("#ch3Wavelength", channelDefs.ch3.wavelength);
    const syncChk = (id, on) => { const el = $(id); if (el) el.checked = !!on; };
    syncChk("#ch1Enabled", channelDefs.ch1.enabled);
    syncChk("#ch2Enabled", channelDefs.ch2.enabled);
    syncChk("#ch3Enabled", channelDefs.ch3.enabled);
    // Hide disabled channels from Setup, Calibration tabs.
    const setHidden = (id, hidden) => { const el = $(id); if (el) el.classList.toggle("hidden", hidden); };
    setHidden("#sliderGroup1", !channelDefs.ch1.enabled);
    setHidden("#sliderGroup2", !channelDefs.ch2.enabled);
    setHidden("#sliderGroup3", !channelDefs.ch3.enabled);
    setHidden("#calChannel1", !channelDefs.ch1.enabled);
    setHidden("#calChannel2", !channelDefs.ch2.enabled);
    setHidden("#calChannel3", !channelDefs.ch3.enabled);
    // Hide live-preview rows for disabled channels too.
    const setHiddenSel = (sel, hidden) => { const el = document.querySelector(sel); if (el) el.classList.toggle("hidden", hidden); };
    setHiddenSel('[data-live-ch="1"]', !channelDefs.ch1.enabled);
    setHiddenSel('[data-live-ch="2"]', !channelDefs.ch2.enabled);
    setHiddenSel('[data-live-ch="3"]', !channelDefs.ch3.enabled);
    // Force value of disabled channels to 0 so they never light up.
    if (!channelDefs.ch1.enabled) { if (slider1) slider1.value = 0; if (num1) num1.value = 0; }
    if (!channelDefs.ch2.enabled) { if (slider2) slider2.value = 0; if (num2) num2.value = 0; }
    if (!channelDefs.ch3.enabled) { if (slider3) slider3.value = 0; if (num3) num3.value = 0; }
    // Refresh dependent UI parts.
    onColorUpdate();
    window.dispatchEvent(new Event("helios:channelDefs"));
}

function loadChannelDefs() {
    try {
        const raw = localStorage.getItem("helios_channel_defs");
        if (raw) {
            const parsed = JSON.parse(raw);
            for (const k of ["ch1", "ch2", "ch3"]) {
                const src = parsed[k];
                if (src) {
                    channelDefs[k].label = String(src.label || channelDefs[k].label);
                    channelDefs[k].color = String(src.color || channelDefs[k].color);
                    channelDefs[k].wavelength = Number(src.wavelength) || channelDefs[k].wavelength;
                    // 'enabled' defaults to true for old configs that lack the key.
                    channelDefs[k].enabled = (src.enabled === undefined) ? true : !!src.enabled;
                }
            }
        }
    } catch (e) { /* ignore corrupt storage */ }
    applyChannelDefs();
}

// Propagate label/colour edits to Setup and Calibration tabs live, so the
// user sees the effect while editing. The Save button only persists the
// current state to localStorage.
function readChannelDefsFromForm() {
    channelDefs.ch1.label = ($("#ch1Label").value || DEFAULT_CHANNEL_DEFS.ch1.label).slice(0, 16);
    channelDefs.ch2.label = ($("#ch2Label").value || DEFAULT_CHANNEL_DEFS.ch2.label).slice(0, 16);
    channelDefs.ch3.label = ($("#ch3Label").value || DEFAULT_CHANNEL_DEFS.ch3.label).slice(0, 16);
    channelDefs.ch1.color = $("#ch1Color").value || DEFAULT_CHANNEL_DEFS.ch1.color;
    channelDefs.ch2.color = $("#ch2Color").value || DEFAULT_CHANNEL_DEFS.ch2.color;
    channelDefs.ch3.color = $("#ch3Color").value || DEFAULT_CHANNEL_DEFS.ch3.color;
    const readWl = (id, fallback) => { const el = $(id); const v = el ? parseInt(el.value, 10) : 0; return v > 0 ? v : fallback; };
    channelDefs.ch1.wavelength = readWl("#ch1Wavelength", DEFAULT_CHANNEL_DEFS.ch1.wavelength);
    channelDefs.ch2.wavelength = readWl("#ch2Wavelength", DEFAULT_CHANNEL_DEFS.ch2.wavelength);
    channelDefs.ch3.wavelength = readWl("#ch3Wavelength", DEFAULT_CHANNEL_DEFS.ch3.wavelength);
    const readChk = (id, fallback) => { const el = $(id); return el ? !!el.checked : fallback; };
    channelDefs.ch1.enabled = readChk("#ch1Enabled", true);
    channelDefs.ch2.enabled = readChk("#ch2Enabled", true);
    channelDefs.ch3.enabled = readChk("#ch3Enabled", true);
}

function bindChannelDefLiveUpdate(inputId) {
    const el = $(inputId);
    if (!el) return;
    // 'input' fires on every keystroke / colour-picker drag.
    el.addEventListener("input", () => {
        readChannelDefsFromForm();
        // Don't call applyChannelDefs() here — that would overwrite the very
        // input field the user is typing into. Update only the downstream
        // consumers (CSS vars + Setup/Calibration label spans + preview).
        document.documentElement.style.setProperty("--ch1", channelDefs.ch1.color);
        document.documentElement.style.setProperty("--ch2", channelDefs.ch2.color);
        document.documentElement.style.setProperty("--ch3", channelDefs.ch3.color);
        const setLbl = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
        setLbl("#label1",    channelDefs.ch1.label);
        setLbl("#label2",    channelDefs.ch2.label);
        setLbl("#label3",    channelDefs.ch3.label);
        setLbl("#calLabel1", channelDefs.ch1.label);
        setLbl("#calLabel2", channelDefs.ch2.label);
        setLbl("#calLabel3", channelDefs.ch3.label);
        onColorUpdate();
        window.dispatchEvent(new Event("helios:channelDefs"));
    });
}
["#ch1Label", "#ch2Label", "#ch3Label",
 "#ch1Color", "#ch2Color", "#ch3Color",
 "#ch1Wavelength", "#ch2Wavelength", "#ch3Wavelength"].forEach(bindChannelDefLiveUpdate);

// Enable checkboxes apply immediately (show/hide channel UI sections live).
["#ch1Enabled", "#ch2Enabled", "#ch3Enabled"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", () => {
        readChannelDefsFromForm();
        applyChannelDefs();
    });
});

// ── Display unit ────────────────────────────────────────────────────────────
function reflectDisplayUnitRadio() {
    const radio = $(`input[name="displayUnit"][value="${displayUnit}"]`);
    if (radio) radio.checked = true;
}
reflectDisplayUnitRadio();

$$('input[name="displayUnit"]').forEach(radio => {
    radio.addEventListener('change', () => {
        displayUnit = radio.value;
        localStorage.setItem("helios_display_unit", displayUnit);
        onColorUpdate();
        // Sequential rows embed the unit label and irradiance values, so they
        // must be rebuilt for the new unit's calibration dataset.
        renderSeqPhases();
        // Re-render calibration tab to show the dataset for the new display unit
        reflectCalModeRadio();
        renderAllCal();
        updateCalWarning();
        window.dispatchEvent(new Event("helios:calDisplayChanged"));
        toast(`Display unit: ${getUnitLabel()}`);
    });
});

$("#btnSaveDisplayUnit").addEventListener("click", () => {
    localStorage.setItem("helios_display_unit", displayUnit);
    toast("Display unit preference saved");
});

$("#btnSaveChannelDefs").addEventListener("click", () => {
    readChannelDefsFromForm();
    localStorage.setItem("helios_channel_defs", JSON.stringify(channelDefs));
    applyChannelDefs();
    toast("Channel definitions saved");
});

$("#btnResetChannelDefs").addEventListener("click", () => {
    if (!confirm("Reset channel labels and colours to the defaults?")) return;
    channelDefs = JSON.parse(JSON.stringify(DEFAULT_CHANNEL_DEFS));
    localStorage.setItem("helios_channel_defs", JSON.stringify(channelDefs));
    applyChannelDefs();
    toast("Channel definitions reset");
});

// ── Intensity Range ───────────────────────────────────────────────────────
const intensityMaxInput = $("#intensityMaxInput");
if (intensityMaxInput) {
    intensityMaxInput.value = intensityMax;
    const btnSaveIntensityMax = $("#btnSaveIntensityMax");
    if (btnSaveIntensityMax) {
        btnSaveIntensityMax.addEventListener("click", () => {
            let v = Math.round(+intensityMaxInput.value || PWM_MAX);
            if (v < 1) v = 1;
            if (v > PWM_MAX) v = PWM_MAX;
            intensityMax = v;
            intensityMaxInput.value = v;
            localStorage.setItem("helios_intensity_max", v);
            applyIntensityMax();
            toast(`Intensity range set to 0–${v}`);
        });
    }
}

loadChannelDefs();

// ── WiFi Settings ────────────────────────────────────────────────────────
async function loadWiFiSettings() {
    const settings = await apiGet("/api/wifi");
    if (settings) {
        $("#wifiSsid").value = settings.ssid || "";
        $("#wifiPassword").value = settings.password || "";
    }
}

$("#btnSaveWiFi").addEventListener("click", async () => {
    const ssid = $("#wifiSsid").value.trim();
    const password = $("#wifiPassword").value;
    
    if (!ssid) {
        toast("Network name (SSID) is required");
        return;
    }
    if (password.length > 0 && password.length < 8) {
        toast("Password must be at least 8 characters");
        return;
    }
    
    const res = await apiPost("/api/wifi", { ssid, password });
    if (res && res.ok) {
        $("#wifiStatus").textContent = "WiFi settings saved. Restart required to apply.";
        toast("WiFi settings saved");
    } else {
        $("#wifiStatus").textContent = "Save failed: " + (res?.error || "unknown error");
        toast("Save failed");
    }
});

$("#btnRestart").addEventListener("click", async () => {
    if (confirm("Restart the Helios unit?")) {
        toast("Restarting...");
        const res = await apiPost("/api/restart", {});
        if (res && res.ok) {
            toast("Restarting... Reconnect to WiFi in 30 seconds");
            // Page will become unresponsive during restart
        } else {
            toast("Restart command failed");
        }
    }
});

// Load WiFi settings on startup
loadWiFiSettings();

// ── Device Name ──────────────────────────────────────────────────────────
//  Shown in the header so multiple units can be told apart at a glance.
//  Persisted on the device; applied live (also pushed via status updates).
function applyDeviceName(name) {
    const n = (name || "Helios").trim() || "Helios";
    const hdr = $("#deviceNameHeader");
    if (hdr && hdr.textContent !== n) hdr.textContent = n;
    if (document.title !== n) document.title = n;
}

async function loadDeviceName() {
    const res = await apiGet("/api/devicename");
    const name = (res && res.name) ? res.name : "Helios";
    const input = $("#deviceNameInput");
    if (input) input.value = name;
    applyDeviceName(name);
}

const btnSaveDeviceName = $("#btnSaveDeviceName");
if (btnSaveDeviceName) {
    btnSaveDeviceName.addEventListener("click", async () => {
        const name = $("#deviceNameInput").value.trim();
        if (!name) {
            $("#deviceNameStatus").textContent = "Name cannot be empty.";
            toast("Enter a device name");
            return;
        }
        const res = await apiPost("/api/devicename", { name });
        if (res && res.ok) {
            applyDeviceName(res.name || name);
            $("#deviceNameStatus").textContent = "Saved.";
            toast("Device name saved");
        } else {
            $("#deviceNameStatus").textContent = "Save failed: " + (res?.error || "unknown error");
            toast("Save failed");
        }
    });
}

loadDeviceName();

// ── Auto-Start Settings ───────────────────────────────────────────────────
async function loadAutoStartSettings() {
    const settings = await apiGet("/api/autostart");
    if (settings) {
        $("#chkAutoStart").checked = settings.enabled || false;
        const presetGroup = $("#autoStartPresetGroup");
        if (settings.enabled) {
            presetGroup.style.opacity = "1";
            presetGroup.style.pointerEvents = "auto";
        }
        // Set the dropdown to the saved preset slot
        if (settings.presetSlot !== undefined && settings.presetSlot >= 0) {
            $("#selAutoStartPreset").value = settings.presetSlot;
        }
    }
}

async function populateAutoStartPresets() {
    const list = await apiGet("/api/presets");
    const select = $("#selAutoStartPreset");
    // Keep first option
    select.innerHTML = '<option value="-1">-- Select a preset --</option>';
    
    if (list && Array.isArray(list)) {
        list.forEach(p => {
            const opt = document.createElement("option");
            opt.value = p.slot;
            opt.textContent = `#${p.slot}: ${p.name}`;
            select.appendChild(opt);
        });
    }
}

$("#chkAutoStart").addEventListener("change", () => {
    const enabled = $("#chkAutoStart").checked;
    const presetGroup = $("#autoStartPresetGroup");
    if (enabled) {
        presetGroup.style.opacity = "1";
        presetGroup.style.pointerEvents = "auto";
    } else {
        presetGroup.style.opacity = "0.5";
        presetGroup.style.pointerEvents = "none";
    }
});

$("#btnSaveAutoStart").addEventListener("click", async () => {
    const enabled = $("#chkAutoStart").checked;
    const presetSlot = parseInt($("#selAutoStartPreset").value);
    
    if (enabled && presetSlot < 0) {
        toast("Please select a preset for auto-start");
        return;
    }
    
    const res = await apiPost("/api/autostart", { enabled, presetSlot });
    if (res && res.ok) {
        $("#autoStartStatus").textContent = enabled 
            ? `Auto-start enabled with preset #${presetSlot}` 
            : "Auto-start disabled";
        toast("Auto-start settings saved");
    } else {
        toast("Failed to save auto-start settings");
    }
});

// Load auto-start settings after presets are loaded
setTimeout(() => {
    populateAutoStartPresets();
    loadAutoStartSettings();
}, 1000);

// ── Run Logs (persistent per-experiment temperature traces) ─────────────────
async function loadRunLogs() {
    const list = await apiGet("/api/runs");
    const tbody = $("#runLogsList");
    if (!tbody) return;
    if (!list || list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" class="hint">No run logs yet.</td></tr>';
        return;
    }
    // Sort newest first by filename (run_NNNN.csv sorts by run number).
    list.sort((a, b) => b.name.localeCompare(a.name));
    tbody.innerHTML = "";
    for (const run of list) {
        const tr = document.createElement("tr");
        // Pretty-print: turn "run_0017.csv" → "Run #17".
        const m = run.name.match(/^run_0*(\d+)\.csv$/);
        const pretty = m ? `Run #${m[1]}` : run.name;
        const sizeKb = (run.size / 1024).toFixed(1);
        tr.innerHTML = `
            <td>${esc(pretty)}</td>
            <td>${sizeKb}\u202fKB</td>
            <td>
                <a class="btn btn-tiny" href="/api/runs/${encodeURIComponent(run.name)}?_=${Date.now()}" download="${esc(run.name)}">Download</a>
                <button class="btn btn-tiny btn-secondary" data-name="${esc(run.name)}">Delete</button>
            </td>`;
        tbody.appendChild(tr);
    }
    tbody.querySelectorAll("button[data-name]").forEach(b => {
        b.addEventListener("click", async () => {
            if (!confirm(`Delete run log "${b.dataset.name}"?`)) return;
            const r = await fetch(`/api/runs/${encodeURIComponent(b.dataset.name)}`, { method: "DELETE" });
            if (r.ok) { toast("Run log deleted"); loadRunLogs(); }
            else     { toast("Cannot delete (run still active?)"); }
        });
    });
}

const btnRefreshRunLogs = $("#btnRefreshRunLogs");
if (btnRefreshRunLogs) btnRefreshRunLogs.addEventListener("click", loadRunLogs);

const btnDeleteAllRuns = $("#btnDeleteAllRuns");
if (btnDeleteAllRuns) btnDeleteAllRuns.addEventListener("click", async () => {
    if (!confirm("Delete ALL run logs? This cannot be undone.")) return;
    const r = await fetch("/api/runs", { method: "DELETE" });
    if (r.ok) { toast("All run logs deleted"); loadRunLogs(); }
});

// Load run logs whenever the user enters the Settings tab.
$$(".tab").forEach(t => {
    if (t.dataset.tab === "settings") {
        t.addEventListener("click", () => loadRunLogs());
    }
});
loadRunLogs();
applyIntensityMax();

// ── Custom PWM Stepper Buttons ────────────────────────────────────────────
//  Replaces native number-input spinners (absent on mobile browsers) with
//  custom +/- buttons. Single press = ±1 step; press-and-hold = continuous
//  increment/decrement with gradual acceleration.
(function initSteppers() {
    const HOLD_DELAY   = 400;  // ms before auto-repeat starts
    const REPEAT_MIN   = 50;   // fastest repeat interval
    const REPEAT_START = 120;  // initial repeat interval
    const ACCEL        = 0.85;  // interval multiplier per tick (speeds up)

    function stepInput(input, delta) {
        const min = +input.min || 0;
        const max = +input.max || PWM_MAX;
        let v = parseFloat(input.value);
        if (isNaN(v)) v = 0;
        v = Math.min(max, Math.max(min, v + delta));
        // Round to avoid floating-point drift for decimal steps
        if (delta % 1 !== 0) {
            const decimals = (delta.toString().split('.')[1] || '').length;
            v = parseFloat(v.toFixed(decimals));
        }
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function attach(btn) {
        const targetId = btn.dataset.target;
        const delta    = +btn.dataset.step;
        if (!targetId || !delta) return;
        const input = document.getElementById(targetId);
        if (!input) return;

        let holdTimer = null;
        let repeatTimer = null;
        let interval = REPEAT_START;
        let fired = false;

        function doStep() {
            stepInput(input, delta);
            fired = true;
        }

        function startRepeat() {
            interval = REPEAT_START;
            function tick() {
                doStep();
                if (interval > REPEAT_MIN) interval = Math.max(REPEAT_MIN, interval * ACCEL);
                repeatTimer = setTimeout(tick, interval);
            }
            repeatTimer = setTimeout(tick, interval);
        }

        function clearAll() {
            if (holdTimer)  { clearTimeout(holdTimer);  holdTimer = null; }
            if (repeatTimer) { clearTimeout(repeatTimer); repeatTimer = null; }
        }

        function onDown(e) {
            e.preventDefault();
            fired = false;
            doStep();                       // immediate single step
            holdTimer = setTimeout(() => {
                startRepeat();              // begin auto-repeat after hold delay
            }, HOLD_DELAY);
        }

        function onUp() {
            clearAll();
        }

        btn.addEventListener("pointerdown", onDown);
        btn.addEventListener("pointerup",   onUp);
        btn.addEventListener("pointerleave", onUp);
        btn.addEventListener("pointercancel", onUp);
        // Prevent context menu on long-press (mobile)
        btn.addEventListener("contextmenu", e => e.preventDefault());
    }

    document.querySelectorAll(".stepper-btn").forEach(attach);
})();

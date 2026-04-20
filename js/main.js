/**
 * Soft Mirror - Main Entry Point
 * State machine, render loop, and human figure rendering
 */

// ==========================================
// App Configuration
// ==========================================

const AppConfig = {
    canvas: {
        width: 1280,
        height: 720,
        pixelDensity: 1,
        // 20 fps: ~17 % less work than 24 fps. For a slow meditative
        // mirror the motion still reads as fluid; below this the live
        // video feed starts to feel stuttery during quick hand moves.
        targetFPS: 20
    },
    timing: {
        effectDuration: 45000,      // ms in EFFECT mode before auto-transition
        transitionDuration: 2000,   // ms for cross-fade transition
        mirrorDuration: 30000       // ms in CALM MIRROR mode before auto-transition
    },
    // Mirror controls - toggleable via keyboard shortcuts 1/2
    mirror: {
        video: false,   // flip the raw camera feed horizontally
        mask: true      // flip the segmentation mask to match
    },
    // Long-running installation safety. All intervals are checked lazily
    // at state transitions so the reset is invisible (happens during
    // TRANSITION state cross-fade).
    longRunning: {
        // Soft reset: clear trails/particles/diagnostics counters.
        // Cheap, runs every 6 h to keep subsystems "young".
        softResetIntervalMs: 6 * 3600 * 1000,
        // Hard reload: full page reload. Nuclear option to shed any slow
        // drift (MediaPipe WASM heap, canvas driver state, etc.).
        // Set to 0 to disable.
        hardReloadIntervalMs: 24 * 3600 * 1000
    },
    debug: false        // press D to toggle debug panel at runtime
};

// Runtime state for the long-running safety checks above.
let lastSoftResetTime = 0;
let appStartTime = 0;

// ==========================================
// App States
// ==========================================

const AppState = {
    LOADING: 'LOADING',
    EFFECT: 'EFFECT',
    TRANSITION: 'TRANSITION',
    MIRROR: 'MIRROR',
    ERROR: 'ERROR'
};

// ==========================================
// Global State
// ==========================================

let currentState = AppState.LOADING;
let previousState = null;
let stateStartTime = 0;

let p5Instance = null;
let fpsCounter = null;
let lastFrameTime = 0;
let deltaTime = 0;

// Canvases
let mainCanvas = null;
let compositeCanvas = null;
let compositeCtx = null;
let humanCanvas = null;
let humanCtx = null;

// ==========================================
// DOM Elements
// ==========================================

const DOM = {
    loadingScreen: null,
    loadingBar: null,
    loadingStatus: null,
    instructions: null,
    modeIndicator: null,
    modeText: null,
    debugPanel: null,
    fpsCounter: null,
    stateInfo: null,
    handVelocity: null,
    ratioInfo: null,
    inferenceInfo: null,
    heapInfo: null,
    uptimeInfo: null,
    installHud: null,
    errorScreen: null,
    retryBtn: null
};

// Heap monitoring (Chrome-only — performance.memory is non-standard).
// Recorded at startup and sampled periodically so we can both display
// live usage in the debug panel and log a warning if it climbs too far
// above the baseline (indicates a slow leak in long-running installs).
const HEAP_WARN_GROWTH_FACTOR = 2.5;   // warn once if usage > baseline × 2.5
const HEAP_SAMPLE_INTERVAL_MS  = 60000; // sample once a minute
let heapBaselineBytes = 0;
let heapPeakBytes = 0;
let heapCurrentBytes = 0;
let heapWarnedAt = 0;
let heapSampleTimer = null;

function sampleHeap() {
    // performance.memory is a Chromium-only API. Gracefully degrade in
    // Safari / Firefox by leaving the numbers at 0.
    const mem = performance && performance.memory;
    if (!mem || typeof mem.usedJSHeapSize !== 'number') return;
    heapCurrentBytes = mem.usedJSHeapSize;
    if (heapBaselineBytes === 0) heapBaselineBytes = heapCurrentBytes;
    if (heapCurrentBytes > heapPeakBytes) heapPeakBytes = heapCurrentBytes;

    // Rate-limit warnings to once per 10 min so logs don't flood.
    const now = performance.now();
    if (heapBaselineBytes > 0 &&
        heapCurrentBytes > heapBaselineBytes * HEAP_WARN_GROWTH_FACTOR &&
        now - heapWarnedAt > 10 * 60 * 1000) {
        console.warn(
            `[Mirror] Heap growth detected: ` +
            `baseline ${Math.round(heapBaselineBytes / 1048576)} MB → ` +
            `current ${Math.round(heapCurrentBytes / 1048576)} MB ` +
            `(peak ${Math.round(heapPeakBytes / 1048576)} MB)`
        );
        heapWarnedAt = now;
    }
}

function startHeapMonitor() {
    if (heapSampleTimer) clearInterval(heapSampleTimer);
    sampleHeap();  // baseline immediately
    heapSampleTimer = setInterval(sampleHeap, HEAP_SAMPLE_INTERVAL_MS);
}

// ==========================================
// Installation Watchdog — iPad-hardened self-recovery
// ==========================================
// Five independent safety nets layered on top of the render-loop logic.
// Everything here runs off plain setInterval timers, NOT the p5 draw loop,
// so it keeps working even if rAF is throttled, the state machine wedges,
// the GPU context is lost, or the main thread stalls.
//
//   1. Independent hard-reload timer  — reloads on schedule even if the
//                                       state-machine-gated reset in
//                                       maybeScheduledReset() never runs.
//   2. Pixel liveness sampler         — getImageData on a few fixed points
//                                       every 10 s. 3 identical samples in
//                                       a row (~30 s) = canvas is frozen
//                                       (Safari GPU context loss, etc.) →
//                                       reload. This is the iPad killer.
//   3. ERROR-state auto-reload        — don't let a transient camera hiccup
//                                       leave the install stuck behind a
//                                       "Try Again" button forever.
//   4. Reinit-failure escalation      — if MediaPipe models fail to re-init
//                                       ≥ 3 times in a row the WASM heap
//                                       is wedged; only a full reload helps.
//   5. Unhandled-error storm          — N uncaught errors/rejections in a
//                                       row trips a reload.
//
// Screen Wake Lock is requested alongside (and re-requested on visibility
// change) so iOS does not put the display to sleep mid-session.

const INSTALL_RELOAD_CHECK_MS      = 60 * 1000;       // poll every minute
const INSTALL_LIVENESS_SAMPLE_MS   = 10 * 1000;       // sample pixels every 10 s
const INSTALL_LIVENESS_STALL_LIMIT = 3;               // 3 identical → ~30 s dead
const INSTALL_ERROR_AUTO_RELOAD_MS = 20 * 1000;       // auto-reload after 20 s in ERROR
const INSTALL_UNHANDLED_ERR_LIMIT  = 15;              // unhandled errors before reload
const INSTALL_REINIT_FAIL_LIMIT    = 3;               // MediaPipe reinit failures before reload
// Safari has no performance.memory, but if we're on Chromium and heap has
// ballooned past this factor it's safer to reload early than to wait for
// the scheduled 24 h reload and risk a tab kill.
const INSTALL_HEAP_EARLY_RELOAD_X  = 3.0;
const INSTALL_MIN_UPTIME_FOR_HEAP_RELOAD_MS = 60 * 60 * 1000;

let installReloadTimer       = null;
let installLivenessTimer     = null;
let installLastSig           = '';
let installIdenticalSamples  = 0;
let installErrorEnteredAt    = 0;
let installUnhandledErrCount = 0;
let installReloading         = false;
let wakeLockSentinel         = null;
let installHudFrameCounter   = 0;

function triggerReload(reason) {
    if (installReloading) return;
    installReloading = true;
    console.warn(`[Mirror] Installation watchdog reloading: ${reason}`);
    try { if (wakeLockSentinel) wakeLockSentinel.release(); } catch (_) {}
    // Small delay gives the warn log a chance to flush to devtools before
    // the page goes away; 250 ms is imperceptible for an installation.
    setTimeout(() => {
        try { location.reload(); } catch (_) {}
    }, 250);
}

// Sample 6 points across the composite canvas and return a stable
// signature. Returns null if we can't read (canvas not ready or
// getImageData throws — e.g. tainted, context lost).
function sampleCanvasSignature() {
    if (!compositeCanvas || !compositeCtx) return null;
    const w = compositeCanvas.width, h = compositeCanvas.height;
    if (w < 10 || h < 10) return null;
    const xs = [w * 0.1 | 0, w * 0.5 | 0, w * 0.9 | 0];
    const ys = [h * 0.1 | 0, h * 0.5 | 0, h * 0.9 | 0];
    try {
        let sig = '';
        let allBlack = true;
        for (const y of ys) for (const x of xs) {
            const d = compositeCtx.getImageData(x, y, 1, 1).data;
            sig += `${d[0]},${d[1]},${d[2]};`;
            if (d[0] > 3 || d[1] > 3 || d[2] > 3) allBlack = false;
        }
        return { sig, allBlack };
    } catch (_) {
        // getImageData can throw when the context is lost — treat that as
        // an immediate liveness failure.
        return { sig: '__UNREADABLE__', allBlack: true };
    }
}

function checkCanvasLiveness() {
    // Skip while the tab is backgrounded (frames legitimately stop) and
    // during states where composite is not drawn.
    if (document.hidden) { installIdenticalSamples = 0; return; }
    if (currentState === AppState.LOADING ||
        currentState === AppState.ERROR) { installIdenticalSamples = 0; return; }

    const result = sampleCanvasSignature();
    if (!result) return;

    if (result.sig === installLastSig) {
        installIdenticalSamples++;
        if (installIdenticalSamples >= INSTALL_LIVENESS_STALL_LIMIT) {
            triggerReload(
                result.sig === '__UNREADABLE__'
                    ? 'canvas context unreadable (likely GPU context loss)'
                    : result.allBlack
                        ? 'canvas frozen + all-black (GPU context loss)'
                        : 'canvas frozen (~30 s no pixel change)'
            );
        }
    } else {
        installIdenticalSamples = 0;
        installLastSig = result.sig;
    }
}

function checkScheduledReload() {
    if (document.hidden) return;
    const uptime = performance.now() - appStartTime;

    // Scheduled hard reload (independent backup to the state-machine-gated
    // path in maybeScheduledReset). Whichever fires first wins.
    const limit = AppConfig.longRunning.hardReloadIntervalMs;
    if (limit > 0 && uptime >= limit) {
        triggerReload(`scheduled hard-reload @ ${Math.round(uptime / 3600000)}h uptime`);
        return;
    }

    // Heap-triggered early reload (Chromium only).
    if (heapBaselineBytes > 0 &&
        heapCurrentBytes > heapBaselineBytes * INSTALL_HEAP_EARLY_RELOAD_X &&
        uptime > INSTALL_MIN_UPTIME_FOR_HEAP_RELOAD_MS) {
        triggerReload(
            `heap ${Math.round(heapCurrentBytes/1048576)}MB ` +
            `> ${INSTALL_HEAP_EARLY_RELOAD_X}× baseline ` +
            `${Math.round(heapBaselineBytes/1048576)}MB`
        );
        return;
    }

    // MediaPipe reinit storm — WASM runtime can't recover, only reload helps.
    if (typeof Segmentation !== 'undefined' && Segmentation.getDiagnostics) {
        const d = Segmentation.getDiagnostics();
        if (d.reinitFailures >= INSTALL_REINIT_FAIL_LIMIT) {
            triggerReload(`MediaPipe reinit failed ×${d.reinitFailures}`);
            return;
        }
    }
}

function checkErrorAutoReload() {
    if (currentState !== AppState.ERROR) {
        installErrorEnteredAt = 0;
        return;
    }
    const now = performance.now();
    if (installErrorEnteredAt === 0) {
        installErrorEnteredAt = now;
        return;
    }
    if (now - installErrorEnteredAt >= INSTALL_ERROR_AUTO_RELOAD_MS) {
        triggerReload(
            `stuck in ERROR for ${Math.round((now - installErrorEnteredAt)/1000)}s`
        );
    }
}

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
        });
        console.log('[Mirror] Screen Wake Lock acquired');
    } catch (err) {
        // Rejected on Safari < 16.4, HTTP pages, or in low power mode.
        console.warn('[Mirror] Wake Lock unavailable:', err && err.name);
    }
}

function startInstallationWatchdog() {
    if (installReloadTimer)   clearInterval(installReloadTimer);
    if (installLivenessTimer) clearInterval(installLivenessTimer);

    installReloadTimer = setInterval(() => {
        checkScheduledReload();
        checkErrorAutoReload();
    }, INSTALL_RELOAD_CHECK_MS);

    installLivenessTimer = setInterval(checkCanvasLiveness, INSTALL_LIVENESS_SAMPLE_MS);

    window.addEventListener('error', (e) => {
        installUnhandledErrCount++;
        console.warn(
            `[Mirror] Unhandled error #${installUnhandledErrCount}:`,
            e && (e.message || e.error)
        );
        if (installUnhandledErrCount >= INSTALL_UNHANDLED_ERR_LIMIT) {
            triggerReload(`unhandled error storm (${installUnhandledErrCount})`);
        }
    });
    window.addEventListener('unhandledrejection', (e) => {
        installUnhandledErrCount++;
        console.warn(
            `[Mirror] Unhandled rejection #${installUnhandledErrCount}:`,
            e && e.reason
        );
        if (installUnhandledErrCount >= INSTALL_UNHANDLED_ERR_LIMIT) {
            triggerReload(`unhandled rejection storm (${installUnhandledErrCount})`);
        }
    });

    requestWakeLock();
    document.addEventListener('visibilitychange', () => {
        // Wake Lock auto-releases when page is hidden; re-request on return.
        if (!document.hidden) requestWakeLock();
    });

    // Prime the HUD right away so it shows live numbers instead of the
    // "booting…" placeholder even before the first p5 draw call.
    updateInstallHUD();
}

// ==========================================
// Initialization
// ==========================================

function initDOM() {
    DOM.loadingScreen = Utils.$('#loading-screen');
    DOM.loadingBar = Utils.$('#loading-bar');
    DOM.loadingStatus = Utils.$('#loading-status');
    DOM.instructions = Utils.$('#instructions');
    DOM.modeIndicator = Utils.$('#mode-indicator');
    DOM.modeText = Utils.$('#mode-text');
    DOM.debugPanel = Utils.$('#debug-panel');
    DOM.fpsCounter = Utils.$('#fps-counter');
    DOM.stateInfo = Utils.$('#state-info');
    DOM.handVelocity = Utils.$('#hand-velocity');
    DOM.ratioInfo = Utils.$('#ratio-info');
    DOM.inferenceInfo = Utils.$('#inference-info');
    DOM.heapInfo = Utils.$('#heap-info');
    DOM.uptimeInfo = Utils.$('#uptime-info');
    DOM.installHud = Utils.$('#install-hud');
    DOM.errorScreen = Utils.$('#error-screen');
    DOM.retryBtn = Utils.$('#retry-btn');
    
    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        // D - Toggle debug panel
        if (e.key === 'd' || e.key === 'D') {
            AppConfig.debug = !AppConfig.debug;
            DOM.debugPanel.classList.toggle('hidden', !AppConfig.debug);
        }
        // H - Toggle the always-on corner HUD
        if (e.key === 'h' || e.key === 'H') {
            if (DOM.installHud) DOM.installHud.classList.toggle('hidden-hud');
        }
        // 1 - Toggle video mirror
        if (e.key === '1') {
            AppConfig.mirror.video = !AppConfig.mirror.video;
            console.log('Video mirror:', AppConfig.mirror.video);
        }
        // 2 - Toggle mask mirror (affects human cutout alignment)
        if (e.key === '2') {
            AppConfig.mirror.mask = !AppConfig.mirror.mask;
            console.log('Mask mirror:', AppConfig.mirror.mask);
        }
        // Space - Force state transition
        if (e.key === ' ') {
            if (currentState === AppState.EFFECT) {
                setState(AppState.MIRROR);
            } else if (currentState === AppState.MIRROR) {
                setState(AppState.EFFECT);
            }
        }
    });
    
    // Retry button
    if (DOM.retryBtn) {
        DOM.retryBtn.addEventListener('click', () => {
            location.reload();
        });
    }
}

function initCanvases(width, height) {
    if (!compositeCanvas) {
        // First call: allocate
        compositeCanvas = Utils.createOffscreenCanvas(width, height);
        compositeCtx = compositeCanvas.getContext('2d');
        humanCanvas = Utils.createOffscreenCanvas(width, height);
        humanCtx = humanCanvas.getContext('2d');

        attachContextLossHandlers();
    } else {
        // Subsequent calls (window resize): resize in-place to avoid GC churn
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        humanCanvas.width = width;
        humanCanvas.height = height;
    }
}

// ==========================================
// Canvas context-loss recovery
// ==========================================
// Modern Chrome/Edge fire `contextlost` / `contextrestored` on 2D canvases
// under GPU memory pressure or driver resets. Safari does not fire them
// but also rarely loses a 2D context; best effort is all we can do here.
// Losing the context leaves the canvas blank forever until rebuilt.

let contextRecoveryInProgress = false;

function attachContextLossHandlers() {
    const targets = [
        { canvas: compositeCanvas, name: 'composite' },
        { canvas: humanCanvas,     name: 'human' }
    ];
    // p5 wraps the main canvas — .elt is the underlying HTMLCanvasElement.
    if (mainCanvas && mainCanvas.elt) {
        targets.push({ canvas: mainCanvas.elt, name: 'main' });
    }

    for (const { canvas, name } of targets) {
        // Preventing default on contextlost tells the browser to try to
        // restore the context instead of permanently losing it.
        canvas.addEventListener('contextlost', (e) => {
            console.warn(`[Mirror] ${name} canvas context lost`);
            e.preventDefault();
        });
        canvas.addEventListener('contextrestored', () => {
            console.warn(`[Mirror] ${name} canvas context restored — rebuilding`);
            recoverCanvases();
        });
    }
}

function recoverCanvases() {
    if (contextRecoveryInProgress) return;
    contextRecoveryInProgress = true;
    try {
        const w = AppConfig.canvas.width;
        const h = AppConfig.canvas.height;

        // Force re-allocation of backing stores by nulling and reinit.
        compositeCanvas = null;
        humanCanvas = null;
        initCanvases(w, h);

        // Effects subsystem allocates its own ring-buffer canvases; tell
        // it to drop + rebuild them at the current size.
        if (typeof Effects !== 'undefined' && Effects.resize) {
            Effects.resize(w, h);
        }
    } finally {
        contextRecoveryInProgress = false;
    }
}

// ==========================================
// p5.js Setup & Draw
// ==========================================

function sketch(p) {
    p.setup = function() {
        // Full screen canvas
        let canvasWidth = window.innerWidth;
        let canvasHeight = window.innerHeight;
        
        // Update config
        AppConfig.canvas.width = canvasWidth;
        AppConfig.canvas.height = canvasHeight;
        
        // Create main canvas - full screen
        mainCanvas = p.createCanvas(canvasWidth, canvasHeight);
        mainCanvas.parent('canvas-container');
        
        // Lower pixel density for performance
        p.pixelDensity(1);
        
        // Target frame rate
        p.frameRate(AppConfig.canvas.targetFPS);
        
        // Initialize offscreen canvases
        initCanvases(canvasWidth, canvasHeight);
        
        // Initialize subsystems
        Effects.init(canvasWidth, canvasHeight);
        
        // Initialize FPS counter
        fpsCounter = new Utils.FPSCounter();

        // Long-running clocks
        appStartTime = performance.now();
        lastSoftResetTime = appStartTime;

        // Heap monitoring (Chrome only; no-op elsewhere)
        startHeapMonitor();

        // Long-running self-recovery watchdog (see top of file for details).
        // Runs independently of the render loop so it works even when p5
        // has been throttled or the state machine has wedged.
        startInstallationWatchdog();

        // Show debug panel
        if (AppConfig.debug) {
            DOM.debugPanel.classList.remove('hidden');
        }
        
        // Start segmentation initialization
        initSegmentation();
    };
    
    p.draw = function() {
        const now = performance.now();
        // Clamp to 100ms: prevents particles jumping after tab switch / sleep
        deltaTime = Math.min(now - lastFrameTime, 100);
        lastFrameTime = now;
        
        // Update FPS
        fpsCounter.update();
        
        // State machine
        updateState(now);
        
        // Render based on state
        render(p, now);
        
        // Update debug panel
        if (AppConfig.debug) {
            updateDebugPanel();
        }

        // HUD updates at ~1 Hz so getDiagnostics cost is negligible.
        installHudFrameCounter++;
        if (installHudFrameCounter >= AppConfig.canvas.targetFPS) {
            installHudFrameCounter = 0;
            updateInstallHUD();
        }
    };
    
    p.windowResized = function() {
        const w = window.innerWidth;
        const h = window.innerHeight;

        AppConfig.canvas.width = w;
        AppConfig.canvas.height = h;

        p.resizeCanvas(w, h);
        initCanvases(w, h);

        // Notify subsystems (Segmentation recomputes cover crop on next frame)
        Segmentation.resize(w, h);
        Effects.resize(w, h);
    };
}

// ==========================================
// Segmentation Initialization
// ==========================================

async function initSegmentation() {
    try {
        // Compute a processing resolution that:
        //   1. Always preserves the screen's exact aspect ratio (no stretch, no wrong crop)
        //   2. Caps total pixels at a device-appropriate budget
        //
        // Target pixel budget (area):
        //   Mobile  → 480×360 = 172 800 px  (phones throttle fast; this is
        //             still above MediaPipe's internal 256-px model input)
        //   Desktop → 1280×720 = 921 600 px  (cap at 720p to avoid over-allocating on 4K)
        //
        // Formula: given target area T and screen ratio R = W/H
        //   procH = sqrt(T / R)  →  procW = procH * R
        // This always gives the right shape at the right size.
        const isMobile = Segmentation.getDiagnostics().isMobile;
        const W = AppConfig.canvas.width;
        const H = AppConfig.canvas.height;
        const ratio = W / H;
        const TARGET_PIXELS = isMobile ? 480 * 360 : 1280 * 720;
        const procHeight = Math.min(H, Math.round(Math.sqrt(TARGET_PIXELS / ratio)));
        const procWidth  = Math.min(W, Math.round(procHeight * ratio));

        await Segmentation.init({
            width: procWidth,
            height: procHeight,
            onProgress: (percent, message) => {
                if (DOM.loadingBar) {
                    DOM.loadingBar.style.width = `${percent}%`;
                }
                if (DOM.loadingStatus) {
                    DOM.loadingStatus.textContent = message;
                }
            },
            onReady: () => {
                // Transition from loading to effect mode
                setTimeout(() => {
                    setState(AppState.EFFECT);
                    
                    // Hide loading screen
                    Utils.addClass(DOM.loadingScreen, 'fade-out');
                    
                    // Show instructions
                    Utils.removeClass(DOM.instructions, 'hidden');
                    
                    // Show mode indicator
                    Utils.removeClass(DOM.modeIndicator, 'hidden');
                    
                    // Hide instructions after a few seconds
                    setTimeout(() => {
                        Utils.addClass(DOM.instructions, 'hidden');
                    }, 8000);
                }, 500);
            },
            onError: (error) => {
                console.error('Segmentation error:', error);
                setState(AppState.ERROR);
                const errorContent = DOM.errorScreen.querySelector('.error-content');
                if (errorContent) {
                    errorContent.innerHTML = `
                        <h2>Camera Access Required</h2>
                        <p>${error.message || 'Please allow camera access to experience the mirror.'}</p>
                        ${location.protocol !== 'https:' && location.hostname !== 'localhost' ? 
                            '<p style="color: #e8c4a0; margin-top: 1rem;">⚠️ Tip: Camera requires HTTPS. Try accessing via localhost or use HTTPS.</p>' : ''}
                        <button id="retry-btn">Try Again</button>
                    `;
                    const retryBtn = errorContent.querySelector('#retry-btn');
                    if (retryBtn) {
                        retryBtn.addEventListener('click', () => location.reload());
                    }
                }
                Utils.removeClass(DOM.errorScreen, 'hidden');
                Utils.addClass(DOM.loadingScreen, 'fade-out');
            }
        });
    } catch (error) {
        console.error('Init error:', error);
        setState(AppState.ERROR);
        Utils.removeClass(DOM.errorScreen, 'hidden');
        Utils.addClass(DOM.loadingScreen, 'fade-out');
    }
}

// ==========================================
// State Machine
// ==========================================

function setState(newState) {
    previousState = currentState;
    currentState = newState;
    stateStartTime = performance.now();

    // Update mode indicator
    switch (newState) {
        case AppState.EFFECT:
            if (DOM.modeText) DOM.modeText.textContent = 'EFFECT MODE';
            Effects.setMode('effect');
            break;
        case AppState.TRANSITION:
            if (DOM.modeText) DOM.modeText.textContent = 'TRANSITIONING...';
            // Opportunistic long-running hygiene — the TRANSITION cross-fade
            // visually masks the reset so users never notice.
            maybeScheduledReset();
            break;
        case AppState.MIRROR:
            if (DOM.modeText) DOM.modeText.textContent = 'CALM MIRROR';
            Effects.setMode('calm');
            break;
    }
}

// Check whether a soft reset or hard reload is due, and execute it
// during TRANSITION (where visual disruption is hidden by the cross-fade).
function maybeScheduledReset() {
    const now = performance.now();
    const uptime = now - appStartTime;
    const cfg = AppConfig.longRunning;

    // Hard reload has priority — it supersedes soft reset for that cycle.
    if (cfg.hardReloadIntervalMs > 0 && uptime >= cfg.hardReloadIntervalMs) {
        console.log(`[Mirror] Scheduled hard reload after ${Math.round(uptime / 3600000)}h uptime`);
        // Give the TRANSITION fade ~1s to paint, then reload.
        setTimeout(() => location.reload(), 1000);
        return;
    }

    if (now - lastSoftResetTime >= cfg.softResetIntervalMs) {
        console.log(
            `[Mirror] Scheduled soft reset ` +
            `(uptime ${Math.round(uptime / 3600000 * 10) / 10}h)`
        );
        performSoftReset();
        lastSoftResetTime = now;
    }
}

// Soft reset: clear accumulated visual/diagnostic state without touching
// the camera or MediaPipe models. Cheap, runs in a frame or two.
function performSoftReset() {
    try {
        if (typeof Effects !== 'undefined' && Effects.softReset) Effects.softReset();
        if (typeof TextSystem !== 'undefined' && TextSystem.clear) TextSystem.clear();
        if (typeof Segmentation !== 'undefined' && Segmentation.softReset) Segmentation.softReset();
    } catch (err) {
        console.warn('[Mirror] Soft reset encountered an error:', err);
    }
}

function updateState(now) {
    const elapsed = now - stateStartTime;
    
    switch (currentState) {
        case AppState.LOADING:
            // Wait for segmentation to initialize
            break;
            
        case AppState.EFFECT:
            // Auto-transition to mirror after duration
            if (elapsed > AppConfig.timing.effectDuration) {
                setState(AppState.TRANSITION);
            }
            break;
            
        case AppState.TRANSITION:
            // Transition complete
            if (elapsed > AppConfig.timing.transitionDuration) {
                if (previousState === AppState.EFFECT) {
                    setState(AppState.MIRROR);
                } else {
                    setState(AppState.EFFECT);
                }
            }
            break;
            
        case AppState.MIRROR:
            // Auto-transition back to effect after duration
            if (elapsed > AppConfig.timing.mirrorDuration) {
                setState(AppState.TRANSITION);
            }
            break;
            
        case AppState.ERROR:
            // Stay in error state
            break;
    }
}

// ==========================================
// Main Render Loop
// ==========================================

function render(p, time) {
    const w = AppConfig.canvas.width;
    const h = AppConfig.canvas.height;
    
    // Don't clear main canvas background - let compositeCanvas control everything
    
    if (currentState === AppState.LOADING || currentState === AppState.ERROR) {
        return;
    }
    
    // Get segmentation data
    const frame = Segmentation.getFrame();
    const mask = Segmentation.getMask();
    const contour = Segmentation.getContour();
    const bodyParts = Segmentation.getBodyParts();
    const handVelocity = Segmentation.getHandVelocity();
    
    // Update subsystems
    Effects.update(time);
    TextSystem.update(deltaTime, time, handVelocity, bodyParts, contour);
    
    // ==========================================
    // Layer 1: Background Trail + Solid Black Background + Human Figure
    // ==========================================

    // Clear composite canvas
    compositeCtx.clearRect(0, 0, w, h);
    
    // First, draw solid black background covering everything
    compositeCtx.fillStyle = 'black';
    compositeCtx.fillRect(0, 0, w, h);

    // Then draw background trails (motion blur effect)
    // Trails contain only the human figure with transparent background
    Effects.drawBackgroundTrail(compositeCtx);

    // Finally draw the human figure on top (sharp and clear)
    // And update the trail with the new human figure
    if (frame && mask) {
        renderHumanFigure(compositeCtx, frame, mask, contour, time);
        Effects.updateBackgroundTrail(humanCanvas);
    }
    
    // ==========================================
    // Layer 6: Text System (Active)
    // ==========================================
    
    // Always enable text system in EFFECT and MIRROR modes
    if (currentState === AppState.MIRROR || currentState === AppState.EFFECT ||
        (currentState === AppState.TRANSITION)) {
        
        compositeCtx.save();
        // Mirror the text layer to match the mirrored video
        compositeCtx.translate(w, 0);
        compositeCtx.scale(-1, 1);
        
        TextSystem.draw(compositeCtx);
        compositeCtx.restore();
    }
    
    // ==========================================
    // Layer 7: Post Effects (DISABLED)
    // ==========================================
    
    // Vignette (DISABLED)
    // Effects.applyVignette(compositeCtx, w, h);
    
    // Glitch (DISABLED)
    /*
    if (currentState === AppState.EFFECT) {
        // Random glitch trigger
        if (Math.random() < 0.005) {
            Effects.triggerGlitch(Utils.randomRange(0.2, 0.5));
        }
    }
    */
    
    // ==========================================
    // Draw to main canvas (mirrored for true mirror effect)
    // ==========================================
    p.drawingContext.save();
    p.drawingContext.translate(w, 0);
    p.drawingContext.scale(-1, 1);
    
    // Draw directly (Global smoothing is disabled per request)
    p.drawingContext.drawImage(compositeCanvas, 0, 0);
    
    p.drawingContext.restore();
}

// ==========================================
// Human Figure Rendering
// ==========================================

function renderHumanFigure(ctx, frame, mask, contour, time) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    
    // Clear human canvas
    humanCtx.clearRect(0, 0, w, h);
    
    // ==========================================
    // Human Figure with Mask
    // ==========================================
    humanCtx.save();

    // 1. Optionally mirror the raw camera feed
    if (AppConfig.mirror.video) {
        humanCtx.translate(w, 0);
        humanCtx.scale(-1, 1);
    }
    
    // Draw frame
    humanCtx.drawImage(frame, 0, 0, w, h);

    // Color grade before masking: warm tone in MIRROR mode, cool in EFFECT mode
    humanCtx.globalCompositeOperation = 'overlay';
    humanCtx.fillStyle = currentState === AppState.MIRROR ? '#554433' : '#334455';
    humanCtx.globalAlpha = 0.3;
    humanCtx.fillRect(0, 0, w, h);
    
    // 2. Mask Layer Mirroring (for human cutout).
    // The mask is already softened by the erosion + downscale step in
    // segmentation, so the previous 0.5 px canvas blur here was
    // imperceptible — drop it to save a full-screen filter pass per frame.
    humanCtx.globalCompositeOperation = 'destination-in';
    humanCtx.globalAlpha = 1.0;

    if (AppConfig.mirror.mask !== AppConfig.mirror.video) {
        humanCtx.save();
        humanCtx.translate(w, 0);
        humanCtx.scale(-1, 1);
        humanCtx.drawImage(mask, 0, 0, w, h);
        humanCtx.restore();
    } else {
        humanCtx.drawImage(mask, 0, 0, w, h);
    }

    humanCtx.globalCompositeOperation = 'source-over';
    
    humanCtx.restore();

    // ==========================================
    // Draw to Composite Canvas
    // ==========================================

    // Draw the human figure directly without any glow effects
    ctx.drawImage(humanCanvas, 0, 0);

}

// ==========================================
// Debug Panel
// ==========================================

function updateDebugPanel() {
    if (DOM.fpsCounter) {
        DOM.fpsCounter.textContent = `FPS: ${fpsCounter.getFPS()}`;
    }
    if (DOM.stateInfo) {
        DOM.stateInfo.textContent = `State: ${currentState} | V:${AppConfig.mirror.video ? 'Mir' : 'Nor'} M:${AppConfig.mirror.mask ? 'Mir' : 'Nor'}`;
    }
    if (DOM.handVelocity) {
        const hv = Segmentation.getHandVelocity();
        const contour = Segmentation.getContour();
        DOM.handVelocity.textContent = `Hand: ${hv.max.toFixed(1)} | Contour: ${contour.length} pts`;
    }
    if (DOM.ratioInfo) {
        const native = Segmentation.getNativeVideoSize();
        const crop = Segmentation.getCoverCrop();
        const w = AppConfig.canvas.width;
        const h = AppConfig.canvas.height;
        const screenRatio = Utils.formatAspectRatio(w, h);
        if (native && native.w > 0) {
            const camRatio = Utils.formatAspectRatio(native.w, native.h);
            if (crop && !crop.isExact) {
                const cropPx = crop.sx > 0
                    ? `crop ${Math.round(crop.sx * 2)}px horiz`
                    : `crop ${Math.round(crop.sy * 2)}px vert`;
                DOM.ratioInfo.textContent = `Screen ${screenRatio} | Cam ${camRatio} | ${cropPx}`;
            } else {
                DOM.ratioInfo.textContent = `Screen ${screenRatio} | Cam ${camRatio} | exact fit`;
            }
        } else {
            DOM.ratioInfo.textContent = `Screen ${screenRatio} | Cam loading...`;
        }
    }
    if (DOM.inferenceInfo) {
        const d = Segmentation.getDiagnostics();
        const warn = d.timeoutCount > 0 ? ` ⚠ timeout×${d.timeoutCount}` : '';
        DOM.inferenceInfo.textContent =
            `${d.isMobile ? '📱' : '🖥'} Inference avg ${d.inferenceAvgMs}ms max ${d.inferenceMaxMs}ms` +
            ` | camFPS ${d.cameraFps} | skip 1/${d.skipFrames + 1}` +
            ` | drop ${d.droppedFrames}${warn}`;
        // Colour-code: red if avg inference > 80% of the timeout budget
        const budget = d.isMobile ? 3000 : 5000;
        DOM.inferenceInfo.style.color = d.inferenceAvgMs > budget * 0.8 ? '#ff6b6b' :
                                         d.inferenceAvgMs > budget * 0.5 ? '#ffa94d' : '';
    }
    if (DOM.heapInfo) {
        if (heapCurrentBytes > 0) {
            const cur  = Math.round(heapCurrentBytes / 1048576);
            const peak = Math.round(heapPeakBytes    / 1048576);
            const base = Math.round(heapBaselineBytes / 1048576);
            const delta = cur - base;
            const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`;
            DOM.heapInfo.textContent = `Heap ${cur}MB (base ${base} ${deltaStr}, peak ${peak})`;
            // Red if heap has grown > 2.5× baseline
            DOM.heapInfo.style.color =
                heapCurrentBytes > heapBaselineBytes * HEAP_WARN_GROWTH_FACTOR ? '#ff6b6b' :
                heapCurrentBytes > heapBaselineBytes * 1.8 ? '#ffa94d' : '';
        } else {
            DOM.heapInfo.textContent = 'Heap: n/a (non-Chromium)';
        }
    }
    if (DOM.uptimeInfo) {
        const ms = performance.now() - appStartTime;
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms %   60000) /   1000);
        DOM.uptimeInfo.textContent =
            `Uptime ${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    }
}

// Always-on installation HUD — dense but small. Designed so that if the
// iPad freezes, a phone photo of the screen is enough to diagnose which
// subsystem died. One line if possible; two on tiny screens.
function updateInstallHUD() {
    if (!DOM.installHud) return;

    const uptimeMs = performance.now() - appStartTime;
    const uh = Math.floor(uptimeMs / 3600000);
    const um = Math.floor((uptimeMs % 3600000) / 60000);

    const fps = fpsCounter ? fpsCounter.getFPS() : 0;

    let camFps = 0, infAvg = 0, to = 0, skip = 0, reinitF = 0, frameAge = -1;
    if (typeof Segmentation !== 'undefined' && Segmentation.getDiagnostics) {
        const d = Segmentation.getDiagnostics();
        camFps  = d.cameraFps;
        infAvg  = d.inferenceAvgMs;
        to      = d.timeoutCount;
        skip    = d.skipFrames;
        reinitF = d.reinitFailures || 0;
        frameAge = d.lastFrameAgeMs;
    }

    const heapStr = heapCurrentBytes > 0
        ? `${Math.round(heapCurrentBytes / 1048576)}M`
        : '-';

    // One-letter state: L/E/T/M/X.
    const stShort = (currentState || '?')[0];

    // Age of the last camera frame in seconds — useful sanity check that
    // "camFps" isn't just stale.
    const ageStr = frameAge >= 0 ? `${(frameAge / 1000).toFixed(1)}s` : '-';

    DOM.installHud.textContent =
        `${uh}h${String(um).padStart(2, '0')}  ` +
        `${fps}fps cam${camFps} age${ageStr}  ` +
        `inf${infAvg}ms skip${skip} to${to} ri${reinitF}  ` +
        `heap${heapStr} err${installUnhandledErrCount} [${stShort}]`;
}

// ==========================================
// Start Application
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    initDOM();
    p5Instance = new p5(sketch);
});

// Export for debugging
window.SoftMirror = {
    getState: () => currentState,
    setState,
    getConfig: () => AppConfig,
    toggleDebug: () => {
        AppConfig.debug = !AppConfig.debug;
        DOM.debugPanel.classList.toggle('hidden', !AppConfig.debug);
    },
    toggleHUD: () => {
        if (DOM.installHud) DOM.installHud.classList.toggle('hidden-hud');
    },
    // Long-running operator controls
    softReset: performSoftReset,
    hardReload: () => location.reload(),
    getUptime: () => performance.now() - appStartTime,
    recoverCanvases,                // force a canvas rebuild for debugging
    // Installation watchdog introspection (for remote ops via console)
    triggerReload,
    getWatchdogState: () => ({
        uptimeMs:            performance.now() - appStartTime,
        identicalSamples:    installIdenticalSamples,
        unhandledErrors:     installUnhandledErrCount,
        errorStateDurationMs: installErrorEnteredAt
            ? performance.now() - installErrorEnteredAt : 0,
        wakeLockHeld:        !!wakeLockSentinel,
        reloading:           installReloading
    }),
    getHeap: () => ({
        baselineMB: Math.round(heapBaselineBytes / 1048576),
        currentMB:  Math.round(heapCurrentBytes  / 1048576),
        peakMB:     Math.round(heapPeakBytes     / 1048576),
        growthX:    heapBaselineBytes
            ? +(heapCurrentBytes / heapBaselineBytes).toFixed(2)
            : 0
    })
};







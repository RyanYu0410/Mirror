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
        targetFPS: 30
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
    debug: false        // press D to toggle debug panel at runtime
};

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
    errorScreen: null,
    retryBtn: null
};

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
    DOM.errorScreen = Utils.$('#error-screen');
    DOM.retryBtn = Utils.$('#retry-btn');
    
    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        // D - Toggle debug panel
        if (e.key === 'd' || e.key === 'D') {
            AppConfig.debug = !AppConfig.debug;
            DOM.debugPanel.classList.toggle('hidden', !AppConfig.debug);
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
    } else {
        // Subsequent calls (window resize): resize in-place to avoid GC churn
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        humanCanvas.width = width;
        humanCanvas.height = height;
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
        //   Mobile  → 640×480 = 307 200 px  (fits any mobile/tablet at ~half-res)
        //   Desktop → 1280×720 = 921 600 px  (cap at 720p to avoid over-allocating on 4K)
        //
        // Formula: given target area T and screen ratio R = W/H
        //   procH = sqrt(T / R)  →  procW = procH * R
        // This always gives the right shape at the right size.
        const isMobile = Segmentation.getDiagnostics().isMobile;
        const W = AppConfig.canvas.width;
        const H = AppConfig.canvas.height;
        const ratio = W / H;
        const TARGET_PIXELS = isMobile ? 640 * 480 : 1280 * 720;
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
            break;
        case AppState.MIRROR:
            if (DOM.modeText) DOM.modeText.textContent = 'CALM MIRROR';
            Effects.setMode('calm');
            break;
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
    
    // 2. Mask Layer Mirroring (for human cutout)
    // Minimal blur for edge anti-aliasing; mask erosion in segmentation handles most of the softening
    humanCtx.filter = 'blur(0.5px)';
    humanCtx.globalCompositeOperation = 'destination-in';
    humanCtx.globalAlpha = 1.0; // Reset alpha for mask

    if (AppConfig.mirror.mask !== AppConfig.mirror.video) {
        // If they differ, we need to flip back/forth
        humanCtx.save();
        humanCtx.translate(w, 0);
        humanCtx.scale(-1, 1);
        humanCtx.drawImage(mask, 0, 0, w, h); // Use original mask with smoothing
        humanCtx.restore();
    } else {
        humanCtx.drawImage(mask, 0, 0, w, h); // Use original mask with smoothing
    }

    // Reset filter and composite operation
    humanCtx.filter = 'none';
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
    }
};







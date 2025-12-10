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
        effectDuration: 45000,
        transitionDuration: 2000,
        mirrorDuration: 30000
    },
    darkness: {
        baseAmount: 100,      // 起始值 - Start fully dark for immediate mask
        maxAmount: 150,     // 最大值（达到后人物周围没有buffer）
        growSpeed: 0.0,     // 黑暗生长速度（像素/帧）- Static mask
        currentAmount: 100,   // 当前值
        mirrorMask: true    // 默认开启
    },
    // Mirror controls (tested)
    mirror: {
        video: false,   // 不翻转摄像头画面（已测试正确）
        mask: true
    },
    // Visual Smoothing (Transition/Delay from previous frame)
    smoothing: {
        enabled: false,  // DISABLED GLOBAL SMOOTHING
        factor: 1.0     
    },
    // Mask Delay (Viscous trails for the black mask)
    maskDelay: {
        enabled: true,
        factor: 0.1     // Very low factor = heavy delay (0.1 = 10% new, 90% old)
    },
    debug: true
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
let effectCanvas = null;
let effectCtx = null;
let humanCanvas = null;
let humanCtx = null;
let feedbackCanvas = null;
let feedbackCtx = null;
let delayedMaskCanvas = null;
let delayedMaskCtx = null;
let solidMaskCanvas = null;
let solidMaskCtx = null;

// Shared contour path
let sharedContourPath = [];

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
    DOM.errorScreen = Utils.$('#error-screen');
    DOM.retryBtn = Utils.$('#retry-btn');
    
    // Keyboard controls
    document.addEventListener('keydown', (e) => {
        // D - Toggle debug panel
        if (e.key === 'd' || e.key === 'D') {
            AppConfig.debug = !AppConfig.debug;
            DOM.debugPanel.classList.toggle('hidden', !AppConfig.debug);
        }
        // Up/Down arrows - Adjust darkness growth speed
        if (e.key === 'ArrowUp') {
            AppConfig.darkness.growSpeed = Math.min(3, AppConfig.darkness.growSpeed + 0.2);
            console.log('Darkness grow speed:', AppConfig.darkness.growSpeed);
        }
        if (e.key === 'ArrowDown') {
            AppConfig.darkness.growSpeed = Math.max(0, AppConfig.darkness.growSpeed - 0.2);
            console.log('Darkness grow speed:', AppConfig.darkness.growSpeed);
        }
        // Left/Right arrows - Adjust smoothing factor
        if (e.key === 'ArrowRight') {
            AppConfig.smoothing.factor = Math.min(1.0, AppConfig.smoothing.factor + 0.05);
            console.log('Smoothing factor (Less delay):', AppConfig.smoothing.factor);
        }
        if (e.key === 'ArrowLeft') {
            AppConfig.smoothing.factor = Math.max(0.01, AppConfig.smoothing.factor - 0.05);
            console.log('Smoothing factor (More delay):', AppConfig.smoothing.factor);
        }
        // 1 - Toggle Video Mirror
        if (e.key === '1') {
            AppConfig.mirror.video = !AppConfig.mirror.video;
            console.log('Video Mirror:', AppConfig.mirror.video);
        }
        // 2 - Toggle Mask Mirror (affects human cutout)
        if (e.key === '2') {
            AppConfig.mirror.mask = !AppConfig.mirror.mask;
            console.log('Human Mask Mirror:', AppConfig.mirror.mask);
        }
        // 3 - Toggle Darkness Mask Mirror (affects black background cutout)
        if (e.key === '3') {
            AppConfig.darkness.mirrorMask = !AppConfig.darkness.mirrorMask;
            console.log('Darkness Mask Mirror:', AppConfig.darkness.mirrorMask);
        }
        // M - Toggle mask mirror
        if (e.key === 'm' || e.key === 'M') {
            AppConfig.darkness.mirrorMask = !AppConfig.darkness.mirrorMask;
            console.log('Mask mirror:', AppConfig.darkness.mirrorMask);
        }
        // Space - Force state change
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
    compositeCanvas = Utils.createOffscreenCanvas(width, height);
    compositeCtx = compositeCanvas.getContext('2d');
    
    effectCanvas = Utils.createOffscreenCanvas(width, height);
    effectCtx = effectCanvas.getContext('2d');
    
    humanCanvas = Utils.createOffscreenCanvas(width, height);
    humanCtx = humanCanvas.getContext('2d');
    
    // Feedback canvas for smoothing/trails
    if (!feedbackCanvas) {
        feedbackCanvas = Utils.createOffscreenCanvas(width, height);
        feedbackCtx = feedbackCanvas.getContext('2d');
        // Fill with black initially to prevent transparency
        feedbackCtx.fillStyle = 'black';
        feedbackCtx.fillRect(0, 0, width, height);
    }
    
    // Delayed Mask Canvas (for viscous darkness trails)
    if (!delayedMaskCanvas) {
        delayedMaskCanvas = Utils.createOffscreenCanvas(width, height);
        delayedMaskCtx = delayedMaskCanvas.getContext('2d');
        // Fill with black initially (no person)
        delayedMaskCtx.fillStyle = 'black';
        delayedMaskCtx.fillRect(0, 0, width, height);
        
        solidMaskCanvas = Utils.createOffscreenCanvas(width, height);
        solidMaskCtx = solidMaskCanvas.getContext('2d');
    } else {
        delayedMaskCanvas.width = width;
        delayedMaskCanvas.height = height;
        delayedMaskCtx.fillStyle = 'black';
        delayedMaskCtx.fillRect(0, 0, width, height);
        
        solidMaskCanvas.width = width;
        solidMaskCanvas.height = height;
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
        Particles.init(canvasWidth, canvasHeight);
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
        deltaTime = now - lastFrameTime;
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
        // Full screen on resize
        AppConfig.canvas.width = window.innerWidth;
        AppConfig.canvas.height = window.innerHeight;
        
        p.resizeCanvas(window.innerWidth, window.innerHeight);
        
        // Resize offscreen canvases
        initCanvases(window.innerWidth, window.innerHeight);
        
        // Notify subsystems
        Particles.resize(window.innerWidth, window.innerHeight);
        Effects.resize(window.innerWidth, window.innerHeight);
    };
}

// ==========================================
// Segmentation Initialization
// ==========================================

async function initSegmentation() {
    try {
        await Segmentation.init({
            width: AppConfig.canvas.width,
            height: AppConfig.canvas.height,
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
                // 显示详细错误信息
                const errorContent = DOM.errorScreen.querySelector('.error-content');
                if (errorContent) {
                    errorContent.innerHTML = `
                        <h2>Camera Access Required</h2>
                        <p>${error.message || 'Please allow camera access to experience the mirror.'}</p>
                        ${location.protocol !== 'https:' && location.hostname !== 'localhost' ? 
                            '<p style="color: #e8c4a0; margin-top: 1rem;">⚠️ Tip: Camera requires HTTPS. Try accessing via localhost or use HTTPS.</p>' : ''}
                        <button id="retry-btn">Try Again</button>
                    `;
                    // 重新绑定按钮事件
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

function getTransitionProgress() {
    if (currentState !== AppState.TRANSITION) return 0;
    const elapsed = performance.now() - stateStartTime;
    return Utils.clamp(elapsed / AppConfig.timing.transitionDuration, 0, 1);
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
    const erodedMask = Segmentation.getErodedMask();
    const contour = Segmentation.getContour();
    const bodyParts = Segmentation.getBodyParts();
    const handVelocity = Segmentation.getHandVelocity();
    
    // Update shared contour path
    sharedContourPath = contour;
    
    // Update subsystems
    // Particles.update(time);
    Effects.update(time);
    TextSystem.update(deltaTime, time, handVelocity, bodyParts, contour);
    
    // Add sparkles near hands on fast movement (DISABLED)
    /*
    if (handVelocity.max > 20 && Math.random() < 0.3) {
        Particles.addSparkleNearHand(bodyParts, 2);
    }
    */
    
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
        renderHumanFigure(compositeCtx, frame, mask, erodedMask, contour, time);
        
        // Capture the pure human figure (transparent background) for next frame's trail
        // We use the humanCanvas which is updated inside renderHumanFigure
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
// Background Rendering
// ==========================================

function renderBackground(ctx, w, h, time) {
    // Solid black background for clean effect
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
}

// ==========================================
// Human Figure Rendering
// ==========================================

function renderHumanFigure(ctx, frame, mask, erodedMask, contour, time) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    
    // Clear human canvas
    humanCtx.clearRect(0, 0, w, h);
    
    // ==========================================
    // Human Figure with Mask
    // ==========================================
    humanCtx.save();
    
    // 1. Video Layer Mirroring
    if (AppConfig.mirror.video) {
        humanCtx.translate(w, 0);
        humanCtx.scale(-1, 1);
    }
    
    // Draw frame
    humanCtx.drawImage(frame, 0, 0, w, h);

    // Apply color grading BEFORE masking to ensure clean background
    humanCtx.globalCompositeOperation = 'overlay'; // or 'soft-light'
    humanCtx.fillStyle = currentState === AppState.MIRROR ? '#554433' : '#334455'; // Warmer for mirror, cooler for effect
    humanCtx.globalAlpha = 0.3;
    humanCtx.fillRect(0, 0, w, h);
    
    // 2. Mask Layer Mirroring (for human cutout)
    // Apply slight blur for smoother edges with motion trails
    humanCtx.filter = 'blur(1.5px)'; // Increased blur for smoother edge anti-aliasing
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
        DOM.stateInfo.innerHTML = `V:${AppConfig.mirror.video ? 'Mir' : 'Nor'} | M:${AppConfig.mirror.mask ? 'Mir' : 'Nor'} | D:${AppConfig.darkness.mirrorMask ? 'Mir' : 'Nor'}`;
    }
    if (DOM.handVelocity) {
        const hv = Segmentation.getHandVelocity();
        const contour = Segmentation.getContour();
        DOM.handVelocity.textContent = `Hand: ${hv.max.toFixed(1)} | Contour: ${contour.length} pts`;
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







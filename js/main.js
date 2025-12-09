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
        baseAmount: 0,      // 起始值
        maxAmount: 150,     // 最大值（达到后人物周围没有buffer）
        growSpeed: 0.3,     // 黑暗生长速度（像素/帧）
        currentAmount: 0,   // 当前值
        mirrorMask: true    // 默认开启
    },
    // Mirror controls (tested)
    mirror: {
        video: false,   // 不翻转摄像头画面（已测试正确）
        mask: true
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
    
    // Clear main canvas
    p.background(10, 10, 15);
    
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
    
    // Update subsystems (Disabled unnecessary updates)
    // Particles.update(time);
    Effects.update(time);
    // TextSystem.update(deltaTime, time, handVelocity, bodyParts, contour);
    
    // Add sparkles near hands on fast movement (DISABLED)
    /*
    if (handVelocity.max > 20 && Math.random() < 0.3) {
        Particles.addSparkleNearHand(bodyParts, 2);
    }
    */
    
    // Clear composite canvas
    compositeCtx.clearRect(0, 0, w, h);
    
    // ==========================================
    // Layer 1: Background (mirrored)
    // ==========================================
    compositeCtx.save();
    compositeCtx.translate(w, 0);
    compositeCtx.scale(-1, 1);
    compositeCtx.fillStyle = 'black';
    compositeCtx.fillRect(0, 0, w, h);
    compositeCtx.restore();
    
    // ==========================================
    // Layer 2: Particles & Volumetric Light (DISABLED)
    // ==========================================
    /*
    if (currentState === AppState.EFFECT || 
        (currentState === AppState.TRANSITION && previousState === AppState.EFFECT)) {
        const alpha = currentState === AppState.TRANSITION ? 
            1 - getTransitionProgress() : 1;
        
        compositeCtx.save();
        compositeCtx.globalAlpha = alpha;
        Particles.draw(compositeCtx, 'effect');
        compositeCtx.restore();
    }
    */
    
    // ==========================================
    // Layer 3: Human Figure (draw first, before black mask)
    // ==========================================
    if (frame && mask) {
        renderHumanFigure(compositeCtx, frame, mask, erodedMask, contour, time);
    }
    
    // ==========================================
    // Layer 5: Encroaching Darkness (constantly shrinking, only person repels it)
    // ==========================================
    
    // Darkness grows over time
    AppConfig.darkness.currentAmount += AppConfig.darkness.growSpeed;
    
    // Cap at max
    if (AppConfig.darkness.currentAmount > AppConfig.darkness.maxAmount) {
        AppConfig.darkness.currentAmount = AppConfig.darkness.maxAmount;
    }
    
    // Draw the encroaching darkness - use MASK directly for accurate silhouette
    Effects.drawEncroachingDarkness(compositeCtx, mask, w, h, {
        darknessAmount: AppConfig.darkness.currentAmount,
        opacity: 1.0, // Full opacity black
        mirror: true  // Mirror to match flipped human figure
    });
    
    // ==========================================
    // Layer 6: Text System (DISABLED)
    // ==========================================
    /*
    if (currentState === AppState.MIRROR || 
        (currentState === AppState.TRANSITION && previousState !== AppState.MIRROR)) {
        const alpha = currentState === AppState.TRANSITION ? 
            getTransitionProgress() : 1;
        
        compositeCtx.save();
        compositeCtx.globalAlpha = alpha;
        TextSystem.draw(compositeCtx);
        compositeCtx.restore();
    }
    */
    
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
    p.drawingContext.drawImage(compositeCanvas, 0, 0);
    p.drawingContext.restore();
}

// ==========================================
// Background Rendering
// ==========================================

function renderBackground(ctx, w, h, time) {
    // Dark gradient background
    const gradient = ctx.createRadialGradient(
        w / 2, h / 2, 0,
        w / 2, h / 2, Math.max(w, h) * 0.8
    );
    
    if (currentState === AppState.MIRROR) {
        // Warmer background for calm mirror
        gradient.addColorStop(0, '#1a1512');
        gradient.addColorStop(0.5, '#12100e');
        gradient.addColorStop(1, '#0a0908');
    } else {
        // Cooler background for effect mode
        gradient.addColorStop(0, '#14141a');
        gradient.addColorStop(0.5, '#0e0e12');
        gradient.addColorStop(1, '#08080a');
    }
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    
    // Subtle animated noise pattern
    const noiseAlpha = 0.02;
    for (let i = 0; i < 50; i++) {
        const x = Utils.noise(i * 0.1, time * 0.0001) * w;
        const y = Utils.noise(i * 0.1 + 100, time * 0.0001) * h;
        const size = Utils.noise(i * 0.1, time * 0.0002) * 3 + 1;
        
        ctx.fillStyle = `rgba(255, 255, 255, ${noiseAlpha})`;
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
    }
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
    
    // 2. Mask Layer Mirroring (for human cutout)
    // If mask needs different mirroring than video, we need to handle it
    humanCtx.globalCompositeOperation = 'destination-in';
    
    if (AppConfig.mirror.mask !== AppConfig.mirror.video) {
        // If they differ, we need to flip back/forth
        humanCtx.save();
        humanCtx.translate(w, 0);
        humanCtx.scale(-1, 1);
        humanCtx.drawImage(erodedMask || mask, 0, 0, w, h);
        humanCtx.restore();
    } else {
        humanCtx.drawImage(erodedMask || mask, 0, 0, w, h);
    }
    
    humanCtx.restore();
    
    // ==========================================
    // Edge glow effect using shadow (DISABLED)
    // ==========================================
    /*
    const glowColor = currentState === AppState.MIRROR ? '#e8c4a0' : '#a0c4d4';
    
    // Multiple glow passes for stronger effect
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 25;
    ctx.drawImage(humanCanvas, 0, 0);
    ctx.restore();
    */
    
    // Draw again without shadow for sharp image
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


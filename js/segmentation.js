/**
 * Soft Mirror - Segmentation Module
 * MediaPipe Selfie Segmentation + Pose tracking
 */

const Segmentation = (function() {
    'use strict';

    // ==========================================
    // Device capability detection
    // ==========================================

    // True on phones and tablets (iPad reports maxTouchPoints > 1 on modern iPadOS)
    const IS_MOBILE = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                      (navigator.maxTouchPoints > 1 && !/Windows/.test(navigator.userAgent));

    // MediaPipe resolves its runtime files (WASM, tflite, binarypb) through the
    // `locateFile` callback passed into each solution constructor. We point it
    // at our self-hosted copy under ./vendor/ so the app doesn't depend on
    // jsdelivr staying reachable for days/weeks on end. Refresh those files
    // via `bash scripts/fetch-vendor.sh`.
    const MP_SELFIE_BASE = 'vendor/mediapipe/selfie_segmentation/';
    const MP_POSE_BASE   = 'vendor/mediapipe/pose/';

    // ==========================================
    // Configuration
    // ==========================================
    
    const CONFIG = {
        segmentation: {
            modelSelection: 1, // 1 = landscape (better quality for full body)
            selfieMode: true
        },
        pose: {
            // 0 = lite (≈2–3× faster than full); wrist/finger tracking is
            // still accurate enough for text-trigger positions and the
            // 0.3-lerp velocity smoothing absorbs the extra jitter.
            modelComplexity: 0,
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.7
        },
        processing: {
            // 1 = run inference on every other camera frame.
            // Camera display still updates every frame, so the live video
            // stays smooth — only the mask / hand-landmark update rate
            // halves, which is imperceptible for this art piece.
            skipFrames: 1,
            maskScale: 0.5  // Half-res for mask processing: masks are inherently blurry,
                            // half-res costs 1/4 the RAM and speeds up getImageData/contour scan
        },
        erosion: {
            defaultAmount: 2,  // Less erosion for sharper edges
            minAmount: 1,
            maxAmount: 8
        },
        handVelocity: {
            smoothing: 0.3,
            threshold: 15
        }
    };

    // Mobile: run inference on 1 of every 3 camera frames instead of every frame.
    // Camera still captures at full fps so the displayed image stays smooth.
    if (IS_MOBILE) CONFIG.processing.skipFrames = 2;

    // Baseline skipFrames is the floor the adaptive controller will not
    // drop below (i.e. "best possible" for this device class).
    const BASELINE_SKIP_FRAMES = CONFIG.processing.skipFrames;
    // Hard ceiling so a runaway thermal event cannot push us to 1 fps.
    const MAX_SKIP_FRAMES = IS_MOBILE ? 5 : 3;
    // Per-device target inference time. Exceeding 1.5× this for a few
    // samples triggers an increment; falling below 0.5× triggers a
    // decrement back toward the baseline.
    const TARGET_INFERENCE_MS = IS_MOBILE ? 180 : 80;
    // How many inference iterations between adaptive adjustments.
    // Too fast → oscillation, too slow → late to react to thermal trends.
    const ADAPT_COOLDOWN_ITERS = 10;
    let lastAdaptIter = 0;

    // ==========================================
    // State
    // ==========================================
    
    let selfieSegmentation = null;
    let pose = null;
    let camera = null;
    let videoElement = null;
    
    let currentFrame = null;
    let currentMask = null;
    let erodedMask = null;
    let contourPoints = [];
    let bodyParts = {};
    let handVelocity = { left: 0, right: 0, max: 0 };

    // Cover-crop: keeps camera feed at its native ratio on any screen
    let coverCrop = null;        // { sx, sy, sw, sh, scale, isExact } or null
    let canvasW = 0;
    let canvasH = 0;

    // Camera watchdog — detects stalled/dropped camera stream and reconnects
    let lastFrameTimestamp = 0;
    let watchdogTimer = null;
    let isRestarting = false;           // re-entrancy guard for restartCamera
    const WATCHDOG_INTERVAL_MS = 4000;  // check every 4 s
    const WATCHDOG_STALL_MS   = 8000;  // restart if no frame for 8 s

    // Exponential backoff for camera restart failures.
    // Doubles each failure, capped, so a permanently-broken camera
    // does not busy-loop the watchdog forever.
    let cameraRestartFailures = 0;
    let nextCameraRestartAllowedAt = 0;
    const CAMERA_BACKOFF_BASE_MS = 4000;  // 4 s, 8 s, 16 s, 32 s, 60 s ...
    const CAMERA_BACKOFF_MAX_MS  = 60000;

    // Consecutive inference timeouts — when this hits the threshold the
    // MediaPipe runtime is presumed stuck (known failure mode on warm
    // iPads) and we do a full subsystem re-init instead of hoping it
    // recovers on its own.
    let consecutiveTimeouts = 0;
    const CONSECUTIVE_TIMEOUT_LIMIT = 5;
    let isReiniting = false;            // re-entrancy guard for reinitModels
    // Count of consecutive reinitModels() failures. main.js's installation
    // watchdog escalates to a full page reload once this crosses a threshold
    // (WASM heap fragmentation on iOS Safari makes reinit unrecoverable).
    let reinitFailures = 0;
    
    let previousHandPositions = { left: null, right: null };
    let isInitialized = false;
    let isProcessing = false;
    let frameCount = 0;
    // Count of inference iterations actually dispatched (not camera frames).
    // Used to run pose at half the segmentation rate — hand positions only
    // drive text-spawn locations, so ~80 ms of extra latency is imperceptible.
    let inferenceIter = 0;
    let onReadyCallback = null;
    let onErrorCallback = null;
    let onProgressCallback = null;

    // ==========================================
    // Diagnostics
    // ==========================================

    let diagInferenceSamples = []; // rolling window of last 15 durations (ms)
    let diagTimeoutCount = 0;
    let diagDroppedFrames = 0;     // frames skipped because isProcessing was still true
    let diagCamFrameCount = 0;
    let diagCamFps = 0;
    let diagCamFpsLastCheck = 0;

    // Offscreen canvases for processing
    let maskCanvas = null;
    let maskCtx = null;
    let erosionCanvas = null;
    let erosionCtx = null;
    let frameCanvas = null;
    let frameCtx = null;
    let smallMaskCanvas = null;
    let smallMaskCtx = null;

    // ==========================================
    // Adaptive quality controller
    // ==========================================

    // Inspect the rolling inference-time window and nudge skipFrames
    // up (lighten load) or down (raise quality) as needed. Called from
    // handleFrame after each inference completes.
    function adjustSkipFrames() {
        const iter = inferenceIter;
        if (iter - lastAdaptIter < ADAPT_COOLDOWN_ITERS) return;
        const n = diagInferenceSamples.length;
        if (n < 5) return;  // not enough data to decide

        let sum = 0;
        for (let i = 0; i < n; i++) sum += diagInferenceSamples[i];
        const avg = sum / n;

        const skip = CONFIG.processing.skipFrames;
        let next = skip;
        if (avg > TARGET_INFERENCE_MS * 1.5 && skip < MAX_SKIP_FRAMES) {
            next = skip + 1;
        } else if (avg < TARGET_INFERENCE_MS * 0.5 && skip > BASELINE_SKIP_FRAMES) {
            next = skip - 1;
        }
        if (next !== skip) {
            CONFIG.processing.skipFrames = next;
            lastAdaptIter = iter;
            console.log(
                `[Mirror] Adaptive: skipFrames ${skip} → ${next} ` +
                `(avg ${Math.round(avg)}ms, target ${TARGET_INFERENCE_MS}ms)`
            );
        } else {
            // Update cooldown anchor even when we did not move, so we do
            // not re-check every single inference.
            lastAdaptIter = iter;
        }
    }

    // ==========================================
    // Initialization
    // ==========================================
    
    // Single shared onFrame handler — used by both init and restartCamera.
    async function handleFrame() {
        if (!isInitialized) return;

        frameCount++;
        lastFrameTimestamp = performance.now();

        // Camera FPS: count frames, settle once per second
        diagCamFrameCount++;
        if (lastFrameTimestamp - diagCamFpsLastCheck >= 1000) {
            diagCamFps = diagCamFrameCount;
            diagCamFrameCount = 0;
            diagCamFpsLastCheck = lastFrameTimestamp;
        }

        if (!coverCrop && videoElement.videoWidth > 0) {
            updateCoverCrop();
        }

        frameCtx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
        if (coverCrop) {
            frameCtx.drawImage(
                videoElement,
                coverCrop.sx, coverCrop.sy, coverCrop.sw, coverCrop.sh,
                0, 0, frameCanvas.width, frameCanvas.height
            );
        } else {
            frameCtx.drawImage(videoElement, 0, 0, frameCanvas.width, frameCanvas.height);
        }
        currentFrame = frameCanvas;

        if (isProcessing) {
            diagDroppedFrames++;
            return;
        }
        if (frameCount % (CONFIG.processing.skipFrames + 1) !== 0) return;

        isProcessing = true;
        inferenceIter++;
        const inferenceStart = performance.now();
        let timeoutId = null;
        let timedOut = false;
        // Shorter timeout on mobile — we want to detect thermal throttling quickly
        const INFERENCE_TIMEOUT = IS_MOBILE ? 3000 : 5000;

        // Run pose only on every other inference pass; segmentation still
        // runs every pass since it drives the visible mask.
        const runPose = (inferenceIter & 1) === 0;
        const workload = runPose
            ? Promise.all([
                selfieSegmentation.send({ image: videoElement }),
                pose.send({ image: videoElement })
              ])
            : selfieSegmentation.send({ image: videoElement });

        try {
            await Promise.race([
                workload,
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        timedOut = true;
                        reject(new Error('inference timeout'));
                    }, INFERENCE_TIMEOUT);
                })
            ]);
            // Success — reset the consecutive-timeout counter.
            consecutiveTimeouts = 0;
        } catch (_) {
            if (timedOut) {
                diagTimeoutCount++;
                consecutiveTimeouts++;
                console.warn(
                    `[Mirror] inference timeout #${diagTimeoutCount} ` +
                    `(consecutive: ${consecutiveTimeouts}) — device may be overloaded`
                );
            }
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
            diagInferenceSamples.push(performance.now() - inferenceStart);
            if (diagInferenceSamples.length > 15) diagInferenceSamples.shift();
            isProcessing = false;
        }

        // If MediaPipe has timed out enough times in a row, assume the
        // WASM runtime is wedged and do a full models + camera re-init.
        // Fire-and-forget; the re-entrancy guard inside reinitModels
        // prevents overlap with the watchdog's camera restart.
        if (consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT && !isReiniting) {
            reinitModels();
        }

        // Adaptive quality scaling (see adjustSkipFrames for thresholds).
        adjustSkipFrames();
    }

    function updateCoverCrop() {
        if (!videoElement || videoElement.videoWidth === 0) return;
        coverCrop = Utils.computeCoverCrop(
            videoElement.videoWidth, videoElement.videoHeight,
            canvasW, canvasH
        );
    }

    async function init(options = {}) {
        const { onReady, onError, onProgress, width = 1280, height = 720 } = options;
        canvasW = width;
        canvasH = height;
        
        onReadyCallback = onReady;
        onErrorCallback = onError;
        onProgressCallback = onProgress;

        try {
            updateProgress(0, 'Creating video element...');
            
            // Create video element.
            // NOTE: `display: none` is known to stall getUserMedia on iOS
            // Safari — the video element must remain "rendered" for the
            // camera stream to keep delivering frames. Position it 1×1 and
            // fully transparent off-screen so it's invisible but live.
            videoElement = document.createElement('video');
            videoElement.setAttribute('playsinline', '');
            videoElement.setAttribute('autoplay', '');
            videoElement.setAttribute('muted', '');
            videoElement.muted = true;
            videoElement.style.position = 'fixed';
            videoElement.style.left = '0';
            videoElement.style.top = '0';
            videoElement.style.width = '2px';
            videoElement.style.height = '2px';
            videoElement.style.opacity = '0.001';
            videoElement.style.pointerEvents = 'none';
            videoElement.style.zIndex = '-1';
            document.body.appendChild(videoElement);
            
            // Create processing canvases
            maskCanvas = Utils.createOffscreenCanvas(width, height);
            maskCtx = maskCanvas.getContext('2d');
            
            // Smaller canvas for erosion processing (performance)
            const smallW = Math.floor(width * CONFIG.processing.maskScale);
            const smallH = Math.floor(height * CONFIG.processing.maskScale);
            smallMaskCanvas = Utils.createOffscreenCanvas(smallW, smallH);
            smallMaskCtx = smallMaskCanvas.getContext('2d', { willReadFrequently: true });
            
            erosionCanvas = Utils.createOffscreenCanvas(width, height);
            erosionCtx = erosionCanvas.getContext('2d');
            
            frameCanvas = Utils.createOffscreenCanvas(width, height);
            frameCtx = frameCanvas.getContext('2d');
            
            updateProgress(10, 'Loading segmentation model...');
            
            // Initialize MediaPipe Selfie Segmentation
            selfieSegmentation = new SelfieSegmentation({
                locateFile: (file) => MP_SELFIE_BASE + file
            });
            
            selfieSegmentation.setOptions(CONFIG.segmentation);
            selfieSegmentation.onResults(onSegmentationResults);
            
            // Initialize the segmentation model
            await selfieSegmentation.initialize();
            console.log('Segmentation model loaded');
            
            updateProgress(35, 'Loading pose model...');
            
            // Initialize MediaPipe Pose
            pose = new Pose({
                locateFile: (file) => MP_POSE_BASE + file
            });
            
            pose.setOptions(CONFIG.pose);
            pose.onResults(onPoseResults);
            
            // Initialize the pose model
            await pose.initialize();
            console.log('Pose model loaded');
            
            updateProgress(60, 'Requesting camera access...');
            
            // Initialize camera — onFrame is the shared handleFrame function
            camera = new Camera(videoElement, {
                onFrame: handleFrame,
                width: width,
                height: height,
                facingMode: 'user'
            });
            
            updateProgress(80, 'Starting camera...');
            
            await camera.start();
            console.log('Camera started');

            updateProgress(95, 'Finalizing...');

            // Wait a moment for first frames
            await new Promise(resolve => setTimeout(resolve, 300));

            isInitialized = true;
            lastFrameTimestamp = performance.now();
            updateProgress(100, 'Ready!');
            console.log('Segmentation system ready');

            startWatchdog();

            // When the tab becomes visible again, reset the watchdog timestamp so
            // it does not immediately fire (the browser suspends the camera while hidden).
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    lastFrameTimestamp = performance.now();
                }
            });

            if (onReadyCallback) onReadyCallback();
            
        } catch (error) {
            console.error('Segmentation init error:', error);
            if (onErrorCallback) onErrorCallback(error);
        }
    }

    function updateProgress(percent, message) {
        if (onProgressCallback) {
            onProgressCallback(percent, message);
        }
    }

    // ==========================================
    // MediaPipe Callbacks
    // ==========================================
    
    function onSegmentationResults(results) {
        if (!results.segmentationMask) return;

        // Clear first to prevent mask accumulation/ghosting
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

        // Apply the same cover crop used for the frame so mask aligns perfectly
        if (coverCrop) {
            maskCtx.drawImage(
                results.segmentationMask,
                coverCrop.sx, coverCrop.sy, coverCrop.sw, coverCrop.sh,
                0, 0, maskCanvas.width, maskCanvas.height
            );
        } else {
            maskCtx.drawImage(results.segmentationMask, 0, 0, maskCanvas.width, maskCanvas.height);
        }
        currentMask = maskCanvas;
        
        // Update eroded mask and contour
        updateErodedMask(CONFIG.erosion.defaultAmount);
    }

    function onPoseResults(results) {
        if (!results.poseLandmarks) {
            bodyParts = {};
            return;
        }

        const landmarks = results.poseLandmarks;
        const w = frameCanvas.width;
        const h = frameCanvas.height;

        // Only the 4 landmarks consumed downstream (text-system hand triggering
        // + hand-velocity calculation). Extracting fewer points keeps landmark
        // conversion cheap per frame.
        bodyParts = {
            leftWrist:  landmarkToPoint(landmarks[15], w, h),
            rightWrist: landmarkToPoint(landmarks[16], w, h),
            leftHand:   landmarkToPoint(landmarks[19], w, h), // left index tip
            rightHand:  landmarkToPoint(landmarks[20], w, h)  // right index tip
        };

        updateHandVelocity();
    }

    function landmarkToPoint(landmark, w, h) {
        if (!landmark || landmark.visibility < 0.3) return null;

        let x, y;
        if (coverCrop) {
            // Landmark coords are normalized relative to the native video frame.
            // Map them into the cropped region, then to canvas pixels.
            const videoW = videoElement.videoWidth;
            const videoH = videoElement.videoHeight;
            x = (landmark.x * videoW - coverCrop.sx) / coverCrop.sw * w;
            y = (landmark.y * videoH - coverCrop.sy) / coverCrop.sh * h;
        } else {
            x = landmark.x * w;
            y = landmark.y * h;
        }

        return { x, y, z: landmark.z, visibility: landmark.visibility };
    }

    function updateHandVelocity() {
        const leftHand = bodyParts.leftWrist || bodyParts.leftHand;
        const rightHand = bodyParts.rightWrist || bodyParts.rightHand;
        
        // Calculate left hand velocity
        if (leftHand && previousHandPositions.left) {
            const dx = leftHand.x - previousHandPositions.left.x;
            const dy = leftHand.y - previousHandPositions.left.y;
            const speed = Math.sqrt(dx * dx + dy * dy);
            handVelocity.left = Utils.lerp(handVelocity.left, speed, CONFIG.handVelocity.smoothing);
        }
        
        // Calculate right hand velocity
        if (rightHand && previousHandPositions.right) {
            const dx = rightHand.x - previousHandPositions.right.x;
            const dy = rightHand.y - previousHandPositions.right.y;
            const speed = Math.sqrt(dx * dx + dy * dy);
            handVelocity.right = Utils.lerp(handVelocity.right, speed, CONFIG.handVelocity.smoothing);
        }
        
        handVelocity.max = Math.max(handVelocity.left, handVelocity.right);
        
        // Store for next frame
        previousHandPositions.left = leftHand ? { x: leftHand.x, y: leftHand.y } : null;
        previousHandPositions.right = rightHand ? { x: rightHand.x, y: rightHand.y } : null;
    }

    // ==========================================
    // Mask Processing
    // ==========================================
    
    function updateErodedMask(shrinkAmount) {
        if (!currentMask) return;
        
        const fullW = erosionCanvas.width;
        const fullH = erosionCanvas.height;
        const w = smallMaskCanvas.width;
        const h = smallMaskCanvas.height;
        
        // IMPORTANT: Clear canvases first to prevent ghosting
        smallMaskCtx.clearRect(0, 0, w, h);
        erosionCtx.clearRect(0, 0, fullW, fullH);
        
        // Draw mask at lower resolution for processing
        smallMaskCtx.drawImage(currentMask, 0, 0, w, h);
        
        // Fast erosion using blur + threshold
        // This is much faster than per-pixel kernel operations
        const scaledRadius = Math.round(shrinkAmount * CONFIG.processing.maskScale);
        
        if (scaledRadius > 0) {
            // Apply blur (simulates erosion effect)
            smallMaskCtx.filter = `blur(${scaledRadius}px)`;
            smallMaskCtx.drawImage(smallMaskCanvas, 0, 0);
            smallMaskCtx.filter = 'none';
            
            // Threshold to sharpen edges (simulate erosion)
            smallMaskCtx.globalCompositeOperation = 'source-over';
            smallMaskCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
            smallMaskCtx.fillRect(0, 0, w, h);
        }
        
        // Scale back up to full resolution
        erosionCtx.drawImage(smallMaskCanvas, 0, 0, fullW, fullH);
        erodedMask = erosionCanvas;
        
        // Extract contour from the small mask for performance
        extractContourFromMask();
    }

    function extractContourFromMask() {
        if (!erodedMask) return;
        
        // Use small mask for contour extraction (faster)
        const w = smallMaskCanvas.width;
        const h = smallMaskCanvas.height;
        const scale = 1 / CONFIG.processing.maskScale;
        
        const data = smallMaskCtx.getImageData(0, 0, w, h).data;
        
        const points = [];
        // step 5 means ~2.8× fewer pixel reads than step 3; the resulting
        // contour is slightly coarser but downstream only uses it to pick
        // random spawn positions for text, so the difference is invisible.
        const step = 5;
        const threshold = 100;
        
        // Scan for edge pixels
        for (let y = step; y < h - step; y += step) {
            for (let x = step; x < w - step; x += step) {
                const idx = (y * w + x) * 4;
                const current = data[idx];
                
                if (current > threshold) {
                    // Quick edge check - only check 4 neighbors
                    const up = data[((y - step) * w + x) * 4];
                    const down = data[((y + step) * w + x) * 4];
                    const left = data[(y * w + x - step) * 4];
                    const right = data[(y * w + x + step) * 4];
                    
                    if (up < threshold || down < threshold || left < threshold || right < threshold) {
                        // Scale back to full resolution
                        points.push({ x: x * scale, y: y * scale });
                    }
                }
            }
        }
        
        // Simplified ordering - just sort by angle from center
        contourPoints = orderContourPointsFast(points);
    }
    
    function orderContourPointsFast(points) {
        if (points.length < 3) return points;

        // Find center
        let cx = 0, cy = 0;
        for (const p of points) {
            cx += p.x;
            cy += p.y;
        }
        cx /= points.length;
        cy /= points.length;

        // Precompute atan2 once per point (comparator used to call it twice per
        // comparison → O(n log n) atan2 calls; now O(n)).
        for (const p of points) {
            p._angle = Math.atan2(p.y - cy, p.x - cx);
        }
        points.sort((a, b) => a._angle - b._angle);

        // Light smoothing (smoothPath allocates new point objects, so the
        // temporary _angle field does not leak into the returned contour).
        return Utils.smoothPath(points, 1);
    }

    // ==========================================
    // Public API
    // ==========================================
    
    function getFrame() {
        return currentFrame;
    }

    function getMask() {
        return currentMask;
    }

    function getErodedMask() {
        return erodedMask;
    }

    function getContour() {
        return contourPoints;
    }

    function getBodyParts() {
        return bodyParts;
    }

    function getHandVelocity() {
        return handVelocity;
    }

    function isHandMovingFast() {
        return handVelocity.max > CONFIG.handVelocity.threshold;
    }

    function getVideoElement() {
        return videoElement;
    }

    function getConfig() {
        return CONFIG;
    }

    function setErosionAmount(amount) {
        CONFIG.erosion.defaultAmount = Utils.clamp(
            amount,
            CONFIG.erosion.minAmount,
            CONFIG.erosion.maxAmount
        );
    }

    function resize(width, height) {
        canvasW = width;
        canvasH = height;
        coverCrop = null; // Will be recomputed on the next frame
    }

    function getCoverCrop() {
        return coverCrop;
    }

    function getNativeVideoSize() {
        if (!videoElement) return null;
        return { w: videoElement.videoWidth, h: videoElement.videoHeight };
    }

    function startWatchdog() {
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = setInterval(async () => {
            if (!isInitialized || isRestarting || isReiniting || document.hidden) return;
            const now = performance.now();
            if (now < nextCameraRestartAllowedAt) return;  // still in backoff
            const stalledMs = now - lastFrameTimestamp;
            if (stalledMs > WATCHDOG_STALL_MS) {
                console.warn(`Camera stalled for ${Math.round(stalledMs)}ms — restarting...`);
                await restartCamera();
            }
        }, WATCHDOG_INTERVAL_MS);
    }

    async function restartCamera() {
        if (isRestarting) return;
        isRestarting = true;
        try {
            if (camera) {
                try { camera.stop(); } catch (_) {}
            }
            isProcessing = false;
            coverCrop = null;

            await new Promise(resolve => setTimeout(resolve, 1000));

            // Reuse the shared handleFrame — same logic, no duplication
            camera = new Camera(videoElement, {
                onFrame: handleFrame,
                width: canvasW,
                height: canvasH,
                facingMode: 'user'
            });

            await camera.start();
            lastFrameTimestamp = performance.now();
            cameraRestartFailures = 0;
            nextCameraRestartAllowedAt = 0;
            console.log('Camera restarted successfully');
        } catch (err) {
            cameraRestartFailures++;
            // 4s → 8s → 16s → 32s → 60s (cap). Skip first multiplier so
            // initial retry is snappy; only back off after repeated fails.
            const backoff = Math.min(
                CAMERA_BACKOFF_BASE_MS * Math.pow(2, cameraRestartFailures - 1),
                CAMERA_BACKOFF_MAX_MS
            );
            nextCameraRestartAllowedAt = performance.now() + backoff;
            console.error(
                `Camera restart failed (attempt ${cameraRestartFailures}, ` +
                `next retry in ${Math.round(backoff / 1000)}s):`, err
            );
        } finally {
            isRestarting = false;
        }
    }

    // Full model re-init: tears down MediaPipe and rebuilds the same
    // pipeline from scratch. Used when consecutive inference timeouts
    // indicate the WASM runtime is wedged.
    async function reinitModels() {
        if (isReiniting) return;
        isReiniting = true;
        console.warn('[Mirror] Re-initializing MediaPipe models after persistent timeouts');
        try {
            // Stop the camera first so no new frames dispatch while we swap models
            if (camera) { try { camera.stop(); } catch (_) {} }
            isProcessing = false;
            coverCrop = null;

            // Close old model instances (ignore errors — they may already be stuck)
            try { if (selfieSegmentation && selfieSegmentation.close) await selfieSegmentation.close(); } catch (_) {}
            try { if (pose && pose.close) await pose.close(); } catch (_) {}

            selfieSegmentation = new SelfieSegmentation({
                locateFile: (file) => MP_SELFIE_BASE + file
            });
            selfieSegmentation.setOptions(CONFIG.segmentation);
            selfieSegmentation.onResults(onSegmentationResults);
            await selfieSegmentation.initialize();

            pose = new Pose({
                locateFile: (file) => MP_POSE_BASE + file
            });
            pose.setOptions(CONFIG.pose);
            pose.onResults(onPoseResults);
            await pose.initialize();

            camera = new Camera(videoElement, {
                onFrame: handleFrame,
                width: canvasW,
                height: canvasH,
                facingMode: 'user'
            });
            await camera.start();

            lastFrameTimestamp = performance.now();
            consecutiveTimeouts = 0;
            diagInferenceSamples.length = 0;
            reinitFailures = 0;
            console.log('[Mirror] Models re-initialized successfully');
        } catch (err) {
            reinitFailures++;
            console.error(`[Mirror] Model re-init failed (#${reinitFailures}):`, err);
        } finally {
            isReiniting = false;
        }
    }

    // Lightweight long-running hygiene — clears diagnostic history and
    // adaptive-controller state so counters cannot drift unboundedly
    // over multi-day runs. Does NOT touch models or camera.
    function softReset() {
        diagInferenceSamples.length = 0;
        diagTimeoutCount = 0;
        diagDroppedFrames = 0;
        diagCamFrameCount = 0;
        diagCamFps = 0;
        diagCamFpsLastCheck = performance.now();
        consecutiveTimeouts = 0;
        cameraRestartFailures = 0;
        nextCameraRestartAllowedAt = 0;
        lastAdaptIter = inferenceIter;
    }

    function destroy() {
        if (watchdogTimer) {
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }
        if (camera) {
            camera.stop();
        }
        if (videoElement && videoElement.parentNode) {
            videoElement.parentNode.removeChild(videoElement);
        }
        isInitialized = false;
    }

    // ==========================================
    // Export
    // ==========================================
    
    function getDiagnostics() {
        const n = diagInferenceSamples.length;
        const avg = n > 0 ? diagInferenceSamples.reduce((a, b) => a + b, 0) / n : 0;
        const max = n > 0 ? Math.max(...diagInferenceSamples) : 0;
        return {
            isMobile: IS_MOBILE,
            inferenceAvgMs: Math.round(avg),
            inferenceMaxMs: Math.round(max),
            timeoutCount: diagTimeoutCount,
            droppedFrames: diagDroppedFrames,
            cameraFps: diagCamFps,
            skipFrames: CONFIG.processing.skipFrames,
            reinitFailures,
            consecutiveTimeouts,
            cameraRestartFailures,
            lastFrameAgeMs: lastFrameTimestamp
                ? Math.round(performance.now() - lastFrameTimestamp) : -1
        };
    }

    return {
        init,
        resize,
        softReset,
        getFrame,
        getMask,
        getErodedMask,
        getContour,
        getBodyParts,
        getHandVelocity,
        isHandMovingFast,
        getVideoElement,
        getConfig,
        getCoverCrop,
        getNativeVideoSize,
        setErosionAmount,
        getDiagnostics,
        destroy,
        get isReady() { return isInitialized; }
    };
})();

window.Segmentation = Segmentation;


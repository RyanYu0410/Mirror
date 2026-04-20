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
    
    let previousHandPositions = { left: null, right: null };
    let isInitialized = false;
    let isProcessing = false;
    let frameCount = 0;
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
        const inferenceStart = performance.now();
        let timeoutId = null;
        let timedOut = false;
        // Shorter timeout on mobile — we want to detect thermal throttling quickly
        const INFERENCE_TIMEOUT = IS_MOBILE ? 3000 : 5000;
        try {
            await Promise.race([
                Promise.all([
                    selfieSegmentation.send({ image: videoElement }),
                    pose.send({ image: videoElement })
                ]),
                new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        timedOut = true;
                        reject(new Error('inference timeout'));
                    }, INFERENCE_TIMEOUT);
                })
            ]);
        } catch (_) {
            if (timedOut) {
                diagTimeoutCount++;
                console.warn(`[Mirror] inference timeout #${diagTimeoutCount} — device may be overloaded`);
            }
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
            diagInferenceSamples.push(performance.now() - inferenceStart);
            if (diagInferenceSamples.length > 15) diagInferenceSamples.shift();
            isProcessing = false;
        }
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
            
            // Create video element
            videoElement = document.createElement('video');
            videoElement.setAttribute('playsinline', '');
            videoElement.style.display = 'none';
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
                locateFile: (file) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`;
                }
            });
            
            selfieSegmentation.setOptions(CONFIG.segmentation);
            selfieSegmentation.onResults(onSegmentationResults);
            
            // Initialize the segmentation model
            await selfieSegmentation.initialize();
            console.log('Segmentation model loaded');
            
            updateProgress(35, 'Loading pose model...');
            
            // Initialize MediaPipe Pose
            pose = new Pose({
                locateFile: (file) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`;
                }
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
        const step = 3; // Sample every N pixels
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
            if (!isInitialized || isRestarting || document.hidden) return;
            const stalledMs = performance.now() - lastFrameTimestamp;
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
            console.log('Camera restarted successfully');
        } catch (err) {
            console.error('Camera restart failed:', err);
        } finally {
            isRestarting = false;
        }
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
            skipFrames: CONFIG.processing.skipFrames
        };
    }

    return {
        init,
        resize,
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


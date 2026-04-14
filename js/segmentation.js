/**
 * Soft Mirror - Segmentation Module
 * MediaPipe Selfie Segmentation + Pose tracking
 */

const Segmentation = (function() {
    'use strict';

    // ==========================================
    // Configuration
    // ==========================================
    
    const CONFIG = {
        segmentation: {
            modelSelection: 1, // 1 = landscape (better quality for full body)
            selfieMode: true
        },
        pose: {
            modelComplexity: 1, // 1 = full (better accuracy)
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.7,  // Higher threshold
            minTrackingConfidence: 0.7    // Higher threshold
        },
        processing: {
            skipFrames: 0,  // Process every frame for smoother results
            maskScale: 1.0  // Full resolution for crisp edges
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
    const WATCHDOG_INTERVAL_MS = 4000;  // check every 4 s
    const WATCHDOG_STALL_MS   = 8000;  // restart if no frame for 8 s
    
    let previousHandPositions = { left: null, right: null };
    let isInitialized = false;
    let isProcessing = false;
    let frameCount = 0;
    let onReadyCallback = null;
    let onErrorCallback = null;
    let onProgressCallback = null;

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
            
            // Initialize camera
            camera = new Camera(videoElement, {
                onFrame: async () => {
                    if (!isInitialized) return;

                    frameCount++;
                    lastFrameTimestamp = performance.now(); // watchdog heartbeat

                    // Lazy-compute cover crop once video dimensions are available
                    if (!coverCrop && videoElement.videoWidth > 0) {
                        updateCoverCrop();
                    }

                    // Capture the video frame with cover-crop so no stretching occurs
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

                    // Skip ML inference on some frames for performance
                    if (isProcessing) return;
                    if (frameCount % (CONFIG.processing.skipFrames + 1) !== 0) return;

                    isProcessing = true;

                    try {
                        // 5-second timeout guards against a hung MediaPipe promise
                        // that would lock isProcessing = true forever.
                        const timeout = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('inference timeout')), 5000)
                        );
                        await Promise.race([
                            Promise.all([
                                selfieSegmentation.send({ image: videoElement }),
                                pose.send({ image: videoElement })
                            ]),
                            timeout
                        ]);
                    } catch (err) {
                        // Silently ignore per-frame errors (including timeout)
                    } finally {
                        // Always release the lock — even if inference hung or threw
                        isProcessing = false;
                    }
                },
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
        
        // Extract key body parts
        bodyParts = {
            // Head
            nose: landmarkToPoint(landmarks[0], w, h),
            leftEye: landmarkToPoint(landmarks[2], w, h),
            rightEye: landmarkToPoint(landmarks[5], w, h),
            leftEar: landmarkToPoint(landmarks[7], w, h),
            rightEar: landmarkToPoint(landmarks[8], w, h),
            
            // Upper body
            leftShoulder: landmarkToPoint(landmarks[11], w, h),
            rightShoulder: landmarkToPoint(landmarks[12], w, h),
            leftElbow: landmarkToPoint(landmarks[13], w, h),
            rightElbow: landmarkToPoint(landmarks[14], w, h),
            leftWrist: landmarkToPoint(landmarks[15], w, h),
            rightWrist: landmarkToPoint(landmarks[16], w, h),
            
            // Hands (approximated from wrist + direction)
            leftHand: landmarkToPoint(landmarks[19], w, h), // left index
            rightHand: landmarkToPoint(landmarks[20], w, h), // right index
            
            // Fingers
            leftPinky: landmarkToPoint(landmarks[17], w, h),
            rightPinky: landmarkToPoint(landmarks[18], w, h),
            leftIndex: landmarkToPoint(landmarks[19], w, h),
            rightIndex: landmarkToPoint(landmarks[20], w, h),
            leftThumb: landmarkToPoint(landmarks[21], w, h),
            rightThumb: landmarkToPoint(landmarks[22], w, h),
            
            // Torso
            leftHip: landmarkToPoint(landmarks[23], w, h),
            rightHip: landmarkToPoint(landmarks[24], w, h)
        };
        
        // Calculate chest center
        if (bodyParts.leftShoulder && bodyParts.rightShoulder && 
            bodyParts.leftHip && bodyParts.rightHip) {
            bodyParts.chest = {
                x: (bodyParts.leftShoulder.x + bodyParts.rightShoulder.x + 
                    bodyParts.leftHip.x + bodyParts.rightHip.x) / 4,
                y: (bodyParts.leftShoulder.y + bodyParts.rightShoulder.y) / 2
            };
        }
        
        // Calculate head center
        if (bodyParts.nose && bodyParts.leftEar && bodyParts.rightEar) {
            bodyParts.head = {
                x: bodyParts.nose.x,
                y: (bodyParts.nose.y + bodyParts.leftEar.y + bodyParts.rightEar.y) / 3 - 20
            };
        }
        
        // Update hand velocities
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
        
        // Sort by angle from center
        points.sort((a, b) => {
            const angleA = Math.atan2(a.y - cy, a.x - cx);
            const angleB = Math.atan2(b.y - cy, b.x - cx);
            return angleA - angleB;
        });
        
        // Light smoothing
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
            if (!isInitialized) return;
            const stalledMs = performance.now() - lastFrameTimestamp;
            if (stalledMs > WATCHDOG_STALL_MS) {
                console.warn(`Camera stalled for ${Math.round(stalledMs)}ms — restarting…`);
                await restartCamera();
            }
        }, WATCHDOG_INTERVAL_MS);
    }

    async function restartCamera() {
        try {
            if (camera) {
                try { camera.stop(); } catch (_) {}
            }
            isProcessing = false;
            coverCrop = null;

            // Short delay before reconnecting
            await new Promise(resolve => setTimeout(resolve, 1000));

            camera = new Camera(videoElement, {
                onFrame: async () => {
                    if (!isInitialized) return;

                    frameCount++;
                    lastFrameTimestamp = performance.now();

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

                    if (isProcessing) return;
                    if (frameCount % (CONFIG.processing.skipFrames + 1) !== 0) return;

                    isProcessing = true;
                    try {
                        const timeout = new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('inference timeout')), 5000)
                        );
                        await Promise.race([
                            Promise.all([
                                selfieSegmentation.send({ image: videoElement }),
                                pose.send({ image: videoElement })
                            ]),
                            timeout
                        ]);
                    } catch (err) {
                        // ignore
                    } finally {
                        isProcessing = false;
                    }
                },
                width: canvasW,
                height: canvasH,
                facingMode: 'user'
            });

            await camera.start();
            lastFrameTimestamp = performance.now();
            console.log('Camera restarted successfully');
        } catch (err) {
            console.error('Camera restart failed:', err);
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
        destroy,
        get isReady() { return isInitialized; }
    };
})();

window.Segmentation = Segmentation;


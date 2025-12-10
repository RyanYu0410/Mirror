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
    
    async function init(options = {}) {
        const { onReady, onError, onProgress, width = 1280, height = 720 } = options;
        
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
                    
                    // Always capture frame for display
                    frameCtx.drawImage(videoElement, 0, 0, frameCanvas.width, frameCanvas.height);
                    currentFrame = frameCanvas;
                    
                    // Skip processing on some frames for performance
                    if (isProcessing) return;
                    if (frameCount % (CONFIG.processing.skipFrames + 1) !== 0) return;
                    
                    isProcessing = true;
                    
                    try {
                        // Run models in parallel (don't await sequentially)
                        const segPromise = selfieSegmentation.send({ image: videoElement });
                        const posePromise = pose.send({ image: videoElement });
                        await Promise.all([segPromise, posePromise]);
                    } catch (err) {
                        // Silently ignore frame errors
                    }
                    
                    isProcessing = false;
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
            updateProgress(100, 'Ready!');
            console.log('Segmentation system ready');
            
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
        
        // IMPORTANT: Clear the canvas first to prevent mask accumulation/ghosting
        maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        
        // Draw new mask to canvas
        maskCtx.drawImage(results.segmentationMask, 0, 0, maskCanvas.width, maskCanvas.height);
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
        return {
            x: landmark.x * w,
            y: landmark.y * h,
            z: landmark.z,
            visibility: landmark.visibility
        };
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

    function orderContourPoints(points) {
        if (points.length < 3) return points;
        
        // Find the topmost point as starting point
        let startIdx = 0;
        let minY = Infinity;
        
        for (let i = 0; i < points.length; i++) {
            if (points[i].y < minY) {
                minY = points[i].y;
                startIdx = i;
            }
        }
        
        const ordered = [points[startIdx]];
        const used = new Set([startIdx]);
        
        // Greedily connect nearest neighbors
        while (ordered.length < points.length) {
            const last = ordered[ordered.length - 1];
            let nearestIdx = -1;
            let nearestDist = Infinity;
            
            for (let i = 0; i < points.length; i++) {
                if (used.has(i)) continue;
                
                const d = Utils.dist(last.x, last.y, points[i].x, points[i].y);
                if (d < nearestDist) {
                    nearestDist = d;
                    nearestIdx = i;
                }
            }
            
            if (nearestIdx === -1 || nearestDist > 50) break; // Gap too large
            
            ordered.push(points[nearestIdx]);
            used.add(nearestIdx);
        }
        
        // Simplify and smooth the path
        let simplified = Utils.simplifyPath(ordered, 8);
        simplified = Utils.smoothPath(simplified, 2);
        
        return simplified;
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

    function destroy() {
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
        getFrame,
        getMask,
        getErodedMask,
        getContour,
        getBodyParts,
        getHandVelocity,
        isHandMovingFast,
        getVideoElement,
        getConfig,
        setErosionAmount,
        destroy,
        get isReady() { return isInitialized; }
    };
})();

window.Segmentation = Segmentation;


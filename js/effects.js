/**
 * Soft Mirror - Visual Effects Module
 * Handles glitch, glow, chromatic aberration, and other effects
 */

const Effects = (function() {
    'use strict';

    // ==========================================
    // Configuration
    // ==========================================
    
    const CONFIG = {
        glitch: {
            enabled: false, // Display path disabled in main.js; set true to re-enable
            intensity: 0.3,
            sliceCount: 8,
            maxOffset: 20,
            colorSplit: 5,
            triggerChance: 0.02,
            duration: 100 // ms
        },
        chromatic: {
            enabled: true,
            offset: 3,
            opacity: 0.5
        },
        bloom: {
            enabled: false, // Disabled for performance
            intensity: 0.3,
            threshold: 200,
            radius: 15
        },
        glow: {
            outlineWidth: 3,
            outlineBlur: 15,
            colors: {
                effect: ['#e8c4a0', '#d4a0a8', '#a0c4d4'],
                calm: ['#e8c4a0', '#d4a574', '#e0a890']
            }
        },
        vignette: {
            enabled: true,
            intensity: 0.4,
            radius: 0.7
        },
        noise: {
            enabled: false, // Disabled for performance
            intensity: 0.02,
            animated: false
        }
    };

    // ==========================================
    // State
    // ==========================================
    
    let glitchActive = false;
    let glitchEndTime = 0;
    let currentMode = 'effect';

    // Contour trail state (used by updateContourTrail / drawContourTrail)
    let contourTrail = [];
    const maxTrailLength = 6;
    const trailFadeSpeed = 0.85;

    // Offscreen canvases for effects
    let glitchCanvas = null;
    let glitchCtx = null;
    let bloomCanvas = null;
    let bloomCtx = null;

    // ==========================================
    // Initialization
    // ==========================================
    
    // Ensure glitch/bloom canvases exist at the current size (lazy — only when effects are enabled)
    function ensureGlitchCanvas(w, h) {
        if (!glitchCanvas || glitchCanvas.width !== w || glitchCanvas.height !== h) {
            glitchCanvas = Utils.createOffscreenCanvas(w, h);
            glitchCtx = glitchCanvas.getContext('2d');
        }
    }

    function ensureBloomCanvas(w, h) {
        if (!bloomCanvas || bloomCanvas.width !== w || bloomCanvas.height !== h) {
            bloomCanvas = Utils.createOffscreenCanvas(w, h);
            bloomCtx = bloomCanvas.getContext('2d');
        }
    }

    function init(width, height) {
        // glitchCanvas and bloomCanvas are lazy — allocated only when their effect is enabled.
        // Pre-allocate ring buffer of trail canvases (avoids per-frame allocation)
        backgroundTrailFrames = [];
        for (let i = 0; i < MAX_BACKGROUND_TRAIL; i++) {
            const c = Utils.createOffscreenCanvas(width, height);
            backgroundTrailFrames.push({ canvas: c, ctx: c.getContext('2d'), alpha: 0, active: false });
        }
        backgroundTrailHead = 0;
        backgroundTrailCount = 0;
    }

    function resize(width, height) {
        // glitchCanvas / bloomCanvas will self-resize on next use (lazy)
        glitchCanvas = null;
        bloomCanvas = null;

        // Resize all ring-buffer slots and reset (old frames have wrong dimensions)
        for (const slot of backgroundTrailFrames) {
            slot.canvas.width = width;
            slot.canvas.height = height;
            slot.alpha = 0;
            slot.active = false;
        }
        backgroundTrailHead = 0;
        backgroundTrailCount = 0;
    }

    // Clear accumulated trail state without touching canvas sizes. Used
    // by the long-running scheduled soft-reset so the installation can
    // shed any slow drift in trail alpha without the visible reallocate.
    function softReset() {
        for (const slot of backgroundTrailFrames) {
            slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
            slot.alpha = 0;
            slot.active = false;
        }
        backgroundTrailHead = 0;
        backgroundTrailCount = 0;
        contourTrail.length = 0;
        glitchActive = false;
    }

    function setMode(mode) {
        currentMode = mode;
    }

    // ==========================================
    // Glitch Effect
    // ==========================================
    
    function triggerGlitch(intensity = null) {
        if (!CONFIG.glitch.enabled) return;
        
        glitchActive = true;
        glitchEndTime = performance.now() + CONFIG.glitch.duration;
        
        if (intensity !== null) {
            CONFIG.glitch.intensity = intensity;
        }
    }

    function updateGlitch() {
        if (!CONFIG.glitch.enabled) return;
        if (glitchActive && performance.now() > glitchEndTime) {
            glitchActive = false;
        }
        // Random auto-trigger (only runs when glitch is enabled)
        if (!glitchActive && Math.random() < CONFIG.glitch.triggerChance) {
            triggerGlitch();
        }
    }

    function applyGlitch(ctx, sourceCanvas) {
        if (!glitchActive || !CONFIG.glitch.enabled) {
            ctx.drawImage(sourceCanvas, 0, 0);
            return;
        }
        
        const cfg = CONFIG.glitch;
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;

        ensureGlitchCanvas(w, h);
        
        // Clear and copy source
        glitchCtx.clearRect(0, 0, w, h);
        glitchCtx.drawImage(sourceCanvas, 0, 0);
        
        // Create horizontal slices with offset
        const sliceHeight = h / cfg.sliceCount;
        
        ctx.clearRect(0, 0, w, h);
        
        for (let i = 0; i < cfg.sliceCount; i++) {
            const y = i * sliceHeight;
            const offset = (Math.random() - 0.5) * cfg.maxOffset * cfg.intensity;
            
            // Occasional color channel split
            if (Math.random() < 0.3) {
                // Red channel offset
                ctx.globalCompositeOperation = 'lighter';
                ctx.fillStyle = `rgba(255, 0, 0, ${cfg.intensity * 0.3})`;
                ctx.drawImage(glitchCanvas, 0, y, w, sliceHeight, offset - cfg.colorSplit, y, w, sliceHeight);
                
                // Cyan channel offset
                ctx.fillStyle = `rgba(0, 255, 255, ${cfg.intensity * 0.3})`;
                ctx.drawImage(glitchCanvas, 0, y, w, sliceHeight, offset + cfg.colorSplit, y, w, sliceHeight);
                
                ctx.globalCompositeOperation = 'source-over';
            }
            
            ctx.drawImage(glitchCanvas, 0, y, w, sliceHeight, offset, y, w, sliceHeight);
        }
        
        // Add scan lines
        ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
        for (let y = 0; y < h; y += 4) {
            ctx.fillRect(0, y, w, 1);
        }
    }

    // ==========================================
    // Chromatic Aberration
    // ==========================================
    
    function applyChromaticAberration(ctx, sourceCanvas, offsetOverride = null) {
        if (!CONFIG.chromatic.enabled) return;
        
        const offset = offsetOverride || CONFIG.chromatic.offset;
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = CONFIG.chromatic.opacity;
        
        // Red channel - offset left
        ctx.drawImage(sourceCanvas, -offset, 0);
        
        // Blue channel - offset right  
        ctx.drawImage(sourceCanvas, offset, 0);
        
        ctx.restore();
    }

    // ==========================================
    // Bloom Effect
    // ==========================================
    
    function applyBloom(ctx, sourceCanvas) {
        if (!CONFIG.bloom.enabled) return;
        
        const cfg = CONFIG.bloom;
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;

        ensureBloomCanvas(w, h);
        
        // Extract bright areas
        bloomCtx.clearRect(0, 0, w, h);
        bloomCtx.drawImage(sourceCanvas, 0, 0);
        
        // Simple blur for bloom
        bloomCtx.filter = `blur(${cfg.radius}px)`;
        bloomCtx.drawImage(bloomCanvas, 0, 0);
        bloomCtx.filter = 'none';
        
        // Blend with original
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = cfg.intensity;
        ctx.drawImage(bloomCanvas, 0, 0);
        ctx.restore();
    }

    // ==========================================
    // Glow Outline
    // ==========================================
    
    function drawGlowingOutline(ctx, contourPoints, time, options = {}) {
        if (!contourPoints || contourPoints.length < 3) return;
        
        const {
            width = CONFIG.glow.outlineWidth,
            blur = CONFIG.glow.outlineBlur,
            animated = true,
            mode = currentMode,
            mirror = true  // Mirror to match flipped video
        } = options;
        
        const colors = CONFIG.glow.colors[mode] || CONFIG.glow.colors.effect;
        const canvasWidth = ctx.canvas.width;
        
        // Mirror points if needed
        const points = mirror ? contourPoints.map(p => ({
            x: canvasWidth - p.x,
            y: p.y
        })) : contourPoints;
        
        ctx.save();
        
        // Multiple glow layers
        for (let layer = 0; layer < 3; layer++) {
            const layerBlur = blur * (1 + layer * 0.5);
            const layerWidth = width + layer * 2;
            const layerAlpha = 0.4 - layer * 0.1;
            
            // Animated color cycling
            let colorIndex = layer;
            if (animated) {
                colorIndex = Math.floor((time * 0.001 + layer) % colors.length);
            }
            const color = colors[colorIndex];
            
            ctx.shadowColor = color;
            ctx.shadowBlur = layerBlur;
            ctx.strokeStyle = Utils.colorToString(color, layerAlpha);
            ctx.lineWidth = layerWidth;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            
            for (let i = 1; i < points.length; i++) {
                ctx.lineTo(points[i].x, points[i].y);
            }
            
            ctx.closePath();
            ctx.stroke();
        }
        
        ctx.restore();
    }

    // ==========================================
    // Vignette
    // ==========================================
    
    function applyVignette(ctx, width, height) {
        if (!CONFIG.vignette.enabled) return;
        
        const cfg = CONFIG.vignette;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.max(width, height) * cfg.radius;
        
        const gradient = ctx.createRadialGradient(
            centerX, centerY, radius * 0.5,
            centerX, centerY, radius
        );
        
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(0.5, `rgba(0, 0, 0, ${cfg.intensity * 0.3})`);
        gradient.addColorStop(1, `rgba(0, 0, 0, ${cfg.intensity})`);
        
        ctx.save();
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
    }

    // ==========================================
    // Film Noise
    // ==========================================
    
    function applyNoise(ctx, width, height, time) {
        if (!CONFIG.noise.enabled) return;
        
        const cfg = CONFIG.noise;
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        const noiseOffset = cfg.animated ? time * 0.1 : 0;
        
        for (let i = 0; i < data.length; i += 4) {
            const noise = (Math.random() - 0.5) * 255 * cfg.intensity;
            data[i] += noise;     // R
            data[i + 1] += noise; // G
            data[i + 2] += noise; // B
        }
        
        ctx.putImageData(imageData, 0, 0);
    }

    // ==========================================
    // Drop Shadow for Human Figure
    // ==========================================
    
    function applyDropShadow(ctx, mask, offsetX = 10, offsetY = 10, blur = 20, alpha = 0.3) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.filter = `blur(${blur}px)`;
        ctx.drawImage(mask, offsetX, offsetY);
        ctx.filter = 'none';
        ctx.restore();
    }

    // ==========================================
    // Black Background & Contour Trailing
    // ==========================================

    // Offscreen canvas for black mask
    let blackMaskCanvas = null;
    let blackMaskCtx = null;

    // Background trail for motion blur effect - ring buffer of pre-allocated canvases.
    // 3 slots saves one full-screen canvas of RAM and 25 % of the per-frame
    // trail copy/draw work. Fade is tuned up slightly so the visible trail
    // length stays roughly the same as the old 4-slot ring buffer.
    const MAX_BACKGROUND_TRAIL = 3;
    const BACKGROUND_TRAIL_FADE = 0.70;
    let backgroundTrailFrames = []; // array of { canvas, ctx, alpha, active }
    let backgroundTrailHead = 0;   // index of the next slot to write into
    let backgroundTrailCount = 0;  // how many slots currently hold live frames


    function initBlackMask(width, height) {
        blackMaskCanvas = Utils.createOffscreenCanvas(width, height);
        blackMaskCtx = blackMaskCanvas.getContext('2d');
    }

    // Draw solid black background using the actual mask (not contour points)
    function drawBlackBackground(ctx, mask, width, height, options = {}) {
        const {
            opacity = 1.0,
            mirror = true  // Should match the human figure mirroring
        } = options;

        // Initialize canvas if needed
        if (!blackMaskCanvas || blackMaskCanvas.width !== width || blackMaskCanvas.height !== height) {
            initBlackMask(width, height);
        }

        // Clear
        blackMaskCtx.clearRect(0, 0, width, height);

        // Fill everything with solid black
        blackMaskCtx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
        blackMaskCtx.fillRect(0, 0, width, height);

        // If we have a mask, cut out the person area
        if (mask) {
            blackMaskCtx.globalCompositeOperation = 'destination-out';

            blackMaskCtx.save();

            // Mirror the mask to match the mirrored human figure
            if (mirror) {
                blackMaskCtx.translate(width, 0);
                blackMaskCtx.scale(-1, 1);
            }

            // Draw mask - white areas will be cut out, leaving black background
            blackMaskCtx.drawImage(mask, 0, 0, width, height);

            blackMaskCtx.restore();
            blackMaskCtx.globalCompositeOperation = 'source-over';
        }

        // Draw to main context
        ctx.drawImage(blackMaskCanvas, 0, 0);
    }

    // Update background trail for motion blur effect (ring-buffer, no ImageData/getImageData)
    function updateBackgroundTrail(sourceCanvas) {
        if (!sourceCanvas || backgroundTrailFrames.length === 0) return;

        // Fade all existing active slots
        for (const slot of backgroundTrailFrames) {
            if (slot.active) {
                slot.alpha *= BACKGROUND_TRAIL_FADE;
                if (slot.alpha < 0.01) slot.active = false;
            }
        }

        // Write new frame into the next ring-buffer slot via drawImage (no getImageData)
        const slot = backgroundTrailFrames[backgroundTrailHead];
        slot.ctx.clearRect(0, 0, slot.canvas.width, slot.canvas.height);
        slot.ctx.drawImage(sourceCanvas, 0, 0);
        slot.alpha = 1.0;
        slot.active = true;

        backgroundTrailHead = (backgroundTrailHead + 1) % MAX_BACKGROUND_TRAIL;
        if (backgroundTrailCount < MAX_BACKGROUND_TRAIL) backgroundTrailCount++;
    }

    // Update contour trail for trailing effect (keeping for compatibility)
    function updateContourTrail(contourPoints) {
        if (!contourPoints || contourPoints.length < 3) return;

        // Add current contour to trail
        contourTrail.unshift({
            points: [...contourPoints],
            alpha: 1.0
        });

        // Limit trail length
        if (contourTrail.length > maxTrailLength) {
            contourTrail.pop();
        }

        // Fade existing trails
        for (let i = 1; i < contourTrail.length; i++) {
            contourTrail[i].alpha *= trailFadeSpeed;
        }
    }

    // Draw background motion blur trails (reads directly from pre-allocated ring-buffer canvases)
    function drawBackgroundTrail(ctx) {
        if (backgroundTrailCount === 0) return;

        ctx.save();
        ctx.globalCompositeOperation = 'source-over';

        // Iterate ring buffer from oldest written slot to newest
        for (let i = 0; i < MAX_BACKGROUND_TRAIL; i++) {
            const slot = backgroundTrailFrames[i];
            if (!slot.active || slot.alpha < 0.05) continue;
            ctx.globalAlpha = slot.alpha * 0.4;
            ctx.drawImage(slot.canvas, 0, 0);
        }

        ctx.restore();
    }

    // Draw contour trailing effect with black outlines
    function drawContourTrail(ctx, time, options = {}) {
        if (contourTrail.length === 0) return;

        const {
            mirror = true
        } = options;

        const canvasWidth = ctx.canvas.width;

        ctx.save();

        // Draw trails from oldest to newest (back to front)
        for (let trailIndex = contourTrail.length - 1; trailIndex >= 0; trailIndex--) {
            const trail = contourTrail[trailIndex];
            if (trail.alpha < 0.05) continue; // Skip very faded trails

            const points = mirror ? trail.points.map(p => ({
                x: canvasWidth - p.x,
                y: p.y
            })) : trail.points;

            // Calculate trail-specific properties for smooth motion blur
            const trailProgress = trailIndex / Math.max(1, contourTrail.length - 1); // 0 = oldest, 1 = newest
            const alpha = trail.alpha * (0.2 + trailProgress * 0.8); // Gradual fade from old to new
            const blur = 8 + trailIndex * 1.5; // Subtle blur increase for older trails
            const width = CONFIG.glow.outlineWidth * (0.6 + trailProgress * 0.8); // Smooth width transition

            // Use black color for all contours
            const color = '#000000';

            // Multiple layers for depth with black outlines
            for (let layer = 0; layer < 3; layer++) {
                const layerBlur = blur * (1 + layer * 0.5);
                const layerAlpha = alpha * (0.9 - layer * 0.2);

                ctx.shadowColor = color;
                ctx.shadowBlur = layerBlur;
                ctx.strokeStyle = Utils.colorToString(color, layerAlpha);
                ctx.lineWidth = width + layer * 0.5;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                ctx.beginPath();
                ctx.moveTo(points[0].x, points[0].y);

                for (let i = 1; i < points.length; i++) {
                    ctx.lineTo(points[i].x, points[i].y);
                }

                ctx.closePath();
                ctx.stroke();
            }
        }

        ctx.restore();
    }

    function drawBlackFadeMask(ctx, contourPoints, width, height, options = {}) {
        const {
            shrinkAmount = 20,
            opacity = 0.95,
            mirror = true  // Mirror the contour to match flipped video
        } = options;
        
        // Initialize black mask canvas if needed
        if (!blackMaskCanvas || blackMaskCanvas.width !== width || blackMaskCanvas.height !== height) {
            initBlackMask(width, height);
        }
        
        // Clear black mask canvas
        blackMaskCtx.clearRect(0, 0, width, height);
        
        // Fill with black
        blackMaskCtx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
        blackMaskCtx.fillRect(0, 0, width, height);
        
        if (!contourPoints || contourPoints.length < 3) {
            // No contour - just draw black overlay
            ctx.drawImage(blackMaskCanvas, 0, 0);
            return;
        }
        
        // Mirror contour points if needed
        const points = mirror ? contourPoints.map(p => ({
            x: width - p.x,
            y: p.y
        })) : contourPoints;
        
        // Calculate center of contour
        let centerX = 0, centerY = 0;
        for (const p of points) {
            centerX += p.x;
            centerY += p.y;
        }
        centerX /= points.length;
        centerY /= points.length;
        
        // Create shrunk contour path and cut it out from black
        blackMaskCtx.globalCompositeOperation = 'destination-out';
        blackMaskCtx.fillStyle = 'white';
        blackMaskCtx.beginPath();
        
        let firstPoint = true;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            
            // Vector from center to point
            const dx = p.x - centerX;
            const dy = p.y - centerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < 1) continue;
            
            // Shrink toward center - larger shrinkAmount = more shrink
            const shrinkRatio = Math.max(0.1, (dist - shrinkAmount) / dist);
            const sx = centerX + dx * shrinkRatio;
            const sy = centerY + dy * shrinkRatio;
            
            if (firstPoint) {
                blackMaskCtx.moveTo(sx, sy);
                firstPoint = false;
            } else {
                blackMaskCtx.lineTo(sx, sy);
            }
        }
        blackMaskCtx.closePath();
        blackMaskCtx.fill();
        
        // Reset composite operation
        blackMaskCtx.globalCompositeOperation = 'source-over';
        
        // Draw the black mask onto main context
        ctx.drawImage(blackMaskCanvas, 0, 0);
    }

    // ==========================================
    // Multiple Outlines Effect
    // ==========================================
    
    function drawMultipleOutlines(ctx, contourPoints, time, count = 3) {
        if (!contourPoints || contourPoints.length < 3) return;

        const colors = CONFIG.glow.colors[currentMode];

        // Compute contour center once, outside all loops
        let centerX = 0, centerY = 0;
        for (const pt of contourPoints) {
            centerX += pt.x;
            centerY += pt.y;
        }
        centerX /= contourPoints.length;
        centerY /= contourPoints.length;

        for (let i = 0; i < count; i++) {
            const offset = (i + 1) * 8;
            const alpha = 0.3 - i * 0.08;
            const colorIndex = (Math.floor(time * 0.002) + i) % colors.length;

            ctx.save();
            ctx.strokeStyle = Utils.colorToString(colors[colorIndex], alpha);
            ctx.lineWidth = 2;
            ctx.setLineDash([10, 5]);
            ctx.lineDashOffset = time * 0.05 + i * 10;

            ctx.beginPath();

            for (let j = 0; j < contourPoints.length; j++) {
                const p = contourPoints[j];
                const dx = p.x - centerX;
                const dy = p.y - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);

                const nx = p.x + (dx / dist) * offset;
                const ny = p.y + (dy / dist) * offset;

                if (j === 0) {
                    ctx.moveTo(nx, ny);
                } else {
                    ctx.lineTo(nx, ny);
                }
            }

            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        }
    }

    // ==========================================
    // Update & Draw
    // ==========================================
    
    function update(time) {
        updateGlitch();
    }

    function applyAllEffects(ctx, sourceCanvas, options = {}) {
        const {
            glitch = true,
            chromatic = true,
            bloom = true,
            vignette = true,
            noise = false,
            time = performance.now()
        } = options;
        
        if (glitch && glitchActive) {
            applyGlitch(ctx, sourceCanvas);
        }
        
        if (chromatic) {
            applyChromaticAberration(ctx, sourceCanvas);
        }
        
        if (bloom) {
            applyBloom(ctx, sourceCanvas);
        }
        
        const w = sourceCanvas.width;
        const h = sourceCanvas.height;
        
        if (vignette) {
            applyVignette(ctx, w, h);
        }
        
        if (noise) {
            applyNoise(ctx, w, h, time);
        }
    }

    // ==========================================
    // Export
    // ==========================================
    
    return {
        init,
        resize,
        softReset,
        setMode,
        update,
        
        // Individual effects
        triggerGlitch,
        applyGlitch,
        applyChromaticAberration,
        applyBloom,
        applyVignette,
        applyNoise,
        applyDropShadow,
        
        // Contour effects
        drawGlowingOutline,
        drawBlackFadeMask,
        drawBlackBackground,
        drawContourTrail,
        updateContourTrail,
        drawMultipleOutlines,

        // Background trail effects
        updateBackgroundTrail,
        drawBackgroundTrail,
        
        // Combined
        applyAllEffects,
        
        // Config
        getConfig: () => CONFIG,
        setGlitchIntensity: (i) => CONFIG.glitch.intensity = i,
        setGlitchEnabled: (e) => CONFIG.glitch.enabled = e,
        setChromaticEnabled: (e) => CONFIG.chromatic.enabled = e,
        setBloomEnabled: (e) => CONFIG.bloom.enabled = e,
        setVignetteEnabled: (e) => CONFIG.vignette.enabled = e
    };
})();

window.Effects = Effects;



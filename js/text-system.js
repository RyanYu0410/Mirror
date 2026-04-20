/**
 * Soft Mirror - Text System
 * Text particles that appear along contour, triggered by hand movement
 */

const TextSystem = (function() {
    'use strict';

    // ==========================================
    // Configuration
    // ==========================================
    
    const CONFIG = {
        trigger: {
            velocityThreshold: 5, 
            cooldown: 200, // Slightly longer cooldown so screen doesn't fill too fast with slow-fading text
            maxActive: 35 
        },
        text: {
            fontSize: { min: 24, max: 48 },
            opacity: { start: 0, peak: 0.95, end: 0 },
            lifetime: { min: 4000, max: 6000 },
            fadeIn: 2000,
            fadeOut: 1500,
            driftSpeed: 0.15,
            fontFamily: "'Cormorant Garamond', Georgia, serif"
        },
        collision: {
            enabled: true,
            minDistance: 70, // Increased distance for bigger text (was 50)
            repulsionStrength: 0.4 // Slightly stronger repulsion
        },
        colors: {
            normal: ['#f4f0e8', '#e8c4a0', '#d4a574'],
            fast: ['#e0a890', '#d4a0a8', '#c8a060'] // colors for fast movement
        }
    };

    // ==========================================
    // Comfort Phrases
    // ==========================================
    
    const COMFORT_PHRASES = [
        // Short, gentle, inclusive phrases (max ~2 words)
        "You exist",
        "Be gentle",
        "Breathe",
        "It's okay",
        "You matter",
        "Stay soft",
        "Keep going",
        "Here now",
        "You're safe",
        "Enough",
        "Trust yourself",
        "Slow down",
        "Feel",
        "Release",
        "Love you",
        "Be free",
        "Shine on",
        "Just be",
        "You glow",
        "Peace",
        "Grace",
        "Hope",
        "Dream",
        "Rest",
        "Heal",
        "Grow",
        "Bloom",
        "Flow",
        "Rise",
        "Connect"
    ];

    // ==========================================
    // Text Particle Class
    // ==========================================
    
    class TextParticle {
        constructor(options) {
            const {
                x, y, text, contourPoint, contourNormal, isFastMovement
            } = options;
            
            this.x = x;
            this.y = y;
            this.startX = x;
            this.startY = y;
            this.text = text;
            
            // Contour-based positioning
            this.contourPoint = contourPoint;
            this.normal = contourNormal || { x: 0, y: -1 };
            
            // Sizing and styling
            this.fontSize = Utils.randomRange(CONFIG.text.fontSize.min, CONFIG.text.fontSize.max);
            this.isFast = isFastMovement;
            
            // Color selection
            const colorPalette = isFastMovement ? CONFIG.colors.fast : CONFIG.colors.normal;
            this.color = Utils.randomChoice(colorPalette);
            
            // Lifecycle
            this.lifetime = Utils.randomRange(CONFIG.text.lifetime.min, CONFIG.text.lifetime.max);
            this.age = 0;
            this.opacity = 0;
            
            // Movement
            this.driftAngle = Math.atan2(this.normal.y, this.normal.x) + 
                              Utils.randomRange(-0.3, 0.3);
            this.driftSpeed = CONFIG.text.driftSpeed * Utils.randomRange(0.8, 1.2);
            
            // Noise offset for organic movement
            this.noiseOffset = Math.random() * 1000;
            
            // Collision
            this.velocity = { x: 0, y: 0 };
        }

        update(deltaTime, time) {
            this.age += deltaTime;
            
            // Calculate opacity based on lifecycle
            const cfg = CONFIG.text;
            
            if (this.age < cfg.fadeIn) {
                // Fade in
                this.opacity = Utils.Easing.easeOutCubic(this.age / cfg.fadeIn) * cfg.opacity.peak;
            } else if (this.age > this.lifetime - cfg.fadeOut) {
                // Fade out
                const fadeProgress = (this.age - (this.lifetime - cfg.fadeOut)) / cfg.fadeOut;
                this.opacity = cfg.opacity.peak * (1 - Utils.Easing.easeInCubic(fadeProgress));
            } else {
                // Full opacity
                this.opacity = cfg.opacity.peak;
            }
            
            // Drift movement
            const drift = this.driftSpeed * (deltaTime / 16);
            this.x += Math.cos(this.driftAngle) * drift;
            this.y += Math.sin(this.driftAngle) * drift;
            
            // Noise-based wobble
            const wobble = Utils.noise(time * 0.001, this.noiseOffset) - 0.5;
            this.x += wobble * 0.5;
            this.y += wobble * 0.3;
            
            // Apply collision velocity
            this.x += this.velocity.x;
            this.y += this.velocity.y;
            this.velocity.x *= 0.9;
            this.velocity.y *= 0.9;
            
            return this.age < this.lifetime;
        }

        draw(ctx) {
            if (this.opacity < 0.01) return;
            
            ctx.save();
            
            // Font setup
            ctx.font = `${this.fontSize}px ${CONFIG.text.fontFamily}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Glow effect
            ctx.shadowColor = this.color;
            ctx.shadowBlur = this.isFast ? 20 : 12;
            
            // Text with glow
            ctx.fillStyle = Utils.colorToString(this.color, this.opacity);
            ctx.fillText(this.text, this.x, this.y);
            
            // Second pass for stronger glow
            ctx.globalAlpha = this.opacity * 0.3;
            ctx.fillText(this.text, this.x, this.y);
            
            ctx.restore();
        }

        getCenter() {
            return { x: this.x, y: this.y };
        }

        // Scalar args only — avoids per-collision { x, y } literal allocation
        // in the O(n²) resolveCollisions loop. At 35 active particles this
        // was ~1200 object allocations per frame; scalars cost zero GC.
        applyRepulsion(fx, fy) {
            const k = CONFIG.collision.repulsionStrength;
            this.velocity.x += fx * k;
            this.velocity.y += fy * k;
        }
    }

    // ==========================================
    // Text System State
    // ==========================================
    
    let particles = [];
    let lastTriggerTime = 0;
    let usedPhrases = new Set();
    let phraseIndex = 0;

    // ==========================================
    // Phrase Selection
    // ==========================================
    
    function getNextPhrase() {
        // Shuffle phrases periodically
        if (usedPhrases.size >= COMFORT_PHRASES.length * 0.8) {
            usedPhrases.clear();
        }
        
        // Find unused phrase
        let attempts = 0;
        let phrase;
        
        do {
            phraseIndex = (phraseIndex + 1) % COMFORT_PHRASES.length;
            phrase = COMFORT_PHRASES[phraseIndex];
            attempts++;
        } while (usedPhrases.has(phrase) && attempts < COMFORT_PHRASES.length);
        
        usedPhrases.add(phrase);
        return phrase;
    }

    // ==========================================
    // Contour Utilities
    // ==========================================
    
    function findNearestContourPoint(contour, targetX, targetY) {
        if (!contour || contour.length === 0) return null;
        
        let nearest = contour[0];
        let minDist = Infinity;
        let nearestIndex = 0;
        
        for (let i = 0; i < contour.length; i++) {
            const p = contour[i];
            const d = Utils.dist(p.x, p.y, targetX, targetY);
            if (d < minDist) {
                minDist = d;
                nearest = p;
                nearestIndex = i;
            }
        }
        
        return { point: nearest, index: nearestIndex };
    }

    function getContourNormal(contour, index) {
        if (!contour || contour.length < 2) return { x: 0, y: -1 };
        
        const prev = contour[(index - 1 + contour.length) % contour.length];
        const next = contour[(index + 1) % contour.length];
        
        // Tangent vector
        const tx = next.x - prev.x;
        const ty = next.y - prev.y;
        const len = Math.sqrt(tx * tx + ty * ty);
        
        if (len === 0) return { x: 0, y: -1 };
        
        // Normal (perpendicular to tangent, pointing outward)
        // Assume contour is clockwise
        return {
            x: ty / len,
            y: -tx / len
        };
    }

    function getRandomContourPosition(contour, nearHand = null) {
        if (!contour || contour.length === 0) return null;
        
        let targetIndex;
        
        if (nearHand) {
            // Find point near hand
            const result = findNearestContourPoint(contour, nearHand.x, nearHand.y);
            if (!result) return null;
            
            // Random offset from nearest point
            const offset = Utils.randomInt(-10, 10);
            targetIndex = (result.index + offset + contour.length) % contour.length;
        } else {
            // Random point on contour
            targetIndex = Utils.randomInt(0, contour.length - 1);
        }
        
        const point = contour[targetIndex];
        const normal = getContourNormal(contour, targetIndex);
        
        // Offset outward from contour
        const outwardOffset = Utils.randomRange(30, 60);
        
        return {
            x: point.x + normal.x * outwardOffset,
            y: point.y + normal.y * outwardOffset,
            point: point,
            normal: normal
        };
    }

    // ==========================================
    // Collision Detection
    // ==========================================
    
    function checkCollision(newX, newY) {
        for (const p of particles) {
            const dist = Utils.dist(newX, newY, p.x, p.y);
            if (dist < CONFIG.collision.minDistance) {
                return true;
            }
        }
        return false;
    }

    function resolveCollisions() {
        if (!CONFIG.collision.enabled) return;

        const minDist = CONFIG.collision.minDistance;
        const minDistSq = minDist * minDist;

        for (let i = 0; i < particles.length; i++) {
            const a = particles[i];
            for (let j = i + 1; j < particles.length; j++) {
                const b = particles[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const distSq = dx * dx + dy * dy;

                // Cheap squared-distance reject; only sqrt on actual overlap.
                if (distSq < minDistSq && distSq > 0) {
                    const dist = Math.sqrt(distSq);
                    const overlap = minDist - dist;
                    const nx = dx / dist;
                    const ny = dy / dist;
                    const force = overlap * 0.5;

                    a.applyRepulsion(-nx * force, -ny * force);
                    b.applyRepulsion( nx * force,  ny * force);
                }
            }
        }
    }

    // ==========================================
    // Trigger Text
    // ==========================================
    
    function tryTrigger(handVelocity, bodyParts, contour) {
        const now = performance.now();
        
        // Check cooldown
        if (now - lastTriggerTime < CONFIG.trigger.cooldown) {
            return false;
        }
        
        // AUTOMATIC TRIGGER: Even without movement, sometimes trigger text
        const autoTriggerChance = 0.05; // 5% chance per frame
        let isAutoTrigger = false;
        
        // Check velocity threshold
        if (handVelocity.max < CONFIG.trigger.velocityThreshold) {
            // If hand is slow, check for random auto-trigger
            if (Math.random() < autoTriggerChance) {
                isAutoTrigger = true;
            } else {
                return false;
            }
        }
        
        // Check max active
        if (particles.length >= CONFIG.trigger.maxActive) {
            return false;
        }
        
        let position = null;
        
        // 1. Try triggering near active hand
        if (!isAutoTrigger) {
            const activeHand = handVelocity.left > handVelocity.right ? 
                (bodyParts.leftWrist || bodyParts.leftHand) :
                (bodyParts.rightWrist || bodyParts.rightHand);
            
            if (activeHand) {
                position = getRandomContourPosition(contour, activeHand);
            }
        }
        
        // 2. If no hand position found or auto-trigger, pick RANDOM contour point
        if (!position) {
            position = getRandomContourPosition(contour);
        }
        
        if (!position) return false;
        
        // Check for collision with existing text
        if (checkCollision(position.x, position.y)) {
            return false;
        }
        
        // Create new text particle
        const isFast = handVelocity.max > CONFIG.trigger.velocityThreshold * 2;
        
        const particle = new TextParticle({
            x: position.x,
            y: position.y,
            text: getNextPhrase(),
            contourPoint: position.point,
            contourNormal: position.normal,
            isFastMovement: isFast
        });
        
        particles.push(particle);
        lastTriggerTime = now;
        
        return true;
    }

    // ==========================================
    // Update & Draw
    // ==========================================
    
    function update(deltaTime, time, handVelocity, bodyParts, contour) {
        // Try to trigger new text
        tryTrigger(handVelocity, bodyParts, contour);
        
        // Update existing particles
        particles = particles.filter(p => p.update(deltaTime, time));
        
        // Resolve collisions
        resolveCollisions();
    }

    function draw(ctx) {
        for (const p of particles) {
            p.draw(ctx);
        }
    }

    // ==========================================
    // Public API
    // ==========================================
    
    function clear() {
        particles = [];
    }

    function forceSpawn(x, y, text = null) {
        const particle = new TextParticle({
            x: x,
            y: y,
            text: text || getNextPhrase(),
            contourPoint: { x, y },
            contourNormal: { x: 0, y: -1 },
            isFastMovement: false
        });
        
        particles.push(particle);
    }

    function getCount() {
        return particles.length;
    }

    function getConfig() {
        return CONFIG;
    }

    function setVelocityThreshold(threshold) {
        CONFIG.trigger.velocityThreshold = threshold;
    }

    // ==========================================
    // Export
    // ==========================================
    
    return {
        update,
        draw,
        clear,
        forceSpawn,
        getCount,
        getConfig,
        setVelocityThreshold,
        getPhrases: () => COMFORT_PHRASES
    };
})();

window.TextSystem = TextSystem;


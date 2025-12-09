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
            velocityThreshold: 12, // pixels per frame to trigger text
            cooldown: 800, // ms between triggers
            maxActive: 15 // maximum active text particles
        },
        text: {
            fontSize: { min: 14, max: 28 },
            opacity: { start: 0, peak: 0.9, end: 0 },
            lifetime: { min: 3000, max: 6000 }, // ms
            fadeIn: 500, // ms
            fadeOut: 1000, // ms
            driftSpeed: 0.3, // pixels per frame
            driftAngle: Math.PI / 4, // radians, outward drift
            fontFamily: "'Cormorant Garamond', Georgia, serif"
        },
        collision: {
            enabled: true,
            minDistance: 80, // minimum distance between text centers
            repulsionStrength: 0.5
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
        // Self-acceptance
        "You are enough",
        "Breathe deeply",
        "This moment is yours",
        "You are worthy",
        "Be gentle with yourself",
        "You are seen",
        "Rest is productive",
        "You matter",
        "Trust the process",
        "You are healing",
        
        // Encouragement
        "Keep going",
        "You've got this",
        "One step at a time",
        "Progress, not perfection",
        "You are growing",
        "Embrace change",
        "Feel your strength",
        "You are resilient",
        "Your best is enough",
        "You are capable",
        
        // Peace
        "Let it go",
        "Be present",
        "Find your calm",
        "Slow down",
        "Just be",
        "Peace is within",
        "Release tension",
        "Allow softness",
        "Breathe in peace",
        "Let yourself rest",
        
        // Hope
        "Tomorrow is new",
        "Light will come",
        "You are becoming",
        "Hope remains",
        "Joy awaits",
        "New beginnings",
        "The storm will pass",
        "Dawn approaches",
        "Beauty surrounds you",
        "Grace finds you",
        
        // Self-love
        "Love yourself first",
        "You deserve kindness",
        "Honor your journey",
        "Celebrate you",
        "You are beautiful",
        "Embrace imperfection",
        "You are whole",
        "Nurture yourself",
        "You are precious",
        "Accept yourself"
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
            
            // Measure text width (will be set in draw)
            this.width = 0;
            this.height = this.fontSize;
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
            
            // Measure width for collision
            this.width = ctx.measureText(this.text).width;
            
            // Glow effect
            const glowAlpha = this.opacity * 0.6;
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

        getRadius() {
            return Math.max(this.width, this.height) / 2;
        }

        applyRepulsion(force) {
            this.velocity.x += force.x * CONFIG.collision.repulsionStrength;
            this.velocity.y += force.y * CONFIG.collision.repulsionStrength;
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
    
    function checkCollision(newX, newY, newRadius) {
        for (const p of particles) {
            const dist = Utils.dist(newX, newY, p.x, p.y);
            const minDist = CONFIG.collision.minDistance;
            
            if (dist < minDist) {
                return true;
            }
        }
        return false;
    }

    function resolveCollisions() {
        if (!CONFIG.collision.enabled) return;
        
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const a = particles[i];
                const b = particles[j];
                
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const minDist = CONFIG.collision.minDistance;
                
                if (dist < minDist && dist > 0) {
                    // Overlap - apply repulsion
                    const overlap = minDist - dist;
                    const nx = dx / dist;
                    const ny = dy / dist;
                    
                    const force = overlap * 0.5;
                    
                    a.applyRepulsion({ x: -nx * force, y: -ny * force });
                    b.applyRepulsion({ x: nx * force, y: ny * force });
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
        
        // Check velocity threshold
        if (handVelocity.max < CONFIG.trigger.velocityThreshold) {
            return false;
        }
        
        // Check max active
        if (particles.length >= CONFIG.trigger.maxActive) {
            return false;
        }
        
        // Determine which hand triggered
        const activeHand = handVelocity.left > handVelocity.right ? 
            (bodyParts.leftWrist || bodyParts.leftHand) :
            (bodyParts.rightWrist || bodyParts.rightHand);
        
        if (!activeHand) return false;
        
        // Get position near hand on contour
        const position = getRandomContourPosition(contour, activeHand);
        
        if (!position) return false;
        
        // Check for collision with existing text
        if (checkCollision(position.x, position.y, CONFIG.collision.minDistance)) {
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


/**
 * Soft Mirror - Particle System
 * Handles ambient particles and interactive effects
 */

const Particles = (function() {
    'use strict';

    // ==========================================
    // Configuration
    // ==========================================
    
    const CONFIG = {
        ambient: {
            count: 60, // Reduced for performance
            minSize: 1,
            maxSize: 3,
            minSpeed: 0.2,
            maxSpeed: 1.0,
            noiseScale: 0.005,
            noiseStrength: 0.3,
            fadeSpeed: 0.02,
            respawnChance: 0.02
        },
        volumetric: {
            rayCount: 5, // Reduced
            rayWidth: 120,
            rayLength: 500,
            rotationSpeed: 0.001,
            opacity: 0.06,
            blendMode: 'screen'
        },
        dust: {
            count: 30, // Reduced
            minSize: 0.5,
            maxSize: 1.5,
            driftSpeed: 0.3
        },
        sparkle: {
            count: 15, // Reduced
            minSize: 2,
            maxSize: 5,
            duration: 45,
            spawnRate: 0.02
        }
    };

    // ==========================================
    // Particle Classes
    // ==========================================
    
    class AmbientParticle {
        constructor(width, height) {
            this.width = width;
            this.height = height;
            this.reset(true);
        }

        reset(initial = false) {
            const cfg = CONFIG.ambient;
            
            this.x = initial ? Math.random() * this.width : 
                     (Math.random() < 0.5 ? -10 : this.width + 10);
            this.y = Math.random() * this.height;
            
            this.vx = Utils.randomRange(-cfg.maxSpeed, cfg.maxSpeed);
            this.vy = Utils.randomRange(-cfg.maxSpeed, cfg.maxSpeed);
            
            this.size = Utils.randomRange(cfg.minSize, cfg.maxSize);
            this.baseSize = this.size;
            
            this.noiseOffset = Math.random() * 1000;
            this.alpha = initial ? Math.random() : 0;
            this.targetAlpha = Utils.randomRange(0.3, 0.8);
            
            // Color: warm tones
            const palette = Utils.WarmPalette;
            const colors = Object.values(palette);
            this.color = Utils.hexToRgb(Utils.randomChoice(colors));
            
            this.life = Utils.randomRange(200, 500);
            this.age = 0;
        }

        update(time) {
            const cfg = CONFIG.ambient;
            
            // Noise-based movement
            const noiseX = Utils.noise(this.x * cfg.noiseScale, this.y * cfg.noiseScale, time * 0.001);
            const noiseY = Utils.noise(this.x * cfg.noiseScale + 100, this.y * cfg.noiseScale + 100, time * 0.001);
            
            this.vx += (noiseX - 0.5) * cfg.noiseStrength;
            this.vy += (noiseY - 0.5) * cfg.noiseStrength;
            
            // Apply velocity with damping
            this.x += this.vx;
            this.y += this.vy;
            this.vx *= 0.99;
            this.vy *= 0.99;
            
            // Size pulsing
            this.size = this.baseSize * (0.8 + 0.4 * Math.sin(time * 0.002 + this.noiseOffset));
            
            // Alpha fade in/out
            this.age++;
            
            if (this.age < 30) {
                this.alpha = Utils.lerp(this.alpha, this.targetAlpha, 0.1);
            } else if (this.age > this.life - 30) {
                this.alpha = Utils.lerp(this.alpha, 0, 0.05);
            }
            
            // Check if needs respawn
            if (this.age >= this.life || 
                this.x < -50 || this.x > this.width + 50 ||
                this.y < -50 || this.y > this.height + 50) {
                this.reset();
            }
        }

        draw(ctx) {
            if (this.alpha < 0.01) return;
            
            ctx.save();
            ctx.globalAlpha = this.alpha;
            
            // Glow effect
            const gradient = ctx.createRadialGradient(
                this.x, this.y, 0,
                this.x, this.y, this.size * 3
            );
            gradient.addColorStop(0, `rgba(${this.color.r}, ${this.color.g}, ${this.color.b}, 1)`);
            gradient.addColorStop(0.4, `rgba(${this.color.r}, ${this.color.g}, ${this.color.b}, 0.3)`);
            gradient.addColorStop(1, `rgba(${this.color.r}, ${this.color.g}, ${this.color.b}, 0)`);
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size * 3, 0, Math.PI * 2);
            ctx.fill();
            
            // Core
            ctx.fillStyle = `rgba(${this.color.r}, ${this.color.g}, ${this.color.b}, 1)`;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size * 0.5, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        }
    }

    class DustParticle {
        constructor(width, height) {
            this.width = width;
            this.height = height;
            this.reset(true);
        }

        reset(initial = false) {
            const cfg = CONFIG.dust;
            
            this.x = Math.random() * this.width;
            this.y = initial ? Math.random() * this.height : this.height + 10;
            
            this.size = Utils.randomRange(cfg.minSize, cfg.maxSize);
            this.alpha = Utils.randomRange(0.1, 0.3);
            
            this.driftAngle = Math.random() * Math.PI * 2;
            this.driftRadius = Utils.randomRange(20, 50);
            this.driftSpeed = Utils.randomRange(0.002, 0.005);
            
            this.riseSpeed = Utils.randomRange(0.1, 0.4);
            this.noiseOffset = Math.random() * 1000;
        }

        update(time) {
            // Gentle rise
            this.y -= this.riseSpeed;
            
            // Drift in a circle
            this.driftAngle += this.driftSpeed;
            const driftX = Math.cos(this.driftAngle) * this.driftRadius * 0.01;
            this.x += driftX;
            
            // Noise-based wobble
            const wobble = Utils.noise(time * 0.001, this.noiseOffset) - 0.5;
            this.x += wobble * 0.5;
            
            // Reset if off screen
            if (this.y < -20) {
                this.reset();
            }
        }

        draw(ctx) {
            ctx.save();
            ctx.globalAlpha = this.alpha;
            ctx.fillStyle = '#f4f0e8';
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    class SparkleParticle {
        constructor(x, y, color) {
            this.x = x;
            this.y = y;
            this.color = color || { r: 255, g: 255, b: 255 };
            
            const cfg = CONFIG.sparkle;
            this.size = Utils.randomRange(cfg.minSize, cfg.maxSize);
            this.maxSize = this.size;
            this.duration = cfg.duration;
            this.age = 0;
            this.rotation = Math.random() * Math.PI * 2;
            this.rotationSpeed = Utils.randomRange(-0.1, 0.1);
        }

        update() {
            this.age++;
            this.rotation += this.rotationSpeed;
            
            // Pulsing size
            const progress = this.age / this.duration;
            const pulse = Math.sin(progress * Math.PI);
            this.size = this.maxSize * pulse;
            
            return this.age < this.duration;
        }

        draw(ctx) {
            if (this.size < 0.1) return;
            
            const alpha = Math.sin((this.age / this.duration) * Math.PI);
            
            ctx.save();
            ctx.translate(this.x, this.y);
            ctx.rotate(this.rotation);
            ctx.globalAlpha = alpha;
            
            // Draw 4-pointed star
            ctx.fillStyle = `rgb(${this.color.r}, ${this.color.g}, ${this.color.b})`;
            
            ctx.beginPath();
            for (let i = 0; i < 4; i++) {
                const angle = (i / 4) * Math.PI * 2;
                const outerX = Math.cos(angle) * this.size;
                const outerY = Math.sin(angle) * this.size;
                const innerAngle = angle + Math.PI / 4;
                const innerX = Math.cos(innerAngle) * this.size * 0.3;
                const innerY = Math.sin(innerAngle) * this.size * 0.3;
                
                if (i === 0) {
                    ctx.moveTo(outerX, outerY);
                } else {
                    ctx.lineTo(outerX, outerY);
                }
                ctx.lineTo(innerX, innerY);
            }
            ctx.closePath();
            ctx.fill();
            
            // Glow
            const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size * 2);
            gradient.addColorStop(0, `rgba(${this.color.r}, ${this.color.g}, ${this.color.b}, 0.5)`);
            gradient.addColorStop(1, `rgba(${this.color.r}, ${this.color.g}, ${this.color.b}, 0)`);
            
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(0, 0, this.size * 2, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        }
    }

    // ==========================================
    // Volumetric Light Rays
    // ==========================================
    
    class VolumetricLight {
        constructor(width, height) {
            this.width = width;
            this.height = height;
            this.centerX = width / 2;
            this.centerY = height * 0.3;
            this.rotation = 0;
            this.rays = [];
            
            this.init();
        }

        init() {
            const cfg = CONFIG.volumetric;
            
            for (let i = 0; i < cfg.rayCount; i++) {
                this.rays.push({
                    angle: (i / cfg.rayCount) * Math.PI * 2,
                    width: Utils.randomRange(cfg.rayWidth * 0.5, cfg.rayWidth),
                    length: Utils.randomRange(cfg.rayLength * 0.7, cfg.rayLength),
                    opacity: Utils.randomRange(cfg.opacity * 0.5, cfg.opacity),
                    noiseOffset: Math.random() * 1000
                });
            }
        }

        update(time) {
            const cfg = CONFIG.volumetric;
            this.rotation += cfg.rotationSpeed;
            
            // Update ray properties with noise
            for (const ray of this.rays) {
                const noise = Utils.noise(time * 0.0005, ray.noiseOffset);
                ray.currentOpacity = ray.opacity * (0.5 + noise * 0.5);
            }
        }

        draw(ctx, mask = null) {
            const cfg = CONFIG.volumetric;
            
            ctx.save();
            ctx.globalCompositeOperation = cfg.blendMode;
            ctx.translate(this.centerX, this.centerY);
            ctx.rotate(this.rotation);
            
            for (const ray of this.rays) {
                const halfWidth = ray.width / 2;
                
                const gradient = ctx.createLinearGradient(0, 0, 0, ray.length);
                gradient.addColorStop(0, `rgba(255, 240, 220, ${ray.currentOpacity})`);
                gradient.addColorStop(0.5, `rgba(255, 230, 200, ${ray.currentOpacity * 0.5})`);
                gradient.addColorStop(1, 'rgba(255, 220, 180, 0)');
                
                ctx.save();
                ctx.rotate(ray.angle);
                
                ctx.beginPath();
                ctx.moveTo(-halfWidth * 0.3, 0);
                ctx.lineTo(-halfWidth, ray.length);
                ctx.lineTo(halfWidth, ray.length);
                ctx.lineTo(halfWidth * 0.3, 0);
                ctx.closePath();
                
                ctx.fillStyle = gradient;
                ctx.fill();
                
                ctx.restore();
            }
            
            ctx.restore();
        }

        setCenter(x, y) {
            this.centerX = x;
            this.centerY = y;
        }
    }

    // ==========================================
    // Particle System Manager
    // ==========================================
    
    let ambientParticles = [];
    let dustParticles = [];
    let sparkles = [];
    let volumetricLight = null;
    
    let width = 0;
    let height = 0;
    let isInitialized = false;

    function init(w, h) {
        width = w;
        height = h;
        
        // Create ambient particles
        ambientParticles = [];
        for (let i = 0; i < CONFIG.ambient.count; i++) {
            ambientParticles.push(new AmbientParticle(width, height));
        }
        
        // Create dust particles
        dustParticles = [];
        for (let i = 0; i < CONFIG.dust.count; i++) {
            dustParticles.push(new DustParticle(width, height));
        }
        
        // Create volumetric light
        volumetricLight = new VolumetricLight(width, height);
        
        sparkles = [];
        isInitialized = true;
    }

    function resize(w, h) {
        width = w;
        height = h;
        
        // Update existing particles
        for (const p of ambientParticles) {
            p.width = w;
            p.height = h;
        }
        for (const p of dustParticles) {
            p.width = w;
            p.height = h;
        }
        
        if (volumetricLight) {
            volumetricLight.width = w;
            volumetricLight.height = h;
            volumetricLight.centerX = w / 2;
            volumetricLight.centerY = h * 0.3;
        }
    }

    function update(time) {
        if (!isInitialized) return;
        
        // Update ambient particles
        for (const p of ambientParticles) {
            p.update(time);
        }
        
        // Update dust particles
        for (const p of dustParticles) {
            p.update(time);
        }
        
        // Update sparkles
        sparkles = sparkles.filter(s => s.update());
        
        // Update volumetric light
        if (volumetricLight) {
            volumetricLight.update(time);
        }
        
        // Random sparkle spawning
        if (Math.random() < CONFIG.sparkle.spawnRate) {
            addSparkle(
                Utils.randomRange(0, width),
                Utils.randomRange(0, height)
            );
        }
    }

    function draw(ctx, mode = 'effect') {
        if (!isInitialized) return;
        
        // Draw volumetric light (behind everything)
        if (volumetricLight && mode === 'effect') {
            volumetricLight.draw(ctx);
        }
        
        // Draw dust
        for (const p of dustParticles) {
            p.draw(ctx);
        }
        
        // Draw ambient particles
        for (const p of ambientParticles) {
            p.draw(ctx);
        }
        
        // Draw sparkles
        for (const s of sparkles) {
            s.draw(ctx);
        }
    }

    function drawVolumetricOnly(ctx) {
        if (volumetricLight) {
            volumetricLight.draw(ctx);
        }
    }

    function addSparkle(x, y, color = null) {
        if (sparkles.length < 50) {
            sparkles.push(new SparkleParticle(x, y, color));
        }
    }

    function addSparkleNearHand(bodyParts, count = 3) {
        const hands = [bodyParts.leftHand, bodyParts.rightHand, 
                       bodyParts.leftWrist, bodyParts.rightWrist];
        
        for (const hand of hands) {
            if (!hand) continue;
            
            for (let i = 0; i < count; i++) {
                if (Math.random() < 0.3) {
                    const x = hand.x + Utils.gaussian(0, 30);
                    const y = hand.y + Utils.gaussian(0, 30);
                    const color = Utils.hexToRgb(Utils.randomChoice(Object.values(Utils.WarmPalette)));
                    addSparkle(x, y, color);
                }
            }
        }
    }

    function setVolumetricCenter(x, y) {
        if (volumetricLight) {
            volumetricLight.setCenter(x, y);
        }
    }

    function getConfig() {
        return CONFIG;
    }

    // ==========================================
    // Export
    // ==========================================
    
    return {
        init,
        resize,
        update,
        draw,
        drawVolumetricOnly,
        addSparkle,
        addSparkleNearHand,
        setVolumetricCenter,
        getConfig,
        get isReady() { return isInitialized; }
    };
})();

window.Particles = Particles;


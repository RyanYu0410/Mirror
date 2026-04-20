/**
 * Soft Mirror - Utility Functions
 * Contains noise, easing, color, timing, and FPS utilities
 */

const Utils = (function() {
    'use strict';

    // ==========================================
    // Perlin Noise Implementation
    // ==========================================
    // Classic Ken-Perlin 256-entry permutation table.
    // Bounded memory (no cache growth) and faster than the previous
    // string-keyed gradient cache.

    const perlinPerm = new Uint8Array(512);

    function buildPermutation(seed) {
        // Fill 0..255 then Fisher–Yates shuffle with a seeded LCG
        const base = new Uint8Array(256);
        for (let i = 0; i < 256; i++) base[i] = i;
        let s = (seed | 0) || 1;
        for (let i = 255; i > 0; i--) {
            // LCG: Numerical Recipes constants
            s = (s * 1664525 + 1013904223) | 0;
            const j = (s >>> 0) % (i + 1);
            const tmp = base[i]; base[i] = base[j]; base[j] = tmp;
        }
        // Duplicate so indexing perm[x+1] never overflows
        for (let i = 0; i < 512; i++) perlinPerm[i] = base[i & 255];
    }

    buildPermutation(Math.floor(Math.random() * 2147483647));

    function setNoiseSeed(seed) {
        buildPermutation(seed);
    }

    function fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    function lerp(a, b, t) {
        return a + t * (b - a);
    }

    function grad(hash, x, y) {
        const h = hash & 3;
        const u = h < 2 ? x : y;
        const v = h < 2 ? y : x;
        return ((h & 1) ? -u : u) + ((h & 2) ? -2 * v : 2 * v);
    }

    function noise2D(x, y) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;

        x -= Math.floor(x);
        y -= Math.floor(y);

        const u = fade(x);
        const v = fade(y);

        const p = perlinPerm;
        const A = p[X] + Y;
        const B = p[X + 1] + Y;

        return lerp(
            lerp(grad(p[A],     x,     y),     grad(p[B],     x - 1, y),     u),
            lerp(grad(p[A + 1], x,     y - 1), grad(p[B + 1], x - 1, y - 1), u),
            v
        );
    }

    // Normalized noise (0 to 1)
    function noise(x, y = 0, z = 0) {
        return (noise2D(x + z * 100, y) + 1) * 0.5;
    }

    // Fractal noise with octaves
    function fractalNoise(x, y, octaves = 4, persistence = 0.5) {
        let total = 0;
        let frequency = 1;
        let amplitude = 1;
        let maxValue = 0;
        
        for (let i = 0; i < octaves; i++) {
            total += noise(x * frequency, y * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= 2;
        }
        
        return total / maxValue;
    }

    // ==========================================
    // Easing Functions
    // ==========================================
    
    const Easing = {
        linear: t => t,
        
        easeInQuad: t => t * t,
        easeOutQuad: t => t * (2 - t),
        easeInOutQuad: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
        
        easeInCubic: t => t * t * t,
        easeOutCubic: t => (--t) * t * t + 1,
        easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
        
        easeInQuart: t => t * t * t * t,
        easeOutQuart: t => 1 - (--t) * t * t * t,
        easeInOutQuart: t => t < 0.5 ? 8 * t * t * t * t : 1 - 8 * (--t) * t * t * t,
        
        easeInExpo: t => t === 0 ? 0 : Math.pow(2, 10 * (t - 1)),
        easeOutExpo: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
        easeInOutExpo: t => {
            if (t === 0 || t === 1) return t;
            return t < 0.5
                ? Math.pow(2, 20 * t - 10) / 2
                : (2 - Math.pow(2, -20 * t + 10)) / 2;
        },
        
        easeInSine: t => 1 - Math.cos(t * Math.PI / 2),
        easeOutSine: t => Math.sin(t * Math.PI / 2),
        easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
        
        easeInElastic: t => {
            if (t === 0 || t === 1) return t;
            return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * (2 * Math.PI / 3));
        },
        easeOutElastic: t => {
            if (t === 0 || t === 1) return t;
            return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;
        },
        
        easeInBack: t => 2.70158 * t * t * t - 1.70158 * t * t,
        easeOutBack: t => 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2),
        
        smoothstep: t => t * t * (3 - 2 * t),
        smootherstep: t => t * t * t * (t * (t * 6 - 15) + 10)
    };

    // ==========================================
    // Color Utilities
    // ==========================================
    
    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 0, g: 0, b: 0 };
    }

    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(x => {
            const hex = Math.round(Math.max(0, Math.min(255, x))).toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }

    function hslToRgb(h, s, l) {
        h = h % 360;
        s = Math.max(0, Math.min(1, s));
        l = Math.max(0, Math.min(1, l));
        
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        
        let r, g, b;
        if (h < 60) { r = c; g = x; b = 0; }
        else if (h < 120) { r = x; g = c; b = 0; }
        else if (h < 180) { r = 0; g = c; b = x; }
        else if (h < 240) { r = 0; g = x; b = c; }
        else if (h < 300) { r = x; g = 0; b = c; }
        else { r = c; g = 0; b = x; }
        
        return {
            r: Math.round((r + m) * 255),
            g: Math.round((g + m) * 255),
            b: Math.round((b + m) * 255)
        };
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        
        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                case g: h = ((b - r) / d + 2) / 6; break;
                case b: h = ((r - g) / d + 4) / 6; break;
            }
        }
        
        return { h: h * 360, s, l };
    }

    function lerpColor(color1, color2, t) {
        const c1 = typeof color1 === 'string' ? hexToRgb(color1) : color1;
        const c2 = typeof color2 === 'string' ? hexToRgb(color2) : color2;
        
        return {
            r: Math.round(lerp(c1.r, c2.r, t)),
            g: Math.round(lerp(c1.g, c2.g, t)),
            b: Math.round(lerp(c1.b, c2.b, t))
        };
    }

    function colorToString(color, alpha = 1) {
        if (typeof color === 'string') {
            if (alpha < 1) {
                const rgb = hexToRgb(color);
                return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
            }
            return color;
        }
        if (alpha < 1) {
            return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
        }
        return rgbToHex(color.r, color.g, color.b);
    }

    // Warm color palette for Calm Mirror mode
    const WarmPalette = {
        cream: '#f4f0e8',
        peach: '#e8c4a0',
        gold: '#d4a574',
        rose: '#d4a0a8',
        coral: '#e0a890',
        amber: '#c8a060',
        blush: '#e8b8b0'
    };

    // Cool color palette for Effect mode
    const CoolPalette = {
        ice: '#a0c4d4',
        mint: '#a0d4c4',
        lavender: '#b4a0d4',
        sky: '#90b8d8',
        silver: '#c0c8d0'
    };

    // ==========================================
    // Math Utilities
    // ==========================================
    
    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function map(value, start1, stop1, start2, stop2) {
        return start2 + (stop2 - start2) * ((value - start1) / (stop1 - start1));
    }

    function mapClamped(value, start1, stop1, start2, stop2) {
        return clamp(map(value, start1, stop1, start2, stop2), Math.min(start2, stop2), Math.max(start2, stop2));
    }

    function dist(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function randomRange(min, max) {
        return min + Math.random() * (max - min);
    }

    function randomInt(min, max) {
        return Math.floor(randomRange(min, max + 1));
    }

    function randomChoice(array) {
        return array[Math.floor(Math.random() * array.length)];
    }

    function shuffle(array) {
        const result = [...array];
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }

    function gaussian(mean = 0, stdev = 1) {
        const u = 1 - Math.random();
        const v = Math.random();
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        return z * stdev + mean;
    }

    // ==========================================
    // Vector Utilities
    // ==========================================
    
    class Vector2 {
        constructor(x = 0, y = 0) {
            this.x = x;
            this.y = y;
        }

        copy() {
            return new Vector2(this.x, this.y);
        }

        add(v) {
            this.x += v.x;
            this.y += v.y;
            return this;
        }

        sub(v) {
            this.x -= v.x;
            this.y -= v.y;
            return this;
        }

        mult(n) {
            this.x *= n;
            this.y *= n;
            return this;
        }

        div(n) {
            if (n !== 0) {
                this.x /= n;
                this.y /= n;
            }
            return this;
        }

        mag() {
            return Math.sqrt(this.x * this.x + this.y * this.y);
        }

        normalize() {
            const m = this.mag();
            if (m > 0) this.div(m);
            return this;
        }

        limit(max) {
            const m = this.mag();
            if (m > max) {
                this.normalize().mult(max);
            }
            return this;
        }

        setMag(len) {
            return this.normalize().mult(len);
        }

        heading() {
            return Math.atan2(this.y, this.x);
        }

        rotate(angle) {
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const x = this.x * cos - this.y * sin;
            const y = this.x * sin + this.y * cos;
            this.x = x;
            this.y = y;
            return this;
        }

        lerp(v, amt) {
            this.x = lerp(this.x, v.x, amt);
            this.y = lerp(this.y, v.y, amt);
            return this;
        }

        dist(v) {
            return dist(this.x, this.y, v.x, v.y);
        }

        static add(v1, v2) {
            return new Vector2(v1.x + v2.x, v1.y + v2.y);
        }

        static sub(v1, v2) {
            return new Vector2(v1.x - v2.x, v1.y - v2.y);
        }

        static fromAngle(angle, length = 1) {
            return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
        }
    }

    // ==========================================
    // Timing Utilities
    // ==========================================
    
    class Timer {
        constructor(duration, callback, loop = false) {
            this.duration = duration;
            this.callback = callback;
            this.loop = loop;
            this.elapsed = 0;
            this.running = false;
            this.completed = false;
        }

        start() {
            this.elapsed = 0;
            this.running = true;
            this.completed = false;
            return this;
        }

        stop() {
            this.running = false;
            return this;
        }

        reset() {
            this.elapsed = 0;
            this.completed = false;
            return this;
        }

        update(deltaTime) {
            if (!this.running || this.completed) return;
            
            this.elapsed += deltaTime;
            
            if (this.elapsed >= this.duration) {
                if (this.loop) {
                    this.elapsed %= this.duration;
                } else {
                    this.running = false;
                    this.completed = true;
                }
                if (this.callback) this.callback();
            }
        }

        getProgress() {
            return clamp(this.elapsed / this.duration, 0, 1);
        }
    }

    class Interval {
        constructor(intervalMs, callback) {
            this.intervalMs = intervalMs;
            this.callback = callback;
            this.elapsed = 0;
            this.running = true;
        }

        update(deltaTime) {
            if (!this.running) return;
            
            this.elapsed += deltaTime;
            while (this.elapsed >= this.intervalMs) {
                this.elapsed -= this.intervalMs;
                if (this.callback) this.callback();
            }
        }

        stop() {
            this.running = false;
        }

        start() {
            this.running = true;
        }
    }

    // ==========================================
    // FPS Counter
    // ==========================================
    
    class FPSCounter {
        constructor(sampleSize = 60) {
            this.sampleSize = sampleSize;
            this.samples = [];
            this.lastTime = performance.now();
            this.fps = 0;
        }

        update() {
            const now = performance.now();
            const delta = now - this.lastTime;
            this.lastTime = now;
            
            this.samples.push(1000 / delta);
            if (this.samples.length > this.sampleSize) {
                this.samples.shift();
            }
            
            this.fps = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
            return this.fps;
        }

        getFPS() {
            return Math.round(this.fps);
        }
    }

    // ==========================================
    // Smoothing / Filtering
    // ==========================================
    
    class SmoothValue {
        constructor(initialValue = 0, smoothing = 0.1) {
            this.value = initialValue;
            this.target = initialValue;
            this.smoothing = smoothing;
        }

        set(target) {
            this.target = target;
        }

        setImmediate(value) {
            this.value = value;
            this.target = value;
        }

        update() {
            this.value = lerp(this.value, this.target, this.smoothing);
            return this.value;
        }

        get() {
            return this.value;
        }
    }

    class SmoothVector {
        constructor(x = 0, y = 0, smoothing = 0.1) {
            this.x = new SmoothValue(x, smoothing);
            this.y = new SmoothValue(y, smoothing);
        }

        set(x, y) {
            this.x.set(x);
            this.y.set(y);
        }

        setImmediate(x, y) {
            this.x.setImmediate(x);
            this.y.setImmediate(y);
        }

        update() {
            return {
                x: this.x.update(),
                y: this.y.update()
            };
        }

        get() {
            return {
                x: this.x.get(),
                y: this.y.get()
            };
        }
    }

    // ==========================================
    // Aspect Ratio / Cover Crop Utilities
    // ==========================================

    /**
     * Compute the source-crop rectangle that makes srcW×srcH "cover" dstW×dstH
     * without stretching (identical logic to CSS object-fit:cover).
     *
     * Use the result as the first four args of the 9-argument drawImage:
     *   ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dstW, dstH)
     *
     * @returns {{ sx, sy, sw, sh, scale, isExact }}
     */
    function computeCoverCrop(srcW, srcH, dstW, dstH) {
        const scale = Math.max(dstW / srcW, dstH / srcH);
        const sw = dstW / scale;
        const sh = dstH / scale;
        const sx = (srcW - sw) / 2;
        const sy = (srcH - sh) / 2;
        const isExact = Math.abs(sw - srcW) < 0.5 && Math.abs(sh - srcH) < 0.5;
        return { sx, sy, sw, sh, scale, isExact };
    }

    /**
     * Format a width/height pair as a simplified ratio string, e.g. "16:9".
     */
    function formatAspectRatio(w, h) {
        function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
        const g = gcd(Math.round(w), Math.round(h));
        return `${Math.round(w) / g}:${Math.round(h) / g}`;
    }

    // ==========================================
    // Canvas Utilities
    // ==========================================
    
    function createOffscreenCanvas(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    function clearCanvas(ctx, width, height) {
        ctx.clearRect(0, 0, width, height);
    }

    // ==========================================
    // DOM Utilities
    // ==========================================
    
    function $(selector) {
        return document.querySelector(selector);
    }

    function $$(selector) {
        return document.querySelectorAll(selector);
    }

    function addClass(element, className) {
        element.classList.add(className);
    }

    function removeClass(element, className) {
        element.classList.remove(className);
    }

    function toggleClass(element, className) {
        element.classList.toggle(className);
    }

    // ==========================================
    // Path / Contour Utilities
    // ==========================================
    
    function simplifyPath(points, tolerance = 5) {
        if (points.length < 3) return points;
        
        // Douglas-Peucker simplification
        function rdp(points, start, end, tolerance, result) {
            let maxDist = 0;
            let maxIndex = 0;
            
            const startPt = points[start];
            const endPt = points[end];
            
            for (let i = start + 1; i < end; i++) {
                const d = perpendicularDistance(points[i], startPt, endPt);
                if (d > maxDist) {
                    maxDist = d;
                    maxIndex = i;
                }
            }
            
            if (maxDist > tolerance) {
                rdp(points, start, maxIndex, tolerance, result);
                result.push(points[maxIndex]);
                rdp(points, maxIndex, end, tolerance, result);
            }
        }
        
        function perpendicularDistance(point, lineStart, lineEnd) {
            const dx = lineEnd.x - lineStart.x;
            const dy = lineEnd.y - lineStart.y;
            const mag = Math.sqrt(dx * dx + dy * dy);
            
            if (mag === 0) return dist(point.x, point.y, lineStart.x, lineStart.y);
            
            const u = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (mag * mag);
            
            let closestX, closestY;
            if (u < 0) {
                closestX = lineStart.x;
                closestY = lineStart.y;
            } else if (u > 1) {
                closestX = lineEnd.x;
                closestY = lineEnd.y;
            } else {
                closestX = lineStart.x + u * dx;
                closestY = lineStart.y + u * dy;
            }
            
            return dist(point.x, point.y, closestX, closestY);
        }
        
        const result = [points[0]];
        rdp(points, 0, points.length - 1, tolerance, result);
        result.push(points[points.length - 1]);
        
        return result;
    }

    function smoothPath(points, iterations = 2) {
        if (points.length < 3) return points;
        
        let smoothed = [...points];
        
        for (let iter = 0; iter < iterations; iter++) {
            const newPoints = [smoothed[0]];
            
            for (let i = 1; i < smoothed.length - 1; i++) {
                const prev = smoothed[i - 1];
                const curr = smoothed[i];
                const next = smoothed[i + 1];
                
                newPoints.push({
                    x: curr.x * 0.5 + (prev.x + next.x) * 0.25,
                    y: curr.y * 0.5 + (prev.y + next.y) * 0.25
                });
            }
            
            newPoints.push(smoothed[smoothed.length - 1]);
            smoothed = newPoints;
        }
        
        return smoothed;
    }

    // ==========================================
    // Export
    // ==========================================
    
    return {
        // Noise
        noise,
        noise2D,
        fractalNoise,
        setNoiseSeed,
        
        // Math
        lerp,
        clamp,
        map,
        mapClamped,
        dist,
        randomRange,
        randomInt,
        randomChoice,
        shuffle,
        gaussian,
        
        // Easing
        Easing,
        
        // Color
        hexToRgb,
        rgbToHex,
        hslToRgb,
        rgbToHsl,
        lerpColor,
        colorToString,
        WarmPalette,
        CoolPalette,
        
        // Vector
        Vector2,
        
        // Timing
        Timer,
        Interval,
        FPSCounter,
        
        // Smoothing
        SmoothValue,
        SmoothVector,
        
        // Aspect ratio / cover crop
        computeCoverCrop,
        formatAspectRatio,

        // Canvas
        createOffscreenCanvas,
        clearCanvas,
        
        // DOM
        $,
        $$,
        addClass,
        removeClass,
        toggleClass,
        
        // Path
        simplifyPath,
        smoothPath
    };
})();

// Make available globally
window.Utils = Utils;


(() => {
  "use strict";

  const init = () => {
    initPageUI();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  function initPageUI() {
    if (document.querySelector(".ui-backdrop")) return;

    const backdrop = el("div", "ui-backdrop");
    backdrop.setAttribute("aria-hidden", "true");

    const shaderWrap = el("div", "ui-shader-wrap");
    const shaderCanvas = el("canvas", "ui-shader-canvas");
    shaderWrap.append(shaderCanvas);

    const gridWrap = el("div", "ui-grid-wrap");
    const gridCanvas = el("canvas", "ui-flow-field-canvas");
    gridWrap.append(gridCanvas);

    backdrop.append(shaderWrap, gridWrap);
    document.body.prepend(backdrop);

    let shaderCtrl = { refresh() {} };
    let cursorCtrl = { refresh() {} };
    let revealCtrl = { refresh() {} };

    const motionGate = createMotionGate(() => {
      shaderCtrl.refresh();
      cursorCtrl.refresh();
      revealCtrl.refresh();
    });

    shaderCtrl = mountPatternShader(shaderCanvas, motionGate.isFirstFrameOnly);
    mountFlowField(gridCanvas);
    cursorCtrl = mountBlendCursor(motionGate.isFirstFrameOnly);
    revealCtrl = mountEntranceReveals(motionGate.isFirstFrameOnly);
    mountScrollNav(motionGate.isFirstFrameOnly);
  }

  function createMotionGate(onChange) {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    let motionPref = mq.matches ? "reduce" : "no-preference";
    let fpsOk = null;
    let probeRaf = 0;
    let probeCleanup = null;

    const isFirstFrameOnly = () => motionPref !== "no-preference" || fpsOk === false;
    let lastFirstFrameOnly = isFirstFrameOnly();

    const notifyIfChanged = () => {
      const next = isFirstFrameOnly();
      if (next !== lastFirstFrameOnly) {
        lastFirstFrameOnly = next;
        onChange(next);
      }
    };

    const stopProbe = () => {
      if (probeCleanup) {
        probeCleanup();
        probeCleanup = null;
      }
      if (probeRaf) {
        cancelAnimationFrame(probeRaf);
        probeRaf = 0;
      }
    };

    const startProbe = () => {
      stopProbe();
      fpsOk = null;
      notifyIfChanged();
      if (motionPref !== "no-preference") return;

      let startTime = 0;
      let winStart = 0;
      let frameCount = 0;
      const samples = [];

      const reset = (now) => {
        startTime = now;
        winStart = 0;
        frameCount = 0;
        samples.length = 0;
      };

      const tick = (now) => {
        probeRaf = 0;
        if (!startTime) reset(now);
        const totalElapsed = now - startTime;

        if (totalElapsed >= 300) {
          if (winStart) {
            frameCount += 1;
            const winElapsed = now - winStart;
            if (winElapsed >= 300) {
              const fps = (1000 * Math.max(0, frameCount - 1)) / winElapsed;
              samples.push(fps);
              if (samples.length > 3) samples.shift();
              if (samples.length === 3) {
                const minFps = Math.min(...samples);
                const maxFps = Math.max(...samples);
                const jitter = maxFps > 0 ? (maxFps - minFps) / maxFps : 1;
                if (minFps >= 24 && jitter <= 0.25) {
                  stopProbe();
                  fpsOk = true;
                  notifyIfChanged();
                  return;
                }
              }
              winStart = now;
              frameCount = 1;
            }
          } else {
            winStart = now;
            frameCount = 1;
          }
        }

        if (totalElapsed >= 3000) {
          stopProbe();
          fpsOk = false;
          notifyIfChanged();
          return;
        }

        probeRaf = requestAnimationFrame(tick);
      };

      const onVisibility = () => {
        if (probeRaf) cancelAnimationFrame(probeRaf);
        probeRaf = 0;
        if (!document.hidden) {
          reset(performance.now());
          probeRaf = requestAnimationFrame(tick);
        }
      };

      if (!document.hidden) {
        probeRaf = requestAnimationFrame(tick);
      }
      document.addEventListener("visibilitychange", onVisibility);
      probeCleanup = () => {
        document.removeEventListener("visibilitychange", onVisibility);
      };
    };

    const onMQChange = () => {
      motionPref = mq.matches ? "reduce" : "no-preference";
      fpsOk = null;
      if (motionPref === "no-preference") {
        startProbe();
      } else {
        stopProbe();
        notifyIfChanged();
      }
    };

    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onMQChange);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(onMQChange);
    }

    if (motionPref === "no-preference") {
      startProbe();
    }

    return {
      isFirstFrameOnly,
      dispose() {
        stopProbe();
        if (typeof mq.removeEventListener === "function") {
          mq.removeEventListener("change", onMQChange);
        } else if (typeof mq.removeListener === "function") {
          mq.removeListener(onMQChange);
        }
      },
    };
  }

  function mountEntranceReveals(isFirstFrameOnly) {
    if (isFirstFrameOnly() || typeof Element.prototype.animate !== "function") {
      return { refresh() {} };
    }

    const EASE = "cubic-bezier(0.44, 0, 0.56, 1)";
    const activeAnims = new Set();
    let footerObs = null;
    let footerReset = null;

    const runReveal = (node, duration, delay = 0) => {
      const anim = node.animate(
        [
          { opacity: 0, transform: "translateY(40px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        {
          duration,
          delay,
          easing: EASE,
          fill: "backwards",
        }
      );
      activeAnims.add(anim);
      const cleanup = () => activeAnims.delete(anim);
      anim.addEventListener("finish", cleanup, { once: true });
      anim.addEventListener("cancel", cleanup, { once: true });
    };

    const hasCssAnimation = (node) => {
      const style = getComputedStyle(node);
      return style.animationName && style.animationName !== "none";
    };

    const profileInfo = document.querySelector(".profile-info");
    if (profileInfo && !hasCssAnimation(profileInfo)) {
      const style = getComputedStyle(profileInfo);
      const isVerticalStack =
        style.display !== "flex" || style.flexDirection.startsWith("column");
      const children = Array.from(profileInfo.children).filter(
        (c) => !hasCssAnimation(c) && getComputedStyle(c).position !== "fixed"
      );

      if (isVerticalStack && children.length >= 2) {
        children.forEach((child, idx) => {
          runReveal(child, 1000, idx === 0 ? 0 : 100);
        });
      } else {
        runReveal(profileInfo, 1000, 0);
      }
    }

    const footer = document.querySelector("footer");
    if (footer && !hasCssAnimation(footer)) {
      const rect = footer.getBoundingClientRect();
      if (rect.top < window.innerHeight || typeof IntersectionObserver === "undefined") {
        runReveal(footer, 600, 0);
      } else {
        footer.style.opacity = "0";
        footer.style.transform = "translateY(40px)";
        footerReset = () => {
          footer.style.opacity = "";
          footer.style.transform = "";
        };

        footerObs = new IntersectionObserver(
          ([entry]) => {
            if (!entry.isIntersecting) return;
            footerObs.disconnect();
            footerObs = null;
            if (footerReset) {
              footerReset();
              footerReset = null;
            }
            if (!isFirstFrameOnly()) {
              runReveal(footer, 600, 0);
            }
          },
          { threshold: 0 }
        );
        footerObs.observe(footer);
      }
    }

    return {
      refresh() {
        if (!isFirstFrameOnly()) return;
        for (const anim of activeAnims) anim.cancel();
        activeAnims.clear();
        if (footerObs) {
          footerObs.disconnect();
          footerObs = null;
        }
        if (footerReset) {
          footerReset();
          footerReset = null;
        }
      },
    };
  }

  function mountScrollNav(isFirstFrameOnly) {
    const nav = document.querySelector(".tab-nav, .ui-header-bar");
    if (!nav) return;

    const isHeaderBar = nav.classList.contains("ui-header-bar");
    const wideMQ = isHeaderBar ? window.matchMedia("(min-width: 1560px)") : null;
    let isScrolled = window.scrollY > 80;
    let isWide = wideMQ ? wideMQ.matches : false;

    let curMaxW = isScrolled ? (isWide ? 1180 : 980) : 1280;
    let curPadL = isScrolled ? 16 : 0;
    let curPadR = isScrolled ? 6 : 0;
    let velMaxW = 0;
    let velPadL = 0;
    let velPadR = 0;
    let raf = 0;
    let lastT = 0;

    const applyHeaderStyles = (mw, pl, pr) => {
      nav.style.maxWidth = `${mw}px`;
      nav.style.paddingLeft = `${pl}px`;
      nav.style.paddingRight = `${pr}px`;
    };

    const stepSpring = (now) => {
      raf = 0;
      const targetMaxW = isScrolled ? (isWide ? 1180 : 980) : 1280;
      const targetPadL = isScrolled ? 16 : 0;
      const targetPadR = isScrolled ? 6 : 0;

      const dt = lastT ? Math.min((now - lastT) / 1000, 0.05) : 1 / 60;
      lastT = now;

      const stiffness = 180;
      const damping = 28;
      const advance = (cur, vel, target) => {
        const accel = stiffness * (target - cur) - damping * vel;
        const nextVel = vel + accel * dt;
        const nextCur = cur + nextVel * dt;
        return [nextCur, nextVel];
      };

      [curMaxW, velMaxW] = advance(curMaxW, velMaxW, targetMaxW);
      [curPadL, velPadL] = advance(curPadL, velPadL, targetPadL);
      [curPadR, velPadR] = advance(curPadR, velPadR, targetPadR);

      const settled =
        Math.abs(targetMaxW - curMaxW) < 0.1 &&
        Math.abs(velMaxW) < 0.5 &&
        Math.abs(targetPadL - curPadL) < 0.05 &&
        Math.abs(velPadL) < 0.5 &&
        Math.abs(targetPadR - curPadR) < 0.05 &&
        Math.abs(velPadR) < 0.5;

      if (settled) {
        curMaxW = targetMaxW;
        curPadL = targetPadL;
        curPadR = targetPadR;
        velMaxW = 0;
        velPadL = 0;
        velPadR = 0;
        lastT = 0;
        applyHeaderStyles(curMaxW, curPadL, curPadR);
      } else {
        applyHeaderStyles(curMaxW, curPadL, curPadR);
        raf = requestAnimationFrame(stepSpring);
      }
    };

    const sync = (animate) => {
      const nextScrolled = window.scrollY > 80;
      const nextWide = wideMQ ? wideMQ.matches : false;
      const changed = nextScrolled !== isScrolled || nextWide !== isWide;
      isScrolled = nextScrolled;
      isWide = nextWide;
      nav.classList.toggle("is-scrolled", isScrolled);

      if (isHeaderBar) {
        if (!animate || isFirstFrameOnly()) {
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
          lastT = 0;
          curMaxW = isScrolled ? (isWide ? 1180 : 980) : 1280;
          curPadL = isScrolled ? 16 : 0;
          curPadR = isScrolled ? 6 : 0;
          velMaxW = 0;
          velPadL = 0;
          velPadR = 0;
          applyHeaderStyles(curMaxW, curPadL, curPadR);
        } else if (changed && !raf) {
          lastT = 0;
          raf = requestAnimationFrame(stepSpring);
        }
      }
    };

    sync(false);
    window.addEventListener("scroll", () => sync(true), { passive: true });
    window.addEventListener("pageshow", () => sync(false));
    if (wideMQ) {
      const onWide = () => sync(true);
      if (typeof wideMQ.addEventListener === "function") {
        wideMQ.addEventListener("change", onWide);
      } else if (typeof wideMQ.addListener === "function") {
        wideMQ.addListener(onWide);
      }
    }
  }

  function mountPatternShader(canvas, isFirstFrameOnly) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      canvas.style.display = "none";
      return { refresh() {} };
    }

    const vertSrc = `#version 300 es
in vec4 a_position;
void main() {
  gl_Position = a_position;
}
`;

    const fragSrc = `#version 300 es
precision mediump float;

uniform vec2 u_loop1, u_loop2, u_loop3, u_loop4;
uniform float u_pixelRatio;
uniform vec2 u_resolution;

uniform float u_scale;
uniform float u_rotation;
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform vec4 u_color3;
uniform vec4 u_color4;
uniform vec4 u_color5;
uniform vec4 u_color6;
uniform float u_colorCount;
uniform float u_grain;
uniform float u_proportion;
uniform float u_softness;
uniform float u_shape;
uniform float u_shapeScale;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_swirlIterations;
uniform vec2 u_offset;

out vec4 fragColor;

#define TWO_PI 6.28318530718
#define PI 3.14159265358979323846

vec2 rotate(vec2 uv, float th) {
  return mat2(cos(th), sin(th), -sin(th), cos(th)) * uv;
}

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
}

float noise(vec2 st) {
  vec2 i = floor(st);
  vec2 f = fract(st);
  float a = random(i);
  float b = random(i + vec2(1.0, 0.0));
  float c = random(i + vec2(0.0, 1.0));
  float d = random(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  float x1 = mix(a, b, u.x);
  float x2 = mix(c, d, u.x);
  return mix(x1, x2, u.y);
}

vec3 blend_multi(float mixer, float softness) {
  float edge = 1.0 - softness;
  vec3 col = u_color1.rgb;
  if (u_colorCount > 1.5) {
    float r1 = smoothstep(0.0 + 0.35 * edge, 0.7 - 0.35 * edge, mixer);
    col = mix(col, u_color2.rgb, r1);
  }
  if (u_colorCount > 2.5) {
    float r2 = smoothstep(0.3 + 0.35 * edge, 1.0 - 0.35 * edge, mixer);
    col = mix(col, u_color3.rgb, r2);
  }
  if (u_colorCount > 3.5) {
    col = mix(col, u_color4.rgb, smoothstep(0.4, 0.75, mixer));
  }
  if (u_colorCount > 4.5) {
    col = mix(col, u_color5.rgb, smoothstep(0.55, 0.85, mixer));
  }
  if (u_colorCount > 5.5) {
    col = mix(col, u_color6.rgb, smoothstep(0.7, 0.95, mixer));
  }
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;

  float noise_scale = .0005 + .006 * u_scale;

  uv -= .5;
  uv *= (noise_scale * u_resolution);
  uv = rotate(uv, u_rotation * .5 * PI);
  uv /= u_pixelRatio;
  uv += .5;
  uv += u_offset;

  float n1 = noise(uv + u_loop1);
  float n2 = noise(uv * 2. - u_loop2);
  float angle = n1 * TWO_PI;
  uv.x += 4. * u_distortion * n2 * cos(angle);
  uv.y += 4. * u_distortion * n2 * sin(angle);

  float iterations_number = ceil(clamp(u_swirlIterations, 1., 30.));
  for (float i = 1.; i <= 30.0; i++) {
    if (i > iterations_number) break;
    uv.x += clamp(u_swirl, 0., 2.) / i * (u_loop3.y * cos(i * 1.5 * uv.y) - u_loop3.x * sin(i * 1.5 * uv.y));
    uv.y += clamp(u_swirl, 0., 2.) / i * (u_loop3.y * cos(i * uv.x) - u_loop3.x * sin(i * uv.x));
  }

  float proportion = clamp(u_proportion, 0., 1.);

  float shape = 0.;
  float mixer = 0.;
  if (u_shape < .5) {
    vec2 checks_shape_uv = uv * (.5 + 3.5 * u_shapeScale);
    shape = .5 + .5 * sin(checks_shape_uv.x) * cos(checks_shape_uv.y);
    mixer = shape + .48 * sign(proportion - .5) * pow(abs(proportion - .5), .5);
  } else if (u_shape < 1.5) {
    vec2 stripes_shape_uv = uv * (.25 + 3. * u_shapeScale);
    float f = fract(stripes_shape_uv.y);
    shape = smoothstep(.0, .55, f) * smoothstep(1., .45, f);
    mixer = shape + .48 * sign(proportion - .5) * pow(abs(proportion - .5), .5);
  } else {
    float sh = 1. - uv.y;
    sh -= .5;
    sh /= (noise_scale * u_resolution.y);
    sh += .5;
    float shape_scaling = .2 * (1. - u_shapeScale);
    shape = smoothstep(.45 - shape_scaling, .55 + shape_scaling, sh + .3 * (proportion - .5));
    mixer = shape;
  }

  vec3 col = blend_multi(mixer, clamp(u_softness, 0., 1.));
  fragColor = vec4(col, 1.0);

  if (u_grain > 0.0) {
    float g = random(gl_FragCoord.xy + u_loop3 * 100.0);
    fragColor.rgb += (g - 0.5) * u_grain;
  }
}
`;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("Shader compile error:", gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) {
      canvas.style.display = "none";
      return { refresh() {} };
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      canvas.style.display = "none";
      return { refresh() {} };
    }

    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const u = (name) => gl.getUniformLocation(prog, name);
    const locs = {
      u_pixelRatio: u("u_pixelRatio"),
      u_resolution: u("u_resolution"),
      u_scale: u("u_scale"),
      u_offset: u("u_offset"),
      u_rotation: u("u_rotation"),
      u_color1: u("u_color1"),
      u_color2: u("u_color2"),
      u_color3: u("u_color3"),
      u_color4: u("u_color4"),
      u_color5: u("u_color5"),
      u_color6: u("u_color6"),
      u_colorCount: u("u_colorCount"),
      u_grain: u("u_grain"),
      u_proportion: u("u_proportion"),
      u_softness: u("u_softness"),
      u_shape: u("u_shape"),
      u_shapeScale: u("u_shapeScale"),
      u_distortion: u("u_distortion"),
      u_swirl: u("u_swirl"),
      u_swirlIterations: u("u_swirlIterations"),
    };

    const TWO_PI = Math.PI * 2;
    const loops = [420, 460, 90].map((period, idx) => ({
      period,
      loc: u(`u_loop${idx + 1}`),
      elapsed: 0,
      radius: (0.07 * period) / TWO_PI,
    }));

    const hexToRgb = (hex) => {
      const h = hex.replace("#", "");
      return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
      ];
    };

    const c1 = hexToRgb("#8AA3D6");
    const c2 = hexToRgb("#FFFFFF");
    const c3 = hexToRgb("#FFFFFF");
    const speed = 14;
    let deviceDpr = window.devicePixelRatio || 1;

    const renderFrame = (dt = 0) => {
      if (!canvas.width || !canvas.height) return;
      gl.uniform1f(locs.u_scale, 0.5);
      gl.uniform2f(locs.u_offset, 0, 65 / 100);
      gl.uniform1f(locs.u_rotation, -5 / 90);
      gl.uniform4f(locs.u_color1, c1[0], c1[1], c1[2], 1);
      gl.uniform4f(locs.u_color2, c2[0], c2[1], c2[2], 1);
      gl.uniform4f(locs.u_color3, c3[0], c3[1], c3[2], 1);
      gl.uniform4f(locs.u_color4, 0, 0, 0, 1);
      gl.uniform4f(locs.u_color5, 0, 0, 0, 1);
      gl.uniform4f(locs.u_color6, 0, 0, 0, 1);
      gl.uniform1f(locs.u_colorCount, 3);
      gl.uniform1f(locs.u_grain, 0);
      gl.uniform1f(locs.u_proportion, 50 / 100);
      gl.uniform1f(locs.u_softness, 100 / 100);
      gl.uniform1f(locs.u_shape, 0);
      gl.uniform1f(locs.u_shapeScale, 10 / 100);
      gl.uniform1f(locs.u_distortion, 20 / 100);
      gl.uniform1f(locs.u_swirl, 12 / 50);
      gl.uniform1f(locs.u_swirlIterations, 8);

      const step = 0.001 * dt * (speed / 14);
      loops.forEach((l, idx) => {
        l.elapsed = (((l.elapsed + step) % l.period) + l.period) % l.period;
        const a = (l.elapsed / l.period) * TWO_PI;
        const s = Math.sin(a);
        const c = Math.cos(a);
        if (idx === 2) {
          gl.uniform2f(l.loc, s, c);
        } else {
          gl.uniform2f(l.loc, l.radius * (s + c - 1), l.radius * (s + 1 - c));
        }
      });

      gl.uniform1f(locs.u_pixelRatio, deviceDpr);
      gl.uniform2f(locs.u_resolution, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    const FRAME_MS = 1000 / 30;
    let raf = 0;
    let inView = true;
    let lastTick = 0;
    let prevTime = null;

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      lastTick = 0;
      prevTime = null;
    };

    const schedule = () => {
      if (isFirstFrameOnly() || raf || !inView || document.hidden) return;
      raf = requestAnimationFrame(tick);
    };

    const tick = (now) => {
      raf = 0;
      if (isFirstFrameOnly() || !inView || document.hidden) return;
      const elapsed = now - lastTick;
      if (lastTick && elapsed < FRAME_MS) {
        schedule();
        return;
      }
      lastTick = lastTick ? now - (elapsed % FRAME_MS) : now;
      const dt = prevTime === null ? 0 : Math.min(Math.max(0, now - prevTime), 100);
      prevTime = now;
      renderFrame(dt);
      schedule();
    };

    let snapshotImg = null;
    const onPageShow = () => {
      if (snapshotImg) snapshotImg.remove();
      if (!isFirstFrameOnly() && inView && !document.hidden) schedule();
    };
    const onPageHide = () => {
      try {
        const parent = canvas.parentElement;
        if (!parent) return;
        renderFrame(0);
        if (!snapshotImg) snapshotImg = document.createElement("img");
        snapshotImg.src = canvas.toDataURL("image/png");
        snapshotImg.alt = "";
        snapshotImg.setAttribute("aria-hidden", "true");
        snapshotImg.style.position = "absolute";
        snapshotImg.style.inset = "0";
        snapshotImg.style.width = "100%";
        snapshotImg.style.height = "100%";
        snapshotImg.style.objectFit = "cover";
        snapshotImg.style.pointerEvents = "none";
        snapshotImg.style.zIndex = "1";
        if (snapshotImg.parentElement !== parent) {
          parent.appendChild(snapshotImg);
        }
      } catch (_) {}
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    observeResize(canvas, { maxDpr: 1.5 }, (info) => {
      deviceDpr = info.deviceDpr;
      canvas.width = info.pixelWidth;
      canvas.height = info.pixelHeight;
      gl.viewport(0, 0, info.pixelWidth, info.pixelHeight);
      renderFrame(0);
      if (!isFirstFrameOnly()) schedule();
    });

    if (typeof IntersectionObserver !== "undefined") {
      new IntersectionObserver(
        ([entry]) => {
          inView = entry.isIntersecting;
          if (inView && !document.hidden) schedule();
          else stop();
        },
        { threshold: 0 }
      ).observe(canvas);
    }

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && inView) schedule();
      else stop();
    });

    return {
      refresh() {
        if (isFirstFrameOnly()) {
          stop();
          renderFrame(0);
        } else {
          schedule();
        }
      },
    };
  }

  function mountFlowField(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const color = "60, 100, 160";
    const spacing = 90;
    const lineOpacity = 0.1;
    const dotOpacity = 0.04;
    let lastInfo = null;

    const draw = (w, h) => {
      if (!finePointer.matches) {
        ctx.clearRect(0, 0, w, h);
        return;
      }

      const cols = Math.ceil(w / spacing) + 1;
      const rows = Math.ceil(h / spacing) + 1;
      const ox = (w - (cols - 1) * spacing) / 2;
      const oy = (h - (rows - 1) * spacing) / 2;
      const pts = [];

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          pts.push({ x: ox + c * spacing, y: oy + r * spacing });
        }
      }

      const segment = (a, b) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len <= 20) return;
        const gx = (dx / len) * 10;
        const gy = (dy / len) * 10;
        ctx.beginPath();
        ctx.moveTo(a.x + gx, a.y + gy);
        ctx.lineTo(b.x - gx, b.y - gy);
        ctx.stroke();
      };

      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = `rgba(${color}, ${lineOpacity})`;
      ctx.lineWidth = 0.5;

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols - 1; c += 1) {
          segment(pts[r * cols + c], pts[r * cols + c + 1]);
        }
      }
      for (let c = 0; c < cols; c += 1) {
        for (let r = 0; r < rows - 1; r += 1) {
          segment(pts[r * cols + c], pts[(r + 1) * cols + c]);
        }
      }

      ctx.fillStyle = `rgba(${color}, ${dotOpacity})`;
      for (const p of pts) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    observeResize(canvas, { maxDpr: 2 }, (info) => {
      lastInfo = info;
      canvas.width = info.pixelWidth;
      canvas.height = info.pixelHeight;
      ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0);
      draw(info.cssWidth, info.cssHeight);
    });

    const onPointerChange = () => {
      if (lastInfo) draw(lastInfo.cssWidth, lastInfo.cssHeight);
    };
    if (typeof finePointer.addEventListener === "function") {
      finePointer.addEventListener("change", onPointerChange);
    } else if (typeof finePointer.addListener === "function") {
      finePointer.addListener(onPointerChange);
    }
  }

  function mountBlendCursor(isFirstFrameOnly) {
    const title = document.querySelector(".profile-info h1");
    const hasExplicitBlendChild = Boolean(title && title.querySelector('[data-cursor="blend"]'));
    if (title && !title.closest('[data-cursor="blend"]') && !hasExplicitBlendChild) {
      title.dataset.cursor = "blend";
    }

    const regions = Array.from(document.querySelectorAll(".ui-cursor-region"));
    if (regions.length === 0) {
      if (title) {
        regions.push(title);
      } else {
        const blendEl = document.querySelector('[data-cursor="blend"]');
        if (blendEl) regions.push(blendEl);
      }
    }
    if (regions.length === 0) return { refresh() {} };

    const textRange = document.createRange();
    const isBlendTarget = (node, x, y) => {
      if (!(node instanceof Element)) return false;
      const explicit = node.closest('[data-cursor="blend"]');
      if (!explicit) return false;
      if (explicit !== title || hasExplicitBlendChild) return true;
      if (typeof x !== "number" || typeof y !== "number" || !title.isConnected) return false;
      try {
        textRange.selectNodeContents(title);
        const rects = textRange.getClientRects();
        for (let i = 0; i < rects.length; i += 1) {
          const r = rects[i];
          if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            return true;
          }
        }
      } catch (_) {
        return true;
      }
      return false;
    };

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let activated = false;
    let teardownActive = null;

    const mountActive = (pending) => {
      if (activated || isFirstFrameOnly() || !finePointer.matches) return;
      activated = true;

      const canvas = el("canvas", "ui-cursor-canvas");
      canvas.setAttribute("aria-hidden", "true");
      document.body.append(canvas);

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        canvas.remove();
        activated = false;
        return;
      }

      let tx = pending ? pending.clientX : 0;
      let ty = pending ? pending.clientY : 0;
      let cx = tx;
      let cy = ty;
      let alpha = 0;
      let scale = 0.5;
      let targetAlpha = 0;
      let raf = 0;
      let prevX = 0;
      let prevY = 0;
      let prevR = 0;

      const clearPrev = () => {
        if (prevR) {
          ctx.clearRect(prevX - prevR - 2, prevY - prevR - 2, (prevR + 2) * 2, (prevR + 2) * 2);
        }
      };

      const draw = () => {
        raf = 0;
        if (isFirstFrameOnly() || document.hidden) return;

        const dx = tx - cx;
        const dy = ty - cy;
        const ease = Math.sqrt(dx * dx + dy * dy) < 50 ? 0.7 : 0.4;
        cx += dx * ease;
        cy += dy * ease;
        alpha += (targetAlpha - alpha) * 0.24;
        scale += ((targetAlpha ? 1 : 0.5) - scale) * 0.24;

        clearPrev();
        const r = 32 * scale;
        if (alpha > 0.002) {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          prevX = cx;
          prevY = cy;
          prevR = r;
        } else {
          prevR = 0;
        }

        const doneAlpha = Math.abs(targetAlpha - alpha) <= 0.002;
        const doneScale = Math.abs((targetAlpha ? 1 : 0.5) - scale) <= 0.002;
        if (Math.abs(dx) + Math.abs(dy) <= 0.1 && doneAlpha && doneScale) {
          cx = tx;
          cy = ty;
          alpha = targetAlpha;
          scale = targetAlpha ? 1 : 0.5;
        } else {
          raf = requestAnimationFrame(draw);
        }
      };

      const start = () => {
        if (!raf && !document.hidden && !isFirstFrameOnly()) {
          raf = requestAnimationFrame(draw);
        }
      };

      const onMoveOrOver = (e) => {
        if (!isBlendTarget(e.target, e.clientX, e.clientY)) {
          targetAlpha = 0;
          if (alpha > 0.002 || prevR) start();
          return;
        }
        tx = e.clientX;
        ty = e.clientY;
        if (alpha <= 0.002 && !prevR) {
          cx = tx;
          cy = ty;
        }
        targetAlpha = 1;
        start();
      };

      const onLeave = () => {
        targetAlpha = 0;
        if (alpha > 0.002 || prevR) start();
      };

      const onVisibility = () => {
        if (document.hidden) {
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
        } else if (targetAlpha > 0 || alpha > 0.002) {
          start();
        }
      };

      const resizeCtrl = observeResize(canvas, { maxDpr: 2, viewport: true }, (info) => {
        canvas.width = info.pixelWidth;
        canvas.height = info.pixelHeight;
        ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0);
        alpha = 0;
        targetAlpha = 0;
        prevR = 0;
      });

      for (const region of regions) {
        region.addEventListener("pointermove", onMoveOrOver, { passive: true });
        region.addEventListener("pointerover", onMoveOrOver, { passive: true });
        region.addEventListener("pointerleave", onLeave, { passive: true });
      }
      window.addEventListener("scroll", onLeave, { passive: true });
      document.addEventListener("visibilitychange", onVisibility);

      if (pending && pending.blend) {
        targetAlpha = 1;
        start();
      }

      teardownActive = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        for (const region of regions) {
          region.removeEventListener("pointermove", onMoveOrOver);
          region.removeEventListener("pointerover", onMoveOrOver);
          region.removeEventListener("pointerleave", onLeave);
        }
        window.removeEventListener("scroll", onLeave);
        document.removeEventListener("visibilitychange", onVisibility);
        resizeCtrl.dispose();
        clearPrev();
        canvas.remove();
        activated = false;
        teardownActive = null;
      };
    };

    const onLazyPointerMove = (e) => {
      if (activated || isFirstFrameOnly() || !finePointer.matches) return;
      mountActive({
        clientX: e.clientX,
        clientY: e.clientY,
        blend: isBlendTarget(e.target, e.clientX, e.clientY),
      });
    };

    for (const region of regions) {
      region.addEventListener("pointermove", onLazyPointerMove, { passive: true });
    }

    const syncPointerCap = () => {
      if (teardownActive && (!finePointer.matches || isFirstFrameOnly())) {
        teardownActive();
      }
    };
    if (typeof finePointer.addEventListener === "function") {
      finePointer.addEventListener("change", syncPointerCap);
    } else if (typeof finePointer.addListener === "function") {
      finePointer.addListener(syncPointerCap);
    }

    return {
      refresh() {
        syncPointerCap();
      },
    };
  }

  function observeResize(target, options, onResize) {
    const maxDpr = typeof options === "number" ? options : options.maxDpr;
    const viewport = typeof options === "object" && !!options.viewport;

    let disposed = false;
    let raf = 0;
    let timer = 0;
    let queued = null;
    let applied = null;
    let dppxMQ = null;

    const sameInfo = (a, b) =>
      a !== null &&
      a.cssWidth === b.cssWidth &&
      a.cssHeight === b.cssHeight &&
      a.pixelWidth === b.pixelWidth &&
      a.pixelHeight === b.pixelHeight &&
      a.dpr === b.dpr &&
      a.deviceDpr === b.deviceDpr;

    const measure = () => {
      const deviceDpr = window.devicePixelRatio || 1;
      const dpr = Math.min(deviceDpr, maxDpr);
      if (viewport) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        if (w <= 0 || h <= 0) return null;
        return {
          cssWidth: w,
          cssHeight: h,
          pixelWidth: Math.max(1, Math.round(w * dpr)),
          pixelHeight: Math.max(1, Math.round(h * dpr)),
          dpr,
          deviceDpr,
        };
      }
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        pixelWidth: Math.max(1, Math.round(rect.width * dpr)),
        pixelHeight: Math.max(1, Math.round(rect.height * dpr)),
        dpr,
        deviceDpr,
      };
    };

    const commit = () => {
      timer = 0;
      if (!queued || sameInfo(applied, queued)) return;
      applied = queued;
      onResize(queued);
    };

    const flush = () => {
      raf = 0;
      if (disposed) return;
      const next = measure();
      if (!next || sameInfo(queued, next)) return;
      queued = next;
      if (applied) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(commit, 100);
      } else {
        if (timer) clearTimeout(timer);
        commit();
      }
    };

    const schedule = () => {
      if (!disposed && !raf) {
        raf = requestAnimationFrame(flush);
      }
    };

    const unlistenDppx = (mq) => {
      if (!mq) return;
      if (typeof mq.removeEventListener === "function") {
        mq.removeEventListener("change", onDppxChange);
      } else if (typeof mq.removeListener === "function") {
        mq.removeListener(onDppxChange);
      }
    };

    const listenDppx = (mq) => {
      if (typeof mq.addEventListener === "function") {
        mq.addEventListener("change", onDppxChange, { once: true });
      } else if (typeof mq.addListener === "function") {
        mq.addListener(onDppxChange);
      }
    };

    const refreshDppx = () => {
      unlistenDppx(dppxMQ);
      dppxMQ = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      listenDppx(dppxMQ);
    };

    function onDppxChange() {
      refreshDppx();
      schedule();
    }

    const ro = !viewport && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (ro) {
      ro.observe(target);
    } else {
      window.addEventListener("resize", schedule, { passive: true });
      window.addEventListener("orientationchange", schedule, { passive: true });
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", schedule, { passive: true });
      }
      if (!viewport && document.fonts && document.fonts.ready) {
        document.fonts.ready.then(schedule);
      }
    }

    refreshDppx();
    flush();

    return {
      dispose() {
        disposed = true;
        if (raf) cancelAnimationFrame(raf);
        if (timer) clearTimeout(timer);
        if (ro) {
          ro.disconnect();
        } else {
          window.removeEventListener("resize", schedule);
          window.removeEventListener("orientationchange", schedule);
          if (window.visualViewport) {
            window.visualViewport.removeEventListener("resize", schedule);
          }
        }
        unlistenDppx(dppxMQ);
      },
    };
  }

  function el(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const c of children) if (c != null && c !== false) node.append(c);
    return node;
  }
})();
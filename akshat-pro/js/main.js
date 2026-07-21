/* ============================================================
   PORTFOLIO — main.js
   Stack: GSAP (local) + ScrollTrigger + SplitText + Lenis CDN
============================================================ */

gsap.registerPlugin(ScrollTrigger, SplitText);

/* ============================================================
   LENIS — smooth scroll
============================================================ */
const lenis = new Lenis({
  duration: 1.35,
  easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  smooth: true,
  smoothTouch: false,
});

// Wire Lenis to GSAP ticker for ScrollTrigger sync
lenis.on('scroll', ScrollTrigger.update);

gsap.ticker.add(time => lenis.raf(time * 1000));
gsap.ticker.lagSmoothing(0);

/* ============================================================
   CUSTOM CURSOR
============================================================ */
const cursor    = document.getElementById('cursor');
const cursorDot = document.getElementById('cursorDot');

let mx = 0, my = 0, cx = 0, cy = 0;

document.addEventListener('mousemove', e => {
  if (window.innerWidth <= 768) return;
  mx = e.clientX;
  my = e.clientY;
  // Dot follows instantly
  gsap.set(cursorDot, { x: mx, y: my });
});

// Smooth lag on outer ring
;(function trackCursor() {
  if (window.innerWidth > 768) {
    cx += (mx - cx) * 0.11;
    cy += (my - cy) * 0.11;
    gsap.set(cursor, { x: cx, y: cy });
  }
  requestAnimationFrame(trackCursor);
})();

// Cursor states
document.querySelectorAll('a, button, .slice, [data-tilt], .project-card').forEach(el => {
  el.addEventListener('mouseenter', () => document.body.classList.add('hovered'));
  el.addEventListener('mouseleave', () => document.body.classList.remove('hovered'));
});

document.querySelectorAll('.slice').forEach(el => {
  el.addEventListener('mouseenter', () => document.body.classList.add('link-hovered'));
  el.addEventListener('mouseleave', () => document.body.classList.remove('link-hovered'));
});

/* ============================================================
   NAV  — scroll state
============================================================ */
ScrollTrigger.create({
  start: 'top -60px',
  onUpdate: self => {
    document.getElementById('nav').classList.toggle('scrolled', self.scroll() > 60);
  }
});

/* ============================================================
   MOBILE MENU
============================================================ */
const burger = document.getElementById('navBurger');
const mobileMenu = document.getElementById('mobileMenu');
let menuOpen = false;

function toggleMenu() {
  menuOpen = !menuOpen;
  mobileMenu.classList.toggle('open', menuOpen);
  burger.setAttribute('aria-expanded', menuOpen);
  mobileMenu.setAttribute('aria-hidden', !menuOpen);
  document.body.style.overflow = menuOpen ? 'hidden' : '';
}

burger.addEventListener('click', toggleMenu);
document.querySelectorAll('.mob-link').forEach(l => l.addEventListener('click', () => {
  if (menuOpen) toggleMenu();
}));

/* ============================================================
   HERO — entry animation
============================================================ */
function initHero() {
  const name = document.getElementById('heroName');
  const tl = gsap.timeline({ delay: 0.25 });

  tl
    .to(name, {
        opacity: 1,
        y: 0,
        duration: 1.1,
        ease: 'power4.out',
      }, 0)
    .to('#heroEyebrow', {
        opacity: 1,
        y: 0,
        duration: 0.7,
        ease: 'power3.out',
      }, 0.2)
    .to('#heroCycling', {
        opacity: 1,
        y: 0,
        duration: 0.65,
        ease: 'power3.out',
      }, 0.75)
    .to('#heroRole', {
        opacity: 1,
        y: 0,
        duration: 0.55,
        ease: 'power3.out',
      }, 0.9)
    .to('#heroActions', {
        opacity: 1,
        y: 0,
        duration: 0.55,
        ease: 'power3.out',
      }, 1.05)
    .to(['#heroScroll', '#heroBadge'], {
        opacity: 1,
        duration: 0.5,
        stagger: 0.08,
      }, 1.2);
}

/* ============================================================
   CYCLING ANIMATED WORD  (GSAP equivalent of the React component)
   Cycles through words like the 21st.dev animated-hero component
============================================================ */
function initCyclingText() {
  const words = ['developer', 'builder', 'founder', 'creator', 'automator'];
  const el    = document.getElementById('cyclingWord');
  if (!el) return;

  let current = 0;

  function cycle() {
    const next = (current + 1) % words.length;

    // Exit: slide up and fade out
    gsap.to(el, {
      yPercent: -110,
      opacity: 0,
      duration: 0.45,
      ease: 'power2.in',
      onComplete() {
        el.textContent = words[next];
        // Enter: slide up from below
        gsap.fromTo(el,
          { yPercent: 110, opacity: 0 },
          {
            yPercent: 0,
            opacity: 1,
            duration: 0.5,
            ease: 'power3.out',
          }
        );
        current = next;
      }
    });
  }

  // Start cycling after hero animation completes
  setTimeout(() => {
    setInterval(cycle, 2200);
  }, 2200);
}

/* ============================================================
   HERO — parallax on scroll
============================================================ */
function initHeroParallax() {
  // Photo drifts upward slowly (parallax depth)
  gsap.to('.hero-photo', {
    yPercent: 18,
    ease: 'none',
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: 'bottom top',
      scrub: true,
    }
  });

  // Glow orb drifts upward slower
  gsap.to('.hero-glow', {
    yPercent: -20,
    ease: 'none',
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: 'bottom top',
      scrub: 1.8,
    }
  });

  // Text content fades + rises as user scrolls away
  gsap.to('.hero-content', {
    yPercent: 12,
    opacity: 0,
    ease: 'none',
    scrollTrigger: {
      trigger: '.hero',
      start: 'top top',
      end: '55% top',
      scrub: 1,
    }
  });
}

/* ============================================================
   TICKER — continuous marquee
============================================================ */
function initTicker() {
  const rail  = document.getElementById('tickerRail');
  const clone = document.querySelector('.ticker-rail--clone');
  const w     = rail.getBoundingClientRect().width;

  // Position clone right after original
  gsap.set(clone, { x: w });

  const dur = w / 80; // pixels per second ~ 80

  gsap.to(rail,  { x: -w, duration: dur, ease: 'none', repeat: -1 });
  gsap.to(clone, { x: 0,  duration: dur, ease: 'none', repeat: -1 });
}

/* ============================================================
   ABOUT — manifesto poem lines
============================================================ */
function initManifesto() {
  const lines = document.querySelectorAll('.poem-line');

  gsap.fromTo(lines,
    { opacity: 0, x: -28 },
    {
      opacity: 1,
      x: 0,
      duration: 0.85,
      stagger: 0.07,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: '#manifestoPoem',
        start: 'top 75%',
        once: true,
      }
    }
  );
}

/* ============================================================
   MASK REVEAL — cursor spotlight effect
   Technique: CSS mask-image with radial-gradient follows cursor.
   The reveal layer is masked — only visible where cursor is.
============================================================ */
function initMaskReveal() {
  const host   = document.getElementById('maskHost');
  const reveal = document.getElementById('maskReveal');
  if (!host || !reveal) return;

  let tX = -300, tY = -300;   // target
  let cX = -300, cY = -300;   // current (lerped)
  let raf;

  host.addEventListener('mousemove', e => {
    if (window.innerWidth <= 768) return;
    const r = host.getBoundingClientRect();
    tX = e.clientX - r.left;
    tY = e.clientY - r.top;
  });

  host.addEventListener('mouseleave', () => {
    tX = -300;
    tY = -300;
  });

  function lerp(a, b, t) { return a + (b - a) * t; }

  function loop() {
    cX = lerp(cX, tX, 0.075);
    cY = lerp(cY, tY, 0.075);
    reveal.style.setProperty('--mx', `${cX}px`);
    reveal.style.setProperty('--my', `${cY}px`);
    raf = requestAnimationFrame(loop);
  }

  loop();
}

/* ============================================================
   STATS — count-up on enter
============================================================ */
function initStats() {
  document.querySelectorAll('.stat-num').forEach(el => {
    const raw    = el.getAttribute('data-target');
    const target = parseInt(raw, 10);
    const suffix = el.textContent.includes('+') ? '+' : '';

    ScrollTrigger.create({
      trigger: el,
      start: 'top 85%',
      once: true,
      onEnter() {
        gsap.fromTo(
          { val: 0 },
          { val: target },
          {
            duration: 1.6,
            ease: 'power2.out',
            onUpdate() {
              el.textContent = Math.round(this.targets()[0].val) + suffix;
            },
          }
        );
      },
    });
  });
}

/* ============================================================
   ABOUT section — scroll reveal
============================================================ */
function initAboutReveal() {
  gsap.fromTo('.about-photo-wrap',
    { opacity: 0, x: 40 },
    {
      opacity: 1, x: 0,
      duration: 0.9,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.about-right', start: 'top 78%', once: true }
    }
  );
}

/* ============================================================
   PROJECTS — Premium Horizontal Accordion  (GSAP-powered)
============================================================ */
function initWork() {
  /* ── Title SplitText entrance ── */
  const titleEl = document.getElementById('workTitle');
  if (titleEl) {
    const split = new SplitText(titleEl, { type: 'chars' });
    gsap.fromTo(split.chars,
      { yPercent: 115, opacity: 0 },
      {
        yPercent: 0, opacity: 1,
        duration: 0.85,
        stagger: 0.025,
        ease: 'power4.out',
        scrollTrigger: {
          trigger: titleEl,
          start: 'top 85%',
          toggleActions: 'play none none none',
        }
      }
    );
  }

  /* ── Card grid staggered reveal ── */
  const cards = document.querySelectorAll('.project-card');
  const grid = document.getElementById('workGrid');
  if (!grid || cards.length === 0) return;

  gsap.fromTo(cards,
    { opacity: 0, y: 40, scale: 0.98 },
    {
      opacity: 1, y: 0, scale: 1,
      duration: 1.0,
      stagger: 0.08,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: grid,
        start: 'top 85%',
        once: true,
      }
    }
  );
}

/* ============================================================
   COMPONENT 1 — WebGL Shader (hero atmospheric glow)
============================================================ */
function initHeroShader() {
  const canvas = document.getElementById('heroShader');
  if (!canvas) return;
  const gl = canvas.getContext('webgl2');
  if (!gl) { canvas.style.display = 'none'; return; }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const resize = () => {
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const VS = `#version 300 es
precision highp float;
in vec4 position;
void main(){gl_Position=position;}`;

  const FS = `#version 300 es
precision highp float;
out vec4 O;
uniform vec2 resolution;
uniform float time;
#define FC gl_FragCoord.xy
#define T time
#define R resolution
#define MN min(R.x,R.y)
float rnd(vec2 p){p=fract(p*vec2(12.9898,78.233));p+=dot(p,p+34.56);return fract(p.x*p.y);}
float noise(in vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.-2.*f);float a=rnd(i),b=rnd(i+vec2(1,0)),c=rnd(i+vec2(0,1)),d=rnd(i+1.);return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}
float fbm(vec2 p){float t=.0,a=1.;mat2 m=mat2(1.,-.5,.2,1.2);for(int i=0;i<5;i++){t+=a*noise(p);p*=2.*m;a*=.5;}return t;}
float clouds(vec2 p){float d=1.,t=.0;for(float i=.0;i<3.;i++){float a=d*fbm(i*10.+p.x*.2+.2*(1.+i)*p.y+d+i*i+p);t=mix(t,d,a);d=a;p*=2./(i+1.);}return t;}
void main(void){
  vec2 uv=(FC-.5*R)/MN,st=uv*vec2(2,1);
  vec3 col=vec3(0);
  float bg=clouds(vec2(st.x+T*.5,-st.y));
  uv*=1.-.3*(sin(T*.2)*.5+.5);
  for(float i=1.;i<12.;i++){
    uv+=.1*cos(i*vec2(.1+.01*i,.8)+i*i+T*.5+.1*uv.x);
    vec2 p=uv;float d=length(p);
    col+=.00125/d*(cos(sin(i)*vec3(1,2,3))+1.);
    float b=noise(i+p+bg*1.731);
    col+=.002*b/length(max(p,vec2(b*p.x*.02,p.y)));
    col=mix(col,vec3(bg*.25,bg*.137,bg*.05),d);
  }
  O=vec4(col,1);
}`;

  const mkShader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };

  const prog = gl.createProgram();
  gl.attachShader(prog, mkShader(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, mkShader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,1,-1,-1,1,1,1,-1]), gl.STATIC_DRAW);

  const pos = gl.getAttribLocation(prog, 'position');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

  const uRes  = gl.getUniformLocation(prog, 'resolution');
  const uTime = gl.getUniformLocation(prog, 'time');

  resize();
  window.addEventListener('resize', resize);

  (function loop(t) {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, t * 0.001);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(loop);
  }(0));
}

/* ============================================================
   COMPONENT 3 — Limelight Nav (spotlight underline)
============================================================ */
function initLimelightNav() {
  const limelight = document.getElementById('navLimelight');
  const nav       = document.getElementById('nav');
  const links     = [...document.querySelectorAll('.nav-links a[data-nav]')];
  if (!limelight || !nav || !links.length) return;

  let ready = false;

  function moveTo(link) {
    if (!link) return;
    const navRect  = nav.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    const left = linkRect.left - navRect.left + linkRect.width / 2 - limelight.offsetWidth / 2;
    limelight.style.left    = `${left}px`;
    limelight.style.opacity = '1';
    if (!ready) { limelight.style.transition = 'none'; ready = true; setTimeout(() => { limelight.style.transition = ''; }, 50); }
  }

  /* Hover: follow mouse */
  links.forEach(l => l.addEventListener('mouseenter', () => moveTo(l)));

  /* Scroll: track active section */
  const sectionIds = links.map(l => l.dataset.nav);
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const link = links.find(l => l.dataset.nav === entry.target.id);
        if (link) moveTo(link);
      }
    });
  }, { threshold: 0.35 });

  sectionIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });

  /* Init on first matching section */
  setTimeout(() => moveTo(links[0]), 100);
}


/* ============================================================
   STACK — skill rings + stat cards + contact paths
============================================================ */
function initStack() {
  /* Skill ring animations on scroll */
  const CIRC = 251.33;
  const nodes = document.querySelectorAll('.skill-node');

  if (nodes.length) {
    ScrollTrigger.create({
      trigger: '.skill-orbit-grid',
      start: 'top 80%',
      once: true,
      onEnter() {
        nodes.forEach((node, i) => {
          const pct   = parseFloat(node.dataset.pct) || 0;
          const fill  = node.querySelector('.s-fill');
          const target = CIRC * (1 - pct / 100);

          gsap.to(fill, {
            strokeDashoffset: target,
            duration: 1.4,
            delay: i * 0.12,
            ease: 'power3.out',
          });

          gsap.fromTo(node,
            { opacity: 0, y: 24 },
            { opacity: 1, y: 0, duration: 0.75, delay: i * 0.1, ease: 'power3.out' }
          );
        });
      }
    });
  }

  /* LeetCode ring */
  const lcFill = document.querySelector('.lc-ring-fill');
  if (lcFill) {
    ScrollTrigger.create({
      trigger: '.stat-card--lc',
      start: 'top 82%',
      once: true,
      onEnter() {
        gsap.to(lcFill, { strokeDashoffset: 139, duration: 1.2, ease: 'power3.out' });
      }
    });
  }

  /* LeetCode bar fills */
  document.querySelectorAll('.lc-bar-fill').forEach(bar => {
    const w = parseFloat(bar.dataset.w) || 0;
    ScrollTrigger.create({
      trigger: bar,
      start: 'top 88%',
      once: true,
      onEnter() {
        gsap.to(bar, { width: `${Math.max(w, 0.5)}%`, duration: 1.2, ease: 'power3.out' });
      }
    });
  });

  /* Stat cards entrance */
  gsap.fromTo('.stat-card',
    { opacity: 0, x: 32 },
    {
      opacity: 1, x: 0,
      duration: 0.85,
      stagger: 0.12,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.stack-stats', start: 'top 80%', once: true }
    }
  );
}


/* ============================================================
   PROCESS — staggered reveal
============================================================ */
function initProcess() {
  document.querySelectorAll('.step').forEach((step, i) => {
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: step,
        start: 'top 82%',
        once: true,
      }
    });

    tl.fromTo(step.querySelector('.step-n'),
        { opacity: 0, scale: 1.6 },
        { opacity: 1, scale: 1, duration: 0.7, ease: 'power3.out' }
      )
      .fromTo(step.querySelector('h3'),
        { opacity: 0, y: 18 },
        { opacity: 1, y: 0,  duration: 0.55, ease: 'power3.out' },
        '-=0.35'
      )
      .fromTo(step.querySelector('p'),
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0,  duration: 0.5, ease: 'power3.out' },
        '-=0.25'
      );
  });
}

/* ============================================================
   TESTIMONIALS — CSS marquee (play-state toggled on hover)
============================================================ */
function initMarquee() {
  const row = document.getElementById('marqueeRow');
  if (!row) return;
  row.addEventListener('mouseenter', () => { row.style.animationPlayState = 'paused'; });
  row.addEventListener('mouseleave', () => { row.style.animationPlayState = 'running'; });
}



/* ============================================================
   FAQ — pure CSS max-height, no GSAP
============================================================ */
function initFAQ() {
  const items = document.querySelectorAll('.faq-item');
  if (!items.length) return;

  items.forEach(item => {
    const btn = item.querySelector('.faq-q');
    const ans = item.querySelector('.faq-a');
    if (!btn || !ans) return;

    btn.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');

      /* Close all */
      items.forEach(i => {
        i.classList.remove('open');
        i.querySelector('.faq-q').setAttribute('aria-expanded', 'false');
        i.querySelector('.faq-a').style.maxHeight = '0';
      });

      /* Open this one if it was closed */
      if (!isOpen) {
        item.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        ans.style.maxHeight = ans.scrollHeight + 'px';
      }
    });
  });

  /* Stagger items on scroll */
  gsap.fromTo('.faq-item',
    { opacity: 0, y: 20 },
    {
      opacity: 1, y: 0,
      duration: 0.6,
      stagger: 0.07,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.faq-list', start: 'top 82%', once: true }
    }
  );
}

/* ============================================================
   CONTACT — entrance animations
============================================================ */
function initContact() {
  const lines = document.querySelectorAll('.ct-line');
  if (lines.length) {
    gsap.fromTo(lines,
      { yPercent: 105, opacity: 0 },
      {
        yPercent: 0,
        opacity: 1,
        duration: 0.9,
        stagger: 0.12,
        ease: 'power4.out',
        scrollTrigger: { trigger: '#contactTitle', start: 'top 80%', once: true }
      }
    );
  }

  gsap.fromTo(['.contact-sub', '.contact-socials'],
    { opacity: 0, y: 20 },
    {
      opacity: 1, y: 0,
      duration: 0.7,
      stagger: 0.1,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.contact-left', start: 'top 78%', once: true }
    }
  );

  gsap.fromTo('.contact-right',
    { opacity: 0, x: 32 },
    {
      opacity: 1, x: 0,
      duration: 0.85,
      ease: 'power3.out',
      scrollTrigger: { trigger: '.contact-right', start: 'top 80%', once: true }
    }
  );
}

/* ============================================================
   GLOBAL section label + body reveals
============================================================ */
function initGlobalReveals() {
  gsap.utils.toArray('.section-label').forEach(el => {
    gsap.fromTo(el,
      { opacity: 0, x: -18 },
      {
        opacity: 1, x: 0,
        duration: 0.6,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true }
      }
    );
  });

  gsap.utils.toArray('.section-title').forEach(el => {
    if (el.id === 'workTitle') return;
    gsap.fromTo(el,
      { opacity: 0, y: 30 },
      {
        opacity: 1, y: 0,
        duration: 0.8,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 82%', once: true }
      }
    );
  });

  gsap.utils.toArray('.section-body').forEach(el => {
    gsap.fromTo(el,
      { opacity: 0, y: 18 },
      {
        opacity: 1, y: 0,
        duration: 0.7,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 88%', once: true }
      }
    );
  });
}

/* ============================================================
   FOOTER — subtle reveal
============================================================ */
function initFooter() {
  gsap.fromTo('.footer-inner',
    { opacity: 0, y: 20 },
    {
      opacity: 1, y: 0,
      duration: 0.8,
      ease: 'power3.out',
      scrollTrigger: {
        trigger: '.footer',
        start: 'top 90%',
        toggleActions: 'play none none none',
      }
    }
  );
}

/* ============================================================
   SCROLL-DRIVEN pin demo (showcases ScrollTrigger advanced use)
   — Pins the services section header while bento scrolls in
============================================================ */
function initServicePin() {
  // Only on larger screens
  if (window.innerWidth < 1024) return;

  ScrollTrigger.create({
    trigger: '.services',
    start: 'top top',
    end: '+=200',
    pin: '.services .section-head',
    pinSpacing: false,
  });
}

/* ============================================================
   HANDLE ANCHOR CLICKS — scroll via Lenis
============================================================ */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    lenis.scrollTo(target, { duration: 1.4, easing: t => 1 - Math.pow(1 - t, 4) });
  });
});

/* ============================================================
   CONTACT FORM & MODAL SUBMISSION — GSAP & AJAX Formspree
============================================================ */
function initContactForm() {
  const form = document.getElementById('contact-form');
  const toast = document.getElementById('success-toast');
  if (!form || !toast) return;

  const card = toast.querySelector('.toast-card');
  const checkCircle = toast.querySelector('.toast-check-circle');
  const closeBtn = document.getElementById('closeToastBtn');
  const submitBtn = form.querySelector('[data-fs-submit-btn]');
  const submitTxt = form.querySelector('.cf-submit-txt');
  const errorBanner = document.getElementById('cf-error-banner');

  // Clear errors when user focuses/inputs on fields
  const fields = form.querySelectorAll('input, textarea');
  fields.forEach(field => {
    field.addEventListener('input', () => {
      field.removeAttribute('aria-invalid');
      const errSpan = form.querySelector(`[data-fs-error="${field.name}"]`);
      if (errSpan) errSpan.textContent = '';
      if (errorBanner) errorBanner.textContent = '';
    });
  });

  // GSAP Toast Animations
  let toastTimeline = null;
  let autoDismissTimer = null;

  function showToast() {
    toast.classList.add('active');

    // Kill any running animations/timers
    if (toastTimeline) toastTimeline.kill();
    if (autoDismissTimer) clearTimeout(autoDismissTimer);

    // Set initial values
    gsap.set(card, { xPercent: 120, opacity: 0 });
    gsap.set(checkCircle, { scale: 0, rotate: -90 });

    toastTimeline = gsap.timeline({ defaults: { ease: 'power3.out' } });

    toastTimeline
      .to(card, { xPercent: 0, opacity: 1, duration: 0.65 })
      .to(checkCircle, { scale: 1, rotate: 0, duration: 0.5, ease: 'back.out(1.8)' }, 0.25);

    // Auto dismiss after 6 seconds
    autoDismissTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    if (toastTimeline) toastTimeline.kill();
    if (autoDismissTimer) clearTimeout(autoDismissTimer);

    toastTimeline = gsap.timeline({
      defaults: { ease: 'power2.in', duration: 0.45 },
      onComplete: () => {
        toast.classList.remove('active');
      }
    });

    toastTimeline
      .to(card, { xPercent: 120, opacity: 0 });
  }

  // Event Listeners for closing toast
  closeBtn.addEventListener('click', hideToast);

  // Validate form client-side
  function validateForm() {
    let isValid = true;
    fields.forEach(field => {
      let isFieldValid = true;
      const value = field.value.trim();
      const errSpan = form.querySelector(`[data-fs-error="${field.name}"]`);

      if (!value) {
        isFieldValid = false;
        if (errSpan) errSpan.textContent = 'This field is required.';
      } else if (field.type === 'email') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(value)) {
          isFieldValid = false;
          if (errSpan) errSpan.textContent = 'Please enter a valid email address.';
        }
      }

      if (!isFieldValid) {
        field.setAttribute('aria-invalid', 'true');
        isValid = false;
      } else {
        field.removeAttribute('aria-invalid');
        if (errSpan) errSpan.textContent = '';
      }
    });
    return isValid;
  }

  // Handle Form Submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (errorBanner) errorBanner.textContent = '';

    if (!validateForm()) {
      if (errorBanner) errorBanner.textContent = 'Please correct the errors below.';
      return;
    }

    // Set loading state
    submitBtn.disabled = true;
    const originalText = submitTxt.textContent;
    submitTxt.textContent = 'Sending...';

    try {
      const formData = new FormData(form);
      const response = await fetch('https://formspree.io/f/xbdbnwpb', {
        method: 'POST',
        body: formData,
        headers: {
          'Accept': 'application/json'
        }
      });

      if (response.ok) {
        // Reset form inputs & open success animation
        form.reset();
        showToast();
      } else {
        // Handle server errors
        const data = await response.json();
        if (data && data.errors) {
          data.errors.forEach(err => {
            if (err.field) {
              const field = form.querySelector(`[name="${err.field}"]`);
              if (field) {
                field.setAttribute('aria-invalid', 'true');
                const errSpan = form.querySelector(`[data-fs-error="${err.field}"]`);
                if (errSpan) errSpan.textContent = err.message;
              }
            } else {
              if (errorBanner) errorBanner.textContent = err.message;
            }
          });
          if (errorBanner && !errorBanner.textContent) {
            errorBanner.textContent = 'Form submission failed. Please try again.';
          }
        } else {
          if (errorBanner) errorBanner.textContent = 'An error occurred. Please try again.';
        }
      }
    } catch (error) {
      console.error('Contact form submission error:', error);
      if (errorBanner) errorBanner.textContent = 'Connection error. Please check your network and try again.';
    } finally {
      submitBtn.disabled = false;
      submitTxt.textContent = originalText;
    }
  });
}

/* ============================================================
   INIT — run after DOM ready
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initHeroShader();
  initLimelightNav();
  initHero();
  initCyclingText();
  initHeroParallax();
  initTicker();
  initManifesto();
  initStats();
  initAboutReveal();
  initWork();
  initStack();
  initProcess();
  initMarquee();
  initFAQ();
  initContact();
  initContactForm();
  initGlobalReveals();
  initFooter();
  // initServicePin();  // uncomment if you want the pinned services header
});

/* ============================================================
   RESIZE — refresh ScrollTrigger
   ============================================================ */
window.addEventListener('resize', () => {
  ScrollTrigger.refresh();
});

/* ============================================================
   PAGE LOADER TIMELINE
   ============================================================ */
const loaderTl = gsap.timeline({
  onComplete: () => {
    gsap.to('#page-loader', {
      opacity: 0,
      pointerEvents: 'none',
      duration: 0.8,
      ease: 'power3.inOut',
      onComplete: () => {
        const loaderEl = document.getElementById('page-loader');
        if (loaderEl) loaderEl.style.display = 'none';
      }
    });
  }
});

// Stagger characters reveal
loaderTl.fromTo('.loader-char', 
  { opacity: 0, y: 30, scale: 0.8 }, 
  { opacity: 1, y: 0, scale: 1, duration: 0.6, stagger: 0.08, ease: 'power4.out' }
);
loaderTl.fromTo('.loader-sub',
  { opacity: 0 },
  { opacity: 0.8, duration: 0.4 },
  '-=0.2'
);
// Smooth progress bar to 85%
loaderTl.to('.loader-progress', 
  { width: '85%', duration: 1.2, ease: 'power2.out' },
  '-=0.4'
);

// Complete loading when page resources are fully ready
window.addEventListener('load', () => {
  gsap.to('.loader-progress', {
    width: '100%',
    duration: 0.4,
    ease: 'power1.out',
    onComplete: () => {
      loaderTl.play();
    }
  });
});

// Fallback if window load takes too long (timeout after 4.5s)
setTimeout(() => {
  const progressEl = document.querySelector('.loader-progress');
  if (progressEl && parseFloat(progressEl.style.width) < 100) {
    gsap.to('.loader-progress', {
      width: '100%',
      duration: 0.3,
      onComplete: () => {
        loaderTl.play();
      }
    });
  }
}, 4500);

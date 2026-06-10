import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/* ------------------------------------------------------------------ */
/* Renderer / scene                                                    */
/* ------------------------------------------------------------------ */
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.9;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 500);

/* Bloom — this is what makes the neon sign and interior actually glow
   while the surroundings stay pitch dark */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.3,   // strength — subtle halo, never washes out the model or text
  0.4,   // radius
  0.88   // threshold — only true neon/highlights bloom
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* Keep ambient LOW — the darkness sells the night scene.
   The kiosk is lit by its own warm interior lights instead. */
scene.add(new THREE.AmbientLight(0x33415c, 0.55));
const moon = new THREE.DirectionalLight(0x8899ff, 0.7);
moon.position.set(4, 8, 2);
scene.add(moon);
const warmFill = new THREE.PointLight(0x66aaff, 0.0, 0, 2); // brand-blue rim, tuned after model load
scene.add(warmFill);
/* Warm interior glow — positioned inside the kiosk after load */
const interiorA = new THREE.PointLight(0xffc78a, 0.0, 0, 2);
const interiorB = new THREE.PointLight(0xffb3d9, 0.0, 0, 2);
/* Colored street accents — magenta wash on the front, cyan kicker from the side */
const neonMagenta = new THREE.PointLight(0xff4fd2, 0.0, 0, 2);
const neonCyan = new THREE.PointLight(0x3fd4ff, 0.0, 0, 2);
scene.add(interiorA, interiorB, neonMagenta, neonCyan);

/* ------------------------------------------------------------------ */
/* Asset loading (HDR night environment + GLB) with progress bar       */
/* ------------------------------------------------------------------ */
const loaderEl = document.getElementById("loader");
const loaderFill = document.getElementById("loaderFill");
const loaderPct = document.getElementById("loaderPct");
const GLB_BYTES = 18792128; // known file size fallback when Content-Length is missing

function setProgress(p) {
  const pct = Math.min(100, Math.round(p * 100));
  loaderFill.style.width = pct + "%";
  loaderPct.textContent = pct + "%";
}

new RGBELoader().load(
  "https://raw.githack.com/pmndrs/drei-assets/456060a26bbeb8fdf79326f224b6d99b8bcce736/hdri/dikhololo_night_1k.hdr",
  (tex) => {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = tex;
  },
  undefined,
  () => { /* environment is a nice-to-have; lights carry the scene if it fails */ }
);

let model = null;
let R = 1; // model bounding-sphere radius — all camera distances scale from this
const center = new THREE.Vector3();

const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
gltfLoader.setDRACOLoader(dracoLoader);

gltfLoader.load(
  "models/kiosk.glb",
  (gltf) => {
    model = gltf.scene;

    // Center the model at the origin
    const box = new THREE.Box3().setFromObject(model);
    box.getCenter(center);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    R = sphere.radius;
    model.position.sub(center);
    scene.add(model);

    // Make the model's own neon/emissive surfaces burn bright enough to bloom
    model.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) {
        const e = o.material.emissive;
        if (e.r + e.g + e.b > 0.05 || o.material.emissiveMap) {
          o.material.emissiveIntensity = Math.max(o.material.emissiveIntensity, 1.35);
        }
      }
    });

    // Blue rim accent above the model
    warmFill.position.set(0, R * 0.9, -R * 0.6);
    warmFill.intensity = R * 0.5;
    warmFill.distance = R * 5;

    // Warm lights tucked inside the kiosk so the interior glows outward
    interiorA.position.set(0, R * 0.35, -R * 0.15);
    interiorA.intensity = R * 1.6;
    interiorA.distance = R * 2.5;
    interiorB.position.set(-R * 0.3, R * 0.45, R * 0.1);
    interiorB.intensity = R * 0.9;
    interiorB.distance = R * 2.0;

    // Street-side colored neon spill
    neonMagenta.position.set(R * 0.4, R * 0.25, R * 0.9);
    neonMagenta.intensity = R * 0.8;
    neonMagenta.distance = R * 3.0;
    neonCyan.position.set(-R * 1.1, R * 0.5, -R * 0.4);
    neonCyan.intensity = R * 0.7;
    neonCyan.distance = R * 3.5;

    setProgress(1);
    setTimeout(() => loaderEl.classList.add("done"), 350);
    onScroll();
  },
  (xhr) => {
    const total = xhr.total || GLB_BYTES;
    setProgress(xhr.loaded / total);
  },
  (err) => {
    loaderPct.textContent = "Failed to load model";
    console.error(err);
  }
);

/* ------------------------------------------------------------------ */
/* Camera choreography                                                 */
/* Six keyframes — azimuth/elevation in degrees, dist in units of R.   */
/* `side` shifts the model toward screen-left (-) or screen-right (+)  */
/* so it sits opposite the text block.                                 */
/* ------------------------------------------------------------------ */
/* Azimuth DECREASES over scroll (reference orbit direction).
   az 90 = the "Sweet Bites" front face. The journey ends back at the
   front (-270 ≡ 90) for the contact scene. */
const KEYS = [
  { az: 115, el:  9, dist: 2.7, side:  0.55, lift: 0.03 }, // 01 hero — front 3/4, model right
  { az:  85, el:  6, dist: 2.15, side: -0.72, lift: 0.08 }, // 02 counter — close-up front, model left
  { az:  50, el:  6, dist: 2.4, side:  0.50, lift: 0.03 }, // 03 signage — front-right 3/4, model right
  { az: -60, el: 16, dist: 3.3, side: -0.42, lift: 0.00 }, // 04 night market — far view, model left
  { az: -150, el:  7, dist: 1.8, side:  0.50, lift: 0.10 }, // 05 service — tight angle, model right
  { az: -310, el: 10, dist: 2.9, side: -0.45, lift: 0.02 }, // 06 contact — front-right diagonal, model left of the form
];
const N = KEYS.length;

const deg = (d) => (d * Math.PI) / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

function applyCamera(p) {
  // p in [0,1] across the whole stage → continuous position between keyframes
  const f = Math.min(p * (N - 1) / 1, N - 1); // spread keys evenly over scroll
  const seg = Math.min(Math.floor(f), N - 2);
  const t = smooth(f - seg);
  const a = KEYS[seg], b = KEYS[seg + 1];

  const az = deg(lerp(a.az, b.az, t));
  const el = deg(lerp(a.el, b.el, t));
  const dist = lerp(a.dist, b.dist, t) * R;
  const side = lerp(a.side, b.side, t) * R;
  const lift = lerp(a.lift, b.lift, t) * R;

  const target = new THREE.Vector3(0, lift, 0);
  camera.position.set(
    target.x + dist * Math.cos(el) * Math.sin(az),
    target.y + dist * Math.sin(el),
    target.z + dist * Math.cos(el) * Math.cos(az)
  );
  camera.lookAt(target);

  // Slide the view sideways so the model sits opposite the text
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
  camera.position.addScaledVector(right, -side);
  // keep same orientation (translate, don't re-aim) → model shifts on screen
}

/* ------------------------------------------------------------------ */
/* Scroll → progress (RAF + ticking, direct DOM writes only)           */
/* ------------------------------------------------------------------ */
const stage = document.getElementById("stage");
const copies = [...document.querySelectorAll(".scene-copy")];
const dots = [...document.querySelectorAll(".progress-dot")];
const countEl = document.getElementById("sectionCount");
const promoLayer = document.getElementById("promoLayer");

let rawP = 0;      // immediate scroll progress
let smoothP = 0;   // damped progress used by the camera
let activeIdx = -1;
let ticking = false;

function computeProgress() {
  const rect = stage.getBoundingClientRect();
  const total = stage.offsetHeight - window.innerHeight;
  return Math.max(0, Math.min(1, -rect.top / total));
}

function updateOverlays(p) {
  // Each scene owns a 1/N slice of progress; fade text in/out inside it
  const slice = 1 / N;
  copies.forEach((el, i) => {
    const start = i * slice;
    const local = (p - start) / slice; // 0..1 within this scene
    let opacity = 0;
    let ty = 30;
    if (local > -0.15 && local < 1.15) {
      const fadeIn = Math.max(0, Math.min(1, (local - 0.12) / 0.22));
      const fadeOut = Math.max(0, Math.min(1, (0.92 - local) / 0.18));
      opacity = Math.min(fadeIn, fadeOut);
      ty = (1 - fadeIn) * 30 - Math.max(0, 1 - fadeOut) * 20;
    }
    if (i === 0) { // hero is visible from the very top
      const fadeOut = Math.max(0, Math.min(1, (0.92 - local) / 0.18));
      opacity = Math.min(1, fadeOut);
      ty = -Math.max(0, 1 - fadeOut) * 20;
    }
    if (i === N - 1) { // contact scene stays visible through the end
      const fadeIn = Math.max(0, Math.min(1, (local - 0.12) / 0.22));
      opacity = fadeIn;
      ty = (1 - fadeIn) * 30;
    }
    el.style.opacity = opacity.toFixed(3);
    el.style.transform = `translateY(calc(-50% + ${ty.toFixed(1)}px))`;
  });

  // Contact panel rides with the final scene and stays visible
  const localC = (p - (N - 1) * slice) / slice;
  const promoOp = Math.max(0, Math.min(1, (localC - 0.3) / 0.3));
  promoLayer.style.opacity = promoOp.toFixed(3);
  promoLayer.classList.toggle("live", promoOp > 0.5);

  // Dots + counter — state change only when the index actually changes
  const idx = Math.min(N - 1, Math.floor(p * N));
  if (idx !== activeIdx) {
    activeIdx = idx;
    dots.forEach((d, i) => d.classList.toggle("active", i === idx));
    countEl.textContent = `0${idx + 1} / 0${N}`;
  }
}

function onScroll() {
  rawP = computeProgress();
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(() => { ticking = false; });
  }
}
window.addEventListener("scroll", onScroll, { passive: true });

/* Dots jump to their scene */
dots.forEach((d, i) => {
  d.addEventListener("click", () => {
    const total = stage.offsetHeight - window.innerHeight;
    const target = (i / N + 0.5 / N) * total;
    window.scrollTo({ top: stage.offsetTop + target, behavior: "smooth" });
  });
});

/* ------------------------------------------------------------------ */
/* Render loop — camera damping gives the buttery scrubbed feel        */
/* ------------------------------------------------------------------ */
function loop() {
  requestAnimationFrame(loop);
  smoothP += (rawP - smoothP) * 0.07;
  if (model) {
    applyCamera(smoothP);
    updateOverlays(smoothP);
  }
  composer.render();
}
loop();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

/* Debug handle for live tuning (harmless in production) */
window.__dbg = { scene, camera, renderer, KEYS, applyCamera, get model() { return model; }, get R() { return R; } };

/* Promo form — demo only, no backend */
document.getElementById("promoForm").addEventListener("submit", (e) => {
  e.preventDefault();
  document.getElementById("promoConfirm").classList.add("show");
});

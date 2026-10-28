// ============================================================
// ПОДСКАЗКИ ПРОКРУТКИ
// Системные полосы прокрутки скрыты (css). В окнах со скроллом вместо них
// по центру сверху/снизу показываются «каменные» стрелки: вверх — если можно
// прокрутить вверх, вниз — если можно вниз. Свечение пульсирует синхронно.
// ============================================================
const NS = 'http://www.w3.org/2000/svg';
const SELECTOR = '.characters-list, .modal, .modal-step, .app-dialog-body, .tm-list';
const PULSE_MS = 2600;          // период пульсации (должен совпадать с css .scroll-arrow svg)
const EDGE = 4;                 // порог «у края», px

function ensureDefs() {
  if (document.getElementById('scroll-arrow-defs')) return;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('id', 'scroll-arrow-defs');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `
    <defs>
      <linearGradient id="sa-stone" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4a4e55"/>
        <stop offset="0.5" stop-color="#2f3237"/>
        <stop offset="1" stop-color="#1b1d21"/>
      </linearGradient>
      <filter id="sa-granite" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" result="noise"/>
        <feColorMatrix in="noise" type="matrix"
          values="0 0 0 0 0.55  0 0 0 0 0.58  0 0 0 0 0.6  0 0 0 1.4 -0.78" result="speckle"/>
        <feComposite in="speckle" in2="SourceAlpha" operator="in" result="grain"/>
        <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="grain"/></feMerge>
      </filter>
    </defs>`;
  document.body.appendChild(svg);
}

function makeArrow(dir) {
  const box = document.createElement('div');
  box.className = 'scroll-arrow ' + dir;
  box.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 28 24');
  // три треугольника от большого к малому
  svg.innerHTML = `
    <g fill="url(#sa-stone)" stroke="#121316" stroke-width="0.8" stroke-linejoin="round" filter="url(#sa-granite)">
      <path d="M2 1.5 L26 1.5 L14 9 Z"/>
      <path d="M5.5 11 L22.5 11 L14 16 Z"/>
      <path d="M9.5 18 L18.5 18 L14 21.5 Z"/>
    </g>`;
  // общая фаза пульсации для всех стрелок, чтобы они мигали синхронно
  svg.style.animationDelay = -(performance.now() % PULSE_MS) + 'ms';
  box.appendChild(svg);
  return box;
}

function attach(sc) {
  if (sc._scrollArrows) return;
  const parent = sc.parentElement;
  if (!parent) return;
  ensureDefs();
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  const up = makeArrow('up');
  const down = makeArrow('down');
  parent.append(up, down);
  sc._scrollArrows = { up, down };

  let raf = 0;
  const update = () => {
    raf = 0;
    if (!sc.isConnected) { up.remove(); down.remove(); return; }
    const max = sc.scrollHeight - sc.clientHeight;
    const can = max > EDGE * 2;
    up.classList.toggle('on', can && sc.scrollTop > EDGE);
    down.classList.toggle('on', can && sc.scrollTop < max - EDGE);
    const x = sc.offsetLeft + sc.offsetWidth / 2;
    up.style.left = down.style.left = x + 'px';
    up.style.top = (sc.offsetTop + 4) + 'px';
    down.style.top = (sc.offsetTop + sc.offsetHeight - 4 - down.offsetHeight) + 'px';
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };

  sc.addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(schedule).observe(sc);
  new MutationObserver(schedule).observe(sc, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  schedule();
}

function scan(root) {
  if (root.matches?.(SELECTOR)) attach(root);
  root.querySelectorAll?.(SELECTOR).forEach(attach);
}

scan(document);
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
}).observe(document.body, { childList: true, subtree: true });

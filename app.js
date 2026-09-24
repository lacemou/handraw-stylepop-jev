const styles = window.STYLES_DATA?.styles || [];
const $ = (id) => document.getElementById(id);
const world = $('world'), input = $('query'), status = $('status'), tooltip = $('ball-tooltip');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const bodies = [], cache = new Map();

let width = 0, height = 0, selection = [], selectedStyle = null;
let revision = 0, timer, controller, composing = false, query = '';
let elapsedTimer = null, elapsedStartedAt = 0;
let copyRevision = 0, targetY = 0;

function resize() {
  const ow = width || world.clientWidth, oh = height || world.clientHeight;
  width = world.clientWidth;
  height = world.clientHeight;
  const base = Math.min(19, Math.sqrt(width * height * 0.22 / (261 * Math.PI)));

  for (const b of bodies) {
    b.r = base * b.scale;
    b.x = Math.max(b.r, Math.min(width - b.r, b.x * width / ow));
    b.y = Math.max(b.r, Math.min(height - b.r, b.y + height - oh));
    b.el.style.width = b.el.style.height = (b.r * 2) + 'px';
  }
  const searchRect = document.querySelector('.search').getBoundingClientRect();
  targetY = searchRect.bottom + 42;
}

for (const style of styles) {
  const el = document.createElement('button');
  el.className = 'ball';
  el.disabled = true;
  el.dataset.id = style.id;
  el.setAttribute('aria-label', `${style.id} ${style.name}`);

  const img = document.createElement('img');
  // 探索池展示原始手绘风格；个人头像只作为详情里的生成示例。
  img.src = '/' + style.preview_url;
  img.alt = '';
  img.draggable = false;
  el.append(img);
  $('balls').append(el);

  const b = {
    id: style.id,
    style,
    el,
    scale: 0.8 + Math.random() * 0.4,
    r: 18,
    x: Math.random() * (world.clientWidth || window.innerWidth),
    y: (world.clientHeight || window.innerHeight) * (0.62 + Math.random() * 0.34),
    vx: (Math.random() - 0.5) * 70,
    vy: 0,
    angle: (Math.random() - 0.5) * 0.6,
    spin: 0,
    rank: -1,
  };
  bodies.push(b);

  el.onclick = () => {
    if (b.rank >= 0) openDetail(style);
  };

  el.onmouseenter = () => {
    if (b.rank >= 0 && tooltip) {
      tooltip.textContent = style.name;
      tooltip.hidden = false;
      tooltip.classList.add('visible');
      tooltip.style.left = b.x + 'px';
      tooltip.style.top = (b.y - b.r - 10) + 'px';
    }
  };

  el.onmouseleave = () => {
    if (tooltip) {
      tooltip.classList.remove('visible');
    }
  };
}

resize();
new ResizeObserver(resize).observe(world);

function target(b) {
  const gap = Math.min(65, (width - 45) / Math.max(selection.length, 1));
  return {
    x: width / 2 + (b.rank - (selection.length - 1) / 2) * gap,
    y: targetY,
  };
}

function select(ids) {
  selection = ids;
  if (tooltip) tooltip.classList.remove('visible');

  for (const b of bodies) {
    const rank = ids.indexOf(b.id);
    const was = b.rank >= 0;
    b.rank = rank;
    b.el.classList.toggle('selected', rank >= 0);
    b.el.disabled = rank < 0;

    if (rank >= 0 && !was) {
      b.vy = -400;
      b.spin = (Math.random() - 0.5) * 4;
    }
    if (rank < 0 && was) {
      b.vy = 35;
      b.vx = (Math.random() - 0.5) * 110;
      b.spin = (Math.random() - 0.5) * 3;
    }
    if (reduced && rank >= 0) {
      Object.assign(b, target(b), { vx: 0, vy: 0 });
    }
  }
}

// 物理模拟步进
function step(dt) {
  for (const b of bodies) {
    if (b.rank >= 0) {
      const t = target(b);
      b.vx += ((t.x - b.x) * 32 - b.vx * 7) * dt;
      b.vy += ((t.y - b.y) * 32 - b.vy * 7) * dt;
      b.angle *= 0.985;
    } else {
      b.vy += 1000 * dt;
      b.vx *= 0.998;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.angle += b.spin * dt;
    b.spin *= Math.exp(-5 * dt);
  }

  const cell = Math.max(12, Math.max(...bodies.map((b) => b.r)) * 2 + 1);
  for (let pass = 0; pass < 4; pass++) {
    const grid = new Map();
    for (const b of bodies) {
      const gx = Math.floor(b.x / cell), gy = Math.floor(b.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const a of grid.get(`${gx + dx},${gy + dy}`) || []) {
            let nx = b.x - a.x, ny = b.y - a.y, dist = Math.hypot(nx, ny), min = b.r + a.r;
            if (dist >= min) continue;
            if (dist < 0.001) { nx = 1; ny = 0; dist = 1; }
            nx /= dist; ny /= dist;
            const overlap = (min - dist) * 0.5;
            a.x -= nx * overlap; a.y -= ny * overlap;
            b.x += nx * overlap; b.y += ny * overlap;
            const speed = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (speed < 0) {
              const j = -speed * 0.62;
              a.vx -= j * nx; a.vy -= j * ny;
              b.vx += j * nx; b.vy += j * ny;
            }
          }
        }
      }
      const key = `${gx},${gy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(b);
    }

    for (const b of bodies) {
      if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * 0.35; }
      if (b.x > width - b.r) { b.x = width - b.r; b.vx = -Math.abs(b.vx) * 0.35; }
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * 0.3; }
      if (b.y > height - b.r - 3) {
        b.y = height - b.r - 3;
        b.vy = -Math.abs(b.vy) * 0.2;
        b.vx *= 0.9;
        b.spin *= 0.25;
      }
    }
  }

  for (const b of bodies) {
    if (Math.abs(b.spin) < 0.03) b.spin = 0;
    if (b.rank >= 0) {
      const t = target(b);
      if (Math.hypot(t.x - b.x, t.y - b.y) < 3 && Math.hypot(b.vx, b.vy) < 18) {
        b.spin = 0;
      }
    }
  }
}

let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min((now - last) / 1000, 0.05);
  last = now;
  while (acc >= 1 / 120) {
    step(1 / 120);
    acc -= 1 / 120;
  }
  for (const b of bodies) {
    b.el.style.transform = `translate(${b.x - b.r}px,${b.y - b.r}px) rotate(${b.angle}rad)`;
  }
  requestAnimationFrame(frame);
}

for (let i = 0; i < 240; i++) step(1 / 120);
requestAnimationFrame(frame);

function resetCopyButton() {
  const copyBtn = $('copy');
  copyBtn.classList.remove('copied');
  const textEl = $('copy-text');
  if (textEl) textEl.textContent = '复制提示词';
}

function closeDetail() {
  $('detail').hidden = true;
  document.body.classList.remove('detail-open');
  selectedStyle = null;
  copyRevision++;
  resetCopyButton();
}

function openDetail(style) {
  selectedStyle = style;
  copyRevision++;
  resetCopyButton();

  // 保持原有布局，只交换两类图片的素材位置：圆形位置放风格参考图，
  // 展开图位置放该风格下的个人头像生成示例。
  $('avatar').src = '/' + style.preview_url;
  $('avatar').alt = style.name + ' 原始风格参考';
  $('style-id').textContent = 'STYLE / ' + style.id;
  $('style-group').textContent = style.group || '经典画风';
  $('style-name').textContent = style.name;

  const authorWrap = $('style-author-wrap');
  if (style.author) {
    $('style-author').textContent = style.author;
    authorWrap.hidden = false;
  } else {
    authorWrap.hidden = true;
  }

  $('traits').textContent = style.traits;
  $('preview').src = '/' + style.avatar_url;
  $('preview').alt = style.name + ' 下的个人头像生成示例';
  $('preview-details').open = false;

  $('detail').hidden = false;
  document.body.classList.add('detail-open');

  $('detail').getAnimations().forEach((a) => a.cancel());
  if (!reduced) {
    $('detail').animate(
      [
        { opacity: 0, transform: 'translateX(30px) scale(0.97)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 400, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    );
  }
}

$('close').onclick = closeDetail;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDetail();
});

function resetElapsed() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
  elapsedStartedAt = 0;
  $('elapsed').hidden = true;
  $('elapsed').textContent = '';
}

function updateElapsed() {
  if (!elapsedStartedAt) return;
  const seconds = (performance.now() - elapsedStartedAt) / 1000;
  $('elapsed').textContent = `耗时 ${seconds.toFixed(1)} 秒`;
}

function startElapsed() {
  resetElapsed();
  elapsedStartedAt = performance.now();
  $('elapsed').hidden = false;
  updateElapsed();
  elapsedTimer = setInterval(updateElapsed, 100);
}

function stopElapsed() {
  if (!elapsedStartedAt) return;
  updateElapsed();
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function prepareQuery() {
  revision++;
  clearTimeout(timer);
  controller?.abort();
  closeDetail();
  resetElapsed();
  query = input.value.trim();
  $('clear').hidden = !input.value;
  return revision;
}

function changed() {
  const version = prepareQuery();
  if (!query) {
    select([]);
    status.textContent = '输入主题，让合适的风格跳出来。';
    return;
  }
  status.textContent = composing ? '输入主题，让合适的风格跳出来。' : '正在分析主题…';
  if (!composing) timer = setTimeout(() => search(query, version), 600);
}

function submitSearchNow() {
  if (composing) return;
  const version = prepareQuery();
  if (!query) {
    select([]);
    status.textContent = '输入主题，让合适的风格跳出来。';
    return;
  }
  search(query, version);
}

async function search(text, version) {
  status.textContent = '正在寻找契合的风格…';
  startElapsed();
  const rc = new AbortController();
  controller = rc;
  try {
    let data = cache.get(text);
    if (!data) {
      const res = await fetch('/api/rank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: text }),
        signal: rc.signal,
      });
      data = await res.json();
      if (!res.ok) throw Error(data.error || '筛选暂时失败');
      if (cache.size >= 30) cache.delete(cache.keys().next().value);
      cache.set(text, data);
    }
    if (version !== revision || composing) return;
    select(data.results.map((r) => r.id));
    status.textContent = `${data.results.length} 种适合这个主题的风格已跃出 · 点击风格展开详情`;
    requestAnimationFrame(() => {
      if (version === revision && !composing) stopElapsed();
    });
  } catch (error) {
    if (version === revision && error.name !== 'AbortError') {
      select([]);
      stopElapsed();
      status.textContent = '暂时没能完成筛选：' + error.message;
    }
  }
}

input.addEventListener('input', changed);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !composing && !e.isComposing) {
    e.preventDefault();
    submitSearchNow();
  }
});
input.addEventListener('compositionstart', () => {
  composing = true;
  changed();
});
input.addEventListener('compositionend', () => {
  composing = false;
  changed();
});

$('clear').onclick = () => {
  input.value = '';
  changed();
  input.focus();
};

// 灵感推荐标签绑定
document.querySelectorAll('.chip').forEach((chip) => {
  chip.onclick = () => {
    input.value = chip.dataset.q;
    changed();
    input.focus();
  };
});

function positiveTraits(traits = '') {
  return traits
    .split(/[；;]/)
    .map((part) => part.trim())
    .filter((part) => part && !/(避免|不要|不准|禁止)/.test(part))
    .join('；');
}

function promptFor(style) {
  const theme = query || '（请先输入主题）';
  const author = style.author || '开源手绘风格库';
  const traits = positiveTraits(style.traits);

  // 沿用上游 handdraw-style 的字段顺序与参考图隔离规则。
  // 不使用本地 prompt_recipe：它是旧版“人物身份保留”头像模板。
  return [
    `主题：${theme}`,
    `Style name: #${style.id} · ${style.name}.`,
    `Reference author/style name: ${author} / ${style.name}.`,
    traits ? `Core style traits: ${traits}` : '',
    "The user's written theme is the sole source for the image content.",
    "Use the attached image only as a style reference. Extract only its stylistic qualities, such as linework, brushwork, medium, material texture, color tendencies, and overall visual language. Do not use, copy, or carry over any subject, person, animal, clothing, prop, action, pose, setting, background, composition, layout, text, or story from the reference. The user's written theme is the sole source for the image content.",
  ].filter(Boolean).join('\n\n');
}

$('copy').onclick = async () => {
  if (!selectedStyle) return;
  const version = ++copyRevision, text = promptFor(selectedStyle);
  try {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw Error('copy failed');
    }
    if (version !== copyRevision) return;

    $('copy').classList.add('copied');
    $('copy-text').textContent = '已复制提示词';
    $('toast-text').textContent = '提示词已成功复制到剪贴板';
    $('toast').classList.add('visible');

    setTimeout(() => {
      $('toast').classList.remove('visible');
      if (version === copyRevision) resetCopyButton();
    }, 2200);
  } catch {
    if (version === copyRevision) {
      $('copy-text').textContent = '复制失败，请重试';
      setTimeout(resetCopyButton, 2000);
    }
  }
};

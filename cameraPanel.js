////////////////////////////////////////////////////////////
// cameraPanel.js — chase camera sliders (V).
// Two speed thresholds, and eye height, distance behind and look-down at
// each. The engine blends between them with speed.
////////////////////////////////////////////////////////////

// Height and distance sliders are quadratic so the first few meters, where
// first person and close chase live, get most of the travel.
const STEPS = 1000;

function sliderSpec(limits) {
  return {
    kmh: { min: limits.kmh[0], max: limits.kmh[1], curve: 1, unit: 'km/h', digits: 0 },
    heightM: { min: limits.heightM[0], max: limits.heightM[1], curve: 2, unit: 'm' },
    behindM: { min: limits.behindM[0], max: limits.behindM[1], curve: 2, unit: 'm' },
    lookDownDeg: { min: limits.lookDownDeg[0], max: limits.lookDownDeg[1], curve: 1, unit: '°', digits: 0 }
  };
}

function toValue(spec, t) {
  const v = spec.min + (spec.max - spec.min) * Math.pow(t / STEPS, spec.curve);
  return spec.digits === 0 ? Math.round(v) : Math.round(v * 10) / 10;
}

function toSlider(spec, v) {
  const f = Math.min(1, Math.max(0, (v - spec.min) / (spec.max - spec.min)));
  return Math.round(Math.pow(f, 1 / spec.curve) * STEPS);
}

function format(spec, v) {
  if (spec.digits === 0) return `${Math.round(v)} ${spec.unit}`.replace(' °', '°');
  if (v === 0) return `0 ${spec.unit}`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${spec.unit}`;
}

/**
 * `get()` returns the current settings, `set(partial)` applies and saves.
 * Returns `{ setVisible(on), toggle() }`.
 */
export function mountCameraPanel({ button, row, panel, get, set, defaults, firstPerson, limits }) {
  const specs = sliderSpec(limits);
  const fields = [];
  panel.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'camTitle';
  title.textContent = 'Chase camera';
  panel.appendChild(title);

  const heading = () => {
    const h = document.createElement('div');
    h.className = 'camGroup';
    panel.appendChild(h);
    return h;
  };

  const slider = (key, label, specKey) => {
    const spec = specs[specKey];
    const wrap = document.createElement('label');
    wrap.className = 'camSlider';
    const head = document.createElement('span');
    head.className = 'camSliderHead';
    const name = document.createElement('span');
    name.textContent = label;
    const out = document.createElement('b');
    head.append(name, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(STEPS);
    input.step = '1';
    input.addEventListener('input', () => {
      set({ [key]: toValue(spec, Number(input.value)) });
      refresh();
    });
    input.addEventListener('change', () => input.blur());
    wrap.append(head, input);
    panel.appendChild(wrap);
    fields.push({ key, spec, input, out });
  };

  heading().textContent = 'Speed thresholds';
  slider('slowKmh', 'Low speed', 'kmh');
  slider('fastKmh', 'High speed', 'kmh');
  const slowHead = heading();
  slider('slowHeightM', 'Height above board', 'heightM');
  slider('slowBehindM', 'Behind board middle', 'behindM');
  slider('slowLookDownDeg', 'Look down', 'lookDownDeg');
  const fastHead = heading();
  slider('fastHeightM', 'Height above board', 'heightM');
  slider('fastBehindM', 'Behind board middle', 'behindM');
  slider('fastLookDownDeg', 'Look down', 'lookDownDeg');

  const actions = document.createElement('div');
  actions.className = 'camActions';
  const action = (text, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => { fn(); refresh(); b.blur(); });
    actions.appendChild(b);
  };
  action('First person', () => set(firstPerson));
  action('Reset', () => set(defaults));
  panel.appendChild(actions);

  function refresh() {
    const s = get();
    for (const f of fields) {
      const v = s[f.key];
      if (document.activeElement !== f.input) f.input.value = String(toSlider(f.spec, v));
      f.out.textContent = format(f.spec, v);
    }
    slowHead.textContent = `At ${Math.round(s.slowKmh)} km/h and below`;
    fastHead.textContent = `At ${Math.round(s.fastKmh)} km/h and above`;
  }

  let open = false;
  let visible = false;
  const apply = () => {
    panel.hidden = !(open && visible);
    button.setAttribute('aria-expanded', open && visible ? 'true' : 'false');
    if (!panel.hidden) refresh();
  };
  button.addEventListener('click', () => { open = !open; apply(); button.blur(); });

  return {
    setVisible(on) {
      if (visible === !!on) return;
      visible = !!on;
      row.hidden = !visible;
      apply();
    },
    toggle() {
      if (!visible) return;
      open = !open;
      apply();
    }
  };
}

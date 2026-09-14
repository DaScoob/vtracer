import { clampChroma, converter, formatHex } from 'culori';

const toOklch = converter('oklch');
const CHROMA_HUE_THRESHOLD = 0.002;

const clamp01 = value => Math.max(0, Math.min(1, value));
const normalizeHue = value => ((value % 360) + 360) % 360;

function hueDelta(startHue, endHue, route) {
    const start = normalizeHue(startHue);
    const end = normalizeHue(endHue);
    const increasing = normalizeHue(end - start);
    const decreasing = increasing === 0 ? 0 : increasing - 360;

    switch (route) {
        case 'increasing': return increasing;
        case 'decreasing': return decreasing;
        case 'longer':
            if (increasing === 0) return 0;
            return Math.abs(increasing) >= Math.abs(decreasing) ? increasing : decreasing;
        case 'shorter':
        default:
            return Math.abs(increasing) <= Math.abs(decreasing) ? increasing : decreasing;
    }
}

function interpolateOklch(start, end, t, route) {
    const startHue = Number.isFinite(start.h) ? start.h : (Number.isFinite(end.h) ? end.h : 0);
    const endHue = Number.isFinite(end.h) ? end.h : startHue;
    return {
        mode: 'oklch',
        l: clamp01(start.l + (end.l - start.l) * t),
        c: Math.max(0, start.c + (end.c - start.c) * t),
        h: normalizeHue(startHue + hueDelta(startHue, endHue, route) * t),
    };
}

function hueLabel(oklch) {
    if (!oklch || oklch.c < CHROMA_HUE_THRESHOLD || !Number.isFinite(oklch.h)) return 'N';
    return `${Math.round(normalizeHue(oklch.h))}°`;
}

export class ColorLab {
    constructor(svg) {
        this.svg = svg;
        this.layers = [];
        this.elementStates = new Map();
        this.active = false;
        this.busy = false;
        this.rampCustomized = false;

        this.root = document.getElementById('color-lab');
        this.layersEl = document.getElementById('color-lab-layers');
        this.emptyEl = document.getElementById('color-lab-empty');
        this.statusEl = document.getElementById('color-lab-status');
        this.startInput = document.getElementById('color-lab-start');
        this.endInput = document.getElementById('color-lab-end');
        this.routeInput = document.getElementById('color-lab-route');
        this.previewEl = document.getElementById('color-lab-ramp-preview');
        this.applyButton = document.getElementById('color-lab-apply');
        this.resetButton = document.getElementById('color-lab-reset');
        this.selectAllButton = document.getElementById('color-lab-select-all');
        this.selectNoneButton = document.getElementById('color-lab-select-none');

        if (!this.root) return;
        this.bindEvents();
        this.updateRampPreview();
        this.updateControls();
    }

    bindEvents() {
        this.selectAllButton.addEventListener('click', () => {
            this.layers.forEach(layer => { layer.selected = true; });
            this.renderLayers();
            if (this.active) this.apply();
        });
        this.selectNoneButton.addEventListener('click', () => {
            this.layers.forEach(layer => { layer.selected = false; });
            this.renderLayers();
            if (this.active) this.apply();
        });
        [this.startInput, this.endInput].forEach(input => {
            input.addEventListener('input', () => {
                this.rampCustomized = true;
                this.updateRampPreview();
                if (this.active) this.apply();
            });
        });
        this.routeInput.addEventListener('change', () => {
            this.updateRampPreview();
            if (this.active) this.apply();
        });
        this.applyButton.addEventListener('click', () => this.apply());
        this.resetButton.addEventListener('click', () => this.reset());
    }

    setBusy(busy) {
        if (!this.root) return;
        this.busy = busy;
        this.root.toggleAttribute('aria-busy', busy);
        this.statusEl.textContent = busy ? 'Vektorisierung läuft …' : this.statusText();
        this.updateControls();
    }

    statusText() {
        if (!this.layers.length) return 'Noch keine SVG-Farblayer';
        const selected = this.layers.filter(layer => layer.selected).length;
        return `${this.layers.length} Farblayer · ${selected} ausgewählt`;
    }

    refresh() {
        if (!this.root) return;

        const previousSelection = new Set(this.layers.filter(l => l.selected).map(l => l.sourceColor));
        const hadLayers = this.layers.length > 0;
        const groups = new Map();
        this.elementStates = new Map();

        this.svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline').forEach(element => {
            const computed = getComputedStyle(element).fill;
            if (!computed || computed === 'none') return;
            const oklch = toOklch(computed);
            const sourceColor = formatHex(computed)?.toLowerCase();
            if (!oklch || !sourceColor) return;

            this.elementStates.set(element, {
                fillAttribute: element.getAttribute('fill'),
                styleFill: element.style.fill,
            });

            if (!groups.has(sourceColor)) {
                groups.set(sourceColor, {
                    sourceColor,
                    oklch,
                    elements: [],
                    selected: !hadLayers || previousSelection.has(sourceColor),
                    appliedColor: null,
                });
            }
            groups.get(sourceColor).elements.push(element);
        });

        this.layers = [...groups.values()].sort((a, b) => {
            const ac = a.oklch.c >= CHROMA_HUE_THRESHOLD && Number.isFinite(a.oklch.h);
            const bc = b.oklch.c >= CHROMA_HUE_THRESHOLD && Number.isFinite(b.oklch.h);
            if (ac !== bc) return ac ? -1 : 1;
            if (ac) return normalizeHue(a.oklch.h) - normalizeHue(b.oklch.h);
            return a.oklch.l - b.oklch.l;
        });

        if (hadLayers && this.layers.length && !this.layers.some(l => l.selected)) {
            this.layers.forEach(l => { l.selected = true; });
        }
        if (!this.rampCustomized) this.syncRampFromLayers();

        this.busy = false;
        this.renderLayers();
        this.updateRampPreview();
        this.updateControls();
        if (this.active && this.layers.length) this.apply();
    }

    syncRampFromLayers() {
        const chromatic = this.layers.filter(l => l.oklch.c >= CHROMA_HUE_THRESHOLD && Number.isFinite(l.oklch.h));
        const source = chromatic.length ? chromatic : this.layers;
        if (!source.length) return;
        this.startInput.value = source[0].sourceColor;
        this.endInput.value = source[source.length - 1].sourceColor;
    }

    renderLayers() {
        this.layersEl.replaceChildren();
        this.layers.forEach(layer => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'color-layer';
            button.classList.toggle('is-selected', layer.selected);
            button.setAttribute('aria-pressed', layer.selected ? 'true' : 'false');
            button.title = `${layer.sourceColor} · ${hueLabel(layer.oklch)} · ${layer.elements.length} Pfade`;
            button.style.setProperty('--layer-source', layer.sourceColor);
            button.style.setProperty('--layer-output', layer.appliedColor || layer.sourceColor);

            const swatch = document.createElement('span');
            swatch.className = 'color-layer__swatch';
            swatch.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.className = 'color-layer__label';
            label.textContent = hueLabel(layer.oklch);
            button.append(swatch, label);

            button.addEventListener('click', () => {
                layer.selected = !layer.selected;
                this.renderLayers();
                this.updateControls();
                if (this.active) this.apply();
            });
            this.layersEl.append(button);
        });

        const hasLayers = this.layers.length > 0;
        this.layersEl.hidden = !hasLayers;
        this.emptyEl.hidden = hasLayers;
        this.statusEl.textContent = this.statusText();
    }

    updateControls() {
        if (!this.root) return;
        const hasLayers = this.layers.length > 0;
        const hasSelection = this.layers.some(layer => layer.selected);
        this.selectAllButton.disabled = this.busy || !hasLayers;
        this.selectNoneButton.disabled = this.busy || !hasLayers;
        this.startInput.disabled = this.busy || !hasLayers;
        this.endInput.disabled = this.busy || !hasLayers;
        this.routeInput.disabled = this.busy || !hasLayers;
        this.applyButton.disabled = this.busy || !hasLayers || !hasSelection;
        this.resetButton.disabled = this.busy || !hasLayers || !this.active;
    }

    updateRampPreview() {
        if (!this.previewEl) return;
        this.previewEl.style.setProperty('--ramp-start', this.startInput.value);
        this.previewEl.style.setProperty('--ramp-end', this.endInput.value);
    }

    restoreElementColors() {
        this.elementStates.forEach((state, element) => {
            if (!element.isConnected) return;
            if (state.fillAttribute === null) element.removeAttribute('fill');
            else element.setAttribute('fill', state.fillAttribute);
            if (state.styleFill) element.style.fill = state.styleFill;
            else element.style.removeProperty('fill');
        });
    }

    apply() {
        if (!this.layers.length || this.busy) return;
        this.restoreElementColors();
        const selected = this.layers.filter(layer => layer.selected);
        this.layers.forEach(layer => { layer.appliedColor = null; });
        if (!selected.length) {
            this.active = false;
            this.renderLayers();
            this.updateControls();
            return;
        }

        const start = toOklch(this.startInput.value);
        const end = toOklch(this.endInput.value);
        if (!start || !end) return;

        selected.forEach((layer, index) => {
            const t = selected.length === 1 ? 0.5 : index / (selected.length - 1);
            const interpolated = interpolateOklch(start, end, t, this.routeInput.value);
            const output = formatHex(clampChroma(interpolated, 'oklch', 'rgb')).toLowerCase();
            layer.appliedColor = output;
            layer.elements.forEach(element => { element.style.fill = output; });
        });

        this.active = true;
        this.renderLayers();
        this.updateControls();
    }

    reset() {
        this.restoreElementColors();
        this.layers.forEach(layer => { layer.appliedColor = null; });
        this.active = false;
        this.renderLayers();
        this.updateControls();
    }
}

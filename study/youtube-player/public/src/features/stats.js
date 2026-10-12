// A "stats for nerds"-style panel: live engine numbers, plus a bandwidth cap
// selector so the ABR logic can be watched making decisions.
import { network } from '../media/fetcher.js';
import { stateName } from '../core/state.js';

export class StatsPanel {
  constructor(player, root) {
    this.player = player;
    this.el = document.createElement('div');
    this.el.className = 'vp-stats';
    this.el.hidden = true;
    this.el.innerHTML = `
      <button type="button" class="vp-stats-close" aria-label="Close stats">×</button>
      <dl></dl>
      <label>Simulated bandwidth cap
        <select>
          <option value="0">none</option>
          <option value="300">300 kbps</option>
          <option value="800">800 kbps</option>
          <option value="2000">2 Mbps</option>
        </select>
      </label>`;
    root.append(this.el);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.querySelector('.vp-stats-close').onclick = () => this.toggle(false);
    const select = this.el.querySelector('select');
    select.value = String(network.capKbps);
    if (select.value === '') select.value = '0';
    select.onchange = () => (network.capKbps = Number(select.value));
    player.on('stats', () => this.render());
  }

  toggle(force) {
    this.el.hidden = force == null ? !this.el.hidden : !force;
    this.render();
  }

  render() {
    if (this.el.hidden) return;
    const rows = { state: stateName(this.player.getPlayerState()), ...this.player.getStats() };
    this.el.querySelector('dl').replaceChildren(
      ...Object.entries(rows).flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = String(v);
        return [dt, dd];
      }),
    );
  }
}

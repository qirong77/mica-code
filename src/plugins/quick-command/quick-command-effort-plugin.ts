import { MicaPlugin } from '../MicaPlugin';
import type { EffortLevel } from '../../store/config.js';

export class QuickCommandEffortPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'effort',
      description: '切换推理强度',
      action: () => {
        const currentEffort = this.atoms.effort.get();
        const efforts = this.atoms.effortOptions.get();

        const items = efforts.map((e) => {
          const isActive = e.name === currentEffort;
          return {
            key: e.name,
            label: e.label,
            suffix: isActive
              ? { text: '(active)', color: '#4CAF50' }
              : undefined,
          };
        });

        const activeIdx = items.findIndex((i) => i.key === currentEffort);

        this.agent.ui.DropDown.atomData.dropdown.set({
          visible: true,
          items,
          selectedIndex: activeIdx >= 0 ? activeIdx : 0,
          title: 'select effort:',
          emptyMessage: 'no efforts available',
        });
      },
    });

    this.agent.ui.DropDown.emitter.on('select', (item) => {
      if (!item) return;
      const efforts = this.atoms.effortOptions.get();
      const found = efforts.find((e) => e.name === item.key);
      if (found) {
        this.atoms.effort.set(item.key as EffortLevel);
      }
    });
  }
}

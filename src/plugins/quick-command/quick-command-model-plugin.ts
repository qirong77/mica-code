import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandModelPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'model',
      description: '切换模型',
      action: () => {
        const currentModel = this.atoms.model.get();
        const models = this.atoms.modelOptions.get();

        const items = models.map((m) => {
          const isActive = m.name === currentModel;
          return {
            key: m.name,
            label: m.label,
            suffix: isActive
              ? { text: '(active)', color: '#4CAF50' }
              : undefined,
          };
        });

        const activeIdx = items.findIndex((i) => i.key === currentModel);

        this.agent.ui.DropDown.atomData.dropdown.set({
          visible: true,
          items,
          selectedIndex: activeIdx >= 0 ? activeIdx : 0,
          title: 'select model:',
          emptyMessage: 'no models available',
        });
      },
    });

    this.agent.ui.DropDown.emitter.on('select', (item) => {
      if (!item) return;
      const models = this.atoms.modelOptions.get();
      const found = models.find((m) => m.name === item.key);
      if (found) {
        this.atoms.model.set(item.key);
      }
    });
  }
}

import { createRoot } from 'react-dom/client'
import '../../../../packages/mica-config-ui/web/styles.css'
import '../../src/renderer/assets/app.css'
import { ConfigPage } from '../../../../packages/mica-config-ui/web/pages/ConfigPage'
import { ArcoProvider } from '../../../../packages/mica-config-ui/web/components/ArcoSettings'
import { setConfigWebClient } from '../../../../packages/mica-config-ui/web/api'

setConfigWebClient({
  readConfigFile: async () => ({ path: '/example/config.json', content: '{"providers":{}}' }),
  writeConfigFile: async (content) => ({ path: '/example/config.json', content }),
})
createRoot(document.getElementById('root')).render(
  <ArcoProvider><div className="mica-config-ui"><ConfigPage /></div></ArcoProvider>
)

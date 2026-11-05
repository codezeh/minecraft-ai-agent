import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { initStore } from './stores/agents'
import { initDiag } from './stores/diag'
import './styles/tokens.css'

initStore()
initDiag()
createApp(App).use(router).mount('#app')

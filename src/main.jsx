import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { SigiloProvider } from './Sigilo.jsx'
import { ConfigProvider } from './Configuracoes.jsx'

// O sigilo fica fora do App porque as folhas impressas são early-returns dele: dentro, trocar
// para a impressão desmontaria o provider e os valores voltariam a ficar ocultos. As
// configurações ficam por fora dos dois porque o Sigilo lê delas o tempo para esconder os valores.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ConfigProvider>
      <SigiloProvider>
        <App />
      </SigiloProvider>
    </ConfigProvider>
  </StrictMode>,
)

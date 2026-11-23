import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { SigiloProvider } from './Sigilo.jsx'
import { ConfigProvider } from './Configuracoes.jsx'
import { ligarCaixaAlta } from './caixaAlta.js'
import Portaria from './Portaria.jsx'

ligarCaixaAlta()

// O sigilo fica fora do App porque as folhas impressas são early-returns dele: dentro, trocar
// para a impressão desmontaria o provider e os valores voltariam a ficar ocultos. As
// configurações ficam por fora dos dois porque o Sigilo lê delas o tempo para esconder os valores.
// A Portaria fica por fora de tudo: login de cliente abre o portal (sem configurações, sigilo nem
// as cargas da equipe); o resto segue para o sistema como antes.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Portaria>
      <ConfigProvider>
        <SigiloProvider>
          <App />
        </SigiloProvider>
      </ConfigProvider>
    </Portaria>
  </StrictMode>,
)

import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { SigiloProvider } from './Sigilo.jsx'

// O sigilo fica fora do App porque as folhas impressas são early-returns dele: dentro, trocar
// para a impressão desmontaria o provider e os valores voltariam a ficar ocultos.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <SigiloProvider>
      <App />
    </SigiloProvider>
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { LazyMotion, domAnimation } from 'motion/react'
import './index.css'
import App from './App.jsx'
import { watchForNewBuilds } from './lib/serviceWorkerUpdate'

// The service worker itself is registered later, by App, once the first page is on screen
watchForNewBuilds()
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      {/* Components animate with m.* rather than motion.*, so the first download carries only the
          animation code every page uses. DashboardPage adds drag and layout for itself. strict
          makes a motion.* component an error in development, as it would bring all of that back. */}
      <LazyMotion features={domAnimation} strict>
        <App />
      </LazyMotion>
    </BrowserRouter>
  </StrictMode>,
)

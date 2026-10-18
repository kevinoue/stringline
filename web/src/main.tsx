import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { apply, storedChoice } from './theme.js'
import './styles.css'

/*
 * Before React, not inside it. Resolving the theme in a component means the
 * first paint happens in light and then flips — the white flash everybody
 * recognises from a dark-mode site that bolted it on afterwards.
 */
apply(storedChoice())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

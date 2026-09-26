import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/global.css'

/**
 * Renderer entry point.
 *
 * The mount is wrapped in a guard because a throw here would leave the user
 * staring at an empty window with no explanation. In a finance app an empty
 * screen reads as "my data is gone", so a failure must say so explicitly.
 */
const container = document.getElementById('root')

if (!container) {
  document.body.innerHTML =
    '<div style="font-family: Segoe UI, sans-serif; padding: 40px; color: #1F1F1F;">' +
    '<h1 style="font-size: 18px; margin-bottom: 8px;">CashInflow could not start</h1>' +
    '<p style="color: #777;">The application root element is missing from the page.</p>' +
    '</div>'
} else {
  try {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    container.innerHTML =
      '<div style="font-family: Segoe UI, sans-serif; padding: 40px; color: #1F1F1F;">' +
      '<h1 style="font-size: 18px; margin-bottom: 8px;">CashInflow could not start</h1>' +
      `<p style="color: #777;">${message.replace(/[<>&]/g, '')}</p>` +
      '</div>'
  }
}
